/** Source ranges used across the whole PMV, including the other split-screen fields. */
import { EPS } from "../timeline/time";

type Range = [number, number];

interface Usage {
  occupied: Range[];
  points: number[];
  changes: number[];
  areas: number[];
  depths: number[];
  dirty: boolean;
}

const lowerBound = (xs: number[], t: number): number => {
  let lo = 0, hi = xs.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (xs[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

function changeAt(u: Usage, t: number, delta: number): void {
  const i = lowerBound(u.points, t);
  if (u.points[i] === t) {
    u.changes[i] += delta;
    if (u.changes[i] === 0) { u.points.splice(i, 1); u.changes.splice(i, 1); }
  } else { u.points.splice(i, 0, t); u.changes.splice(i, 0, delta); }
  u.dirty = true;
}

/** Integral of the reuse depth: built once after an insertion, queried without rescanning old clips. */
function index(u: Usage): void {
  if (!u.dirty) return;
  let area = 0, depth = 0;
  for (let i = 0; i < u.points.length; i++) {
    if (i) area += (u.points[i] - u.points[i - 1]) * depth;
    u.areas[i] = area;
    depth += u.changes[i];
    u.depths[i] = depth;
  }
  u.dirty = false;
}

const areaAt = (u: Usage, t: number, i: number): number => i < 0 ? 0 : u.areas[i] + (t - u.points[i]) * u.depths[i];

export class SourceUsage {
  private scenes = new Map<string, Usage>();

  add(sceneId: string, start: number, length: number): void {
    if (!(length > 0)) return;
    let u = this.scenes.get(sceneId);
    if (!u) {
      u = { occupied: [], points: [], changes: [], areas: [], depths: [], dirty: true };
      this.scenes.set(sceneId, u);
    }
    const end = start + length;
    // Merge occupied ranges. Once the source is full this stays a single interval, regardless of clip count.
    let first = 0;
    while (first < u.occupied.length && u.occupied[first][1] < start) first++;
    let last = first, a = start, b = end;
    while (last < u.occupied.length && u.occupied[last][0] <= b) {
      a = Math.min(a, u.occupied[last][0]); b = Math.max(b, u.occupied[last][1]); last++;
    }
    u.occupied.splice(first, last - first, [a, b]);
    changeAt(u, start, 1);
    changeAt(u, end, -1);
  }

  /** Legal start windows whose entire clip is still unused. */
  free(sceneId: string, lo: number, hi: number, need: number): Range[] {
    const out: Range[] = [];
    let cursor = lo;
    for (const [a, b] of this.scenes.get(sceneId)?.occupied ?? []) {
      if (b <= cursor) continue;
      if (a >= hi) break;
      if (a - cursor >= need - EPS) out.push([cursor, Math.max(cursor, a - need)]);
      cursor = Math.max(cursor, b);
    }
    if (hi - cursor >= need - EPS) out.push([cursor, Math.max(cursor, hi - need)]);
    return out;
  }

  overlap(sceneId: string, start: number, need: number): number {
    const u = this.scenes.get(sceneId);
    if (!u) return 0;
    index(u);
    return areaAt(u, start + need, lowerBound(u.points, start + need) - 1) - areaAt(u, start, lowerBound(u.points, start) - 1);
  }

  /** Freshness needs only the merged union, not the weighted history. */
  fresh(sceneId: string, start: number, need: number): boolean {
    const ranges = this.scenes.get(sceneId)?.occupied ?? [];
    let lo = 0, hi = ranges.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (ranges[mid][1] <= start + EPS) lo = mid + 1;
      else hi = mid;
    }
    return lo === ranges.length || ranges[lo][0] >= start + need - EPS;
  }

  hasFree(sceneId: string, lo: number, hi: number, need: number): boolean {
    let cursor = lo;
    for (const [a, b] of this.scenes.get(sceneId)?.occupied ?? []) {
      if (b <= cursor) continue;
      if (a >= hi) break;
      if (a - cursor >= need - EPS) return true;
      cursor = Math.max(cursor, b);
    }
    return hi - cursor >= need - EPS;
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
    let best = lo + rnd() * (end - lo);
    const u = this.scenes.get(sceneId);
    if (!u) return best;
    index(u);
    let low = this.overlap(sceneId, best, need);
    // The two sorted breakpoint streams (t and t - need) are merged in one sweep.
    // Both integral cursors only move forward: O(boundaries), not O(old clips × boundaries).
    let left = lowerBound(u.points, lo), right = lowerBound(u.points, lo + need);
    let a = left - 1, b = right - 1;
    let t = lo;
    for (;;) {
      while (a + 1 < u.points.length && u.points[a + 1] <= t) a++;
      while (b + 1 < u.points.length && u.points[b + 1] <= t + need) b++;
      const cost = areaAt(u, t + need, b) - areaAt(u, t, a);
      if (cost < low - EPS) [best, low] = [t, cost];
      if (t >= end) break;
      const nextLeft = u.points[left] ?? Infinity;
      const nextRight = right < u.points.length ? u.points[right] - need : Infinity;
      const next = Math.min(nextLeft, nextRight);
      if (nextLeft <= nextRight) left++;
      if (nextRight <= nextLeft) right++;
      t = Math.min(end, Math.max(t, next));
    }
    return best;
  }
}
