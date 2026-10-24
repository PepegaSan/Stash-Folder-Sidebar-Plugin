/** The generator's split screens (Pepega's layouts): where which layout plays, how its fields are cut, what lands on the tracks. */
import { describe, expect, it } from "vitest";
import { type FillOptions, fillGroups } from "../src/generator/assemble";
import { MOODS, applyGeneration, buildGeneration, defaultSettings, fieldCapacity, withinFields } from "../src/generator/generate";
import { FULL_ONLY, layoutSlots, planLayouts, snapLayouts, withLayouts } from "../src/generator/layouts";
import type { MaterialItem } from "../src/generator/material";
import { analyzeBeats, planCuts } from "../src/generator/rhythm";
import { flattenTimeline } from "../src/timeline/flatten";
import { assertTrackInvariants, clip, project } from "./helpers";

const GRID = { bpm: 120, offset: 0, beatsPerBar: 4 }; // beat = 0.5 s, bar = 2 s, phrase = 8 s
const quietThenLoud = (t0: number) => (t0 < 16 ? 0.1 : 1);
const loudThenQuiet = (t0: number) => (t0 < 16 ? 1 : 0.1);
const noMaps = { speedMaps: {}, speedPct: () => null };
const cut = (o: object = {}) => ({ mode: "fixed" as const, pace: "normal" as const, every: 1, pattern: [], onGrid: true, minBeats: 0, maxBeats: 0, ...o });
const item = (sceneId: string): MaterialItem => ({ snippet: { id: `sn_${sceneId}`, sceneId, markerId: null, in: 0, out: 100, label: sceneId, tags: [] }, performers: [], fixedStart: false });

describe("which layout plays where", () => {
  it("full screen while it is calm, the fullest on the drop, and the same per seed", () => {
    const beats = analyzeBeats(GRID, 0, 32, quietThenLoud);
    const steps = planLayouts(beats, MOODS.classic.style.layouts, 1);
    expect(steps[0]).toEqual({ t: 0, kind: "full" });
    expect(steps[1].t).toBe(16);
    expect(["trim", "tri"]).toContain(steps[1].kind);
    // later changes only at the start of a phrase, never to the same layout
    for (const [k, st] of steps.entries()) if (k > 1) expect([st.t % 8, st.kind !== steps[k - 1].kind]).toEqual([0, true]);
    expect(planLayouts(beats, MOODS.classic.style.layouts, 1)).toEqual(steps);
    // a 4-way is the fullest there is
    expect(planLayouts(beats, withLayouts(["full", "duo", "quad"]), 1)[1]).toEqual({ t: 16, kind: "quad" });
  });

  it("back to full screen when it calms down, at the start of a phrase", () => {
    const steps = planLayouts(analyzeBeats(GRID, 0, 32, loudThenQuiet), withLayouts(["full", "tri"]), 3);
    expect(steps).toEqual([
      { t: 0, kind: "full" },
      { t: 8, kind: "tri" },
      { t: 16, kind: "full" },
    ]);
  });

  it("one layout only: it plays all through", () => {
    expect(planLayouts(analyzeBeats(GRID, 0, 32, quietThenLoud), withLayouts(["quad"]), 1)).toEqual([{ t: 0, kind: "quad" }]);
  });

  it("a layout change is a cut, and the count towards the next one starts there", () => {
    const beats = analyzeBeats(GRID, 0, 16);
    // (bar-grid cuts need two beats since the last one: none at 6)
    const starts = planCuts(beats, GRID, 0, 16, cut({ every: 4 }), [5.5]).map((s) => s.start);
    expect(starts).toEqual([0, 2, 4, 5.5, 8, 10, 12, 14]);
  });

  it("with the cuts of another PMV a change moves to the next cut", () => {
    const slots = [0, 1.2, 3.7, 9].map((start, i, all) => ({ start, duration: (all[i + 1] ?? 12) - start, energy: 0.5, downbeat: false, phrase: false, drop: false, progress: 0 }));
    expect(snapLayouts([{ t: 0, kind: "full" }, { t: 3, kind: "duo" }, { t: 3.5, kind: "tri" }, { t: 8, kind: "full" }], slots)).toEqual([
      { t: 0, kind: "full" },
      { t: 3.7, kind: "tri" },
      { t: 9, kind: "full" },
    ]);
  });
});

