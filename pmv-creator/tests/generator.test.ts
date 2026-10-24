import { describe, expect, it } from "vitest";
import { type FillOptions, fillSlots, timelineWindow } from "../src/generator/assemble";
import { allowedParts, applyBeatSync, applyGeneration, buildGeneration, defaultSettings, generationRange } from "../src/generator/generate";
import { type ClipOptions, type MaterialItem, buildMarkerFilter, buildSceneFilter, clientAnyTags } from "../src/generator/material";
import { actionMotion, beatFit, makePercentile, previewPieces, rhythmOf } from "../src/generator/motion";
import { mulberry32 } from "../src/generator/random";
import { analyzeBeats, assignStages, planCuts } from "../src/generator/rhythm";
import type { Clip } from "../src/model/project";
import { editorReducer, initialEditorState } from "../src/state/reducer";
import { assertTrackInvariants, clip, project } from "./helpers";

const GRID = { bpm: 120, offset: 0, beatsPerBar: 4 }; // beat = 0.5 s, bar = 2 s

/** quiet for 16 s, then loud */
const quietThenLoud = (t0: number) => (t0 < 16 ? 0.1 : 1);

const item = (sceneId: string, a: number, b: number, extra: Partial<MaterialItem> = {}): MaterialItem => ({
  snippet: { id: `sn_${sceneId}_${a}`, sceneId, markerId: null, in: a, out: b, label: sceneId, tags: [] },
  performers: [],
  fixedStart: false,
  ...extra,
});

const fill = (o: Partial<FillOptions> = {}): FillOptions => ({
  seed: 1,
  order: "shuffle",
  offset: "random",
  variety: true,
  followTimeline: false,
  paceMatch: false,
  speed: 1,
  speedRamps: false,
  transitions: "none",
  flashDrops: true,
  ...o,
});
const noMaps = { speedMaps: {}, speedPct: () => null };

