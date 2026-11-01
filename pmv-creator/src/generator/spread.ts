/** Temporal variety: balance sections of a long source and avoid its last neighbourhood. */
import type { MaterialItem } from "./material";
import type { SourceUsage } from "./usage";
import { EPS } from "../timeline/time";

type Window = [number, number];
const SECTIONS = 12;
const JUMP = 0.18;
interface SceneSpread { from: number; to: number; load: number[]; last: number | null }

export class SourceSpread {
  private scenes = new Map<string, SceneSpread>();

  constructor(items: MaterialItem[]) {
    for (const { snippet: s } of items) {
      const state = this.scenes.get(s.sceneId);
      if (state) { state.from = Math.min(state.from, s.in); state.to = Math.max(state.to, s.out); }
      else this.scenes.set(s.sceneId, { from: s.in, to: s.out, load: Array(SECTIONS).fill(0), last: null });
    }
  }

  record(sceneId: string, t: number, need: number): void {
    const s = this.scenes.get(sceneId);
    if (!s) return;
    const i = Math.max(0, Math.min(SECTIONS - 1, Math.floor((t - s.from) / Math.max(EPS, s.to - s.from) * SECTIONS)));
    s.load[i] += need;
    s.last = t;
  }

  /** Fresh start windows in a lightly used, distant section; bounded to twelve section checks. */
  windows(sceneId: string, lo: number, hi: number, need: number, usage: SourceUsage, rnd: () => number, measured: number[] = []): Window[] {
    const s = this.scenes.get(sceneId);
    let free = usage.free(sceneId, lo, hi, need);
    if (!s || !free.length) return free;
    const span = s.to - s.from;
    if (s.last !== null) {
      const left = s.last - span * JUMP, right = s.last + span * JUMP;
      const distant: Window[] = [];
      for (const [a, b] of free) {
        if (a <= left) distant.push([a, Math.min(b, left)]);
        if (b >= right) distant.push([Math.max(a, right), b]);
      }
      if (distant.length) free = distant;
    }
    const candidates: Array<{ windows: Window[]; load: number; measured: boolean }> = [];
    for (let i = 0; i < SECTIONS; i++) {
      const a = s.from + span * i / SECTIONS, b = s.from + span * (i + 1) / SECTIONS;
      const windows = free.flatMap(([x, y]): Window[] => {
        const from = Math.max(a, x), to = Math.min(b, y);
        return to >= from ? [[from, to]] : [];
      });
      if (!windows.length) continue;
      candidates.push({ windows, load: s.load[i], measured: windows.some(([a, b]) => measured.some((t) => t >= a && t <= b)) });
    }
    const mapped = candidates.filter((c) => c.measured);
    const eligible = mapped.length ? mapped : candidates;
    const lowest = Math.min(...eligible.map((c) => c.load));
    const choices = eligible.filter((c) => c.load <= lowest + EPS).map((c) => c.windows);
    return choices.length ? choices[Math.floor(rnd() * choices.length)] : free;
  }
}

export function drawStart(windows: Window[], rnd: () => number): number {
  const width = windows.reduce((sum, [a, b]) => sum + b - a, 0);
  if (width <= EPS) return windows[Math.floor(rnd() * windows.length)][0];
  let t = rnd() * width;
  for (const [a, b] of windows) { if (t <= b - a) return a + t; t -= b - a; }
  return windows[windows.length - 1][1];
}
