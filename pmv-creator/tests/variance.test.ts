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
  it("alternates distant sections even with only a handful of cuts from a two-hour source", () => {
    const cuts = slots(18, 1);
    const pool = [[item(576, 6624)]];
    for (const seed of [1, 7, 42, 12345]) {
      const clips = fillSlots(project(), cuts, cuts.map(() => 0), pool, options({ seed }), noMaps);
      noOverlap(clips);
      for (let i = 1; i < clips.length; i++) expect(Math.abs(clips[i].sourceIn - clips[i - 1].sourceIn)).toBeGreaterThanOrEqual((6624 - 576) * 0.18 - 1e-6);
      const sections = new Set(clips.map((c) => Math.min(11, Math.floor((c.sourceIn - 576) / (6624 - 576) * 12))));
      expect(sections.size).toBeGreaterThanOrEqual(10);
    }
  });

  it("does not let clustered preview motion points concentrate the start of a long-source PMV", () => {
    const cuts = slots(12, 1);
    const map = [600, 605, 610, 615, 620, 625, 630, 635].map((t) => ({ t, len: 0.75, speed: 10 }));
    const ctx = { speedMaps: { long: map }, speedPct: makePercentile(Array(8).fill(10)) };
    const clips = fillSlots(project(), cuts, cuts.map(() => 0), [[item(576, 6624)]], options({ paceMatch: true }), ctx);
    for (let i = 1; i < clips.length; i++) expect(Math.abs(clips[i].sourceIn - clips[i - 1].sourceIn)).toBeGreaterThanOrEqual((6624 - 576) * 0.18 - 1e-6);
    expect(Math.max(...clips.map((c) => c.sourceIn))).toBeGreaterThan(5500);
  });

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

  it("changes the cut at every slider step with default settings and lowers reuse monotonically from 0 to 100 %", () => {
    // typical material: 8 videos of 10 minutes, 120 cuts of 2 s, random start points, no motion maps
    const cuts = slots(120, 2);
    const pool = [Array.from({ length: 8 }, (_, i) => item(48, 552, `s${i}`))];
    const overlapSec = (clips: Clip[]) => {
      let sum = 0;
      clips.forEach((c, i) => {
        for (const prev of clips.slice(0, i)) {
          if (prev.sceneId !== c.sceneId) continue;
          const o = Math.min(c.sourceIn + c.duration * c.speed, prev.sourceIn + prev.duration * prev.speed) - Math.max(c.sourceIn, prev.sourceIn);
          if (o > 1e-6) sum += o;
        }
      });
      return sum;
    };
    const levels = [0, 5, 25, 50, 75, 95, 100];
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const mean: number[] = [];
    const keys = new Map<number, string[]>();
    for (const variance of levels) {
      let total = 0;
      keys.set(variance, []);
      for (const seed of seeds) {
        const clips = fillSlots(project(), cuts, cuts.map(() => 0), pool, options({ seed, variance }), noMaps);
        expect(clips).toHaveLength(120);
        total += overlapSec(clips);
        keys.get(variance)!.push(clips.map((c) => `${c.sceneId}@${c.sourceIn.toFixed(3)}`).join("|"));
      }
      mean.push(total / seeds.length);
    }
    // 100 %: no reuse at all; 0 %: some; in between it never grows with the slider
    expect(mean[mean.length - 1]).toBe(0);
    expect(mean[0]).toBeGreaterThan(1);
    for (let i = 1; i < mean.length; i++) expect(mean[i]).toBeLessThanOrEqual(mean[i - 1] + 0.5);
    // every step below 100 % gives another cut than 100 % for every seed – a change of the slider is never a no-op
    for (const variance of levels.slice(0, -1)) keys.get(variance)!.forEach((k, i) => expect(k).not.toBe(keys.get(100)![i]));
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