describe("cutting (Pepega rules)", () => {
  const beats = analyzeBeats(GRID, 0, 32, quietThenLoud);

  it("detects the drop where it gets loud", () => {
    expect(beats.filter((b) => b.drop).map((b) => b.t)).toEqual([16]);
  });

  it("auto pace: calm every 4 beats on the bar grid, loud every beat, cut on the drop", () => {
    const slots = planCuts(beats, GRID, 0, 32, { mode: "auto", pace: "normal", every: 2, pattern: [], onGrid: true, minBeats: 0, maxBeats: 0 });
    const calm = slots.filter((s) => s.start < 16);
    const loud = slots.filter((s) => s.start >= 16);
    expect(calm.every((s) => s.duration === 2 && s.downbeat)).toBe(true);
    expect(loud.every((s) => s.duration === 0.5)).toBe(true);
    expect(slots.find((s) => s.start === 16)?.drop).toBe(true);
    expect(slots.reduce((n, s) => n + s.duration, 0)).toBeCloseTo(32);
  });

  it("slow pace: 8-beat cuts land on every second bar line", () => {
    const slots = planCuts(beats, GRID, 0, 32, { mode: "auto", pace: "slow", every: 2, pattern: [], onGrid: true, minBeats: 0, maxBeats: 0 });
    expect(slots.filter((s) => s.start < 16).map((s) => s.start)).toEqual([0, 4, 8, 12]);
  });

  it("energy is relative to the song: an even song cuts at medium pace", () => {
    const even = analyzeBeats(GRID, 0, 16, () => 0.1);
    const slots = planCuts(even, GRID, 0, 16, { mode: "auto", pace: "slow", every: 2, pattern: [], onGrid: true, minBeats: 0, maxBeats: 0 });
    expect(slots.every((s) => s.duration === 2)).toBe(true);
  });

  it("respects shortest / longest clip", () => {
    const slots = planCuts(beats, GRID, 0, 32, { mode: "fixed", pace: "normal", every: 1, pattern: [], onGrid: true, minBeats: 2, maxBeats: 0 });
    expect(Math.min(...slots.map((s) => s.duration))).toBeGreaterThanOrEqual(1 - 1e-9);
    const longest = planCuts(analyzeBeats(GRID, 0, 16, () => 0.1), GRID, 0, 16, { mode: "auto", pace: "slow", every: 2, pattern: [], onGrid: true, minBeats: 0, maxBeats: 3 });
    expect(Math.max(...longest.map((s) => s.duration))).toBeLessThanOrEqual(1.5 + 1e-9);
  });

  it("pattern mode allows fractions of a beat", () => {
    const slots = planCuts(analyzeBeats(GRID, 0, 4), GRID, 0, 4, { mode: "pattern", pace: "normal", every: 2, pattern: [1, 0.5, 0.5], onGrid: true, minBeats: 0, maxBeats: 0 });
    expect(slots.map((s) => s.duration)).toEqual([0.5, 0.25, 0.25, 0.5, 0.25, 0.25, 0.5, 0.25, 0.25, 0.5, 0.25, 0.25]);
  });

  it("a song whose first beat comes a few ms in gets no sliver clip at the start", () => {
    const late = { ...GRID, offset: 0.005 };
    const lb = analyzeBeats(late, 0, 8);
    expect(lb[0]).toMatchObject({ t: 0, downbeat: true, phrase: true });
    expect(lb[1].t).toBeCloseTo(0.505);
    const slots = planCuts(lb, late, 0, 8, { mode: "fixed", pace: "normal", every: 1, pattern: [], onGrid: true, minBeats: 0, maxBeats: 0 });
    expect(slots[0]).toMatchObject({ start: 0, downbeat: true });
    expect(slots[0].duration).toBeCloseTo(0.505);
    expect(Math.min(...slots.map((s) => s.duration))).toBeGreaterThan(0.49);
    // more than half a beat before the first one stays a beat of its own (a pickup)
    expect(analyzeBeats({ ...GRID, offset: 0.3 }, 0, 4)[0].t).toBe(0);
    expect(analyzeBeats({ ...GRID, offset: 0.3 }, 0, 4)[1].t).toBeCloseTo(0.3);
  });

  it("pattern mode keeps its cuts on the beat grid when the range starts between beats", () => {
    const off = { ...GRID, offset: 0.3 };
    const slots = planCuts(analyzeBeats(off, 0, 10), off, 0, 10, { mode: "pattern", pace: "normal", every: 2, pattern: [2, 1], onGrid: true, minBeats: 0, maxBeats: 0 });
    expect(slots[0].start).toBe(0);
    for (const s of slots.slice(1)) expect(Math.abs(((s.start - 0.3) / 0.5) % 1)).toBeLessThan(1e-6);
    expect(slots.slice(1, 4).map((s) => +s.start.toFixed(3))).toEqual([1.3, 1.8, 2.8]);
    expect(slots.reduce((n, s) => n + s.duration, 0)).toBeCloseTo(10);
  });

  it("tag stages: last stage on drops (2 bars) and in the finale", () => {
    const slots = planCuts(beats, GRID, 0, 32, { mode: "fixed", pace: "normal", every: 4, pattern: [], onGrid: true, minBeats: 0, maxBeats: 0 });
    const st = assignStages(slots, 3, 0.5);
    const at = (t: number) => st[slots.findIndex((s) => s.start === t)];
    expect([at(0), at(10), at(24)]).toEqual([0, 0, 1]); // stages 1..n-1 share the first 90 % of the song
    expect([at(16), at(18)]).toEqual([2, 2]); // drop + following bar
    expect(at(20)).toBe(1);
    expect(at(30)).toBe(2); // finale = last tenth
  });
});

