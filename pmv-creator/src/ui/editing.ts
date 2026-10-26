/** Glue between UI gestures and edit actions (target track, drop length, snapping). */
import { snippetFromRange } from "../culling/culling";
import { uid } from "../model/ids";
import { type PmvProject, type Snippet, type SourceMedia, audioEnd, clipEnd } from "../model/project";
import type { UiState } from "../state/reducer";
import { clipFromSnippet, findClip } from "../timeline/ops";
import { type SnapOptions, beatLength } from "../timeline/time";
import type { EditAction } from "../state/reducer";

/** The timeline marker at this time (within a frame or two), if any. */
export const markerAt = (p: PmvProject, time: number) => p.markers.find((m) => Math.abs(m.time - time) < 0.05) ?? null;

/** ◆ and key M toggle: a marker at the playhead goes away, otherwise a new one (M1, M2 …) is set there. */
export function toggleMarkerAction(p: PmvProject, time: number): EditAction {
  const hit = markerAt(p, time);
  return hit ? { type: "marker/remove", markerId: hit.id } : { type: "marker/add", marker: { id: uid("mrk"), time, label: `M${p.markers.length + 1}` } };
}

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

/** `excludeId`: the clip or split screen range being dragged (its own edges don't count). */
export function snapOptions(p: PmvProject, ui: UiState, playhead: number, excludeId?: string): SnapOptions | null {
  if (!ui.snap) return null;
  const points = [0, playhead, ...p.markers.map((m) => m.time)];
  if (p.audio) points.push(p.audio.start, audioEnd(p.audio));
  for (const t of p.tracks) for (const c of t.clips) if (c.id !== excludeId) points.push(c.start, clipEnd(c));
  for (const r of p.layouts) if (r.id !== excludeId) points.push(r.start, r.start + r.duration);
  return { grid: p.beatGrid, division: ui.snapDivision, points, threshold: 8 / ui.zoom };
}

export function insertAction(p: PmvProject, ui: UiState, s: Snippet, start: number, trackId?: string, clipId = uid("clip")): EditAction | null {
  const track = trackId ?? targetTrackId(p, ui.selectedClipId);
  if (!track) return null;
  const clip = { ...clipFromSnippet(s, start, { duration: dropDuration(p, ui, s), volume: p.clipVolume }), id: clipId };
  return { type: "clip/insert", trackId: track, clip, mode: ui.editMode };
}

/** The whole scene as one snippet (not kept in the bin). */
export const wholeScene = (src: SourceMedia): Snippet => snippetFromRange(src.sceneId, 0, src.duration, src.title);

/**
 * A whole scene onto the timeline at `start` – full length (no quantising), its source comes along, one undo step.
 * For compilations: the playhead at the clip's end afterwards makes the next scene follow this one.
 */
export function wholeSceneAction(p: PmvProject, ui: UiState, src: SourceMedia, start: number, trackId?: string, clipId = uid("clip")): EditAction | null {
  const track = trackId ?? targetTrackId(p, ui.selectedClipId);
  if (!track || src.duration <= 0) return null;
  const clip = { ...clipFromSnippet(wholeScene(src), start, { duration: src.duration, volume: p.clipVolume }), id: clipId, snippetId: null };
  return { type: "clip/insert", trackId: track, clip, mode: ui.editMode, sources: [src] };
}

// HTML5 drag & drop from the sidebar: dataTransfer is unreadable during dragover, so keep the payload here.
// Either a snippet of the bin (by id) or a whole scene (its source).
let dragPayload: { snippetId: string | null; source: SourceMedia | null; clipId: string } | null = null;
export const startSnippetDrag = (snippetId: string) => (dragPayload = { snippetId, source: null, clipId: uid("clip") });
export const startSceneDrag = (source: SourceMedia) => (dragPayload = { snippetId: null, source, clipId: uid("clip") });
export const currentSnippetDrag = () => dragPayload;
export const endSnippetDrag = () => (dragPayload = null);
