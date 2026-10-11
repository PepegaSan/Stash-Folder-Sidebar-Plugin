// Copying scene markers between scenes — shared by quickMarkers.js (classic Stash, loaded
// with import() on first use) and stashui.js (Stash UI). No UI here, only data.
//
// The clipboard lives in localStorage, so a copy in classic Stash can be pasted in Stash UI
// and the other way round (same origin). "Same videos" are scenes whose video fingerprint
// (phash) is (almost) the same and whose length matches. A transfer can also replace the
// markers of the target (delete the ones the source doesn't have). The last transfer can be
// undone (the new marker ids and the deleted markers are kept in localStorage too, for a day).

export const CLIPBOARD_KEY = "quickMarkers.clipboard";
export const UNDO_KEY = "quickMarkers.lastTransfer";
// Marker Sync groups ticked off by hand (their keys), so they leave the list until restored.
export const DONE_KEY = "quickMarkers.syncDone";
// Fired when the clipboard, the undo record or the ticked-off groups change (the name is kept for compatibility).
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
    id: m.id != null ? String(m.id) : null,
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

// ---------- Marker names (transfer only some of them) ----------
// A name filter is null (all markers) or an array of names; a marker's name is what Stash shows:
// its title, or its primary tag when it has none (markerLabel).

// The markers whose name is in `names` (all of them when names is null or empty).
export function pickMarkers(markers, names) {
  if (!names || !names.length) return markers;
  return markers.filter((m) => names.indexOf(markerLabel(m)) >= 0);
}

/**
 * The marker names of `scenes` (anything with .markers) for the filter chips: count = how many
 * markers have the name, videos = in how many of the scenes. Names of `selected` that none has
 * are listed too (with 0), so a chosen name can still be unticked.
 * → [{ name, count, videos }] in alphabetical order
 */
export function markerNames(scenes, selected) {
  const stats = new Map();
  const stat = (name) => {
    if (!stats.has(name)) stats.set(name, { name, count: 0, videos: 0 });
    return stats.get(name);
  };
  const seen = new Set();
  scenes.forEach((s) => {
    if (s.id != null && seen.has(s.id)) return;
    if (s.id != null) seen.add(s.id);
    const here = new Set();
    s.markers.forEach((m) => {
      const name = markerLabel(m);
      stat(name).count++;
      here.add(name);
    });
    here.forEach((name) => stat(name).videos++);
  });
  (selected || []).forEach(stat);
  return Array.from(stats.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true })
  );
}

