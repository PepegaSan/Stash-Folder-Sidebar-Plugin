/**
 * Project -> RenderPlan: a flat list of frame-exact pieces that the Python backend renders one by one
 * (filtergraph per piece) and then joins with the concat demuxer. All timing decisions happen here,
 * the backend only translates pieces into FFmpeg arguments – the effects too: every piece carries what
 * they do in its frames, worked out by the same effectFrame() the preview draws with.
 */
import { type EffectFrame, type EffectTimeline, FX_FONT, TEXT_SECONDS, effectFrame, withStutters } from "../fx/timeline";
import { t } from "../i18n";
import { type ColorGrade, colorGrade } from "../model/look";
import type { FitMode, OutputSettings, PmvProject, TransitionType } from "../model/project";
import { type Segment, flattenTimeline, resolveTransitions, sourceTimeAt } from "../timeline/flatten";

export const RENDER_PLAN_VERSION = 1;
/** A piece with effects is at most this long: its per-frame values become FFmpeg expressions, which must stay short. */
export const MAX_FX_FRAMES = 150;

export interface SourceRef {
  sceneId: string;
  path: string;
  /** Source time of the piece's first frame. */
  in: number;
  speed: number;
  volume: number;
  hasAudio: boolean;
  fit: FitMode;
  label: string;
}

/**
 * What the effects do in a piece. Frame numbers count from the piece's first frame; per-frame lists have one value
 * per frame, windows are [from, to). Shares refer to the picture's width.
 */
export interface PieceFx {
  /** Timeline frame of the piece's first frame – the seed of the shaking and the glitch stripes. */
  at: number;
  /** Zoom per frame (≥ 1, pulse and the margin for the shaking). */
  zoom?: number[];
  /** Shaking: [from, to, amplitude]. */
  shake?: Array<[number, number, number]>;
  /** Colour rush: hue rotation per frame in degrees. */
  hue?: number[];
  /** Echo strength per frame (0 = off). */
  echo?: number[];
  /** Tunnel: [first frame (negative = began before this piece), frames, seconds]. */
  tunnel?: Array<[number, number, number]>;
  glitch?: Array<[number, number]>;
  /** RGB split per frame (0 = off). */
  rgb?: number[];
  invert?: Array<[number, number]>;
  strobe?: Array<[number, number]>;
  /** Words: first frame (negative = began before this piece), size as a share of the picture height. */
  text?: Array<{ word: string; from: number; size: number }>;
}

export type RenderPiece =
  | { kind: "clip"; frames: number; src: SourceRef; fx?: PieceFx }
  | { kind: "black"; frames: number; fx?: PieceFx }
  /** a = outgoing, b = incoming; null = black. */
  | { kind: "xfade"; frames: number; transition: TransitionType; a: SourceRef | null; b: SourceRef | null; fx?: PieceFx };

export interface RenderAudio {
  path: string;
  /** Stash-relative URL of the file – a render helper on a PC fetches the music from there. */
  url?: string;
  sourceIn: number;
  start: number;
  gainDb: number;
  fadeIn: number;
  fadeOut: number;
}

