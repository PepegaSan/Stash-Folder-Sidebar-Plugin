/** Source ranges used across the whole PMV, including the other split-screen fields. */
import { EPS } from "../timeline/time";

type Range = [number, number];

export class SourceUsage {
  private ranges = new Map<string, Range[]>();

  add(sceneId: string, start: number, length: number): void {
    const ranges = this.ranges.get(sceneId) ?? [];
    ranges.push([start, start + length]);
    ranges.sort((a, b) => a[0] - b[0]);
    this.ranges.set(sceneId, ranges);
  }

  /** Legal start windows whose entire clip is still unused. */
  free(sceneId: string, lo: number, hi: number, need: number): Range[] {
    const out: Range[] = [];
    let cursor = lo;
    for (const [a, b] of this.ranges.get(sceneId) ?? []) {
      if (b <= cursor) continue;
      if (a >= hi) break;
      if (a - cursor >= need - EPS) out.push([cursor, Math.max(cursor, a - need)]);
      cursor = Math.max(cursor, b);
    }
    if (hi - cursor >= need - EPS) out.push([cursor, Math.max(cursor, hi - need)]);
    return out;
  }

  overlap(sceneId: string, start: number, need: number): number {
    let sum = 0;
    for (const [a, b] of this.ranges.get(sceneId) ?? []) {
      if (a >= start + need) break;
      sum += Math.max(0, Math.min(b, start + need) - Math.max(a, start));
    }
    return sum;
  }

  /** Draw from all free start windows, weighted by their width. Once full, prefer the least reused range. */
  pick(sceneId: string, lo: number, hi: number, need: number, rnd: () => number): number {
    const free = this.free(sceneId, lo, hi, need);
    if (free.length) {
      const total = free.reduce((sum, [a, b]) => sum + b - a, 0);
      if (total <= EPS) return free[Math.floor(rnd() * free.length)][0];
      let draw = rnd() * total;
      for (const [a, b] of free) {
        if (draw <= b - a) return a + draw;
        draw -= b - a;
      }
      return free[free.length - 1][1];
    }
    const end = Math.max(lo, hi - need);
    // Overlap is piecewise linear; its minima lie on these boundaries (or on a flat stretch).
    const candidates = [lo + rnd() * (end - lo), lo, end];
    for (const [a, b] of this.ranges.get(sceneId) ?? []) candidates.push(a - need, a, b - need, b);
    let best = candidates[0];
    let low = Infinity;
    for (const t of new Set(candidates)) {
      if (t < lo || t > end) continue;
      const cost = this.overlap(sceneId, t, need);
      if (cost < low - EPS) [best, low] = [t, cost];
    }
    return best;
  }
}