// A click on a filter chip: from "all" to only that name, then adding / removing names; none left
// (or name null, the "All" chip) = all markers again. → the new filter
export function toggleName(names, name) {
  if (name == null) return null;
  const list = names ? names.slice() : [];
  const i = list.indexOf(name);
  if (i >= 0) list.splice(i, 1);
  else list.push(name);
  return list.length ? list : null;
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

/**
 * Markers of `target` that none of the copied markers of `plan` (planCopy into target) match:
 * what replacing the target's markers with the source's would delete.
 */
export function planRemove(plan, target) {
  const kept = plan
    .filter((p) => p.status !== "outside")
    .map((p) => ({ primaryTag: p.marker.primaryTag, seconds: p.seconds, end_seconds: p.end_seconds }));
  return target.markers.filter((m) => m.id && !kept.some((k) => sameMarker(m, k)));
}

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

// Deletes markers by id; when the batch call fails (some gone already), one by one.
// → the ids that were really deleted (a marker that is gone already is not one of them).
async function destroyMarkers(gql, ids) {
  if (!ids.length) return [];
  try {
    await gql("mutation($ids: [ID!]!) { sceneMarkersDestroy(ids: $ids) }", { ids });
    return ids.slice();
  } catch (e) {
    const done = [];
    for (const id of ids) {
      try {
        await gql("mutation($id: ID!) { sceneMarkerDestroy(id: $id) }", { id });
        done.push(id);
      } catch (err) {
        /* already deleted */
      }
    }
    return done;
  }
}

/**
 * Deletes `markers` (from loadScene) of a scene. removed: optional array that gets what is
 * needed to create them again (for undo) — only of markers this call really deleted, so an undo
 * never brings back a marker someone else deleted. → number deleted.
 */
export async function removeMarkers(gql, sceneId, markers, removed) {
  const list = markers.filter((m) => m.id && m.primaryTag);
  const gone = await destroyMarkers(gql, list.map((m) => m.id));
  const deleted = list.filter((m) => gone.indexOf(m.id) >= 0);
  if (removed) deleted.forEach((m) => removed.push(markerInput(sceneId, { marker: m, seconds: m.seconds, end_seconds: m.end_seconds })));
  return deleted.length;
}

const sameTags = (a, b) =>
  a.tags.map((t) => t.id).sort().join(",") === b.tags.map((t) => t.id).sort().join(",");

/**
 * A job planned on data loaded earlier, checked against the scene as it is now (`fresh`, from
 * loadScene): markers that exist by now are not created again, and only markers that are still
 * there unchanged (time, tags, title) are deleted. → { plan, remove }
 */
export function recheckJob(job, fresh) {
  const plan = job.plan.map((p) =>
    p.status === "new" &&
    fresh.markers.some((x) => sameMarker(x, { primaryTag: p.marker.primaryTag, seconds: p.seconds, end_seconds: p.end_seconds }))
      ? Object.assign({}, p, { status: "exists" })
      : p
  );
  const remove = (job.remove || []).filter((m) =>
    fresh.markers.some((x) => x.id === m.id && sameMarker(x, m) && x.title === m.title && sameTags(x, m))
  );
  return { plan, remove };
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

/**
 * Runs sync jobs [{ sceneId, plan, remove? }]: creates the "new" markers of each plan and deletes
 * its `remove` markers, then remembers all of it for undo (also when a job fails). Each scene is
 * loaded again right before (recheckJob): a page open for a while, a double click or the same
 * scene in two jobs then neither creates duplicates nor deletes markers changed meanwhile.
 * onProgress(job index, done, total) per created marker.
 * → { added, removed, at } — at: the undo record of this transfer (readUndo().at), null when
 *   nothing changed or the browser could not store it.
 */
export async function syncScenes(gql, create, jobs, onProgress) {
  const created = [];
  const restore = [];
  let at = null;
  try {
    for (let i = 0; i < jobs.length; i++) {
      const job = recheckJob(jobs[i], await loadScene(gql, jobs[i].sceneId));
      await applyPlan(create, jobs[i].sceneId, job.plan, (done, total) => onProgress && onProgress(i, done, total), created);
      if (job.remove.length) await removeMarkers(gql, jobs[i].sceneId, job.remove, restore);
    }
  } finally {
    at = rememberTransfer(created, jobs.map((j) => j.sceneId), restore);
  }
  return { added: created.length, removed: restore.length, at };
}

// ---------- Undo ----------

/**
 * Remembers one transfer (replaces the previous one). ids: the created markers; sceneIds: the
 * scenes it changed; restore: inputs of the markers it deleted (created again on undo).
 * → the record's `at`, or null: nothing to remember, or the browser refused to store it (then
 *   the previous record is dropped too, so no Undo button undoes an older transfer instead).
 */
export function rememberTransfer(ids, sceneIds, restore) {
  ids = ids || [];
  restore = restore || [];
  if (!ids.length && !restore.length) return null;
  const at = Date.now();
  try {
    localStorage.setItem(UNDO_KEY, JSON.stringify({ ids, restore, sceneIds: sceneIds.map(String), at }));
  } catch (e) {
    dropUndo();
    return null;
  }
  window.dispatchEvent(new Event(CLIPBOARD_EVENT));
  return at;
}

function dropUndo() {
  try {
    localStorage.removeItem(UNDO_KEY);
  } catch (e) {
    /* ignore */
  }
  window.dispatchEvent(new Event(CLIPBOARD_EVENT));
}

// → { ids, restore, sceneIds, at } of the last transfer, or null (none, or older than a day).
export function readUndo() {
  try {
    const rec = JSON.parse(localStorage.getItem(UNDO_KEY) || "null");
    if (!rec || !Array.isArray(rec.ids) || !(Date.now() - rec.at < UNDO_MAX_AGE)) return null;
    rec.restore = Array.isArray(rec.restore) ? rec.restore : [];
    return rec.ids.length || rec.restore.length ? rec : null;
  } catch (e) {
    return null;
  }
}

// How many markers undoing `rec` touches (copied ones deleted + deleted ones restored).
export const undoSize = (rec) => (rec ? rec.ids.length + rec.restore.length : 0);

let undoRunning = null;

// Deletes the markers of the last transfer and creates the ones it deleted again.
// → the undone record (null if there was none). A second call while one runs gets the same promise.
export function undoLastTransfer(gql) {
  if (!undoRunning) undoRunning = runUndo(gql).finally(() => (undoRunning = null));
  return undoRunning;
}

async function runUndo(gql) {
  const rec = readUndo();
  if (!rec) return null;
  // Taken off first: a second click or another tab finds nothing, instead of restoring twice.
  dropUndo();
  const restore = rec.restore.slice();
  let ids = rec.ids;
  try {
    // Some may be gone already (deleted by hand): destroyMarkers then deletes the rest one by one.
    await destroyMarkers(gql, ids);
    ids = [];
    const create = createWithGql(gql);
    while (restore.length) {
      await create(restore[0]);
      restore.shift();
    }
    return rec;
  } catch (e) {
    // What is left can be undone again — without the markers restored already.
    try {
      localStorage.setItem(UNDO_KEY, JSON.stringify(Object.assign({}, rec, { ids, restore })));
      window.dispatchEvent(new Event(CLIPBOARD_EVENT));
    } catch (err) {
      /* ignore */
    }
    throw e;
  }
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
 * Whether `scene` may be the source of a group transfer (names / keepOthers as in analyzeGroup).
 * A source without the markers to copy would only delete — all markers of the others, like an
 * empty source without a filter. With keepOthers that is wanted: only markers with the chosen
 * names go (e.g. a wrongly set "Party"), so then any video may be the source.
 */
export function canBeSource(scene, names, keepOthers) {
  if (names && names.length && keepOthers) return true;
  return pickMarkers(scene.markers, names).length > 0;
}

/**
 * One group of same videos, seen from `sourceId` (default: the scene with the most markers; an id
 * that canBeSource refuses is ignored).
 * names: optional name filter (pickMarkers) — then only markers with those names are copied, and
 * replacing a target's markers leaves it with exactly those, like without a filter.
 * keepOthers: with a name filter, replacing deletes only markers with those names; the target's
 * markers with other names stay.
 * → { key, scenes, source, names, keepOthers, short, targets: [{ scene, plan, add, remove, durationDiff, short, sure }], sourceRemove, missing, extra }
 *   missing = markers of the source that the others don't have yet; remove / extra = markers of
 *   the others that the source doesn't have (deleted when a target's markers are replaced);
 *   short = a video of the group is a short clip (those are easily mixed up); sourceRemove = with a
 *   name filter (and not keepOthers): the source's markers with other names, so it can end up with
 *   only the chosen markers too (deleted only when asked for).
 */
export function analyzeGroup(scenes, sourceId, names, keepOthers) {
  names = names && names.length ? names.slice() : null;
  keepOthers = !!keepOthers;
  const count = (s) => pickMarkers(s.markers, names).length;
  const source =
    scenes.find((s) => s.id === String(sourceId) && canBeSource(s, names, keepOthers)) ||
    scenes.slice().sort((a, b) => count(b) - count(a) || b.markers.length - a.markers.length || Number(a.id) - Number(b.id))[0];
  const from = pickMarkers(source.markers, names);
  // The source has none of the chosen markers: nothing to copy, and (unless only those are
  // replaced) nothing to replace either — no video of the group has them.
  const idle = !!names && !from.length && !keepOthers;
  const targets = scenes
    .filter((s) => s !== source)
    .map((s) => {
      const plan = planCopy(from, s, 0);
      const diff = durationDiff(source, s);
      const short = Math.min(source.duration, s.duration) < SHORT_CLIP;
      return {
        scene: s,
        plan,
        add: countNew(plan),
        remove: idle ? [] : planRemove(plan, keepOthers ? { markers: pickMarkers(s.markers, names) } : s),
        durationDiff: diff,
        short,
        sure: diff <= SURE_DURATION_DIFF && !short,
      };
    });
  const key = scenes.map((s) => s.id).sort((a, b) => Number(a) - Number(b)).join(",");
  return {
    key,
    scenes,
    source,
    names,
    keepOthers,
    short: targets.some((x) => x.short),
    sourceRemove: idle || !names || keepOthers ? [] : source.markers.filter((m) => m.id && from.indexOf(m) < 0),
    targets,
    missing: targets.reduce((n, x) => n + x.add, 0),
    extra: targets.reduce((n, x) => n + x.remove.length, 0),
  };
}

/**
 * All groups of same videos in the library (Stash's duplicate search over the phashes), with an
 * optional name filter (see analyzeGroup). Groups where a video has markers the others lack come
 * first, groups with a short clip last. → [analyzeGroup(...)]
 */
export async function findSameVideoGroups(gql, names, keepOthers) {
  const d = await gql(
    `query($d: Int, $dd: Float) { findDuplicateScenes(distance: $d, duration_diff: $dd) { ${SCENE_FIELDS} } }`,
    { d: GROUP_DISTANCE, dd: MAX_DURATION_DIFF },
    { heavy: true }
  );
  return ((d && d.findDuplicateScenes) || [])
    .map((group) => analyzeGroup(group.map(toScene), null, names, keepOthers))
    .sort(
      (a, b) =>
        a.short - b.short || b.missing - a.missing || b.extra - a.extra || b.source.markers.length - a.source.markers.length
    );
}

// → Set of the keys of the Marker Sync groups ticked off by hand.
export function readDone() {
  try {
    const list = JSON.parse(localStorage.getItem(DONE_KEY) || "[]");
    return new Set(Array.isArray(list) ? list.map(String) : []);
  } catch (e) {
    return new Set();
  }
}

// Ticks groups off (done = true) or brings them back into the list. keys: one key or an array.
export function setDone(keys, done) {
  const set = readDone();
  [].concat(keys).forEach((k) => (done ? set.add(String(k)) : set.delete(String(k))));
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify(Array.from(set)));
  } catch (e) {
    throw new Error("The browser does not allow storing the ticked-off groups.");
  }
  window.dispatchEvent(new Event(CLIPBOARD_EVENT));
  return set;
}

// Loads one group again (after copying), keeping its source and name filter. → analyzeGroup(...)
export async function reloadGroup(gql, group) {
  const scenes = [];
  for (const s of group.scenes) scenes.push(await loadScene(gql, s.id));
  return analyzeGroup(scenes, group.source.id, group.names, group.keepOthers);
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
