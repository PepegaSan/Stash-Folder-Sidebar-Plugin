/**
 * "Cuts like another PMV": measures a PMV from the library for its cuts and flashes. The backend decodes it into
 * small gray frames (op gray_frames, 30 s per piece, two pieces per call); the cuts are found in the browser
 * (generator/template.ts). Results are remembered per browser.
 */
import { decodeGrayFrames } from "../../generator/motion";
import { type TimedFrame, detectCuts } from "../../generator/template";
import { t } from "../../i18n";
import { grayFrames } from "../../stash/backend";

const PIECE = 30;
const PER_CALL = 2;
const FPS = 30;
/** Longer videos are no PMVs (and would be a lot of frames). */
export const MAX_TEMPLATE_SECONDS = 20 * 60;
const CACHE_V = 1;

export interface TemplateScan {
  duration: number;
  cuts: number[];
  flashes: number[];
}

export async function scanCutTemplate(scene: { id: string; path: string; duration: number }, status: (text: string) => void): Promise<TemplateScan> {
  const key = `pmv-creator:cuts:${CACHE_V}:${scene.id}:${scene.duration.toFixed(1)}`;
  try {
    const hit = localStorage.getItem(key);
    if (hit) return JSON.parse(hit) as TemplateScan;
  } catch {
    /* storage blocked */
  }
  if (!(scene.duration > 1)) throw new Error(t("The video has no length – is it scanned in Stash?"));
  if (scene.duration > MAX_TEMPLATE_SECONDS) throw new Error(t("Longer than 20 minutes – that is no PMV."));
  const pieces = Math.ceil(scene.duration / PIECE);
  const frames: TimedFrame[] = [];
  let size: [number, number] = [0, 0];
  for (let k = 0; k < pieces; k += PER_CALL) {
    status(t("Looking through the PMV: {s} of {d} s…", { s: Math.round(k * PIECE), d: Math.round(scene.duration) }));
    const ks = Array.from({ length: Math.min(PER_CALL, pieces - k) }, (_, i) => k + i);
    const res = await grayFrames(ks.map((n) => ({ key: `p${n}`, path: scene.path, start: n * PIECE, duration: Math.min(PIECE, scene.duration - n * PIECE), fps: FPS })));
    for (const n of ks) {
      const r = res[`p${n}`];
      if (!r || r.error) throw new Error(r?.error ?? t("The backend did not answer."));
      const g = decodeGrayFrames(r.data, r.w, r.h, r.fps, r.t0);
      size = [g.w, g.h];
      g.frames.forEach((px, i) => frames.push({ t: g.t0 + i / g.fps, px }));
    }
  }
  if (frames.length < 10) throw new Error(t("Too few frames read – is this a video?"));
  const found = detectCuts(frames, size[0], size[1]);
  const out: TemplateScan = { duration: scene.duration, cuts: found.cuts.map(round3), flashes: found.flashes.map(round3) };
  try {
    localStorage.setItem(key, JSON.stringify(out));
  } catch {
    /* quota */
  }
  return out;
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
