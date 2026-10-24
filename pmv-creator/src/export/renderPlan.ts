/**
 * Project -> RenderPlan: a flat list of frame-exact pieces that the Python backend renders one by one
 * (filtergraph per piece) and then joins with the concat demuxer. All timing decisions happen here,
 * the backend only translates pieces into FFmpeg arguments – the effects too: every piece carries what
 * they do in its frames, worked out by the same effectFrame() the preview draws with.
 */
import { type EffectFrame, type EffectTimeline, FX_FONT, TEXT_SECONDS, effectFrame, withStutters } from "../fx/timeline";
import { t } from "../i18n";
import { dividerRects, fieldRect, fitInField, layoutFields } from "../model/layouts";
import { type ColorGrade, colorGrade } from "../model/look";
import type { FitMode, OutputSettings, PmvProject, TransitionType } from "../model/project";
import { type Segment, flattenTimeline, resolveTransitions, sourceTimeAt } from "../timeline/flatten";

export const RENDER_PLAN_VERSION = 1;
/**
 * A piece with effects is at most this long: its per-frame values become FFmpeg expressions and commands (a long
 * filtergraph goes into a file). Rarely reached – a cut in a clip could skip a source frame where the frame rates differ.
 */
export const MAX_FX_FRAMES = 1800;

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
  /** Words: first frame (negative = began before this piece), size as a share of the picture height, frames it stays (until the next word comes). */
  text?: Array<{ word: string; from: number; size: number; frames: number }>;
  /** Flashes: [frame, strength, r, g, b] for every frame one shows. */
  flash?: Array<[number, number, number, number, number]>;
  /** Split screens with glowing dividers: the beats (seconds from the piece's start, the last one before it first). */
  glow?: number[];
}

/** A field of a split screen: its rectangle in pixels, the group whose clip it shows, mirrored, how the clip fits in. */
export interface PieceField {
  rect: [number, number, number, number];
  group: number;
  fx: boolean;
  fy: boolean;
  fit: FitMode;
}

export type RenderPiece =
  | { kind: "clip"; frames: number; src: SourceRef; fx?: PieceFx }
  | { kind: "black"; frames: number; fx?: PieceFx }
  /** a = outgoing, b = incoming; null = black. */
  | { kind: "xfade"; frames: number; transition: TransitionType; a: SourceRef | null; b: SourceRef | null; fx?: PieceFx }
  /** A split screen: per group the clip's source (null = black), the fields, the dividers [x, y, w, h] in pixels. */
  | { kind: "layout"; frames: number; groups: Array<SourceRef | null>; fields: PieceField[]; dividers: Array<[number, number, number, number]>; fx?: PieceFx };

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

/** The effects in frames [from, from + frames) of the timeline; null when none of them does anything there. `split`: a split screen (its dividers can glow). */
export function pieceFx(tl: EffectTimeline, from: number, frames: number, split = false): PieceFx | null {
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
  const text = tl.texts.flatMap((x, k) => {
    const f0 = Math.round(x.t * fps);
    // the next word takes over (the preview shows the newest)
    const next = tl.texts[k + 1] ? Math.round(tl.texts[k + 1].t * fps) : Infinity;
    const n = Math.max(1, Math.min(textFrames, next - f0));
    return overlaps(f0, n) ? [{ word: x.word, from: f0 - from, size: x.size, frames: n }] : [];
  });
  if (tunnel.length) fx.tunnel = tunnel;
  if (text.length) fx.text = text;
  const flash = fr.flatMap((f, i): Array<[number, number, number, number, number]> => (f.flash ? [[i, round(f.flash.a, 4), ...f.flash.color]] : []));
  if (flash.length) fx.flash = flash;
  if (split && tl.glow) {
    // the beats in this piece and the last one before it – the glow of that one may still be fading
    const t0 = from / fps;
    const t1 = (from + frames) / fps;
    const k = tl.glow.findIndex((b) => b >= t0);
    const first = k < 0 ? tl.glow.length - 1 : Math.max(0, k - 1);
    const beats = tl.glow.slice(first).filter((b) => b < t1).map((b) => round(b - t0, 6));
    if (beats.length) fx.glow = beats;
  }
  if (shake.length || tunnel.length || text.length || flash.length || fx.glow) any = true;
  for (const k of Object.keys(fx) as Array<keyof PieceFx>) if (fx[k] === undefined) delete fx[k];
  return any ? fx : null;
}

