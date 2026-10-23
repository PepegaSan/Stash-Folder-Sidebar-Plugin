/**
 * Stash's own saved scene filters (the ones saved in the scene list) as a clip source of the generator. A saved
 * filter keeps its criteria in the interface's form ({ value: { items, excluded, depth }, modifier } …); they are
 * turned into the GraphQL SceneFilterType they stand for – ported from Stash UI's stashfilters.js, with
 * resolution/orientation mapped to their enums. Criteria that can't be turned are named, not guessed.
 */
import { gql } from "./graphql";
import type { StashRef } from "./types";

interface SavedFilterRaw {
  id: string;
  name: string;
  find_filter: { q: string | null; sort: string | null; direction: string | null } | null;
  object_filter: Record<string, unknown> | null;
}

export interface SavedSceneFilter {
  id: string;
  name: string;
  /** Search text of the filter. */
  q: string;
  filter: Record<string, unknown>;
  /** Criteria that were left out (not understood). */
  skipped: string[];
}

const Q = `query PmvSavedFilters { findSavedFilters(mode: SCENES) { id name find_filter { q sort direction } object_filter } }`;

async function loadAll(): Promise<SavedFilterRaw[]> {
  const data = await gql<{ findSavedFilters: SavedFilterRaw[] | null }>(Q);
  return data.findSavedFilters ?? [];
}

