/**
 * Generator stage "cutting": beats with energy and drops -> beat-aligned slots.
 * Pace table, energy thresholds, drop rule and bar-grid cutting follow the Pepega PMV Generator.
 */
import type { AudioTrack, BeatGrid } from "../model/project";
import { EPS, beatIndexAt, beatLength, clamp, timeOfBeat } from "../timeline/time";

export interface BeatInfo {
  t: number;
  /** Normalised loudness of this beat, 0..1 (0.5 without music). */
  e: number;
  /** Position in the bar (0 = the "one"). */
  pos: number;
  downbeat: boolean;
  /** First beat of a 4-bar phrase. */
  phrase: boolean;
  drop: boolean;
}

/** Raw loudness (RMS of waveform peaks) of the timeline range [t0, t1). */
export type EnergyFn = (t0: number, t1: number) => number;

export function peaksEnergy(peaks: Float32Array, peaksPerSecond: number, audio: Pick<AudioTrack, "start" | "sourceIn">): EnergyFn {
  return (t0, t1) => {
    const i0 = Math.max(0, Math.floor((t0 - audio.start + audio.sourceIn) * peaksPerSecond));
    const i1 = Math.min(peaks.length, Math.ceil((t1 - audio.start + audio.sourceIn) * peaksPerSecond));
    if (i1 <= i0) return 0;
    let s = 0;
    for (let i = i0; i < i1; i++) s += peaks[i] * peaks[i];
    return Math.sqrt(s / (i1 - i0));
  };
}

/** Beats in [from, to). Energy is relative to the range (10th..90th percentile -> 0..1), so quiet songs still vary. */
export function analyzeBeats(grid: BeatGrid, from: number, to: number, energy?: EnergyFn): BeatInfo[] {
  const beat = beatLength(grid);
  const bpb = grid.beatsPerBar;
  const raw = beatIndexAt(from, grid);
  const idx: number[] = [];
  for (let b = Math.abs(raw - Math.round(raw)) < 1e-6 ? Math.round(raw) : raw; timeOfBeat(b, grid) < to - EPS; b = Math.floor(b + 1 + 1e-9)) idx.push(b);
  // less than half a beat before the first full one joins it – no cut a few milliseconds into the range
  const lead = idx.length > 1 && idx[1] - idx[0] < 0.5;
  if (lead) idx.shift();
  const at = (i: number) => (i === 0 && lead ? from : timeOfBeat(idx[i], grid));

  const rawE = idx.map((b, i) => (energy ? energy(at(i), timeOfBeat(b, grid) + beat) : 0));
  const sorted = [...rawE].sort((a, b) => a - b);
  const lo = sorted[Math.floor(0.1 * (sorted.length - 1))] ?? 0;
  const hi = sorted[Math.floor(0.9 * (sorted.length - 1))] ?? 0;
  const norm = (v: number) => (energy && hi - lo > 1e-9 ? clamp((v - lo) / (hi - lo), 0, 1) : 0.5);

  let lastDrop = -Infinity;
  return idx.map((b, i) => {
    const pos = (((b % bpb) + bpb) % bpb + 1e-9) % bpb;
    const downbeat = pos < 1e-6;
    const e = norm(rawE[i]);
    // a drop: clearly louder than a bar ago, loud, and not right after the last one
    const drop = !!energy && i >= 4 && e - norm(rawE[i - 4]) > 0.35 && e > 0.6 && i - lastDrop >= 16;
    if (drop) lastDrop = i;
    return { t: at(i), e, pos, downbeat, phrase: downbeat && Math.round(b / bpb) % 4 === 0, drop };
  });
}

/**
 * auto    – cut length follows the energy: calm · medium · loud = PACE[pace] beats
 * fixed   – a cut every `every` beats
 * pattern – beat lengths cycled ([4, 2, 2]); fractions allowed (0.5 = eighths)
 * template – the cuts of another PMV (project.cutTemplate, see template.ts)
 */