export interface RenderPlan {
  version: number;
  projectId: string;
  projectName: string;
  output: OutputSettings;
  totalFrames: number;
  /** True if any piece uses original clip audio – otherwise pieces are rendered without audio. */
  clipAudio: boolean;
  audio: RenderAudio | null;
  /** The colour look, folded into numbers (absent = the picture stays as it is). */
  grade?: Pick<ColorGrade, "matrix" | "offset" | "layers" | "vignette">;
  /** Stash-relative URL of the text effect's font – a render helper on a PC downloads it from there. */
  fontUrl?: string;
  pieces: RenderPiece[];
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;
const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

/** The effects in frames [from, from + frames) of the timeline; null when none of them does anything there. */
export function pieceFx(tl: EffectTimeline, from: number, frames: number): PieceFx | null {
  const fps = tl.fps;
  const fr: EffectFrame[] = Array.from({ length: frames }, (_, i) => effectFrame(tl, (from + i) / fps));
  const fx: PieceFx = { at: from };
  let any = false;
  const values = (get: (f: EffectFrame) => number, rest: number, digits: number): number[] | undefined => {
    const v = fr.map((f) => round(get(f), digits));
    if (v.every((x) => x === rest)) return undefined;
    any = true;
    return v;
  };
  const runs = <T>(get: (f: EffectFrame) => T | null): Array<[number, number, T]> => {
    const out: Array<[number, number, T]> = [];
    fr.forEach((f, i) => {
      const v = get(f);
      const last = out[out.length - 1];
      if (v === null) return;
      if (last && last[1] === i && last[2] === v) last[1] = i + 1;
      else out.push([i, i + 1, v]);
    });
    return out;
  };
  const windows = (on: (f: EffectFrame) => boolean): Array<[number, number]> | undefined => {
    const w = runs((f) => (on(f) ? true : null)).map(([a, b]): [number, number] => [a, b]);
    if (!w.length) return undefined;
    any = true;
    return w;
  };
  fx.zoom = values((f) => f.zoom, 1, 5);
  const shake = runs((f) => (f.shake > 0 ? round(f.shake, 6) : null));
  if (shake.length) fx.shake = shake;
  if (fr[0].hue !== null) fx.hue = values((f) => f.hue ?? 0, Number.NaN, 3);
  fx.echo = values((f) => f.echo, 0, 4);
  fx.glitch = windows((f) => f.glitch);
  fx.rgb = values((f) => f.rgb, 0, 5);
  fx.invert = windows((f) => f.invert);
  fx.strobe = windows((f) => f.strobe);
  // tunnels and words come as events – their own clocks run on across the pieces
  const overlaps = (start: number, length: number) => start < from + frames && start + length > from;
  const tunnel = tl.tunnels.flatMap((x): Array<[number, number, number]> => {
    const f0 = Math.round(x.t * fps);
    const n = Math.ceil(x.dur * fps - 1e-6);
    return overlaps(f0, n) ? [[f0 - from, n, round(x.dur, 6)]] : [];
  });
  const textFrames = Math.ceil(TEXT_SECONDS * fps - 1e-6);
  const text = tl.texts.flatMap((x) => {
    const f0 = Math.round(x.t * fps);
    return overlaps(f0, textFrames) ? [{ word: x.word, from: f0 - from, size: x.size }] : [];
  });
  if (tunnel.length) fx.tunnel = tunnel;
  if (text.length) fx.text = text;
  if (shake.length || tunnel.length || text.length) any = true;
  for (const k of Object.keys(fx) as Array<keyof PieceFx>) if (fx[k] === undefined) delete fx[k];
  return any ? fx : null;
}

/** Long pieces with effects are cut into several (a clip goes on frame-exactly), each gets its effects. */
function addEffects(pieces: RenderPiece[], tl: EffectTimeline, fps: number): RenderPiece[] {
  const out: RenderPiece[] = [];
  let at = 0;
  for (const piece of pieces) {
    const whole = pieceFx(tl, at, piece.frames);
    if (!whole) out.push(piece);
    else if (piece.kind === "xfade" || piece.frames <= MAX_FX_FRAMES) out.push({ ...piece, fx: whole });
    else {
      for (let off = 0; off < piece.frames; off += MAX_FX_FRAMES) {
        const frames = Math.min(MAX_FX_FRAMES, piece.frames - off);
        const fx = pieceFx(tl, at + off, frames) ?? undefined;
        if (piece.kind === "black") out.push({ kind: "black", frames, ...(fx ? { fx } : {}) });
        else out.push({ kind: "clip", frames, src: { ...piece.src, in: r6(piece.src.in + (off / fps) * piece.src.speed) }, ...(fx ? { fx } : {}) });
      }
    }
    at += piece.frames;
  }
  return out;
}

/** `fx`: the project's effects on its timeline (effectTimeline) – the preview's own, so both show the same. */
export function buildRenderPlan(p: PmvProject, fx: EffectTimeline | null = null): { plan: RenderPlan; warnings: string[] } {
  const fps = p.output.fps;
  const segs = withStutters(flattenTimeline(p), fx, fps);
  const trans = resolveTransitions(p, segs);
  const warnings = new Set<string>();

  const ref = (seg: Segment | undefined, frame: number): SourceRef | null => {
    const clip = seg?.clip;
    if (!seg || !clip) return null;
    const src = p.sources[clip.sceneId];
    if (!src?.path) {
      warnings.add(t("Scene {id}: file path unknown – rendered black", { id: clip.sceneId }));
      return null;
    }
    return {
      sceneId: clip.sceneId,
      path: src.path,
      in: r6(Math.max(0, sourceTimeAt(seg, frame, fps))),
      speed: clip.speed,
      volume: clip.volume,
      hasAudio: src.hasAudio,
      fit: clip.fit ?? p.output.fit,
      label: clip.label || src.title,
    };
  };

  const head = segs.map(() => 0);
  const tail = segs.map(() => 0);
  trans.forEach((t, i) => {
    if (!t) return;
    head[i] = t.after;
    if (i > 0) tail[i - 1] = t.before;
  });
  segs.forEach((seg, i) => {
    const c = seg.clip;
    if (c?.transitionIn && seg.startFrame === seg.clipStartFrame && !trans[i]) {
      warnings.add(t("Transition at {t} s dropped (no material/too short)", { t: (seg.startFrame / fps).toFixed(2) }));
    }
  });

  const pieces: RenderPiece[] = [];
  const push = (piece: RenderPiece) => {
    const last = pieces[pieces.length - 1];
    if (piece.kind === "black" && last?.kind === "black") last.frames += piece.frames;
    else pieces.push(piece);
  };

  segs.forEach((seg, i) => {
    const t = trans[i];
    if (t) {
      const from = seg.startFrame - t.before;
      push({ kind: "xfade", frames: t.before + t.after, transition: t.type, a: ref(segs[i - 1], from), b: ref(seg, from) });
    }
    const bodyStart = seg.startFrame + head[i];
    const bodyEnd = seg.endFrame - tail[i];
    if (bodyEnd <= bodyStart) return;
    const src = ref(seg, bodyStart);
    push(src ? { kind: "clip", frames: bodyEnd - bodyStart, src } : { kind: "black", frames: bodyEnd - bodyStart });
  });

  const uses = (s: SourceRef | null) => !!s && s.volume > 0 && s.hasAudio;
  const clipAudio = pieces.some((x) => (x.kind === "clip" ? uses(x.src) : x.kind === "xfade" ? uses(x.a) || uses(x.b) : false));

  let audio: RenderAudio | null = null;
  if (p.audio?.path) {
    const a = p.audio;
    audio = { path: a.path!, ...(a.url ? { url: a.url } : {}), sourceIn: a.sourceIn, start: a.start, gainDb: a.gainDb, fadeIn: a.fadeIn, fadeOut: a.fadeOut };
  } else if (p.audio) {
    warnings.add(t("The music has no server path – rendering without music"));
  }
  if (!segs.some((s) => s.clip)) warnings.add(t("The timeline has no clips"));
  const look = colorGrade(p.output);
  const all = fx ? addEffects(pieces, fx, fps) : pieces;

  return {
    plan: {
      version: RENDER_PLAN_VERSION,
      projectId: p.id,
      projectName: p.name,
      output: p.output,
      totalFrames: segs.length ? segs[segs.length - 1].endFrame : 0,
      clipAudio,
      audio,
      ...(look ? { grade: { matrix: look.matrix, offset: look.offset, layers: look.layers, vignette: look.vignette } } : {}),
      ...(all.some((x) => x.fx?.text) ? { fontUrl: FX_FONT.url } : {}),
      pieces: all,
    },
    warnings: [...warnings],
  };
}
