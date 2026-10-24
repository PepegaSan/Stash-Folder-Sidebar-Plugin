import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../src/generator/generate";
import type { ClipOptions } from "../src/generator/material";
import type { StashRef, StashSceneCore } from "../src/stash/types";
import { project } from "./helpers";

const SKIP = { id: "50", name: "PMV Creator: skip" };
const PMV = { id: "51", name: "PMV Creator" };
const filters: Array<Record<string, any>> = [];

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
const library = [scene("1", []), scene("2", [PMV]), scene("3", [SKIP])];

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
}));
vi.mock("../src/stash/sceneCache", async (orig) => ({ ...(await orig<typeof import("../src/stash/sceneCache")>()), primeScenes: () => undefined }));

const { collectPools } = await import("../src/ui/generator/run");
const used = async (o: Partial<ClipOptions>) => (await collectPools({ ...defaultSettings("trk").clips, ...o }, project(), 1)).sources.map((s) => s.sceneId);

describe("generator material", () => {
  beforeEach(() => void (filters.length = 0));

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
