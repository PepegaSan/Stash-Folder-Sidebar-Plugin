/** Stash GraphQL queries used for culling. */
import { gql } from "./graphql";
import type { StashMarkerWithScene, StashRef, StashScene } from "./types";

const SCENE_CORE = `
  id title date rating100
  files { id path basename duration width height frame_rate video_codec audio_codec }
  paths { screenshot stream preview sprite vtt }
  sceneStreams { url mime_type label }
  studio { id name }
  performers { id name }
  tags { id name }`;

const markerFields = (withEnd: boolean) => `
  id title seconds ${withEnd ? "end_seconds" : ""}
  primary_tag { id name } tags { id name }
  screenshot preview stream`;

// SceneMarker.end_seconds only exists on newer Stash versions; fall back once if the server rejects it.
let markerEndSupported = true;
async function withMarkerFallback<T>(run: (withEnd: boolean) => Promise<T>): Promise<T> {
  try {
    return await run(markerEndSupported);
  } catch (e) {
    if (markerEndSupported && /end_seconds/.test(String(e))) {
      markerEndSupported = false;
      return run(false);
    }
    throw e;
  }
}

export type SceneSort = "date" | "title" | "rating" | "created_at" | "duration" | "random";

export interface SceneSearch {
  q: string;
  tagIds: string[];
  performerIds: string[];
  hasMarkers: boolean;
  sort: SceneSort;
  /** Seed for the (deterministic) random sort. */
  seed: number;
  page: number;
  perPage: number;
}

export async function searchScenes(s: SceneSearch): Promise<{ count: number; scenes: StashScene[] }> {
  const sceneFilter: Record<string, unknown> = {};
  if (s.tagIds.length) sceneFilter.tags = { value: s.tagIds, modifier: "INCLUDES_ALL", depth: 0 };
  if (s.performerIds.length) sceneFilter.performers = { value: s.performerIds, modifier: "INCLUDES_ALL" };
  if (s.hasMarkers) sceneFilter.has_markers = "true";
  const filter = {
    q: s.q || undefined,
    page: s.page,
    per_page: s.perPage,
    sort: s.sort === "random" ? `random_${s.seed}` : s.sort,
    direction: s.sort === "title" ? "ASC" : "DESC",
  };
  return queryScenes(sceneFilter, filter);
}

/** Raw findScenes with full scene fields incl. markers (used by search and the generator). */
export function queryScenes(sceneFilter: Record<string, unknown>, findFilter: Record<string, unknown>): Promise<{ count: number; scenes: StashScene[] }> {
  return withMarkerFallback(async (withEnd) => {
    const data = await gql<{ findScenes: { count: number; scenes: StashScene[] } }>(
      `query PmvFindScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
        findScenes(filter: $filter, scene_filter: $scene_filter) {
          count scenes { ${SCENE_CORE} scene_markers { ${markerFields(withEnd)} } }
        }
      }`,
      { filter: findFilter, scene_filter: sceneFilter },
    );
    return data.findScenes;
  });
}

/** Raw findSceneMarkers with their scenes. */
export function queryMarkers(markerFilter: Record<string, unknown>, findFilter: Record<string, unknown>): Promise<{ count: number; markers: StashMarkerWithScene[] }> {
  return withMarkerFallback(async (withEnd) => {
    const data = await gql<{ findSceneMarkers: { count: number; scene_markers: StashMarkerWithScene[] } }>(
      `query PmvFindMarkers($filter: FindFilterType, $mf: SceneMarkerFilterType) {
        findSceneMarkers(filter: $filter, scene_marker_filter: $mf) {
          count scene_markers { ${markerFields(withEnd)} scene { ${SCENE_CORE} } }
        }
      }`,
      { filter: findFilter, mf: markerFilter },
    );
    return { count: data.findSceneMarkers.count, markers: data.findSceneMarkers.scene_markers };
  });
}

/** ID of a tag by exact name (e.g. the "Favorite" tag Stash UI uses), null if it doesn't exist. */
export async function tagIdByName(name: string): Promise<string | null> {
  const data = await gql<{ findTags: { tags: StashRef[] } }>(
    `query PmvTagByName($tf: TagFilterType) { findTags(tag_filter: $tf, filter: { per_page: 1 }) { tags { id name } } }`,
    { tf: { name: { value: name, modifier: "EQUALS" } } },
  );
  return data.findTags.tags[0]?.id ?? null;
}

/** Stash's scene preview settings (how preview pieces map back onto the scene). */
export async function previewConfig(): Promise<{ previewSegments: number; previewSegmentDuration: number; previewExcludeStart: string; previewExcludeEnd: string } | null> {
  try {
    const data = await gql<{ configuration: { general: { previewSegments: number; previewSegmentDuration: number; previewExcludeStart: string; previewExcludeEnd: string } } }>(
      `query PmvPreviewCfg { configuration { general { previewSegments previewSegmentDuration previewExcludeStart previewExcludeEnd } } }`,
    );
    return data.configuration.general;
  } catch {
    return null;
  }
}

/**
 * Scenes by id. Stash rejects the whole batch when a single id is unknown ("scene with id X not found"),
 * so on that error the ids are asked one by one and unknown ones are simply left out.
 */
export async function fetchScenes(ids: string[]): Promise<StashScene[]> {
  if (!ids.length) return [];
  try {
    return await withMarkerFallback(async (withEnd) => {
      const data = await gql<{ findScenes: { scenes: StashScene[] } }>(
        `query PmvScenesById($ids: [ID!], $filter: FindFilterType) {
          findScenes(ids: $ids, filter: $filter) { scenes { ${SCENE_CORE} scene_markers { ${markerFields(withEnd)} } } }
        }`,
        { ids, filter: { per_page: -1 } },
      );
      return data.findScenes.scenes;
    });
  } catch (e) {
    if (!/not found/i.test(String(e))) throw e;
    if (ids.length === 1) return [];
    return (await Promise.all(ids.map((id) => fetchScenes([id])))).flat();
  }
}

export interface MarkerSearch {
  q: string;
  tagIds: string[];
  page: number;
  perPage: number;
}

/** Library-wide marker search, e.g. "every marker tagged X" – the fastest way to fill the bin. */
export async function searchMarkers(s: MarkerSearch): Promise<{ count: number; markers: StashMarkerWithScene[] }> {
  const markerFilter: Record<string, unknown> = {};
  if (s.tagIds.length) markerFilter.tags = { value: s.tagIds, modifier: "INCLUDES", depth: 0 };
  return queryMarkers(markerFilter, { q: s.q || undefined, page: s.page, per_page: s.perPage, sort: "created_at", direction: "DESC" });
}

export async function findTags(q: string): Promise<StashRef[]> {
  const data = await gql<{ findTags: { tags: StashRef[] } }>(
    `query PmvTags($filter: FindFilterType) { findTags(filter: $filter) { tags { id name } } }`,
    { filter: { q, per_page: 20, sort: "name", direction: "ASC" } },
  );
  return data.findTags.tags;
}

export async function findPerformers(q: string): Promise<StashRef[]> {
  const data = await gql<{ findPerformers: { performers: StashRef[] } }>(
    `query PmvPerformers($filter: FindFilterType) { findPerformers(filter: $filter) { performers { id name } } }`,
    { filter: { q, per_page: 20, sort: "name", direction: "ASC" } },
  );
  return data.findPerformers.performers;
}