/**
 * Long pieces with effects are cut into several (a clip goes on frame-exactly), each gets its effects. A part never
 * starts past its file's last frame – FFmpeg would decode nothing there; from it the last picture stays, as unsplit.
 */
function addEffects(pieces: RenderPiece[], tl: EffectTimeline, fps: number, sources: PmvProject["sources"]): RenderPiece[] {
  const out: RenderPiece[] = [];
  let at = 0;
  const later = (src: SourceRef | null, off: number): SourceRef | null => {
    if (!src) return null;
    const media = sources[src.sceneId];
    const last = media && media.duration > 0 ? Math.max(0, media.duration - 1 / (media.fps > 0 ? media.fps : 30)) : Infinity;
    return { ...src, in: r6(Math.min(last, src.in + (off / fps) * src.speed)) };
  };
  for (const piece of pieces) {
    const split = piece.kind === "layout";
    const whole = pieceFx(tl, at, piece.frames, split);
    if (!whole) out.push(piece);
    else if (piece.kind === "xfade" || piece.frames <= MAX_FX_FRAMES) out.push({ ...piece, fx: whole });
    else {
      for (let off = 0; off < piece.frames; off += MAX_FX_FRAMES) {
        const frames = Math.min(MAX_FX_FRAMES, piece.frames - off);
        const fx = pieceFx(tl, at + off, frames, split) ?? undefined;
        const extra = fx ? { fx } : {};
        if (piece.kind === "black") out.push({ kind: "black", frames, ...extra });
        else if (piece.kind === "layout") out.push({ ...piece, frames, groups: piece.groups.map((g) => later(g, off)), ...extra });
        else out.push({ kind: "clip", frames, src: later(piece.src, off)!, ...extra });
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

  // the size the backend renders: rounded down to even numbers (the encoder's chroma) – the fields have to fit into it
  const W = Math.floor(p.output.width / 2) * 2;
  const H = Math.floor(p.output.height / 2) * 2;
  segs.forEach((seg, i) => {
    if (seg.layout) {
      // a split screen: every group's clip from this segment's first frame, every field in pixels
      const groups = seg.layout.groups.map((g) => ref(g ?? undefined, seg.startFrame));
      const fields = layoutFields(seg.layout.kind, seg.layout.dir).map((f): PieceField => {
        const rect = fieldRect(f, W, H);
        const src = groups[f.group];
        const media = src ? p.sources[src.sceneId] : null;
        const fit = src ? fitInField(src.fit, media && media.height > 0 ? media.width / media.height : 0, rect[2] / rect[3]) : "cover";
        return { rect, group: f.group, fx: f.fx, fy: f.fy, fit };
      });
      push({ kind: "layout", frames: seg.endFrame - seg.startFrame, groups, fields, dividers: dividerRects(layoutFields(seg.layout.kind, seg.layout.dir), W, H) });
      return;
    }
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
  const clipAudio = pieces.some((x) => (x.kind === "clip" ? uses(x.src) : x.kind === "xfade" ? uses(x.a) || uses(x.b) : x.kind === "layout" ? x.groups.some(uses) : false));

  let audio: RenderAudio | null = null;
  if (p.audio?.path) {
    const a = p.audio;
    audio = { path: a.path!, ...(a.url ? { url: a.url } : {}), sourceIn: a.sourceIn, start: a.start, gainDb: a.gainDb, fadeIn: a.fadeIn, fadeOut: a.fadeOut };
  } else if (p.audio) {
    warnings.add(t("The music has no server path – rendering without music"));
  }
  if (!segs.some((s) => s.clip || s.layout?.groups.some((g) => g))) warnings.add(t("The timeline has no clips"));
  const look = colorGrade(p.output);
  const all = fx ? addEffects(pieces, fx, fps, p.sources) : pieces;

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
