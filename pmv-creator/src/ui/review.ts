/**
 * ⏭ Review the cuts: [ / ] (or ↑ / ↓) select the previous / next clip and play from a second before its cut, so
 * every cut can be checked one after another without aiming at the timeline.
 */
import type { Clip, PmvProject } from "../model/project";
import type { Action, EditorState } from "../state/reducer";
import type { Transport } from "../state/transport";
import { findClip } from "../timeline/ops";
import { EPS } from "../timeline/time";

/** Seconds played before the cut. */
export const REVIEW_LEAD = 1;

/**
 * The clip before/after `ref` (a clip's start or the playhead) over all audible tracks, in time; where two tracks
 * cut at the same moment the upper one counts (it is the one that is seen).
 */
export function neighbourCut(p: PmvProject, ref: number, dir: -1 | 1): Clip | null {
  const starts = new Map<number, Clip>();
  for (const tr of p.tracks) {
    if (tr.muted) continue;
    for (const c of tr.clips) {
      const key = Math.round(c.start * 1e4);
      if (!starts.has(key)) starts.set(key, c); // tracks[0] is the top-most track
    }
  }
  const clips = [...starts.values()].sort((a, b) => a.start - b.start);
  if (dir > 0) return clips.find((c) => c.start > ref + EPS) ?? null;
  for (let i = clips.length - 1; i >= 0; i--) if (clips[i].start < ref - EPS) return clips[i];
  return null;
}

/** Selects the neighbouring clip and plays from REVIEW_LEAD before it; false when there is none. */
export function reviewCut(state: EditorState, dispatch: (a: Action) => void, transport: Transport, dir: -1 | 1): boolean {
  const { present: p, ui } = state;
  const sel = ui.selectedClipId ? findClip(p, ui.selectedClipId)?.clip : null;
  const next = neighbourCut(p, sel ? sel.start : transport.time, dir);
  if (!next) return false;
  // the cut is seen in the PMV preview – a scene shown in the big player steps aside
  dispatch({ type: "ui", patch: { selectedClipId: next.id, ...(ui.activeSceneId && ui.sceneInPlayer ? { sceneInPlayer: false } : {}) } });
  transport.seek(Math.max(0, next.start - REVIEW_LEAD));
  transport.play();
  return true;
}