describe("selection", () => {
  const slots = planCuts(analyzeBeats(GRID, 0, 40), GRID, 0, 40, { mode: "fixed", pace: "normal", every: 1, pattern: [], onGrid: true, minBeats: 0, maxBeats: 0 });

  it("variety: the same scene not within the last 24 clips", () => {
    const pool = Array.from({ length: 30 }, (_, i) => item(`s${i}`, 0, 60));
    const clips = fillSlots(project(), slots, slots.map(() => 0), [pool], fill(), noMaps);
    for (let i = 0; i < clips.length; i++) {
      const window = clips.slice(Math.max(0, i - 24), i).map((c) => c.sceneId);
      expect(window).not.toContain(clips[i].sceneId);
    }
  });

  it("is deterministic per seed", () => {
    const pool = Array.from({ length: 10 }, (_, i) => item(`s${i}`, 0, 60));
    const a = fillSlots(project(), slots, slots.map(() => 0), [pool], fill({ seed: 5 }), noMaps).map((c) => [c.sceneId, c.sourceIn]);
    const b = fillSlots(project(), slots, slots.map(() => 0), [pool], fill({ seed: 5 }), noMaps).map((c) => [c.sceneId, c.sourceIn]);
    const c = fillSlots(project(), slots, slots.map(() => 0), [pool], fill({ seed: 6 }), noMaps).map((x) => [x.sceneId, x.sourceIn]);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("follows the scene timeline (±12 %)", () => {
    const pool = Array.from({ length: 5 }, (_, i) => item(`s${i}`, 0, 100));
    const clips = fillSlots(project(), slots, slots.map(() => 0), [pool], fill({ followTimeline: true }), noMaps);
    slots.forEach((s, i) => {
      const [lo, hi] = timelineWindow(0, 100, s.progress);
      expect(clips[i].sourceIn).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(clips[i].sourceIn).toBeLessThanOrEqual(hi);
    });
  });

  it("marker clips start at their marker and play on when reused", () => {
    const marker = item("m", 10, 12, { fixedStart: true });
    const clips = fillSlots(project(), slots.slice(0, 3), [0, 0, 0], [[marker]], fill({ variety: false }), noMaps);
    expect(clips.map((c) => c.sourceIn)).toEqual([10, 10.5, 11]);
  });

  it("clip speed follows the music: loud slots get the fast spots", () => {
    const loudSlots = planCuts(analyzeBeats(GRID, 0, 32, quietThenLoud), GRID, 0, 32, { mode: "fixed", pace: "normal", every: 2, pattern: [], onGrid: true, minBeats: 0, maxBeats: 0 });
    const speedMaps: Record<string, Array<{ t: number; len: number; speed: number }>> = {};
    for (let n = 0; n < 8; n++) {
      speedMaps[`calm${n}`] = Array.from({ length: 6 }, (_, i) => ({ t: i * 10, len: 0.75, speed: 2 + n + i * 0.1 }));
      speedMaps[`fast${n}`] = Array.from({ length: 6 }, (_, i) => ({ t: i * 10, len: 0.75, speed: 40 + n + i }));
    }
    const speedPct = makePercentile(Object.values(speedMaps).flatMap((m) => m.map((x) => x.speed)));
    const pool = Object.keys(speedMaps).map((id) => item(id, 0, 60));
    const clips = fillSlots(project(), loudSlots, loudSlots.map(() => 0), [pool], fill({ paceMatch: true, variety: false }), { speedMaps, speedPct });
    // the speed percentile of the spot each clip starts on
    const pctOf = (c: Clip) => speedPct(speedMaps[c.sceneId].find((x) => Math.abs(x.t - c.sourceIn) < 1e-9)!.speed)!;
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const calm = mean(clips.filter((_, i) => loudSlots[i].energy < 0.5).map(pctOf));
    const loud = mean(clips.filter((_, i) => loudSlots[i].energy >= 0.5).map(pctOf));
    expect(calm).toBeLessThan(0.3);
    expect(loud).toBeGreaterThan(0.7);
  });
});

describe("motion analysis (experimental modes)", () => {
  it("finds the rhythm of a periodic motion and its turns", () => {
    const pts = Array.from({ length: 60 }, (_, i) => ({ t: 3 + i / 30, m: 1 + 0.8 * Math.sin((2 * Math.PI * (i / 30)) / 0.5) }));
    const r = rhythmOf(pts)!;
    expect(r.period).toBeCloseTo(0.5, 1);
    // a turn is a minimum of the motion curve: sin(...) = -1 at 3 + 0.375 (+ k · 0.5)
    const phase = (((r.turn - 3.375) % 0.5) + 0.5) % 0.5;
    expect(Math.min(phase, 0.5 - phase)).toBeLessThan(0.03);
  });

  it("beat fit: at most ±12 %, 1, 2 or ½ pulses per beat", () => {
    expect(beatFit(0.5, 120)).toBeCloseTo(1);
    expect(beatFit(0.53, 120)).toBeCloseTo(1.06);
    expect(beatFit(0.26, 120)).toBeCloseTo(1.04); // two pulses per beat
    expect(beatFit(0.7, 120)).toBeNull();
  });

  it("measures action, not the camera", () => {
    const rnd = mulberry32(3);
    const w = 64;
    const h = 36;
    const a = Uint8Array.from({ length: w * h }, () => Math.floor(rnd() * 255));
    const b = a.slice();
    // a 24×16 region moves 3 px to the right, the rest stands still
    for (let y = 10; y < 26; y++) for (let x = 20; x < 44; x++) b[y * w + x + 3] = a[y * w + x];
    expect(actionMotion(a, b, w)).toBeCloseTo(3, 0);
    expect(actionMotion(a, a, w)).toBe(0);
  });

  it("maps preview pieces back onto the scene like Stash generates them", () => {
    const pieces = previewPieces(9, 600, { previewSegments: 12, previewSegmentDuration: 0.75, previewExcludeStart: "5%", previewExcludeEnd: "5%" });
    expect(pieces).toHaveLength(12);
    expect(pieces[0].t).toBeCloseTo(30);
    expect(pieces[1].t).toBeCloseTo(75);
  });

  it("beat sync: speed factor + start on the first turn; markers keep their start", () => {
    const clips: Clip[] = [clip("1", 0, 1, { sourceIn: 10 }), clip("2", 1, 1, { sourceIn: 20, markerId: "9" })];
    const r = applyBeatSync(clips, { [clips[0].id]: { period: 0.53, half: null, turn: 9.2, q: 0.8 }, [clips[1].id]: { period: 0.47, half: null, turn: 20.3, q: 0.8 } }, 120, () => 100, (c) => !!c.markerId);
    expect(r.synced).toBe(2);
    expect(r.clips[0].speed).toBeCloseTo(1.06);
    expect(r.clips[0].sourceIn).toBeCloseTo(10.26); // 9.2 + 2 · 0.53
    expect(r.clips[1].sourceIn).toBe(20);
    expect(r.clips[1].speed).toBeCloseTo(0.94);
  });

  it("beat sync is idempotent and matches the period on the timeline (speed ≠ 1)", () => {
    const rh = { period: 0.53, half: null, turn: 9.2, q: 0.8 };
    const c1 = clip("1", 0, 1, { sourceIn: 10 });
    const first = applyBeatSync([c1], { [c1.id]: rh }, 120, () => 100, () => false).clips[0];
    expect(first).not.toBe(c1);
    // same measurement again (remembered at the new start): nothing moves
    const again = applyBeatSync([first], { [first.id]: rh }, 120, () => 100, () => false);
    expect(again.clips[0]).toBe(first);
    expect(again.synced).toBe(1);
    // a clip at 1.5×: the motion period on the timeline (source period / speed) is what has to fit the beat
    // 0.8 s in the source at 1.5× = 0.533 s on the timeline → +6.7 % = one pulse per 0.5-s beat
    const slow = { period: 0.8, half: null, turn: 10.4, q: 0.8 };
    const c2 = clip("2", 0, 1, { sourceIn: 10, speed: 1.5 });
    const fast = applyBeatSync([c2], { [c2.id]: slow }, 120, () => 100, () => false).clips[0];
    expect(fast.speed).toBeCloseTo(1.6, 3);
    expect(slow.period / fast.speed).toBeCloseTo(0.5, 3);
  });
});

describe("Stash filters (ported from Pepega's buildFilter)", () => {
  const base = (): ClipOptions => defaultSettings("t").clips;
  const ref = (id: string) => ({ id, name: id });

  it("all/any tags, excludes, rating, shape, resolution, min length, path", () => {
    const o = { ...base(), tags: [ref("1"), ref("2")], tagMode: "any" as const, xtags: [ref("9")], minRating: 60, shape: "portrait" as const, maxRes: 1080, minMinutes: 5, pathContains: "/clips" };
    expect(buildSceneFilter(o, null)).toEqual({
      tags: { value: ["1", "2"], modifier: "INCLUDES", depth: 0, excludes: ["9"] },
      rating100: { value: 59, modifier: "GREATER_THAN" },
      orientation: { value: ["PORTRAIT"] },
      resolution: { value: "QUAD_HD", modifier: "LESS_THAN" },
      path: { value: "/clips", modifier: "INCLUDES" },
      duration: { value: 300, modifier: "GREATER_THAN" },
    });
  });

  it("main tags + any-of tags: main tags in Stash, any-of checked on the client", () => {
    const o = { ...base(), tags: [ref("1"), ref("2")], tagMode: "any" as const, mainTags: [ref("7")] };
    expect(buildSceneFilter(o, null).tags).toEqual({ value: ["7"], modifier: "INCLUDES_ALL", depth: 0 });
    expect(clientAnyTags(o, null)).toEqual(["1", "2"]);
  });

  it("markers: tags on the marker (with sub-tags), the rest on its scene", () => {
    const o = { ...base(), kind: "markers" as const, tags: [ref("1")], performers: [ref("p")] };
    const f = buildMarkerFilter(o, null) as { tags: unknown; scene_filter: Record<string, unknown> };
    expect(f.tags).toEqual({ value: ["1"], modifier: "INCLUDES_ALL", depth: -1 });
    expect(f.scene_filter.performers).toEqual({ value: ["p"], modifier: "INCLUDES_ALL" });
    expect(f.scene_filter.tags).toBeUndefined();
  });
});

describe("generate end-to-end", () => {
  const settings = () => {
    const p = project([], [clip("1", 0, 4), clip("2", 40, 4)]);
    p.beatGrid = GRID;
    p.audio = { name: "m", path: "/m.mp3", url: null, duration: 32, sourceIn: 0, start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0 };
    const s = defaultSettings(p.tracks[1].id);
    return { p, s };
  };

  it("fills the song exactly, overwrites only the range, one undo step", () => {
    const { p, s } = settings();
    const pools = [[item("1", 0, 100), item("2", 0, 100), item("3", 0, 100)]];
    const range = generationRange(p, s.target, 0);
    const { result, stats } = buildGeneration(p, s, range, { pools, sources: [], energy: quietThenLoud, context: noMaps });
    expect(result.clips.reduce((n, c) => n + c.duration, 0)).toBeCloseTo(32);
    expect(stats.drops).toBe(1);

    let st = initialEditorState(p);
    st = editorReducer(st, { type: "generate/apply", result });
    assertTrackInvariants(st.present);
    const track = st.present.tracks[1].clips;
    expect(track.filter((c) => c.start < 32)).toHaveLength(result.clips.length);
    expect(track.some((c) => c.start === 40)).toBe(true); // clip after the range survives
    expect(st.present.bin.length).toBeGreaterThan(0);
    st = editorReducer(st, { type: "undo" });
    expect(st.present).toBe(p);
  });

  it("cuts excluded ranges out of scenes instead of dropping them; excluded markers are dropped", () => {
    const ex = [
      { id: "e1", sceneId: "1", markerId: null, in: 26.5, out: 30 },
      { id: "e2", sceneId: "1", markerId: null, in: 10, out: 12 },
    ];
    expect(allowedParts(item("1", 2, 28), ex).map((x) => [x.snippet.in, x.snippet.out])).toEqual([
      [2, 10],
      [12, 26.5],
    ]);
    expect(allowedParts(item("1", 11, 14, { fixedStart: true }), ex)).toEqual([]);
    expect(allowedParts(item("2", 2, 28), ex)).toHaveLength(1);
  });

  it("re-uses existing bin snippets instead of duplicating them", () => {
    const { p, s } = settings();
    p.bin = [{ id: "existing", sceneId: "1", markerId: "m1", in: 5, out: 13, label: "M", tags: [] }];
    const marker = item("1", 5, 13, { fixedStart: true });
    marker.snippet = { ...marker.snippet, id: "fresh", markerId: "m1" };
    const { result } = buildGeneration(p, s, { from: 0, to: 8 }, { pools: [[marker]], sources: [], context: noMaps });
    const next = applyGeneration(p, result);
    expect(next.bin).toHaveLength(1);
    expect(next.tracks[1].clips.filter((c) => c.start < 8).every((c) => c.snippetId === "existing")).toBe(true);
  });
});
