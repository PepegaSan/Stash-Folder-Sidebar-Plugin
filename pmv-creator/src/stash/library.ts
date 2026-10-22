/** Writes to the Stash library: the generator's skip tag and the labels of a finished PMV. */
import { gql } from "./graphql";
import { tagIdByName } from "./queries";
import type { StashRef } from "./types";

/** Scenes with this tag never end up in a generated PMV (⊘ "never use it again"). */
export const SKIP_TAG = "PMV Creator: skip";
/** Every PMV labeled after its render gets this tag. */
export const PMV_TAG = "PMV Creator";

const tagIds = new Map<string, string | null>();

/** Tag id by exact name, remembered for the session (also "doesn't exist"). */
export async function cachedTagId(name: string): Promise<string | null> {
  if (!tagIds.has(name)) tagIds.set(name, await tagIdByName(name));
  return tagIds.get(name) ?? null;
}

/** Tag id by name; the tag is created when Stash doesn't have it yet. */
export async function ensureTag(name: string): Promise<string> {
  const known = await cachedTagId(name);
  if (known) return known;
  const data = await gql<{ tagCreate: { id: string } }>(`mutation PmvTagCreate($input: TagCreateInput!) { tagCreate(input: $input) { id } }`, { input: { name } });
  tagIds.set(name, data.tagCreate.id);
  return data.tagCreate.id;
}

/** Adds the tag to the scenes or removes it, leaving their other tags alone. */
export async function setSceneTag(sceneIds: string[], tagId: string, on: boolean): Promise<void> {
  await gql(`mutation PmvSceneTag($input: BulkSceneUpdateInput!) { bulkSceneUpdate(input: $input) { id } }`, {
    input: { ids: sceneIds, tag_ids: { ids: [tagId], mode: on ? "ADD" : "REMOVE" } },
  });
}

export interface SceneLabels {
  id: string;
  title: string | null;
  performers: StashRef[];
  tags: StashRef[];
}

type SceneWithFiles = SceneLabels & { files: Array<{ path: string }> };

const scenesByPath = async (value: string, modifier: "EQUALS" | "INCLUDES"): Promise<SceneWithFiles[]> =>
  (
    await gql<{ findScenes: { scenes: SceneWithFiles[] } }>(
      `query PmvSceneByFile($sf: SceneFilterType, $filter: FindFilterType) {
        findScenes(scene_filter: $sf, filter: $filter) { scenes { id title performers { id name } tags { id name } files { path } } }
      }`,
      // INCLUDES matches the words of the value one by one – the newest scenes first, a fresh render is among them
      { sf: { path: { value, modifier } }, filter: { per_page: 40, sort: "created_at", direction: "DESC" } },
    )
  ).findScenes.scenes;

/**
 * The scene of a file (a fresh render), null while Stash hasn't scanned it. The exact path first; then by file
 * name, in case Stash spells the folder differently (separators, a mapped share).
 */
export async function findSceneByFile(path: string): Promise<SceneLabels | null> {
  const base = path.split(/[\\/]/).pop() ?? path;
  const norm = (x: string) => x.replace(/\\/g, "/");
  let hit = (await scenesByPath(path, "EQUALS"))[0];
  if (!hit) {
    const named = (await scenesByPath(base, "INCLUDES")).filter((s) => s.files.some((f) => norm(f.path).endsWith(`/${base}`) || f.path === base));
    hit = named.find((s) => s.files.some((f) => norm(f.path) === norm(path))) ?? named[0];
  }
  return hit ? { id: hit.id, title: hit.title, performers: hit.performers, tags: hit.tags } : null;
}

export async function updateScene(input: { id: string; title?: string; details?: string; performer_ids?: string[]; tag_ids?: string[] }): Promise<void> {
  await gql(`mutation PmvSceneUpdate($input: SceneUpdateInput!) { sceneUpdate(input: $input) { id } }`, { input });
}
