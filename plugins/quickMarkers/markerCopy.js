// Copying scene markers between scenes — shared by quickMarkers.js (classic Stash, loaded
// with import() on first use) and stashui.js (Stash UI). No UI here, only data.
//
// The clipboard lives in localStorage, so a copy in classic Stash can be pasted in Stash UI
// and the other way round (same origin). "Same videos" are scenes whose video fingerprint
// (phash) is (almost) the same and whose length matches. The last transfer can be undone
// (its marker ids are kept in localStorage too, for a day).

export const CLIPBOARD_KEY = "quickMarkers.clipboard";
export const UNDO_KEY = "quickMarkers.lastTransfer";
// Fired when the clipboard or the undo record changes (the name is kept for compatibility).
export const CLIPBOARD_EVENT = "quickMarkers:clipboard";
const UNDO_MAX_AGE = 24 * 60 * 60 * 1000;

// Stash's phash_distance matches a Hamming distance *below* this value: 5 = up to 4 differing bits.
const PHASH_DISTANCE = 5;
// Same videos differ in length by at most this much (seconds); up to SURE_DURATION_DIFF they are preselected.
const MAX_DURATION_DIFF = 3;
const SURE_DURATION_DIFF = 1;
// Clips shorter than this are never preselected: 25 frames of a few seconds look alike too easily.
const SHORT_CLIP = 30;
// Two markers are the same when tag, start and end are this close (seconds).
const SAME_MARKER_TOLERANCE = 0.5;

const MARKER_FIELDS = "id title seconds end_seconds primary_tag { id name } tags { id name }";
const SCENE_FIELDS = `id title paths { screenshot } files { path basename duration fingerprints { type value } } scene_markers { ${MARKER_FIELDS} }`;

