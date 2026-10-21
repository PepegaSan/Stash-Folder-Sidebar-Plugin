/**
 * Multi-track timeline -> one contiguous list of frame-exact segments ("what is visible when").
 * Used by the preview player, EDL export and the render plan, so all three agree frame for frame.
 */
import { type Clip, type PmvProject, type Transition, clipEnd, projectDuration } from "../model/project";
import { toFrame } from "./time";

export interface Segment {
  startFrame: number;
  endFrame: number;
  /** null = gap (black). */
  clip: Clip | null;
  trackId: string | null;
  /** Quantised start of the whole clip – the source mapping is anchored here. */
  clipStartFrame: number;
}

export function flattenTimeline(p: PmvProject): Segment[] {
  const fps = p.output.fps;
  const total = toFrame(projectDuration(p), fps);
  if (total <= 0) return [];

  interface Q { clip: Clip; trackIdx: number; trackId: string; s: number; e: number }
  const qs: Q[] = [];
  p.tracks.forEach((t, trackIdx) => {
    if (t.muted) return;
    for (const clip of t.clips) {
      const s = toFrame(clip.start, fps);
      const e = toFrame(clipEnd(clip), fps);
      if (e > s) qs.push({ clip, trackIdx, trackId: t.id, s, e });
    }
  });

  const bounds = new Set<number>([0, total]);
  for (const q of qs) {
    if (q.s < total) bounds.add(q.s);
    if (q.e < total) bounds.add(q.e);
  }
  const sorted = [...bounds].sort((a, b) => a - b);

  const out: Segment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    let best: Q | null = null;
    for (const q of qs) if (q.s <= a && q.e >= b && (!best || q.trackIdx < best.trackIdx)) best = q;
    const last = out[out.length - 1];
    if (last && (last.clip?.id ?? null) === (best?.clip.id ?? null)) {
      last.endFrame = b;
      continue;
    }
    out.push({ startFrame: a, endFrame: b, clip: best?.clip ?? null, trackId: best?.trackId ?? null, clipStartFrame: best?.s ?? a });
  }
  return out;
}

/** Source time shown at timeline `frame` (fractional frames allowed). Extends linearly into handles. */
export function sourceTimeAt(seg: Segment, frame: number, fps: number): number {
  if (!seg.clip) return 0;
  return seg.clip.sourceIn + ((frame - seg.clipStartFrame) / fps) * seg.clip.speed;
}

/** Index of the segment containing `frame`, -1 if outside. */
export function segmentIndexAt(segs: Segment[], frame: number): number {
  let lo = 0;
  let hi = segs.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (frame < segs[mid].startFrame) hi = mid - 1;
    else if (frame >= segs[mid].endFrame) lo = mid + 1;
    else return mid;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Transitions

export interface ResolvedTransition {
  type: Transition["type"];
  /** Frames before the cut (taken from the outgoing segment). */
  before: number;
  /** Frames after the cut (taken from the incoming segment). */
  after: number;
}

/** Keeps outgoing clips this far away from the end of their file. */
const HANDLE_MARGIN = 0.05;

/**
 * Resolves `clip.transitionIn` against the flattened sequence. Transitions are centred on the cut and
 * consume at most half of each neighbouring segment (so they can never overlap each other); they are
 * shortened when a source has no handle material. Index i = transition into segs[i].
 */
export function resolveTransitions(p: PmvProject, segs: Segment[]): Array<ResolvedTransition | null> {
  const fps = p.output.fps;
  return segs.map((seg, i) => {
    const c = seg.clip;
    if (!c?.transitionIn || seg.startFrame !== seg.clipStartFrame) return null;
    const d = toFrame(c.transitionIn.duration, fps);
    if (d < 1) return null;
    const prev = i > 0 ? segs[i - 1] : null;
    let before = prev ? Math.floor(d / 2) : 0;
    let after = d - before;
    before = Math.min(before, prev ? Math.floor((prev.endFrame - prev.startFrame) / 2) : 0);
    after = Math.min(after, Math.floor((seg.endFrame - seg.startFrame) / 2));

    // The incoming clip needs `before` frames of material ahead of its in-point …
    const srcB = sourceTimeAt(seg, seg.startFrame, fps);
    before = Math.min(before, Math.floor((srcB * fps) / c.speed + 1e-6));
    // … and the outgoing clip `after` frames beyond the cut.
    if (prev?.clip) {
      const fileDur = p.sources[prev.clip.sceneId]?.duration ?? 0;
      if (fileDur > 0) {
        const srcA = sourceTimeAt(prev, seg.startFrame, fps);
        after = Math.min(after, Math.max(0, Math.floor(((fileDur - HANDLE_MARGIN - srcA) * fps) / prev.clip.speed)));
      }
    }
    if (before + after < 1) return null;
    return { type: c.transitionIn.type, before, after };
  });
}
