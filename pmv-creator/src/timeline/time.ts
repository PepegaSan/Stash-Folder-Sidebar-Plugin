import type { BeatGrid } from "../model/project";

export const EPS = 1e-6;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Absolute positions are quantised (not durations), so rounding never accumulates into drift. */
export const toFrame = (t: number, fps: number): number => Math.round(t * fps);

export const beatLength = (g: BeatGrid): number => 60 / g.bpm;
export const beatIndexAt = (t: number, g: BeatGrid): number => (t - g.offset) / beatLength(g);
export const timeOfBeat = (beat: number, g: BeatGrid): number => g.offset + beat * beatLength(g);

/** `division` is measured in beats: 4 = bar (4/4), 1 = beat, 0.5 = eighth, 0.25 = sixteenth. */
export function nearestGridTime(t: number, g: BeatGrid, division: number): number {
  const step = beatLength(g) * division;
  return g.offset + Math.round((t - g.offset) / step) * step;
}

export function formatTime(t: number): string {
  const sign = t < 0 ? "-" : "";
  const a = Math.abs(t);
  const m = Math.floor(a / 60);
  const s = a - m * 60;
  return `${sign}${m}:${s.toFixed(3).padStart(6, "0")}`;
}

/** 1-based "bar.beat.sixteenth" like most DAWs. */
export function formatBarBeat(t: number, g: BeatGrid): string {
  const sixteenths = Math.floor(beatIndexAt(t, g) * 4 + EPS);
  const perBar = g.beatsPerBar * 4;
  const bar = Math.floor(sixteenths / perBar);
  const rest = sixteenths - bar * perBar;
  return `${bar + 1}.${Math.floor(rest / 4) + 1}.${(rest % 4) + 1}`;
}

export interface SnapOptions {
  grid: BeatGrid | null;
  division: number;
  points: number[];
  /** Seconds. */
  threshold: number;
}

export function snapTime(t: number, o: SnapOptions): number {
  let best = t;
  let bestDist = o.threshold;
  for (const p of o.points) {
    const d = Math.abs(p - t);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  if (o.grid) {
    const g = nearestGridTime(t, o.grid, o.division);
    if (Math.abs(g - t) < bestDist) best = g;
  }
  return best;
}

/** Snaps whichever edge of [start, start+duration) is closer to a snap target. Returns the new start. */
export function snapRange(start: number, duration: number, o: SnapOptions): number {
  const s = snapTime(start, o);
  const e = snapTime(start + duration, o);
  const ds = s === start ? Infinity : Math.abs(s - start);
  const de = e === start + duration ? Infinity : Math.abs(e - start - duration);
  if (ds === Infinity && de === Infinity) return start;
  return ds <= de ? s : e - duration;
}