/** The saved scene filters, by name. */
export async function listSavedSceneFilters(): Promise<StashRef[]> {
  return (await loadAll()).map((f) => ({ id: String(f.id), name: f.name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** A saved filter, read fresh (it may have been changed in Stash since); null when it no longer exists. */
export async function savedSceneFilter(id: string): Promise<SavedSceneFilter | null> {
  const sf = (await loadAll()).find((x) => String(x.id) === String(id));
  if (!sf) return null;
  const { filter, skipped } = convertSavedFilter(sf.object_filter);
  return { id: String(sf.id), name: sf.name, q: sf.find_filter?.q ?? "", filter, skipped };
}

// Stash's labels (utils/resolution.ts, orientation.ts) -> GraphQL enums
const RESOLUTION: Record<string, string> = {
  "144p": "VERY_LOW",
  "240p": "LOW",
  "360p": "R360P",
  "480p": "STANDARD",
  "540p": "WEB_HD",
  "720p": "STANDARD_HD",
  "1080p": "FULL_HD",
  "1440p": "QUAD_HD",
  "1920p": "VR_HD",
  "4k": "FOUR_K",
  "5k": "FIVE_K",
  "6k": "SIX_K",
  "7k": "SEVEN_K",
  "8k": "EIGHT_K",
  huge: "HUGE",
};
const RESOLUTION_KEYS = new Set(["resolution", "average_resolution"]);
const NULLISH = new Set(["IS_NULL", "NOT_NULL"]);
/** DuplicationCriterionInput's flags (Stash 0.31). */
const DUPLICATE_FLAGS = ["duplicated", "phash", "url", "stash_id", "title"];
/** Number criteria: "is empty" still needs an Int value (any). Other empty criteria take a string. */
const NUMBER_KEYS = new Set(["rating100", "o_counter", "play_count", "duration", "resume_time", "play_duration", "file_count", "tag_count", "performer_count", "performer_age", "framerate", "bitrate", "interactive_speed", "id"]);
const emptyValue = (key: string) => (NUMBER_KEYS.has(key) ? 0 : "");
const BOOL = new Set(["organized", "interactive", "performer_favorite", "ignore_auto_tag", "favorite"]);
/** Asked as a plain string: has_markers "true"/"false", is_missing the name of the missing field. */
const PLAIN_STRING = new Set(["has_markers", "is_missing"]);

const ids = (list: unknown): string[] =>
  (Array.isArray(list) ? list : []).map((x) => String(x && typeof x === "object" ? (x as { id?: unknown }).id : x)).filter((x) => x && x !== "undefined");
const int = (v: unknown): number | null => (v === "" || v == null || isNaN(Number(v)) ? null : Math.round(Number(v)));

/** One saved criterion -> its GraphQL criterion; undefined = can't be turned. */
function criterion(key: string, c: unknown): unknown {
  if (!c || typeof c !== "object") return undefined;
  const { modifier: m, value: v } = c as { modifier?: string; value?: unknown };
  const modifier = m || undefined;
  if (BOOL.has(key)) {
    const b = typeof v === "boolean" ? v : String(v) === "true" ? true : String(v) === "false" ? false : null;
    return b ?? undefined;
  }
  if (PLAIN_STRING.has(key)) return typeof v === "boolean" || (typeof v === "string" && v) ? String(v) : undefined;
  if (RESOLUTION_KEYS.has(key)) {
    const e = typeof v === "string" ? (RESOLUTION[v.toLowerCase()] ?? (Object.values(RESOLUTION).includes(v) ? v : null)) : null;
    return e ? { value: e, modifier: modifier || "EQUALS" } : undefined;
  }
  if (key === "duplicated") {
    // { phash: true, title: false, … } as Stash saves it; an old filter saved "true" (= phash duplicates)
    if (typeof v === "string" || typeof v === "boolean") return String(v) === "true" || String(v) === "false" ? { phash: String(v) === "true" } : undefined;
    const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const f of DUPLICATE_FLAGS) if (typeof o[f] === "boolean") out[f] = o[f];
    if (int(o.distance) != null) out.distance = int(o.distance);
    return Object.keys(out).length ? out : undefined;
  }
  if (key === "stash_id_endpoint") {
    const o = (v ?? {}) as { endpoint?: string; stashID?: string; stash_id?: string };
    return { endpoint: o.endpoint || undefined, stash_id: o.stashID || o.stash_id || undefined, modifier: modifier || "EQUALS" };
  }
  if (key === "orientation") return Array.isArray(v) && v.length && v.every((x) => typeof x === "string") ? { value: v.map((x: string) => x.toUpperCase()) } : undefined;
  if (v && typeof v === "object" && !Array.isArray(v) && Array.isArray((v as { items?: unknown }).items)) {
    // tags, performers, studios …: the chosen items (+ excluded ones), tags and studios with their depth
    const o = v as { items: unknown[]; excluded?: unknown[]; depth?: unknown };
    const out: Record<string, unknown> = { value: ids(o.items), modifier: modifier || "INCLUDES" };
    if (Array.isArray(o.excluded) && o.excluded.length) out.excludes = ids(o.excluded);
    if (o.depth != null) out.depth = Number(o.depth);
    if (NULLISH.has(String(out.modifier))) delete out.value;
    return out;
  }
  if (v && typeof v === "object" && !Array.isArray(v) && ("value" in v || "value2" in v)) {
    const o = v as { value?: unknown; value2?: unknown; distance?: unknown };
    if ("distance" in o) return { value: String(o.value ?? ""), distance: int(o.distance) ?? 0, modifier: modifier || "EQUALS" }; // phash
    // a number or a date/timestamp (or a range of them) – a date has dashes; anything else isn't guessed
    const num = int(o.value) != null && (o.value2 == null || int(o.value2) != null) && !/[-:T]/.test(String(o.value));
    if (NULLISH.has(String(modifier))) return { modifier, value: emptyValue(key) };
    if (!num && !/^\d{4}-\d{2}/.test(String(o.value ?? ""))) return undefined;
    const out: Record<string, unknown> = { modifier: modifier || "EQUALS", value: num ? int(o.value) : String(o.value ?? "") };
    if (o.value2 != null && o.value2 !== "") out.value2 = num ? int(o.value2) : String(o.value2);
    return out;
  }
  if (Array.isArray(v)) return v.length && v.every((x) => typeof x === "string") ? { value: v } : undefined;
  if (NULLISH.has(String(modifier))) return { modifier, value: emptyValue(key) };
  if (typeof v === "number") return { value: Math.round(v), modifier: modifier || "EQUALS" };
  if (typeof v === "string") return { value: v, modifier: modifier || "INCLUDES" };
  return undefined;
}

/** object_filter -> { filter, skipped: criterion names } */
export function convertSavedFilter(obj: unknown): { filter: Record<string, unknown>; skipped: string[] } {
  const filter: Record<string, unknown> = {};
  const skipped: string[] = [];
  const src = obj && typeof obj === "object" ? (obj as Record<string, unknown>) : {};
  for (const [key, c] of Object.entries(src)) {
    let g: unknown;
    try {
      g = criterion(key, c);
    } catch {
      g = undefined;
    }
    if (g === undefined || (g && typeof g === "object" && (g as { value?: unknown }).value === null)) skipped.push(key);
    else filter[key] = g;
  }
  return { filter, skipped };
}