describe("the fields of a layout", () => {
  const beats = analyzeBeats(GRID, 0, 8);
  const slots = planCuts(beats, GRID, 0, 8, cut());
  const steps = [
    { t: 0, kind: "full" as const },
    { t: 2, kind: "tri" as const },
    { t: 6, kind: "full" as const },
  ];
  const opts = (o: object = {}) => ({ from: 0, to: 8, dir: "cols" as const, width: 1920, height: 1080, beats, beatLen: 0.5, minBeats: 0, maxBeats: 0, ...o });
  const byGroup = (list: ReturnType<typeof layoutSlots>, g: number) => list.filter((s) => (s.group ?? 0) === g && s.start >= 2 && s.start < 6).map((s) => [s.start, s.duration]);

  it("every field starts with the layout, then they cut in turn – each clip goes on until its field's next cut", () => {
    const out = layoutSlots(slots, steps, opts());
    expect(byGroup(out, 0)).toEqual([
      [2, 0.5],
      [2.5, 1.5],
      [4, 1.5],
      [5.5, 0.5],
    ]);
    expect(byGroup(out, 1)).toEqual([
      [2, 1],
      [3, 1.5],
      [4.5, 1.5],
    ]);
    expect(byGroup(out, 2)).toEqual([
      [2, 1.5],
      [3.5, 1.5],
      [5, 1],
    ]);
    // group 0 (V1) fills the whole range; fields cut hard and know their shape
    expect(out.filter((s) => (s.group ?? 0) === 0).reduce((n, s) => n + s.duration, 0)).toBeCloseTo(8);
    const field = out.find((s) => s.group === 2)!;
    expect(field.hard).toBe(true);
    expect(field.aspect).toBeCloseTo(640 / 1080, 6);
    expect(out.find((s) => s.start === 6)!.hard).toBe(true);
    expect(out.find((s) => s.start === 0.5)!.hard).toBe(false);
  });

  it("shortest clip: a field waits until its clip has been on long enough", () => {
    const out = layoutSlots(slots, steps, opts({ minBeats: 2 }));
    for (const g of [0, 1, 2]) {
      const list = byGroup(out, g);
      for (const [start, duration] of list) if (start + duration < 6 - 1e-6) expect(duration).toBeGreaterThanOrEqual(1 - 1e-6);
    }
  });

  it("longest clip: a field whose clip has been on that long is cut on the next beat", () => {
    const b16 = analyzeBeats(GRID, 0, 16);
    const every4 = planCuts(b16, GRID, 0, 16, cut({ every: 4 }));
    const duo = [{ t: 0, kind: "duo" as const }];
    const longest = (o: object) => Math.max(...layoutSlots(every4, duo, opts({ to: 16, beats: b16, ...o })).map((s) => s.duration));
    expect(longest({})).toBeCloseTo(4);
    expect(longest({ maxBeats: 4 })).toBeLessThanOrEqual(2 + 1e-6);
  });

  it("a narrow field gets the clips whose shape fits it; a clip shape rule wins over variety", () => {
    const p = project();
    p.sources["9"] = { ...p.sources["1"], sceneId: "9", width: 1080, height: 1920 };
    const narrow = [{ start: 0, duration: 1, energy: 0.5, downbeat: true, phrase: true, drop: false, progress: 0, group: 1, aspect: 640 / 1080, hard: true }];
    const fill: FillOptions = { seed: 1, order: "source", offset: "start", variety: true, followTimeline: false, paceMatch: false, speed: 1, speedRamps: false, transitionOn: "none", transitionType: "fade", flashDrops: false };
    const picked = fillGroups(p, narrow, [0], [[item("1"), item("9")]], fill, noMaps);
    expect(picked[1].map((c) => c.sceneId)).toEqual(["9"]);
    expect(picked[0]).toEqual([]);
    const wide = [{ ...narrow[0], group: 0, aspect: undefined, shape: "landscape" as const }];
    expect(fillGroups(p, wide, [0], [[item("9"), item("1")]], fill, noMaps)[0].map((c) => c.sceneId)).toEqual(["1"]);
  });
});

