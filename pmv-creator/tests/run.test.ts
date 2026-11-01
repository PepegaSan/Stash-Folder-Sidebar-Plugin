import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../src/generator/generate";
import type { ClipOptions } from "../src/generator/material";
import type { StashRef, StashSceneCore } from "../src/stash/types";
import { project } from "./helpers";

const SKIP = { id: "50", name: "PMV Creator: skip" };
const PMV = { id: "51", name: "PMV Creator" };
const filters: Array<Record<string, any>> = [];
const fetchedIds: string[][] = [];
let markerQueries = 0;

const scene = (id: string, tags: StashRef[]): StashSceneCore => ({
  id,
  title: `Scene ${id}`,
  date: null,
  rating100: null,
  files: [{ id: `f${id}`, path: `/media/${id}.mp4`, basename: `${id}.mp4`, duration: 60, width: 1920, height: 1080, frame_rate: 30, video_codec: "h264", audio_codec: "aac" }],
  paths: { screenshot: null, stream: null, preview: null, sprite: null, vtt: null },
  sceneStreams: [],
  studio: null,
  performers: [],
  tags,
});
// Stash answers with a rendered PMV too, as if it ignored the filter – the client check must catch it
const marker = { id: "m1", title: "Small marker", seconds: 300, end_seconds: 305, primary_tag: { id: "9", name: "Tag" }, tags: [], screenshot: null, preview: null, stream: null };
const longScene = { ...scene("1", []), scene_markers: [marker] };
longScene.files[0].duration = 1800;
const library = [longScene, scene("2", [PMV]), scene("3", [SKIP])];

vi.mock("../src/stash/library", async (orig) => ({
  ...(await orig<typeof import("../src/stash/library")>()),
  cachedTagId: async (name: string) => [SKIP, PMV].find((x) => x.name === name)?.id ?? null,
}));
vi.mock("../src/stash/queries", async (orig) => ({
  ...(await orig<typeof import("../src/stash/queries")>()),
  queryScenes: async (filter: Record<string, any>) => {
    filters.push(filter);
    return { count: library.length, scenes: library };
  },
  fetchScenes: async (ids: string[]) => { fetchedIds.push(ids); return library.filter((s) => ids.includes(s.id)); },
  queryMarkers: async () => { markerQueries++; return { count: 1, markers: [{ ...marker, scene: longScene }] }; },
}));
vi.mock("../src/stash/sceneCache", async (orig) => ({ ...(await orig<typeof import("../src/stash/sceneCache")>()), primeScenes: () => undefined }));
vi.mock("../src/stash/savedFilters", () => ({ savedSceneFilter: async () => ({ id: "saved", name: "Saved", filter: {}, q: "", skipped: [] }) }));

const { collectPools, runGenerator } = await import("../src/ui/generator/run");
const used = async (o: Partial<ClipOptions>) => (await collectPools({ ...defaultSettings("trk").clips, ...o }, project(), 1)).sources.map((s) => s.sceneId);

