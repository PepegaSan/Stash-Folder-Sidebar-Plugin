/** Glue between UI gestures and edit actions (target track, drop length, snapping). */
import { uid } from "../model/ids";
import { type PmvProject, type Snippet, audioEnd, clipEnd } from "../model/project";
import type { UiState } from "../state/reducer";
import { clipFromSnippet, findClip } from "../timeline/ops";
import { type SnapOptions, beatLength } from "../timeline/time";
import type { EditAction } from "../state/reducer";

/** Track of the selected clip, otherwise the bottom-most unlocked track (V1). */
export function targetTrackId(p: PmvProject, selectedClipId: string | null): string | null {
  if (selectedClipId) {
    const loc = findClip(p, selectedClipId);
    if (loc && !loc.track.locked) return loc.track.id;
  }
  for (let i = p.tracks.length - 1; i >= 0; i--) if (!p.tracks[i].locked) return p.tracks[i].id;
  return null;
}

/** With "quantize drops" a snippet lands with a length that is a whole number of snap steps. */
export function dropDuration(p: PmvProject, ui: UiState, s: Snippet): number {
  const len = s.out - s.in;
  if (!ui.snap || !ui.quantizeDrops) return len;
  const step = beatLength(p.beatGrid) * ui.snapDivision;
  return Math.max(1, Math.round(len / step)) * step;
}

export function snapOptions(p: PmvProject, ui: UiState, playhead: number, excludeClipId?: string): SnapOptions | null {
  if (!ui.snap) return null;
  const points = [0, playhead, ...p.markers.map((m) => m.time)];
  if (p.audio) points.push(p.audio.start, audioEnd(p.audio));
  for (const t of p.tracks) for (const c of t.clips) if (c.id !== excludeClipId) points.push(c.start, clipEnd(c));
  return { grid: p.beatGrid, division: ui.snapDivision, points, threshold: 8 / ui.zoom };
}

export function insertAction(p: PmvProject, ui: UiState, s: Snippet, start: number, trackId?: string, clipId = uid("clip")): EditAction | null {
  const track = trackId ?? targetTrackId(p, ui.selectedClipId);
  if (!track) return null;
  const clip = { ...clipFromSnippet(s, start, { duration: dropDuration(p, ui, s) }), id: clipId };
  return { type: "clip/insert", trackId: track, clip, mode: ui.editMode };
}

// HTML5 drag & drop from the bin: dataTransfer is unreadable during dragover, so keep the payload here.
let dragPayload: { snippetId: string; clipId: string } | null = null;
export const startSnippetDrag = (snippetId: string) => (dragPayload = { snippetId, clipId: uid("clip") });
export const currentSnippetDrag = () => dragPayload;
export const endSnippetDrag = () => (dragPayload = null);
