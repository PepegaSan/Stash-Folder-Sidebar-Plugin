import { describe, expect, it } from "vitest";
import { type FillOptions, fillGroups, fillSlots } from "../src/generator/assemble";
import { defaultSettings } from "../src/generator/generate";
import type { MaterialItem } from "../src/generator/material";
import { makePercentile } from "../src/generator/motion";
import type { Slot } from "../src/generator/rhythm";
import type { Clip } from "../src/model/project";
import { clip, project } from "./helpers";

const item = (a = 144, b = 1656, id = "long"): MaterialItem => ({
  snippet: { id: `${id}_${a}`, sceneId: id, markerId: null, in: a, out: b, label: id, tags: [] },
  performers: [], fixedStart: false,
});
const slots = (count: number, duration = 10): Slot[] => Array.from({ length: count }, (_, i) => ({
  start: i * duration, duration, progress: i / count, energy: 0.5, downbeat: true, phrase: false, drop: false,
}));
const options = (patch: Partial<FillOptions> = {}): FillOptions => ({
  seed: 7, ...defaultSettings("t").select, ...defaultSettings("t").style, ...patch,
});
const noMaps = { speedMaps: {}, speedPct: () => null };
const noOverlap = (clips: Clip[]) => {
  for (const [i, c] of clips.entries()) for (const prev of clips.slice(0, i)) {
    if (prev.sceneId !== c.sceneId) continue;
    const overlap = Math.min(c.sourceIn + c.duration * c.speed, prev.sourceIn + prev.duration * prev.speed) - Math.max(c.sourceIn, prev.sourceIn);
    expect(overlap).toBeLessThan(1e-6);
  }
};

describe("source variance within one PMV", () => {
  it("takes different 5/10/20-second ranges throughout a 30-minute video, across seeds", () => {
    const cuts = slots(75);
    cuts.forEach((s, i) => { s.duration = [5, 10, 20][i % 3]; });
    for (const seed of [1, 7, 42, 12345]) {
      const clips = fillSlots(project(), cuts, cuts.map(() => 0), [[item()]], options({ seed }), noMaps);
      expect(clips).toHaveLength(75);
      noOverlap(clips);
      expect(Math.min(...clips.map((c) => c.sourceIn))).toBeLessThan(300);
      expect(Math.max(...clips.map((c) => c.sourceIn))).toBeGreaterThan(1400);
      expect(clips.every((c) => c.sourceIn >= 144 && c.sourceIn + c.duration * c.speed <= 1656 + 1e-6)).toBe(true);
    }
  });

  it("escapes the same few preview spots; 0, 50 and 100% increase source diversity", () => {
    const cuts = slots(80, 5);
    const map = [200, 500, 800, 1100].map((t) => ({ t, len: 0.75, speed: 10 }));
    const ctx = { speedMaps: { long: map }, speedPct: makePercentile(Array(8).fill(10)) };
    const run = (variance: number) => fillSlots(project(), cuts, cuts.map(() => 0), [[item()]], options({ paceMatch: true, variance }), ctx);
    const low = run(0), middle = run(50), high = run(100);
    expect(new Set(low.map((c) => c.sourceIn)).size).toBe(4);
    expect(new Set(middle.map((c) => c.sourceIn)).size).toBeGreaterThan(20);
    expect(new Set(middle.map((c) => c.sourceIn)).size).toBeLessThan(80);
    noOverlap(high);
    expect(new Set(high.map((c) => c.sourceIn)).size).toBe(80);
    expect(run(100).map((c) => c.sourceIn)).toEqual(high.map((c) => c.sourceIn));
  });

  it("shares usage across split-screen fields and tag stages, even with duplicate candidates", () => {
    const cuts = slots(50, 5).flatMap((s) => [{ ...s, group: 0 }, { ...s, group: 1 }]);
    const groups = fillGroups(project(), cuts, cuts.map((_, i) => i % 2), [[item()], [item()]], options(), noMaps);
    expect(groups.map((g) => g.length)).toEqual([50, 50]);
    noOverlap(groups.flat());
  });

  it("reserves future pinned source ranges before selecting any clips", () => {
    const cuts = slots(50, 10);
    const pin = clip("long", 490, 10, { sourceIn: 500, speed: 2, pinned: true });
    const clips = fillSlots(project(), cuts, cuts.map(() => 0), [[item()]], options(), noMaps, [pin]);
    expect(clips).toHaveLength(49);
    noOverlap([...clips, pin]);
  });

  it("uses fresh markers before looping an exhausted one, including overlapping markers", () => {
    const cuts = slots(12, 5);
    const markers = [item(100, 110), item(105, 120), item(300, 350)].map((x) => ({ ...x, fixedStart: true }));
    const clips = fillSlots(project(), cuts, cuts.map(() => 0), [markers], options(), noMaps);
    expect(clips).toHaveLength(12);
    noOverlap(clips);
    expect(clips.every((c) => (c.sourceIn >= 100 && c.sourceIn + 5 <= 120) || (c.sourceIn >= 300 && c.sourceIn + 5 <= 350))).toBe(true);
  });

  it("finds fresh material beyond the old 24-candidate lookahead", () => {
    const cuts = slots(2, 5);
    const duplicates = Array.from({ length: 30 }, () => ({ ...item(100, 105), fixedStart: true }));
    const fresh = { ...item(300, 310), fixedStart: true };
    const clips = fillSlots(project(), cuts, [0, 0], [[...duplicates, fresh]], options({ order: "source" }), noMaps);
    expect(clips.map((c) => c.sourceIn)).toEqual([100, 300]);
  });

  it("fills a long PMV from too little material without escaping the selected range", () => {
    const cuts = slots(100, 10);
    const clips = fillSlots(project(), cuts, cuts.map(() => 0), [[item(100, 115)]], options({ speed: 2 }), noMaps);
    expect(clips).toHaveLength(100);
    expect(clips.every((c) => c.duration === 10 && c.speed === 1.5 && c.sourceIn === 100)).toBe(true);
  });

  it("keeps source ranges inside timeline windows and counts speed ramps in reuse checks", () => {
    const cuts = slots(50, 10).map((s, i) => ({ ...s, energy: i % 2 ? 0.8 : 0.2 }));
    const clips = fillSlots(project(), cuts, cuts.map(() => 0), [[item()]], options({ speedRamps: true, followTimeline: true }), noMaps);
    noOverlap(clips);
    expect(clips.every((c) => c.sourceIn >= 144 && c.sourceIn + c.duration * c.speed <= 1656 + 1e-6)).toBe(true);
  });

  it("honours an explicit beginning/continue offset, with source variance independent of scene variety", () => {
    const cuts = slots(10, 5);
    const run = (patch: Partial<FillOptions>) => fillSlots(project(), cuts, cuts.map(() => 0), [[item()]], options(patch), noMaps);
    expect(run({ offset: "start" }).map((c) => c.sourceIn)).toEqual(Array(10).fill(144));
    expect(run({ offset: "continue" }).map((c) => c.sourceIn)).toEqual(Array.from({ length: 10 }, (_, i) => 144 + i * 5));
    noOverlap(run({ variety: false }));
  });
});