export type CutMode = "auto" | "fixed" | "pattern" | "template";
export type Pace = "slow" | "normal" | "fast";
export const PACE: Record<Pace, [number, number, number]> = { slow: [8, 4, 2], normal: [4, 2, 1], fast: [2, 1, 1] };

export interface CutOptions {
  mode: CutMode;
  pace: Pace;
  every: number;
  pattern: number[];
  /** Cuts sit on the bar grid (every beat, beats 1 and 3, or the "one") instead of "N beats after the last cut". */
  onGrid: boolean;
  /** A clip stays at least / at most this many beats (0 = off). */
  minBeats: number;
  maxBeats: number;
}

export interface Slot {
  start: number;
  duration: number;
  energy: number;
  downbeat: boolean;
  phrase: boolean;
  drop: boolean;
  /** Position of the slot in the generated range, 0..1. */
  progress: number;
  /** The template PMV flashes here. */
  flash?: boolean;
}

const beatIndexAtTime = (beats: BeatInfo[], t: number): number => {
  let lo = 0;
  let hi = beats.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (beats[mid].t <= t + EPS) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

export function planCuts(beats: BeatInfo[], grid: BeatGrid, from: number, to: number, o: CutOptions): Slot[] {
  if (!beats.length || to <= from + EPS) return [];
  const starts: number[] = [];

  if (o.mode === "pattern") {
    const pattern = o.pattern.filter((x) => x > 0);
    starts.push(beats[0].t);
    // counted from the first full beat, so a range that starts between beats keeps its cuts on the grid
    let b = Math.ceil(beatIndexAt(beats[0].t, grid) - 1e-6);
    for (let k = 0; ; k++) {
      b += pattern.length ? pattern[k % pattern.length] : 2;
      if (timeOfBeat(b, grid) >= to - EPS) break;
      starts.push(timeOfBeat(b, grid));
    }
  } else {
    const bpb = grid.beatsPerBar;
    let last = 0;
    starts.push(beats[0].t);
    for (let k = 1; k < beats.length; k++) {
      const B = beats[k];
      const held = k - last;
      const every = o.mode === "auto" ? PACE[o.pace][B.e > 0.72 ? 2 : B.e > 0.4 ? 1 : 0] : Math.max(1, Math.round(o.every));
      let cut: boolean;
      if (o.onGrid && bpb % every === 0) cut = B.pos % every < 1e-6 && held >= Math.min(every, 2);
      else if (o.onGrid && every % bpb === 0) cut = B.downbeat && held >= every * 0.75;
      else cut = held >= every;
      if (B.drop && held >= Math.max(1, o.minBeats)) cut = true;
      if (o.maxBeats > 0 && held >= o.maxBeats) cut = true;
      if (o.minBeats > 0 && held < o.minBeats) cut = false;
      if (cut) {
        starts.push(B.t);
        last = k;
      }
    }
  }

  const span = to - from;
  return starts
    .map((start, i) => {
      const end = Math.min(starts[i + 1] ?? to, to);
      const B = beats[beatIndexAtTime(beats, start)];
      const onBeat = Math.abs(B.t - start) < EPS;
      return {
        start,
        duration: end - start,
        energy: B.e,
        downbeat: onBeat && B.downbeat,
        phrase: onBeat && B.phrase,
        drop: onBeat && B.drop,
        progress: clamp((start - from) / span, 0, 1),
      };
    })
    .filter((s) => s.duration > EPS);
}

/** Tag stages: 1…n-1 share the song up to the finale (last tenth); the last plays on drops (two bars) and in the finale. */
export function assignStages(slots: Slot[], stages: number, beatLen: number): number[] {
  if (stages < 2) return slots.map(() => 0);
  let dropUntil = -Infinity;
  return slots.map((s) => {
    if (s.drop) dropUntil = s.start + 8 * beatLen;
    if (s.start < dropUntil - EPS || s.progress >= 0.9) return stages - 1;
    return Math.min(stages - 2, Math.floor((s.progress / 0.9) * (stages - 1)));
  });
}
