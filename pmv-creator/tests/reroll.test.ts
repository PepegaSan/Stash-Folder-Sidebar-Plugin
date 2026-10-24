import { describe, expect, it } from "vitest";
import { applyGeneration, buildGeneration, defaultSettings, generationRange } from "../src/generator/generate";
import { FULL_ONLY } from "../src/generator/layouts";
import type { MaterialItem } from "../src/generator/material";
import { rerollClips } from "../src/generator/reroll";
import { type Clip, clipEnd } from "../src/model/project";
import { PMV_TAG, SKIP_TAG } from "../src/stash/library";
import { editorReducer, initialEditorState } from "../src/state/reducer";
import { labelUpdate } from "../src/ui/labels";
import { assertTrackInvariants, clip, project } from "./helpers";

const GRID = { bpm: 120, offset: 0, beatsPerBar: 4 };
const noMaps = { speedMaps: {}, speedPct: () => null };

const item = (sceneId: string, a: number, b: number, extra: Partial<MaterialItem> = {}): MaterialItem => ({
  snippet: { id: `sn_${sceneId}_${a}`, sceneId, markerId: null, in: a, out: b, label: `S${sceneId}`, tags: [] },
  performers: [],
  fixedStart: false,
  ...extra,
});

/** Project with a song of 32 s and sources 1…6 (100 s each). */
function songProject() {
  const p = project([], [clip("1", 40, 4)]);
  p.beatGrid = GRID;
  p.audio = { name: "m", path: "/m.mp3", url: null, duration: 32, sourceIn: 0, start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0 };
  for (const id of ["4", "5", "6"]) p.sources[id] = { ...p.sources["1"], sceneId: id, path: `/media/${id}.mp4`, title: `S${id}` };
  return p;
}
const pools = () => [["1", "2", "3", "4", "5", "6"].map((id) => item(id, 0, 100))];

describe("📌 kept clips and generating again", () => {
  it("another variant leaves kept clips where they are and fills around them", () => {
    const p0 = songProject();
    // full screen: every run cuts the same slots (split screens move with the seed)
    const base = defaultSettings(p0.tracks[1].id);
    const s = { ...base, style: { ...base.style, layouts: FULL_ONLY } };
    const range = generationRange(p0, s.target, 0);
    let st = initialEditorState(p0);
    st = editorReducer(st, { type: "generate/apply", result: buildGeneration(p0, s, range, { pools: pools(), sources: [], context: noMaps }).result });
    const generated = st.present.tracks[1].clips.filter((c) => c.start < 32);
    const kept = [generated[1], generated[4]];
    st = editorReducer(st, { type: "clips/pin", clipIds: kept.map((c) => c.id), pinned: true });

    const s2 = { ...s, seed: 2 };
    const r2 = buildGeneration(st.present, s2, range, { pools: pools(), sources: [], context: noMaps }).result;
    // the kept slots are not generated again
    for (const k of kept) expect(r2.clips.some((c) => c.start < clipEnd(k) && clipEnd(c) > k.start)).toBe(false);
    st = editorReducer(st, { type: "generate/apply", result: r2 });
    const after = st.present.tracks[1].clips;
    assertTrackInvariants(st.present);
    for (const k of kept) expect(after.find((c) => c.id === k.id)).toEqual({ ...k, pinned: true });
    expect(after.filter((c) => c.start < 32).reduce((n, c) => n + c.duration, 0)).toBeCloseTo(32);
    expect(after.some((c) => c.start === 40)).toBe(true);
    // the run is remembered for re-rolling single clips
    expect(st.present.generator).toMatchObject({ from: 0, to: 32, settings: { seed: 2 } });

    // "clear the track first" clears everything but the kept clips
    const r3 = buildGeneration(st.present, { ...s2, seed: 3, target: { ...s2.target, replaceTrack: true } }, range, { pools: pools(), sources: [], context: noMaps }).result;
    const cleared = applyGeneration(st.present, r3).tracks[1].clips;
    expect(cleared.some((c) => c.start === 40)).toBe(false);
    for (const k of kept) expect(cleared.some((c) => c.id === k.id)).toBe(true);
  });

  it("pinning is undoable and pinning a kept clip again changes nothing", () => {
    let st = initialEditorState(project([], [clip("1", 0, 2)]));
    const id = st.present.tracks[1].clips[0].id;
    st = editorReducer(st, { type: "clips/pin", clipIds: [id], pinned: true });
    expect(st.present.tracks[1].clips[0].pinned).toBe(true);
    const same = editorReducer(st, { type: "clips/pin", clipIds: [id], pinned: true });
    expect(same).toBe(st);
    st = editorReducer(st, { type: "clips/pin", clipIds: [id], pinned: false });
    expect("pinned" in st.present.tracks[1].clips[0]).toBe(false);
    st = editorReducer(st, { type: "undo" });
    expect(st.present.tracks[1].clips[0].pinned).toBe(true);
  });
});