export async function gqlFetch(query, variables) {
  const res = await fetch("/graphql", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error("Stash answered " + res.status);
  const json = await res.json();
  if (json.errors && json.errors.length) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data;
}

const round = (n) => Math.round(n * 1000) / 1000;
const byTime = (a, b) => a.seconds - b.seconds;

function toScene(raw) {
  const files = raw.files || [];
  const file = files[0] || {};
  const phashes = [];
  files.forEach((f) =>
    (f.fingerprints || []).forEach((fp) => {
      if (fp.type === "phash" && fp.value && phashes.indexOf(fp.value) < 0) phashes.push(fp.value);
    })
  );
  return {
    id: String(raw.id),
    title: raw.title || file.basename || "Scene " + raw.id,
    path: file.path || "",
    screenshot: (raw.paths && raw.paths.screenshot) || "",
    duration: file.duration || 0,
    durations: files.map((f) => f.duration || 0),
    phashes,
    markers: (raw.scene_markers || []).map(toMarker).sort(byTime),
  };
}

function toMarker(m) {
  return {
    title: m.title || "",
    seconds: m.seconds,
    end_seconds: m.end_seconds != null ? m.end_seconds : null,
    primaryTag: m.primary_tag ? { id: String(m.primary_tag.id), name: m.primary_tag.name } : null,
    tags: (m.tags || []).map((t) => ({ id: String(t.id), name: t.name })),
  };
}

export async function loadScene(gql, sceneId) {
  const d = await gql(`query($id: ID!) { findScene(id: $id) { ${SCENE_FIELDS} } }`, { id: String(sceneId) });
  if (!d || !d.findScene) throw new Error("Scene " + sceneId + " not found");
  return toScene(d.findScene);
}

// ---------- Clipboard ----------

export function readClipboard() {
  try {
    const raw = localStorage.getItem(CLIPBOARD_KEY);
    const data = raw ? JSON.parse(raw) : null;
    return data && Array.isArray(data.markers) && data.markers.length ? data : null;
  } catch (e) {
    return null;
  }
}

function writeClipboard(data) {
  try {
    if (data) localStorage.setItem(CLIPBOARD_KEY, JSON.stringify(data));
    else localStorage.removeItem(CLIPBOARD_KEY);
  } catch (e) {
    throw new Error("The browser does not allow storing the copied markers.");
  }
  window.dispatchEvent(new Event(CLIPBOARD_EVENT));
}

export const clearClipboard = () => writeClipboard(null);

// → the clipboard content; throws when the scene has no markers.
export async function copySceneMarkers(gql, sceneId) {
  const scene = await loadScene(gql, sceneId);
  if (!scene.markers.length) throw new Error("This scene has no markers to copy.");
  const data = {
    v: 1,
    sceneId: scene.id,
    sceneTitle: scene.title,
    duration: scene.duration,
    copiedAt: Date.now(),
    markers: scene.markers,
  };
  writeClipboard(data);
  return data;
}

// ---------- Planning ----------

const close = (a, b) => Math.abs(a - b) <= SAME_MARKER_TOLERANCE;

function sameMarker(a, b) {
  const tagA = a.primaryTag && a.primaryTag.id;
  const tagB = b.primaryTag && b.primaryTag.id;
  if (tagA !== tagB || !close(a.seconds, b.seconds)) return false;
  if (a.end_seconds == null || b.end_seconds == null) return a.end_seconds == null && b.end_seconds == null;
  return close(a.end_seconds, b.end_seconds);
}

/**
 * What pasting `source` markers into a scene would do.
 * → [{ marker, seconds, end_seconds, status: "new" | "exists" | "outside" }] sorted by time.
 * offset (seconds) moves every marker; markers that then start before 0 or after the
 * end of the target are "outside", ends are cut at the end of the target.
 */
export function planCopy(source, target, offset) {
  const shift = Number(offset) || 0;
  const duration = target.duration || 0;
  const planned = [];
  return source
    .slice()
    .sort(byTime)
    .map((m) => {
      const seconds = round(m.seconds + shift);
      let end = m.end_seconds != null ? round(m.end_seconds + shift) : null;
      if (end != null && duration) end = Math.min(end, round(duration));
      if (end != null && end <= seconds + 0.05) end = null;
      const item = { marker: m, seconds, end_seconds: end, status: "new" };
      const moved = { primaryTag: m.primaryTag, seconds, end_seconds: end };
      if (seconds < 0 || (duration && seconds > duration)) item.status = "outside";
      else if (target.markers.some((x) => sameMarker(x, moved)) || planned.some((x) => sameMarker(x, moved))) item.status = "exists";
      else planned.push(moved);
      return item;
    });
}

export const countNew = (plan) => plan.filter((p) => p.status === "new").length;

function markerInput(sceneId, item) {
  const m = item.marker;
  const input = {
    scene_id: String(sceneId),
    title: m.title,
    seconds: item.seconds,
    primary_tag_id: m.primaryTag.id,
    tag_ids: m.tags.map((t) => t.id).filter((id) => id !== m.primaryTag.id),
  };
  if (item.end_seconds != null) input.end_seconds = item.end_seconds;
  return input;
}

export const createWithGql = (gql) => (input) =>
  gql("mutation($input: SceneMarkerCreateInput!) { sceneMarkerCreate(input: $input) { id } }", { input });

// The id of a created marker, from a plain GraphQL answer or an Apollo mutation result.
function createdId(result) {
  const data = result && (result.sceneMarkerCreate ? result : result.data);
  return data && data.sceneMarkerCreate ? String(data.sceneMarkerCreate.id) : null;
}

/**
 * Creates the "new" items of a plan one after the other.
 * create(input, isLast) → promise; onProgress(done, total); created: optional array that gets
 * the new marker ids (also when a later one fails, so they can still be undone). → number created.
 */
export async function applyPlan(create, sceneId, plan, onProgress, created) {
  const items = plan.filter((p) => p.status === "new" && p.marker.primaryTag);
  for (let i = 0; i < items.length; i++) {
    const id = createdId(await create(markerInput(sceneId, items[i]), i === items.length - 1));
    if (created && id) created.push(id);
    if (onProgress) onProgress(i + 1, items.length);
  }
  return items.length;
}

// ---------- Undo ----------

// Remembers the markers of one transfer (replaces the previous one). sceneIds: the scenes they went to.
export function rememberTransfer(ids, sceneIds) {
  if (!ids || !ids.length) return;
  try {
    localStorage.setItem(UNDO_KEY, JSON.stringify({ ids, sceneIds: sceneIds.map(String), at: Date.now() }));
  } catch (e) {
    return;
  }
  window.dispatchEvent(new Event(CLIPBOARD_EVENT));
}

// → { ids, sceneIds, at } of the last transfer, or null (none, or older than a day).
export function readUndo() {
  try {
    const rec = JSON.parse(localStorage.getItem(UNDO_KEY) || "null");
    return rec && Array.isArray(rec.ids) && rec.ids.length && Date.now() - rec.at < UNDO_MAX_AGE ? rec : null;
  } catch (e) {
    return null;
  }
}

// Deletes the markers of the last transfer. → the undone record (null if there was none).
export async function undoLastTransfer(gql) {
  const rec = readUndo();
  if (!rec) return null;
  try {
    await gql("mutation($ids: [ID!]!) { sceneMarkersDestroy(ids: $ids) }", { ids: rec.ids });
  } catch (e) {
    // Some may be gone already (deleted by hand): delete the rest one by one.
    for (const id of rec.ids) {
      try {
        await gql("mutation($id: ID!) { sceneMarkerDestroy(id: $id) }", { id });
      } catch (err) {
        /* already deleted */
      }
    }
  }
  try {
    localStorage.removeItem(UNDO_KEY);
  } catch (e) {
    /* ignore */
  }
  window.dispatchEvent(new Event(CLIPBOARD_EVENT));
  return rec;
}

// ---------- Same videos ----------

function durationDiff(a, b) {
  let best = Infinity;
  (a.durations.length ? a.durations : [a.duration]).forEach((x) =>
    (b.durations.length ? b.durations : [b.duration]).forEach((y) => {
      best = Math.min(best, Math.abs(x - y));
    })
  );
  return best;
}

/**
 * Scenes with (almost) the same video as `scene` (from loadScene).
 * → [{ scene, durationDiff, short, sure, plan, add }] — sure: length within 1 s and not a short clip (those are
 * preselected); plan / add = what copying this scene's markers there would do.
 * Empty when `scene` has no phash yet (scene.phashes.length === 0).
 */
export async function findSameVideos(gql, scene) {
  const found = new Map();
  for (const phash of scene.phashes) {
    const d = await gql(
      `query($f: SceneFilterType, $p: FindFilterType) { findScenes(scene_filter: $f, filter: $p) { scenes { ${SCENE_FIELDS} } } }`,
      { f: { phash_distance: { value: phash, modifier: "EQUALS", distance: PHASH_DISTANCE } }, p: { per_page: 50 } }
    );
    ((d && d.findScenes && d.findScenes.scenes) || []).forEach((raw) => {
      if (String(raw.id) !== scene.id) found.set(String(raw.id), toScene(raw));
    });
  }
  return Array.from(found.values())
    .map((other) => {
      const diff = durationDiff(scene, other);
      const plan = planCopy(scene.markers, other, 0);
      const short = Math.min(scene.duration, other.duration) < SHORT_CLIP;
      return { scene: other, durationDiff: diff, short, sure: diff <= SURE_DURATION_DIFF && !short, plan, add: countNew(plan) };
    })
    .filter((x) => x.durationDiff <= MAX_DURATION_DIFF)
    .sort((a, b) => a.durationDiff - b.durationDiff);
}

// ---------- Library overview (groups of same videos) ----------

// findDuplicateScenes counts the distance inclusively: 4 = up to 4 differing bits, like PHASH_DISTANCE above.
const GROUP_DISTANCE = PHASH_DISTANCE - 1;

/**
 * One group of same videos, seen from `sourceId` (default: the scene with the most markers).
 * → { key, scenes, source, targets: [{ scene, plan, add, durationDiff, short, sure }], missing }
 *   missing = markers of the source that the others don't have yet.
 */
export function analyzeGroup(scenes, sourceId) {
  const source =
    scenes.find((s) => s.id === String(sourceId)) ||
    scenes.slice().sort((a, b) => b.markers.length - a.markers.length || Number(a.id) - Number(b.id))[0];
  const targets = scenes
    .filter((s) => s !== source)
    .map((s) => {
      const plan = planCopy(source.markers, s, 0);
      const diff = durationDiff(source, s);
      const short = Math.min(source.duration, s.duration) < SHORT_CLIP;
      return { scene: s, plan, add: countNew(plan), durationDiff: diff, short, sure: diff <= SURE_DURATION_DIFF && !short };
    });
  const key = scenes.map((s) => s.id).sort((a, b) => Number(a) - Number(b)).join(",");
  return { key, scenes, source, targets, missing: targets.reduce((n, x) => n + x.add, 0) };
}

/**
 * All groups of same videos in the library (Stash's duplicate search over the phashes).
 * Groups where a video has markers the others lack come first. → [analyzeGroup(...)]
 */
export async function findSameVideoGroups(gql) {
  const d = await gql(
    `query($d: Int, $dd: Float) { findDuplicateScenes(distance: $d, duration_diff: $dd) { ${SCENE_FIELDS} } }`,
    { d: GROUP_DISTANCE, dd: MAX_DURATION_DIFF },
    { heavy: true }
  );
  return ((d && d.findDuplicateScenes) || [])
    .map((group) => analyzeGroup(group.map(toScene)))
    .sort((a, b) => b.missing - a.missing || b.source.markers.length - a.source.markers.length);
}

// Loads one group again (after copying), keeping its source. → analyzeGroup(...)
export async function reloadGroup(gql, group) {
  const scenes = [];
  for (const s of group.scenes) scenes.push(await loadScene(gql, s.id));
  return analyzeGroup(scenes, group.source.id);
}

// How many scenes have a phash: only those can be found as same videos. → { total, withPhash }
export async function phashCoverage(gql) {
  const d = await gql(
    'query { all: findScenes(filter: { per_page: 0 }) { count } missing: findScenes(filter: { per_page: 0 }, scene_filter: { is_missing: "phash" }) { count } }'
  );
  const total = (d && d.all && d.all.count) || 0;
  return { total, withPhash: Math.max(0, total - ((d && d.missing && d.missing.count) || 0)) };
}

// Generates the missing phashes of the whole library (a Stash job, see Tasks). → job id
export async function generatePhashes(gql) {
  const d = await gql("mutation { metadataGenerate(input: { phashes: true, overwrite: false }) }");
  return d && d.metadataGenerate;
}

export function formatTime(seconds) {
  const sign = seconds < 0 ? "−" : ""; // a shifted marker can land before the start
  const s = Math.floor(Math.abs(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return sign + (h ? h + ":" + String(m).padStart(2, "0") + ":" + sec : m + ":" + sec);
}

export function markerLabel(m) {
  return m.title || (m.primaryTag ? m.primaryTag.name : "Marker");
}
