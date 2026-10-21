/**
 * Pure, non-destructive edit operations on a PmvProject.
 *
 * Every function returns a new project (structural sharing) or the *same* reference when the edit
 * is not possible (locked track, nothing fits, ...). The reducer relies on that identity check to
 * skip history entries for no-ops.
 *
 * Invariant per track: clips sorted by start, no overlaps.
 */
import { uid } from "../model/ids";
import { type Clip, type PmvProject, type Snippet, type Track, clipEnd, clipSourceOut, createTrack } from "../model/project";
import { EPS, clamp } from "./time";

/**
 * clamp     – clips stop at their neighbours, nothing else changes ("magnetic", the default)
 * ripple    – later clips on the track shift to make or close room
 * overwrite – the edited clip wins; overlapped clips are trimmed or split
 */
export type EditMode = "clamp" | "ripple" | "overwrite";
export type TrimEdge = "start" | "end";
export type SpeedKeep = "duration" | "range";

export const MIN_SPEED = 0.1;
export const MAX_SPEED = 10;

const minDuration = (p: PmvProject) => 1 / p.output.fps;

/** Unknown durations (0) do not constrain edits. */
function sourceDuration(p: PmvProject, sceneId: string): number {
  const d = p.sources[sceneId]?.duration ?? 0;
  return d > 0 ? d : Infinity;
}