describe("🎲 another clip", () => {
  /** V1: scenes 1 2 3 1 2 3 …, 2 s each. */
  const lane = () => {
    const clips: Clip[] = [];
    for (let i = 0; i < 12; i++) clips.push(clip(String((i % 3) + 1), i * 2, 2, { sourceIn: 10, speed: i === 6 ? 1.25 : 1, transitionIn: i === 6 ? { type: "fade", duration: 0.3 } : null }));
    const p = songProject();
    p.tracks[1].clips = clips;
    return p;
  };

  it("takes another scene, not one that plays nearby – place, length, speed and transition stay", () => {
    const p = lane();
    const target = p.tracks[1].clips[6];
    const [ch] = rerollClips(p, [target.id], pools(), { seed: 7, variety: true, followTimeline: false, range: null });
    expect(["4", "5", "6"]).toContain(ch.sceneId);
    expect(ch.speed).toBe(1.25);
    expect(ch.sourceIn).toBeGreaterThanOrEqual(0);
    expect(ch.sourceIn + 2 * 1.25).toBeLessThanOrEqual(100);

    let st = initialEditorState(p);
    st = editorReducer(st, { type: "clips/material", changes: [ch], sources: [] });
    const after = st.present.tracks[1].clips[6];
    expect(after).toMatchObject({ id: target.id, start: target.start, duration: target.duration, speed: 1.25, transitionIn: target.transitionIn, sceneId: ch.sceneId });
    st = editorReducer(st, { type: "undo" });
    expect(st.present).toBe(p);
  });

  it("is the same for the same seed and different for another", () => {
    const p = lane();
    const ids = p.tracks[1].clips.map((c) => c.id);
    const a = rerollClips(p, ids, pools(), { seed: 3, variety: true, followTimeline: false, range: null });
    const b = rerollClips(p, ids, pools(), { seed: 3, variety: true, followTimeline: false, range: null });
    const c = rerollClips(p, ids, pools(), { seed: 4, variety: true, followTimeline: false, range: null });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    // every clip got a scene other than its own
    a.forEach((ch, i) => expect(ch.sceneId).not.toBe(p.tracks[1].clips[i].sceneId));
  });

  it("goes on to other scenes instead of back to the ones it was just rolled away from", () => {
    const p = lane();
    const target = p.tracks[1].clips[6]; // scene 1; 2 and 3 play nearby
    for (let seed = 0; seed < 20; seed++) {
      const [ch] = rerollClips(p, [target.id], pools(), { seed, variety: true, followTimeline: false, range: null, avoid: { [target.id]: ["1", "4", "5"] } });
      expect(ch.sceneId).toBe("6");
    }
  });

  it("stays out of excluded scenes and gives nothing when there is no other candidate", () => {
    const p = lane();
    const id = p.tracks[1].clips[0].id; // scene 1
    const only = [[item("1", 0, 100), item("2", 0, 100)]];
    p.exclusions = [{ id: "x", sceneId: "2", markerId: null, in: 0, out: 100 }];
    expect(rerollClips(p, [id], only, { seed: 1, variety: true, followTimeline: false, range: null })).toEqual([]);
    p.exclusions = [];
    expect(rerollClips(p, [id], only, { seed: 1, variety: true, followTimeline: false, range: null }).map((x) => x.sceneId)).toEqual(["2"]);
  });

  it("stays in the clip's tag stage, starts marker clips at the marker, leaves locked tracks alone", () => {
    const p = lane();
    const id = p.tracks[1].clips[0].id; // scene 1
    const stages = [
      [item("1", 0, 100), item("4", 20, 28, { fixedStart: true, snippet: { id: "m4", sceneId: "4", markerId: "44", in: 20, out: 28, label: "M", tags: [] } })],
      [item("5", 0, 100), item("6", 0, 100)],
    ];
    const [ch] = rerollClips(p, [id], stages, { seed: 1, variety: true, followTimeline: false, range: null });
    expect(ch).toMatchObject({ sceneId: "4", markerId: "44", sourceIn: 20, label: "M" });
    p.tracks[1] = { ...p.tracks[1], locked: true };
    expect(rerollClips(p, [id], stages, { seed: 1, variety: true, followTimeline: false, range: null })).toEqual([]);
  });

  it("⊘ scene out: exclusion and new material in one undo step", () => {
    const p = lane();
    const ex = { id: "x1", sceneId: "1", markerId: null, in: 0, out: 100 };
    const out = { ...p, exclusions: [ex] };
    const ids = p.tracks[1].clips.filter((c) => c.sceneId === "1").map((c) => c.id);
    const changes = rerollClips(out, ids, pools(), { seed: 9, variety: true, followTimeline: false, range: null });
    expect(changes).toHaveLength(ids.length);
    expect(changes.every((c) => c.sceneId !== "1")).toBe(true);
    let st = initialEditorState(p);
    st = editorReducer(st, { type: "clips/material", changes, sources: [], exclusions: [ex] });
    expect(st.present.exclusions).toEqual([ex]);
    expect(st.present.tracks[1].clips.some((c) => c.sceneId === "1")).toBe(false);
    st = editorReducer(st, { type: "undo" });
    expect(st.present).toBe(p);
  });
});

