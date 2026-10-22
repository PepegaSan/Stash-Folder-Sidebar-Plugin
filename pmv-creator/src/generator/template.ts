/**
 * "Cuts like another PMV" – Pepega's "PMV as template" without split screens: the cuts and flashes of an existing
 * PMV are measured in its small gray frames (backend op gray_frames, the same pictures as the motion analysis) and
 * become the generator's slots. The cut rule is Pepega's (pmvscan.js). Flashes differ: Pepega counts a jump to a bright
 * picture, which a cut to a bright clip also is – here a flash is a short, nearly uniform bright picture.
 */
import type { BeatGrid, CutTemplate } from "../model/project";
import { EPS, beatIndexAt, clamp, timeOfBeat } from "../timeline/time";
import type { BeatInfo, Slot } from "./rhythm";

export interface TimedFrame {
  t: number;
  px: Uint8Array;
}

/** A flash: frames at least this bright (0..1; pink flashes too) … */
const FLASH_LUMA = 0.45;
/** … and this flat (standard deviation of the brightness, 0..1) … */
const FLASH_FLAT = 0.08;
/** … for at most this long (s) – longer is a white scene. */
const FLASH_MAX = 0.5;
/** Frames before/after a flash that fade into/out of it – no cut is looked for there. */
const FLASH_FADE = 3;
/** A cut: the largest region difference is above max(CUT_FLOOR, CUT_FACTOR × the median of the last 12 overall ones). */
const CUT_FLOOR = 0.09;
const CUT_FACTOR = 3.2;
const RECENT = 12;
/** Two cuts at least this far apart (s). */
const MIN_GAP = 0.15;
/** A cut or flash this close to a beat lands on it (s). */
const SNAP = 0.08;

/** Mean absolute difference (0..1) per region: all, column thirds/halves, quadrants, row thirds. */
function regionDiffs(a: Uint8Array, b: Uint8Array, w: number, h: number): { all: number; max: number } {
  const sums = new Float64Array(13);
  const counts = new Float64Array(13);
  for (let y = 0; y < h; y++) {
    const r3 = Math.min(2, Math.floor((y * 3) / h));
    const r2 = y * 2 < h ? 0 : 1;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = Math.abs(a[i] - b[i]) / 255;
      const c3 = Math.min(2, Math.floor((x * 3) / w));
      const c2 = x * 2 < w ? 0 : 1;
      for (const k of [0, 1 + c3, 4 + c2, 6 + r2 * 2 + c2, 10 + r3]) {
        sums[k] += d;
        counts[k]++;
      }
    }
  }
  let max = 0;
  for (let k = 0; k < 13; k++) if (counts[k]) max = Math.max(max, sums[k] / counts[k]);
  return { all: counts[0] ? sums[0] / counts[0] : 0, max };
}

/** Brightness and its standard deviation, 0..1. */
function lumaStats(px: Uint8Array): { luma: number; std: number } {
  if (!px.length) return { luma: 0, std: 0 };
  let s = 0;
  for (let i = 0; i < px.length; i++) s += px[i];
  const m = s / px.length;
  let v = 0;
  for (let i = 0; i < px.length; i++) v += (px[i] - m) ** 2;
  return { luma: m / 255, std: Math.sqrt(v / px.length) / 255 };
}

/** Cut and flash times of a PMV from its frames (in time order, all of the same size). */
export function detectCuts(frames: TimedFrame[], w: number, h: number): { cuts: number[]; flashes: number[] } {
  const flashes: number[] = [];
  const flash = frames.map(() => false);
  const stats = frames.map((f) => lumaStats(f.px));
  const flat = stats.map((s) => s.luma >= FLASH_LUMA && s.std <= FLASH_FLAT);
  // a run of flat bright frames is one flash (at its brightest frame); the fade in and out belongs to it
  for (let i = 0; i < frames.length; ) {
    if (!flat[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < frames.length && flat[j + 1]) j++;
    if (frames[j].t - frames[i].t <= FLASH_MAX) {
      let peak = i;
      for (let k = i; k <= j; k++) if (stats[k].luma > stats[peak].luma) peak = k;
      flashes.push(frames[peak].t);
      for (let k = Math.max(0, i - FLASH_FADE); k <= Math.min(frames.length - 1, j + FLASH_FADE); k++) flash[k] = true;
    }
    i = j + 1;
  }
  const cuts: number[] = [];
  const recent: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const d = regionDiffs(frames[i].px, frames[i - 1].px, w, h);
    if (!flash[i] && !flash[i - 1]) {
      const sorted = [...recent].sort((a, b) => a - b);
      const local = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0.02;
      const t = frames[i].t;
      if (d.max > Math.max(CUT_FLOOR, local * CUT_FACTOR) && (!cuts.length || t - cuts[cuts.length - 1] > MIN_GAP)) cuts.push(t);
    }
    recent.push(d.all);
    if (recent.length > RECENT) recent.shift();
  }
  return { cuts, flashes };
}

/** A time on the nearest beat when one is within 80 ms. */
export function snapToBeat(t: number, grid: BeatGrid): number {
  const b = timeOfBeat(Math.round(beatIndexAt(t, grid)), grid);
  return Math.abs(b - t) <= SNAP ? b : t;
}

/**
 * Where the template's time 0 lies on the timeline: where its own sound starts when that is the project music,
 * otherwise at the start of the generated range (a song of your own: its cuts start with it).
 */
export function templateShift(tpl: CutTemplate, audio: { name: string; start: number; sourceIn: number } | null, from: number): number {
  return tpl.music && audio && audio.name === tpl.music ? audio.start - audio.sourceIn : from;
}

/**
 * Slots between the template's cuts (and flashes, which hide a cut) in [from, to): snapped to the beat, at least
 * `minLen` long; energy, drop and bar position from the beats, `flash` where the original flashes.
 */
export function templateSlots(beats: BeatInfo[], grid: BeatGrid, from: number, to: number, cuts: number[], flashes: number[], minLen = 0.1): Slot[] {
  if (to <= from + EPS) return [];
  const snapped = (list: number[]) => list.map((t) => snapToBeat(t, grid));
  const fl = snapped(flashes);
  const points = [...snapped(cuts), ...fl].filter((t) => t > from + minLen - EPS && t < to - minLen + EPS).sort((a, b) => a - b);
  const starts = [from];
  for (const t of points) if (t - starts[starts.length - 1] >= minLen - EPS) starts.push(t);
  const span = to - from;
  const beatAt = (t: number): BeatInfo | null => {
    let best: BeatInfo | null = null;
    for (const b of beats) {
      if (b.t > t + SNAP) break;
      best = b;
    }
    return best;
  };
  return starts.map((start, i) => {
    const end = starts[i + 1] ?? to;
    const B = beatAt(start);
    const onBeat = !!B && Math.abs(B.t - start) <= SNAP;
    return {
      start,
      duration: end - start,
      energy: B?.e ?? 0.5,
      downbeat: onBeat && !!B?.downbeat,
      phrase: onBeat && !!B?.phrase,
      drop: onBeat && !!B?.drop,
      progress: clamp((start - from) / span, 0, 1),
      flash: fl.some((f) => Math.abs(f - start) < minLen),
    };
  });
}