describe("generating split screens", () => {
  const setup = () => {
    const p = project([clip("2", 2, 2)], [clip("1", 40, 4)]);
    p.beatGrid = GRID;
    p.audio = { name: "m", path: "/m.mp3", url: null, duration: 32, sourceIn: 0, start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0 };
    const base = defaultSettings(p.tracks[1].id);
    const s = { ...base, style: { ...base.style, layouts: withLayouts(["full", "tri"]) } };
    const pools = [["1", "2", "3"].map(item)];
    return { p, s, pools };
  };

  it("fills V1 and the tracks above it; the other fields only where the split screens are", () => {
    const { p, s, pools } = setup();
    const userClip = p.tracks[0].clips[0];
    const { result } = buildGeneration(p, s, { from: 0, to: 32 }, { pools, sources: [], energy: quietThenLoud, context: noMaps });
    expect(result.trackId).toBe(p.tracks[1].id);
    expect(result.layouts[0]).toMatchObject({ start: 16, kind: "tri", dir: "cols" });
    expect(result.fields).toHaveLength(2);
    expect(result.fields.flat().every((c) => c.transitionIn === null)).toBe(true);

    const q = applyGeneration(p, result);
    assertTrackInvariants(q);
    expect(q.tracks).toHaveLength(3);
    const [v3, v2, v1] = q.tracks;
    expect(v1.id).toBe(p.tracks[1].id);
    expect(v1.clips.filter((c) => c.start < 32).reduce((n, c) => n + c.duration, 0)).toBeCloseTo(32);
    expect(v1.clips.some((c) => c.start === 40)).toBe(true);
    const inside = (c: { start: number; duration: number }) => q.layouts.some((r) => c.start >= r.start - 1e-6 && c.start + c.duration <= r.start + r.duration + 1e-6);
    expect(v3.clips.length).toBeGreaterThan(0);
    expect(v3.clips.every(inside)).toBe(true);
    // V2's own clip lies outside the split screens and stays
    expect(v2.clips.filter((c) => !inside(c))).toEqual([userClip]);
    // every field shows a clip
    const split = flattenTimeline(q).filter((x) => x.layout);
    expect(split.length).toBeGreaterThan(0);
    expect(split.every((x) => x.layout!.groups.every((g) => g?.clip))).toBe(true);
    // the same scene never fills two fields at once
    for (const x of split) {
      const scenes = x.layout!.groups.map((g) => g!.clip!.sceneId);
      expect(new Set(scenes).size).toBe(scenes.length);
    }
  });

  it("generating full screen again takes the split screens of the range away, with their fields' clips", () => {
    const { p, s, pools } = setup();
    const first = applyGeneration(p, buildGeneration(p, s, { from: 0, to: 32 }, { pools, sources: [], energy: quietThenLoud, context: noMaps }).result);
    const again = { ...s, seed: 2, style: { ...s.style, layouts: FULL_ONLY } };
    const r = buildGeneration(first, again, { from: 0, to: 32 }, { pools, sources: [], energy: quietThenLoud, context: noMaps }).result;
    expect(r.layouts).toEqual([]);
    const q = applyGeneration(first, r);
    assertTrackInvariants(q);
    expect(q.layouts).toEqual([]);
    expect(q.tracks[0].clips).toEqual([]);
    expect(q.tracks[1].clips).toEqual(p.tracks[0].clips);
    expect(q.tracks[2].clips.filter((c) => c.start < 32).reduce((n, c) => n + c.duration, 0)).toBeCloseTo(32);
  });

  it("never the same scene in two fields at once – also when the longest clip cuts fields out of turn", () => {
    for (const n of [4, 6]) {
      for (const seed of [1, 2, 3, 4, 5]) {
        const p = project([], []);
        p.beatGrid = GRID;
        p.audio = { name: "m", path: "/m.mp3", url: null, duration: 64, sourceIn: 0, start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0 };
        const base = defaultSettings(p.tracks[1].id);
        const s = { ...base, seed, cut: { ...base.cut, maxBeats: 2 }, style: { ...base.style, layouts: withLayouts(["quad"]) } };
        const ids = Array.from({ length: n }, (_, i) => String(i + 1));
        const { result } = buildGeneration(p, s, { from: 0, to: 64 }, { pools: [ids.map(item)], sources: [], context: noMaps });
        for (const x of flattenTimeline(applyGeneration(p, result)).filter((y) => y.layout)) {
          const scenes = x.layout!.groups.map((g) => g!.clip!.sceneId);
          expect(new Set(scenes).size, `${n} scenes, seed ${seed}, frame ${x.startFrame}: ${scenes}`).toBe(4);
        }
      }
    }
  });

  it("a locked or hidden field track: only layouts that fit below it, and its split screens stay as they are", () => {
    const { p, s, pools } = setup();
    const duo = { ...s, style: { ...s.style, layouts: withLayouts(["full", "duo"]) } };
    const first = applyGeneration(p, buildGeneration(p, duo, { from: 0, to: 32 }, { pools, sources: [], energy: quietThenLoud, context: noMaps }).result);
    expect(first.layouts.length).toBeGreaterThan(0);
    // V2 (the second field) locked: no 2-way any more, the old ones and V2's clips stay
    const locked = { ...first, tracks: first.tracks.map((x, i) => (i === 0 ? { ...x, locked: true } : x)) };
    expect(fieldCapacity(locked)).toBe(1);
    const r = buildGeneration(locked, { ...duo, seed: 2 }, { from: 0, to: 32 }, { pools, sources: [], energy: quietThenLoud, context: noMaps }).result;
    expect(r.layouts).toEqual([]);
    const q = applyGeneration(locked, r);
    expect(q.layouts).toEqual(first.layouts);
    expect(q.tracks[0].clips).toEqual(first.tracks[0].clips);
    expect(q.tracks[1].clips.filter((c) => c.start < 32).reduce((n, c) => n + c.duration, 0)).toBeCloseTo(32);
    // hidden counts like locked; tracks that are not there yet are added
    const hidden = { ...p, tracks: p.tracks.map((x, i) => (i === 0 ? { ...x, muted: true } : x)) };
    expect(fieldCapacity(hidden)).toBe(1);
    expect(fieldCapacity(p)).toBe(4);
    expect(withinFields(withLayouts(["tri", "kaleido"]), 1)).toEqual(withLayouts(["kaleido"]));
    expect(withinFields(withLayouts(["quad"]), 2)).toEqual(FULL_ONLY);
  });

  it("split screens outside the range stay – unless the track is cleared first", () => {
    const { p, s, pools } = setup();
    const outside = { id: "lay_out", start: 34, duration: 2, kind: "duo" as const, dir: "cols" as const };
    const withOutside = { ...p, layouts: [outside] };
    const build = (o: typeof s) => buildGeneration(withOutside, o, { from: 0, to: 32 }, { pools, sources: [], energy: quietThenLoud, context: noMaps }).result;
    expect(applyGeneration(withOutside, build(s)).layouts.some((x) => x.id === "lay_out")).toBe(true);
    const cleared = applyGeneration(withOutside, build({ ...s, target: { ...s.target, replaceTrack: true } }));
    expect(cleared.layouts.some((x) => x.id === "lay_out")).toBe(false);
    expect(cleared.layouts.length).toBeGreaterThan(0);
  });
});