export function sortClips(clips: Clip[]): Clip[] {
  return [...clips].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export interface ClipLocation {
  track: Track;
  trackIndex: number;
  clip: Clip;
}

export function findClip(p: PmvProject, clipId: string): ClipLocation | null {
  for (let i = 0; i < p.tracks.length; i++) {
    const clip = p.tracks[i].clips.find((c) => c.id === clipId);
    if (clip) return { track: p.tracks[i], trackIndex: i, clip };
  }
  return null;
}

/** Replaces a track's clips; `fn` returning null means "edit rejected". */
function withTrack(p: PmvProject, trackId: string, fn: (clips: Clip[]) => Clip[] | null): PmvProject {
  const idx = p.tracks.findIndex((t) => t.id === trackId);
  if (idx < 0 || p.tracks[idx].locked) return p;
  const next = fn(p.tracks[idx].clips);
  if (!next) return p;
  const tracks = p.tracks.slice();
  tracks[idx] = { ...p.tracks[idx], clips: sortClips(next) };
  return { ...p, tracks };
}

function mapClip(p: PmvProject, clipId: string, fn: (c: Clip) => Clip): PmvProject {
  const loc = findClip(p, clipId);
  if (!loc) return p;
  return withTrack(p, loc.track.id, (clips) => clips.map((c) => (c.id === clipId ? fn(c) : c)));
}

// ---------------------------------------------------------------------------------------------
// Clip-level helpers

export function trimHead(c: Clip, newStart: number): Clip {
  const d = newStart - c.start;
  return { ...c, start: newStart, duration: c.duration - d, sourceIn: c.sourceIn + d * c.speed };
}

export function trimTail(c: Clip, newEnd: number): Clip {
  return { ...c, duration: newEnd - c.start };
}

export function clipFromSnippet(s: Snippet, start: number, opts: { duration?: number; speed?: number } = {}): Clip {
  const speed = opts.speed ?? 1;
  return {
    id: uid("clip"),
    sceneId: s.sceneId,
    snippetId: s.id,
    markerId: s.markerId,
    start: Math.max(0, start),
    duration: opts.duration ?? Math.max(EPS, (s.out - s.in) / speed),
    sourceIn: s.in,
    speed,
    volume: 0,
    transitionIn: null,
    fit: null,
    label: s.label,
  };
}

// ---------------------------------------------------------------------------------------------
// Track-level helpers (operate on a clip list)

/** Removes [from, to) from the clips, trimming or splitting whatever overlaps. */
export function carve(clips: Clip[], from: number, to: number, minDur: number): Clip[] {
  const out: Clip[] = [];
  for (const c of clips) {
    const s = c.start;
    const e = clipEnd(c);
    if (e <= from + EPS || s >= to - EPS) {
      out.push(c);
      continue;
    }
    const keepsLeft = s < from - EPS;
    if (keepsLeft) {
      const left = trimTail(c, from);
      if (left.duration >= minDur - EPS) out.push(left);
    }
    if (e > to + EPS) {
      const right = trimHead(keepsLeft ? { ...c, id: uid("clip"), transitionIn: null } : c, to);
      if (right.duration >= minDur - EPS) out.push(right);
    }
  }
  return out;
}

/** Splits the clip spanning `at` (if any) into two. */
function splitAt(clips: Clip[], at: number, minDur: number): Clip[] {
  return clips.flatMap((c) => {
    if (c.start < at - EPS && clipEnd(c) > at + EPS) {
      const left = trimTail(c, at);
      const right = trimHead({ ...c, id: uid("clip"), transitionIn: null }, at);
      if (left.duration < minDur || right.duration < minDur) return [c];
      return [left, right];
    }
    return [c];
  });
}

function shiftFrom(clips: Clip[], at: number, delta: number): Clip[] {
  return clips.map((c) => (c.start >= at - EPS ? { ...c, start: c.start + delta } : c));
}

export function freeGaps(clips: Clip[], ignoreId?: string): Array<[number, number]> {
  const gaps: Array<[number, number]> = [];
  let cursor = 0;
  for (const c of sortClips(clips.filter((x) => x.id !== ignoreId))) {
    if (c.start > cursor + EPS) gaps.push([cursor, c.start]);
    cursor = Math.max(cursor, clipEnd(c));
  }
  gaps.push([cursor, Infinity]);
  return gaps;
}

/** Nearest start for [start, start+duration) that lies completely inside a free gap, or null. */
export function fitIntoGap(clips: Clip[], start: number, duration: number, ignoreId?: string): number | null {
  let best: number | null = null;
  let bestDist = Infinity;
  for (const [a, b] of freeGaps(clips, ignoreId)) {
    if (b - a + EPS < duration) continue;
    const s = clamp(start, a, b - duration);
    const dist = Math.abs(s - start);
    if (dist < bestDist - EPS) {
      best = s;
      bestDist = dist;
    }
  }
  return best;
}

function place(clips: Clip[], clip: Clip, mode: EditMode, minDur: number): Clip[] | null {
  switch (mode) {
    case "overwrite":
      return [...carve(clips, clip.start, clipEnd(clip), minDur), clip];
    case "ripple": {
      const split = splitAt(clips, clip.start, minDur);
      return [...shiftFrom(split, clip.start, clip.duration), clip];
    }
    case "clamp": {
      const s = fitIntoGap(clips, clip.start, clip.duration);
      return s === null ? null : [...clips, { ...clip, start: s }];
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Edit operations

export function insertClip(p: PmvProject, trackId: string, clip: Clip, mode: EditMode): PmvProject {
  const c = { ...clip, start: Math.max(0, clip.start) };
  return withTrack(p, trackId, (clips) => place(clips, c, mode, minDuration(p)));
}

/** Ripple applies at the destination; the origin keeps its gap (nothing else on that track moves). */
export function moveClip(p: PmvProject, clipId: string, toTrackId: string, toStart: number, mode: EditMode): PmvProject {
  const loc = findClip(p, clipId);
  if (!loc || loc.track.locked) return p;
  const dest = p.tracks.find((t) => t.id === toTrackId);
  if (!dest || dest.locked) return p;
  const moved = { ...loc.clip, start: Math.max(0, toStart) };
  if (Math.abs(moved.start - loc.clip.start) < EPS && dest.id === loc.track.id) return p;
  const removed = withTrack(p, loc.track.id, (clips) => clips.filter((c) => c.id !== clipId));
  const destClips = removed.tracks.find((t) => t.id === toTrackId)!.clips;
  const placed = place(destClips, moved, mode, minDuration(p));
  return placed ? withTrack(removed, toTrackId, () => placed) : p;
}

/** Moves one edge of the clip to `time`. Source bounds (0 … file duration) are always respected. */
export function trimClip(p: PmvProject, clipId: string, edge: TrimEdge, time: number, mode: EditMode): PmvProject {
  const loc = findClip(p, clipId);
  if (!loc || loc.track.locked) return p;
  const c = loc.clip;
  const md = minDuration(p);
  const others = loc.track.clips.filter((x) => x.id !== clipId);
  const trackId = loc.track.id;

  if (edge === "start") {
    let s = Math.max(time, c.start - c.sourceIn / c.speed, 0);
    s = Math.min(s, clipEnd(c) - md);
    if (mode === "ripple") {
      // Ripple head trim: the clip stays where it is, its content changes, followers move by -delta.
      const delta = s - c.start;
      if (Math.abs(delta) < EPS) return p;
      const trimmed = { ...c, sourceIn: c.sourceIn + delta * c.speed, duration: c.duration - delta };
      return withTrack(p, trackId, () => [...shiftFrom(others, clipEnd(c), -delta), trimmed]);
    }
    if (mode === "clamp") {
      const prevEnd = others.reduce((m, o) => (clipEnd(o) <= c.start + EPS ? Math.max(m, clipEnd(o)) : m), 0);
      s = Math.max(s, prevEnd);
    }
    if (Math.abs(s - c.start) < EPS) return p;
    const trimmed = trimHead(c, s);
    const rest = mode === "overwrite" ? carve(others, trimmed.start, clipEnd(trimmed), md) : others;
    return withTrack(p, trackId, () => [...rest, trimmed]);
  }

  let e = Math.min(time, c.start + (sourceDuration(p, c.sceneId) - c.sourceIn) / c.speed);
  e = Math.max(e, c.start + md);
  if (mode === "ripple") {
    const delta = e - clipEnd(c);
    if (Math.abs(delta) < EPS) return p;
    return withTrack(p, trackId, () => [...shiftFrom(others, clipEnd(c), delta), trimTail(c, e)]);
  }
  if (mode === "clamp") {
    const nextStart = others.reduce((m, o) => (o.start >= clipEnd(c) - EPS ? Math.min(m, o.start) : m), Infinity);
    e = Math.min(e, nextStart);
  }
  if (Math.abs(e - clipEnd(c)) < EPS) return p;
  const trimmed = trimTail(c, e);
  const rest = mode === "overwrite" ? carve(others, c.start, e, md) : others;
  return withTrack(p, trackId, () => [...rest, trimmed]);
}

/** Slip: different source material, same position and length on the timeline (keeps beat sync). */
export function slipClip(p: PmvProject, clipId: string, sourceIn: number): PmvProject {
  const loc = findClip(p, clipId);
  if (!loc) return p;
  const c = loc.clip;
  const maxIn = Math.max(0, sourceDuration(p, c.sceneId) - c.duration * c.speed);
  const s = clamp(sourceIn, 0, maxIn);
  if (Math.abs(s - c.sourceIn) < EPS) return p;
  return mapClip(p, clipId, (x) => ({ ...x, sourceIn: s }));
}

/**
 * keep "duration": the slot on the timeline stays, the source out-point moves (beat-sync safe).
 * keep "range":    the source range stays, the clip gets longer/shorter (end trim with `mode`).
 */
export function setClipSpeed(p: PmvProject, clipId: string, speed: number, keep: SpeedKeep, mode: EditMode): PmvProject {
  const loc = findClip(p, clipId);
  if (!loc || loc.track.locked) return p;
  const c = loc.clip;
  let v = clamp(speed, MIN_SPEED, MAX_SPEED);
  if (Math.abs(v - c.speed) < EPS) return p;
  const srcDur = sourceDuration(p, c.sceneId);

  if (keep === "duration") {
    let sourceIn = c.sourceIn;
    if (sourceIn + c.duration * v > srcDur) sourceIn = Math.max(0, srcDur - c.duration * v);
    if (sourceIn + c.duration * v > srcDur + EPS) v = (srcDur - sourceIn) / c.duration;
    return mapClip(p, clipId, (x) => ({ ...x, speed: v, sourceIn }));
  }

  const range = clipSourceOut(c) - c.sourceIn;
  const withSpeed = mapClip(p, clipId, (x) => ({ ...x, speed: v }));
  const trimmed = trimClip(withSpeed, clipId, "end", c.start + range / v, mode);
  return trimmed === withSpeed ? withSpeed : trimmed;
}

export type ClipPatch = Partial<Pick<Clip, "volume" | "transitionIn" | "fit" | "label">>;

export function updateClip(p: PmvProject, clipId: string, patch: ClipPatch): PmvProject {
  return mapClip(p, clipId, (c) => ({ ...c, ...patch }));
}

/**
 * Swap the material, keep the slot: start, duration, speed, transition and volume stay.
 * If the snippet is shorter than the slot, material after its out-point (handles) is used.
 */
export function replaceClip(p: PmvProject, clipId: string, snippet: Snippet): PmvProject {
  const loc = findClip(p, clipId);
  if (!loc) return p;
  const c = loc.clip;
  const srcDur = sourceDuration(p, snippet.sceneId);
  let speed = c.speed;
  let sourceIn = snippet.in;
  if (sourceIn + c.duration * speed > srcDur) sourceIn = Math.max(0, srcDur - c.duration * speed);
  if (sourceIn + c.duration * speed > srcDur + EPS) speed = Math.max(MIN_SPEED, (srcDur - sourceIn) / c.duration);
  return mapClip(p, clipId, (x) => ({
    ...x,
    sceneId: snippet.sceneId,
    snippetId: snippet.id,
    markerId: snippet.markerId,
    sourceIn,
    speed,
    label: snippet.label,
  }));
}

export interface ClipSourceInput {
  sceneId: string;
  sourceIn: number;
  /** Only used with fit. */
  sourceOut?: number;
  markerId: string | null;
  snippetId?: string | null;
  label?: string;
}

/**
 * Different material for the same slot – start and length on the timeline never change (A → B stays).
 * fit = false: the speed stays, the source range just moves (like slip, also into another scene).
 * fit = true:  exactly [sourceIn, sourceOut] plays in the slot; the speed follows (range / duration).
 */
export function setClipSource(p: PmvProject, clipId: string, src: ClipSourceInput, fit: boolean): PmvProject {
  const loc = findClip(p, clipId);
  if (!loc) return p;
  const c = loc.clip;
  const srcDur = sourceDuration(p, src.sceneId);
  let speed = c.speed;
  if (fit && src.sourceOut != null && src.sourceOut > src.sourceIn + EPS) speed = clamp((src.sourceOut - src.sourceIn) / c.duration, MIN_SPEED, MAX_SPEED);
  const sourceIn = clamp(src.sourceIn, 0, Math.max(0, srcDur - c.duration * speed));
  // material shorter than the slot: slow down rather than run past the end of the file
  if (sourceIn + c.duration * speed > srcDur + EPS) speed = Math.max(MIN_SPEED, (srcDur - sourceIn) / c.duration);
  const sameScene = src.sceneId === c.sceneId;
  if (sameScene && Math.abs(sourceIn - c.sourceIn) < EPS && Math.abs(speed - c.speed) < EPS && src.markerId === c.markerId) return p;
  return mapClip(p, clipId, (x) => ({
    ...x,
    sceneId: src.sceneId,
    sourceIn,
    speed,
    markerId: src.markerId,
    snippetId: src.snippetId !== undefined ? src.snippetId : sameScene ? x.snippetId : null,
    label: src.label ?? (sameScene ? x.label : ""),
  }));
}

export function splitClip(p: PmvProject, clipId: string, at: number): PmvProject {
  const loc = findClip(p, clipId);
  if (!loc) return p;
  const c = loc.clip;
  const md = minDuration(p);
  if (at < c.start + md - EPS || at > clipEnd(c) - md + EPS) return p;
  const left = trimTail(c, at);
  const right = trimHead({ ...c, id: uid("clip"), transitionIn: null }, at);
  return withTrack(p, loc.track.id, (clips) => [...clips.filter((x) => x.id !== clipId), left, right]);
}

export function deleteClip(p: PmvProject, clipId: string, ripple: boolean): PmvProject {
  const loc = findClip(p, clipId);
  if (!loc) return p;
  const c = loc.clip;
  return withTrack(p, loc.track.id, (clips) => {
    const rest = clips.filter((x) => x.id !== clipId);
    return ripple ? shiftFrom(rest, clipEnd(c), -c.duration) : rest;
  });
}

// ---------------------------------------------------------------------------------------------
// Tracks

/** New tracks go on top (highest priority). */
export function addTrack(p: PmvProject): PmvProject {
  const used = new Set(p.tracks.map((t) => t.name));
  let n = p.tracks.length + 1;
  while (used.has(`V${n}`)) n++;
  return { ...p, tracks: [createTrack(`V${n}`), ...p.tracks] };
}

export function removeTrack(p: PmvProject, trackId: string): PmvProject {
  if (p.tracks.length <= 1) return p;
  const tracks = p.tracks.filter((t) => t.id !== trackId);
  return tracks.length === p.tracks.length ? p : { ...p, tracks };
}

export function updateTrack(p: PmvProject, trackId: string, patch: Partial<Pick<Track, "name" | "muted" | "locked">>): PmvProject {
  if (!p.tracks.some((t) => t.id === trackId)) return p;
  return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, ...patch } : t)) };
}