describe("🏷 labeling the rendered PMV", () => {
  const ref = (id: string, name = id) => ({ id, name });
  const job = { path: "/renders/a.mp4", title: "My PMV", details: "Made with PMV Creator.", sceneIds: [], queued: 0 };

  it("all performers, the tags a quarter of the scenes share (two at least), the PMV tag – on top of what the scene has", () => {
    const sources = [
      { performers: [ref("p1")], tags: [ref("t1"), ref("t2"), ref("s", SKIP_TAG)] },
      { performers: [ref("p2")], tags: [ref("t1"), ref("t3"), ref("s", SKIP_TAG)] },
      { performers: [ref("p1")], tags: [ref("t1")] },
      { performers: [], tags: [ref("t4"), ref("pmv", PMV_TAG)] },
      { performers: [ref("p3")], tags: [ref("t2")] },
    ];
    const scene = { id: "900", title: null, performers: [ref("p9")], tags: [ref("old")] };
    const r = labelUpdate(job, scene, sources, "pmv");
    expect(r.input).toEqual({ id: "900", title: "My PMV", details: "Made with PMV Creator.", performer_ids: ["p9", "p1", "p2", "p3"], tag_ids: ["old", "t1", "t2", "pmv"] });
    expect(r.performers).toBe(4);
    expect(r.tags).toBe(2);
  });

  it("a PMV from one scene takes all of its tags", () => {
    const r = labelUpdate(job, { id: "1", title: null, performers: [], tags: [] }, [{ performers: [], tags: [ref("a"), ref("b")] }], "pmv");
    expect(r.input.tag_ids).toEqual(["a", "b", "pmv"]);
  });
});
