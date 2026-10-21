/** Culling: turning Stash scenes/markers into bin snippets and exclusions. Pure functions. */
import { uid } from "../model/ids";
import type { Exclusion, PmvProject, Snippet, SourceMedia } from "../model/project";
import { type StashMarker, type StashSceneCore, markerLabel, sceneTitle } from "../stash/types";
import { EPS } from "../timeline/time";

export function sceneToSource(scene: StashSceneCore): SourceMedia | null {
  const f = scene.files[0];
  if (!f) return null;
  return {
    sceneId: scene.id,
    fileId: f.id,
    path: f.path,
    title: sceneTitle(scene),
    duration: f.duration,
    fps: f.frame_rate,
    width: f.width,
    height: f.height,
    hasAudio: !!f.audio_codec,
    videoCodec: f.video_codec || null,
  };
}

/** Marker range: [seconds, end_seconds) or `defaultLength` for point markers, clamped to the file. */
export function markerRange(m: StashMarker, sceneDuration: number, defaultLength: number): [number, number] {
  const start = Math.max(0, m.seconds);
  let end = m.end_seconds != null && m.end_seconds > start + EPS ? m.end_seconds : start + defaultLength;
  if (sceneDuration > 0) end = Math.min(end, sceneDuration);
  return [start, Math.max(end, start + 0.1)];
}

export function snippetFromMarker(m: StashMarker, sceneId: string, sceneDuration: number, defaultLength: number): Snippet {
  const [a, b] = markerRange(m, sceneDuration, defaultLength);
  return {
    id: uid("snip"),
    sceneId,
    markerId: m.id,
    in: a,
    out: b,
    label: markerLabel(m),
    tags: [m.primary_tag?.name, ...m.tags.map((t) => t.name)].filter((x): x is string => !!x),
  };
}

export function snippetFromRange(sceneId: string, a: number, b: number, label: string, tags: string[] = []): Snippet {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return { id: uid("snip"), sceneId, markerId: null, in: lo, out: hi, label, tags };
}

export function exclusionFromRange(sceneId: string, a: number, b: number, markerId: string | null = null): Exclusion {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return { id: uid("excl"), sceneId, markerId, in: lo, out: hi };
}

export function overlapsExclusion(exclusions: Exclusion[], sceneId: string, a: number, b: number): boolean {
  return exclusions.some((x) => x.sceneId === sceneId && x.in < b - EPS && x.out > a + EPS);
}

export const isMarkerInBin = (p: PmvProject, markerId: string) => p.bin.some((s) => s.markerId === markerId);
export const isMarkerExcluded = (p: PmvProject, markerId: string) => p.exclusions.some((x) => x.markerId === markerId);

/**
 * Free-form scene input: "12", "12, 34 56", "#78" or Stash links like "http://host/scenes/123?t=4".
 * Returns unique IDs in input order plus the tokens that are neither.
 */
export function parseSceneIdInput(text: string): { ids: string[]; invalid: string[] } {
  const ids: string[] = [];
  const invalid: string[] = [];
  for (const token of text.split(/[\s,;]+/)) {
    if (!token) continue;
    const m = token.match(/\/scenes\/(\d+)(?:[/?#]|$)/) ?? token.match(/^#?(\d+)$/);
    if (!m) invalid.push(token);
    else if (!ids.includes(m[1])) ids.push(m[1]);
  }
  return { ids, invalid };
}

/** A source may only leave the project when nothing references it any more. */
export function isSourceUsed(p: PmvProject, sceneId: string): boolean {
  return (
    p.bin.some((s) => s.sceneId === sceneId) ||
    p.exclusions.some((x) => x.sceneId === sceneId) ||
    p.tracks.some((t) => t.clips.some((c) => c.sceneId === sceneId))
  );
}
