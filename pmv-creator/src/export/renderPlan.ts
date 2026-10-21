/**
 * Project -> RenderPlan: a flat list of frame-exact pieces that the Python backend renders one by one
 * (filtergraph per piece) and then joins with the concat demuxer. All timing decisions happen here,
 * the backend only translates pieces into FFmpeg arguments.
 */
import { t } from "../i18n";
import type { FitMode, OutputSettings, PmvProject, TransitionType } from "../model/project";
import { type Segment, flattenTimeline, resolveTransitions, sourceTimeAt } from "../timeline/flatten";

export const RENDER_PLAN_VERSION = 1;

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

export type RenderPiece =
  | { kind: "clip"; frames: number; src: SourceRef }
  | { kind: "black"; frames: number }
  /** a = outgoing, b = incoming; null = black. */
  | { kind: "xfade"; frames: number; transition: TransitionType; a: SourceRef | null; b: SourceRef | null };

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
  pieces: RenderPiece[];
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

export function buildRenderPlan(p: PmvProject): { plan: RenderPlan; warnings: string[] } {
  const fps = p.output.fps;
  const segs = flattenTimeline(p);
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

  return {
    plan: {
      version: RENDER_PLAN_VERSION,
      projectId: p.id,
      projectName: p.name,
      output: p.output,
      totalFrames: segs.length ? segs[segs.length - 1].endFrame : 0,
      clipAudio,
      audio,
      pieces,
    },
    warnings: [...warnings],
  };
}
