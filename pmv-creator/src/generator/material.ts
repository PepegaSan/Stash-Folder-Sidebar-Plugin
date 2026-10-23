/** Generator stage "clips": Stash filters (ported from Pepega's buildFilter) and candidates from scenes/markers. */
import { snippetFromMarker, snippetFromRange } from "../culling/culling";
import type { Snippet } from "../model/project";
import { type StashMarker, type StashRef, type StashSceneCore, sceneTitle } from "../stash/types";

export interface MaterialItem {
  snippet: Snippet;
  performers: string[];
  /** Marker clips start at their marker (and stay inside it when it has an end). */
  fixedStart: boolean;
}

/** saved = one of Stash's own saved scene filters (stash/savedFilters.ts). */
export type ClipSource = "filter" | "watched" | "project" | "bin" | "saved";
export type ClipKind = "scenes" | "markers";
export type AllAny = "all" | "any";
export type Shape = "all" | "portrait" | "landscape";

export interface TagStage {
  tags: StashRef[];
  xtags: StashRef[];
}

export interface ClipOptions {
  source: ClipSource;
  kind: ClipKind;
  tags: StashRef[];
  xtags: StashRef[];
  tagMode: AllAny;
  /** Tags every clip must have (e.g. a model); the normal tags only count together with them. */
  mainTags: StashRef[];
  performers: StashRef[];
  perfMode: AllAny;
  favoritesOnly: boolean;
  /** 0..100 (Stash rating100), 0 = any. */
  minRating: number;
  /** Scenes at least this long, minutes. */
  minMinutes: number;
  /** 0 = any, else "up to" 720 / 1080 / 1440. */
  maxRes: number;
  shape: Shape;
  pathContains: string;
  /** Marker tag filter also matches sub-tags. */
  markerSubTags: boolean;
  /** Max scenes / markers fetched (random order with the seed). */
  limit: number;
  /** Scenes: use their markers as clips where they have some. */
  preferMarkers: boolean;
  /** Scenes: skip this share at the start and end (intros, credits), percent. */
  skipPercent: number;
  markerLength: number;
  stagesOn: boolean;
  stages: TagStage[];
  /** source "saved": the saved filter (read fresh from Stash on every run). */
  savedFilter: StashRef | null;
}

const MAX_RES: Record<number, string> = { 720: "FULL_HD", 1080: "QUAD_HD", 1440: "VR_HD" }; // "up to …" = below the next size

const ids = (refs: StashRef[]) => refs.map((r) => r.id);

/** Tags that are asked for in "any" mode next to main tags – Stash can't express that in one filter. */
export const clientAnyTags = (o: ClipOptions, favId: string | null): string[] =>
  o.tagMode === "any" && (o.mainTags.length || (o.favoritesOnly && favId)) ? ids(o.tags).filter((id) => !ids(o.mainTags).includes(id)) : [];

/** SceneFilterType for the options (tags may be left out, e.g. when they are asked on markers instead). */
export function buildSceneFilter(o: ClipOptions, favId: string | null, withTags = true): Record<string, unknown> {
  const f: Record<string, unknown> = {};
  const tags = withTags ? ids(o.tags) : [];
  const xtags = withTags ? ids(o.xtags) : [];
  const fav = o.favoritesOnly && favId ? favId : null;
  const main = ids(o.mainTags);
  if (o.tagMode === "any" && tags.length > 1 && !main.length && !fav) {
    f.tags = { value: tags, modifier: "INCLUDES", depth: 0, ...(xtags.length ? { excludes: xtags } : {}) };
  } else {
    // with main tags + "any", the any-tags are checked on the client (clientAnyTags)
    const inc = [...main, ...(o.tagMode === "any" && (main.length || fav) ? [] : tags)];
    if (fav) inc.push(fav);
    if (inc.length || xtags.length) f.tags = { value: [...new Set(inc)], modifier: "INCLUDES_ALL", depth: 0, ...(xtags.length ? { excludes: xtags } : {}) };
  }
  if (o.performers.length) f.performers = { value: ids(o.performers), modifier: o.perfMode === "any" && o.performers.length > 1 ? "INCLUDES" : "INCLUDES_ALL" };
  if (o.minRating > 0) f.rating100 = { value: o.minRating - 1, modifier: "GREATER_THAN" };
  if (MAX_RES[o.maxRes]) f.resolution = { value: MAX_RES[o.maxRes], modifier: "LESS_THAN" };
  if (o.shape !== "all") f.orientation = { value: [o.shape.toUpperCase()] };
  if (o.pathContains.trim()) f.path = { value: o.pathContains.trim(), modifier: "INCLUDES" };
  f.duration = { value: Math.max(4, Math.round(o.minMinutes * 60)), modifier: "GREATER_THAN" };
  return f;
}

/** SceneMarkerFilterType: the tags are asked on the marker (sub-tags optional), everything else on its scene. */
export function buildMarkerFilter(o: ClipOptions, favId: string | null): Record<string, unknown> {
  const m: Record<string, unknown> = { scene_filter: buildSceneFilter(o, favId, false) };
  if (o.tags.length || o.xtags.length) {
    m.tags = {
      value: ids(o.tags),
      modifier: o.tagMode === "any" && o.tags.length > 1 ? "INCLUDES" : "INCLUDES_ALL",
      depth: o.markerSubTags ? -1 : 0,
      ...(o.xtags.length ? { excludes: ids(o.xtags) } : {}),
    };
  }
  return m;
}

export interface SceneWithMarkers extends StashSceneCore {
  scene_markers?: StashMarker[];
}

export function sceneItems(scene: SceneWithMarkers, o: Pick<ClipOptions, "preferMarkers" | "skipPercent" | "markerLength">): MaterialItem[] {
  const dur = scene.files[0]?.duration ?? 0;
  if (!(dur > 0)) return [];
  const performers = scene.performers.map((p) => p.id);
  const markers = scene.scene_markers ?? [];
  if (o.preferMarkers && markers.length) {
    return markers.map((m) => ({ snippet: snippetFromMarker(m, scene.id, dur, o.markerLength), performers, fixedStart: true }));
  }
  const skip = Math.min(40, Math.max(0, o.skipPercent)) / 100;
  const a = dur * skip;
  const b = dur * (1 - skip);
  return [{ snippet: snippetFromRange(scene.id, a, b, sceneTitle(scene)), performers, fixedStart: false }];
}

export function markerItem(m: StashMarker, scene: StashSceneCore, markerLength: number): MaterialItem {
  return {
    snippet: snippetFromMarker(m, scene.id, scene.files[0]?.duration ?? 0, markerLength),
    performers: scene.performers.map((p) => p.id),
    fixedStart: true,
  };
}
