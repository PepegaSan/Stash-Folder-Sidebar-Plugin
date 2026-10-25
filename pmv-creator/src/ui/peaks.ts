/**
 * Waveforms of the scenes' sound (clip audio). The backend decodes a file's sound track once to peaks
 * (50 per second, one byte each) and keeps them; this store asks for them on demand, two scenes at a time,
 * and tells every waveform canvas when something arrived. Nothing is asked for until a waveform is wanted
 * (the toggle above the timeline, “Load waveform” in the scene view).
 */
import { useEffect, useState } from "react";
import { audioPeaks } from "../stash/backend";

export type PeaksStatus = "idle" | "queued" | "loading" | "ready" | "none" | "error";

export interface ScenePeaks {
  status: PeaksStatus;
  /** 0–255 per bucket, `pps` buckets per second of the file; null unless ready. */
  peaks: Uint8Array | null;
  pps: number;
  /** The file's loudest bucket (0..1) – the waveforms are drawn relative to it. */
  max: number;
  error?: string;
}

const IDLE: ScenePeaks = { status: "idle", peaks: null, pps: 50, max: 0 };
const MAX_PARALLEL = 2;

const states = new Map<string, ScenePeaks>();
const paths = new Map<string, string>();
const queue: string[] = [];
let running = 0;
let version = 0;
const listeners = new Set<() => void>();

const notify = () => {
  version++;
  listeners.forEach((fn) => fn());
};

export const peaksOf = (sceneId: string): ScenePeaks => states.get(sceneId) ?? IDLE;

export function decodePeaks(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Asks the backend for the scene's peaks unless they are there or on their way. */
export function requestPeaks(sceneId: string, path: string): void {
  const s = peaksOf(sceneId);
  if (s.status !== "idle" && s.status !== "error") return;
  states.set(sceneId, { ...IDLE, status: "queued" });
  paths.set(sceneId, path);
  queue.push(sceneId);
  notify();
  pump();
}

function pump(): void {
  while (running < MAX_PARALLEL && queue.length) {
    const sceneId = queue.shift()!;
    const path = paths.get(sceneId)!;
    running++;
    states.set(sceneId, { ...IDLE, status: "loading" });
    notify();
    audioPeaks(path)
      .then((r) => {
        if (r.hasAudio && r.peaks) {
          const peaks = decodePeaks(r.peaks);
          let max = 0;
          for (let i = 0; i < peaks.length; i++) if (peaks[i] > max) max = peaks[i];
          states.set(sceneId, { status: "ready", peaks, pps: r.pps || 50, max: max / 255 });
        } else {
          states.set(sceneId, { ...IDLE, status: "none" });
        }
      })
      .catch((e: unknown) => {
        states.set(sceneId, { ...IDLE, status: "error", error: String(e) });
      })
      .finally(() => {
        running--;
        notify();
        pump();
      });
  }
}

/** Loudest bucket (0..1) between two source times; 0 outside the file. */
export function peakAt(p: ScenePeaks, t0: number, t1: number): number {
  if (!p.peaks) return 0;
  const i0 = Math.max(0, Math.floor(t0 * p.pps));
  const i1 = Math.min(p.peaks.length, Math.max(i0 + 1, Math.ceil(t1 * p.pps)));
  let m = 0;
  for (let i = i0; i < i1; i++) if (p.peaks[i] > m) m = p.peaks[i];
  return m / 255;
}

/**
 * Height (0..1) to draw for a source time range: the loudest bucket relative to the file's loudest moment, on a
 * 40 dB scale – a quiet recording stays visible, and a slap still stands out from a moan (linear peaks of a quiet
 * camera recording are a few pixels high at best).
 */
export function peakLevel(p: ScenePeaks, t0: number, t1: number): number {
  const v = peakAt(p, t0, t1);
  if (v <= 0 || p.max <= 0) return 0;
  return Math.max(0, 1 + Math.log10(v / p.max) / 2);
}

/** How many scenes are still on their way, of all asked for in this session. */
export function peaksProgress(): { loading: number; total: number } {
  let loading = 0;
  for (const s of states.values()) if (s.status === "queued" || s.status === "loading") loading++;
  return { loading, total: states.size };
}

/** A counter that changes whenever any scene's peaks change – components read the store after it. */
export function usePeaksVersion(): number {
  const [v, setV] = useState(version);
  useEffect(() => {
    const fn = () => setV(version);
    listeners.add(fn);
    fn();
    return () => void listeners.delete(fn);
  }, []);
  return v;
}

export function usePeaks(sceneId: string | null): ScenePeaks {
  usePeaksVersion();
  return sceneId ? peaksOf(sceneId) : IDLE;
}

/** Tests only. */
export function resetPeaks(): void {
  states.clear();
  paths.clear();
  queue.length = 0;
  running = 0;
  notify();
}