describe("generator material", () => {
  beforeEach(() => { filters.length = 0; fetchedIds.length = 0; markerQueries = 0; });

  it.each(["filter", "project", "watched", "saved"] as const)("%s: legacy marker flags cannot shrink a long video to its five-second marker", async (source) => {
    const o = { ...defaultSettings("trk").clips, source, kind: "markers" as const, preferMarkers: true, savedFilter: { id: "saved", name: "Saved" } };
    delete o.materialMode;
    const { pools } = await collectPools(o, project(), 7);
    expect(pools[0]).toHaveLength(1);
    expect(pools[0][0]).toMatchObject({ fixedStart: false, snippet: { sceneId: "1", markerId: null, in: 144, out: 1656 } });
    expect(markerQueries).toBe(0);
  });

  it("the bin chooses video IDs by default; it does not silently lock the generator to old marker snippets", async () => {
    const p = project();
    p.bin = [
      { id: "a", sceneId: "1", markerId: "m1", in: 300, out: 305, label: "Small", tags: [] },
      { id: "b", sceneId: "1", markerId: null, in: 600, out: 602, label: "Other", tags: [] },
    ];
    const { pools, sources } = await collectPools({ ...defaultSettings("trk").clips, source: "bin", preferMarkers: true }, p, 7);
    expect(fetchedIds).toEqual([["1"]]);
    expect(pools[0]).toHaveLength(1);
    expect(pools[0][0]).toMatchObject({ fixedStart: false, snippet: { markerId: null, in: 144, out: 1656 } });
    expect(sources[0].duration).toBe(1800);
  });

  it("only explicit selected-range mode keeps the exact bin snippets", async () => {
    const p = project();
    p.bin = [{ id: "a", sceneId: "1", markerId: "m1", in: 300, out: 305, label: "Small", tags: [] }];
    const { pools } = await collectPools({ ...defaultSettings("trk").clips, source: "bin", materialMode: "ranges" }, p, 7);
    expect(pools[0][0]).toMatchObject({ snippet: p.bin[0], fixedStart: true });
    expect(fetchedIds).toEqual([]);
  });

  it.each(["filter", "project", "watched", "saved"] as const)("%s: explicitly selected marker mode stays inside markers", async (source) => {
    const { pools } = await collectPools({ ...defaultSettings("trk").clips, source, materialMode: "markers", savedFilter: { id: "saved", name: "Saved" } }, project(), 7);
    expect(pools[0]).toHaveLength(1);
    expect(pools[0][0]).toMatchObject({ fixedStart: true, snippet: { markerId: "m1", in: 300, out: 305 } });
  });

  it("does not turn marker-only scenes without markers into whole-video candidates", async () => {
    const p = project(); p.sources = { "2": p.sources["2"] };
    const { pools } = await collectPools({ ...defaultSettings("trk").clips, source: "project", materialMode: "markers", tags: [PMV] }, p, 7);
    expect(pools).toEqual([[]]);
  });

  it("whole-video bin sources still exclude permanently skipped scenes and rendered PMVs", async () => {
    const p = project();
    p.bin = ["1", "2", "3"].map((sceneId) => ({ id: sceneId, sceneId, markerId: null, in: 1, out: 2, label: "Small", tags: [] }));
    const { pools } = await collectPools({ ...defaultSettings("trk").clips, source: "bin" }, p, 7);
    expect(pools[0].map((it) => it.snippet.sceneId)).toEqual(["1"]);
  });

  it("generates across the long video from a five-second bin marker and remembers the effective whole-video mode", async () => {
    const p = project();
    p.bin = [{ id: "small", sceneId: "1", markerId: "m1", in: 300, out: 305, label: "Small", tags: [] }];
    const s = defaultSettings(p.tracks[1].id);
    s.clips.source = "bin"; s.clips.kind = "markers"; s.clips.preferMarkers = true; delete s.clips.materialMode;
    s.target.range = "bars"; s.target.bars = 40;
    const out = await runGenerator(p, s, 0, () => {});
    const clips = [out.result.clips, ...out.result.fields].flat();
    expect(clips.length).toBeGreaterThan(10);
    expect(clips.every((c) => c.markerId === null && c.sourceIn >= 144 && c.sourceIn + c.duration * c.speed <= 1656 + 1e-6)).toBe(true);
    expect(Math.min(...clips.map((c) => c.sourceIn))).toBeLessThan(400);
    expect(Math.max(...clips.map((c) => c.sourceIn))).toBeGreaterThan(1400);
    expect(out.result.settings.clips).toMatchObject({ materialMode: "whole", kind: "scenes", preferMarkers: false });
    expect(out.result.sources[0].duration).toBe(1800);
    expect(out.material).toEqual({ mode: "whole", availableSeconds: 1512 });
  });

  it("reports available material after exclusions without double-counting overlapping stage pools", async () => {
    const p = project();
    p.exclusions = [{ id: "ex", sceneId: "1", markerId: null, in: 200, out: 300 }];
    const s = defaultSettings(p.tracks[1].id);
    s.clips.tags = [PMV]; s.clips.stagesOn = true;
    s.target.range = "bars";
    const out = await runGenerator(p, s, 0, () => {});
    // 1800s × .84 - 100s exclusion, plus 60s × .84; both stages contain the same ranges.
    expect(out.material.availableSeconds).toBeCloseTo(1462.4);
  });

  it("leaves out the PMVs rendered here and the ⊘ scenes", async () => {
    expect(await used({ source: "filter" })).toEqual(["1"]);
    expect(filters[0].tags.excludes).toEqual(["50", "51"]);
    expect(await used({ source: "watched" })).toEqual(["1"]);
  });

  it("uses the rendered PMVs when the tags ask for “PMV Creator” – ⊘ stays out", async () => {
    expect(await used({ source: "filter", tags: [PMV] })).toEqual(["1", "2"]);
    expect(filters[0].tags.excludes).toEqual(["50"]);
  });
});
