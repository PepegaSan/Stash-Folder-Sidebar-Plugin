import { describe, expect, it } from "vitest";
import { mulberry32 } from "../src/generator/random";
import { SourceUsage } from "../src/generator/usage";

describe("indexed source usage", () => {
  it("matches raw overlap sums and the exact least-reused start after many overlapping insertions", () => {
    const usage = new SourceUsage();
    const rnd = mulberry32(9);
    const ranges: Array<[number, number]> = [];
    const overlap = (t: number, need: number) => ranges.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, t + need) - Math.max(a, t)), 0);
    for (let i = 0; i < 100; i++) {
      const a = Math.floor(rnd() * 90), b = a + 1 + Math.floor(rnd() * 20);
      usage.add("s", a, b - a);
      ranges.push([a, b]);
      for (let j = 0; j < 3; j++) {
        const lo = rnd() * 30, hi = 60 + rnd() * 30, need = 1 + rnd() * 15;
        const t = lo + rnd() * (hi - lo - need);
        expect(usage.overlap("s", t, need)).toBeCloseTo(overlap(t, need), 7);
        expect(usage.fresh("s", t, need)).toBe(overlap(t, need) < 1e-9);
        expect(usage.hasFree("s", lo, hi, need)).toBe(usage.free("s", lo, hi, need).length > 0);
        const start = usage.pick("s", lo, hi, need, rnd);
        expect(start).toBeGreaterThanOrEqual(lo);
        expect(start + need).toBeLessThanOrEqual(hi + 1e-9);
        const candidates = [lo, hi - need, ...ranges.flatMap(([a, b]) => [a, b, a - need, b - need])].filter((x) => x >= lo && x <= hi - need);
        expect(overlap(start, need)).toBeCloseTo(Math.min(...candidates.map((x) => overlap(x, need))), 7);
      }
    }
    expect(usage.overlap("other", 0, 100)).toBe(0);
    expect(usage.fresh("other", 0, 100)).toBe(true);
  });

  it("handles adjacent ranges, exact fits, repeated full coverage and changing slot lengths", () => {
    const usage = new SourceUsage();
    usage.add("s", 10, 5);
    usage.add("s", 20, 5);
    expect(usage.free("s", 10, 25, 5)).toEqual([[15, 15]]);
    usage.add("s", 15, 5);
    expect(usage.hasFree("s", 10, 25, 5)).toBe(false);
    for (let i = 0; i < 1000; i++) usage.add("s", 10, 15);
    expect(usage.overlap("s", 11, 2)).toBe(2002);
    const start = usage.pick("s", 10, 25, 15, mulberry32(1));
    expect(start).toBe(10);
    expect(usage.pick("s", 10, 25, 2, mulberry32(1))).toBeGreaterThanOrEqual(10);
  });
});
