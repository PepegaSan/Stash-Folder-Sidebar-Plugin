/** Runs the generator: fetches clips from Stash, analyses music/motion, builds the result (not yet applied). */
import { sceneToSource } from "../../culling/culling";
import { type GenerationResult, type GenerationStats, type GeneratorSettings, applyBeatSync, buildGeneration, generationRange } from "../../generator/generate";
import { type ClipOptions, type MaterialItem, buildMarkerFilter, buildSceneFilter, clientAnyTags, markerItem, sceneItems } from "../../generator/material";
import { DEFAULT_PREVIEW_CONFIG, type Rhythm, type SpeedSpot, decodeGrayFrames, makePercentile, motionCurve, rhythmOf, speedMapFromPreview, toFrames } from "../../generator/motion";
import { peaksEnergy } from "../../generator/rhythm";
import { t } from "../../i18n";
import type { Clip, PmvProject, SourceMedia } from "../../model/project";
import { grayFrames } from "../../stash/backend";
import { fetchScenes, previewConfig, queryMarkers, queryScenes, tagIdByName } from "../../stash/queries";
import { primeScenes } from "../../stash/sceneCache";
import type { StashSceneCore } from "../../stash/types";
import { getAudioAnalysis } from "../hooks";

export type Status = (msg: string) => void;

const sourcesOf = (scenes: StashSceneCore[]) => scenes.map(sceneToSource).filter((s): s is SourceMedia => !!s);
const hasAny = (tagIds: Set<string>, tags: Array<{ id: string }>) => !tagIds.size || tags.some((t) => tagIds.has(t.id));

async function collectOne(o: ClipOptions, p: PmvProject, seed: number, favId: string | null): Promise<{ items: MaterialItem[]; sources: SourceMedia[] }> {
  const find = { per_page: Math.max(1, Math.min(500, o.limit)), sort: `random_${seed}`, direction: "ASC" };
  if (o.source === "bin") return { items: p.bin.map((snippet) => ({ snippet, performers: [], fixedStart: !!snippet.markerId })), sources: [] };
  if (o.source === "project") {
    const scenes = await fetchScenes(Object.keys(p.sources));
    primeScenes(scenes);
    return { items: scenes.flatMap((s) => sceneItems(s, o)), sources: sourcesOf(scenes) };
  }
  if (o.source === "watched") {
    // most played in the last 30 days; too few -> of all time
    const recent = { play_count: { value: 0, modifier: "GREATER_THAN" }, last_played_at: { value: new Date(Date.now() - 30 * 864e5).toISOString(), modifier: "GREATER_THAN" } };
    const byPlays = { per_page: find.per_page, sort: "play_count", direction: "DESC" };
    let r = await queryScenes(recent, byPlays);
    if (r.scenes.length < 8) r = await queryScenes({ play_count: { value: 0, modifier: "GREATER_THAN" } }, byPlays);
    primeScenes(r.scenes);
    return { items: r.scenes.flatMap((s) => sceneItems(s, o)), sources: sourcesOf(r.scenes) };
  }
  const any = new Set(clientAnyTags(o, favId));
  if (o.kind === "markers") {
    const r = await queryMarkers(buildMarkerFilter(o, favId), find);
    const markers = r.markers.filter((m) => hasAny(any, [...m.tags, m.primary_tag, ...m.scene.tags]));
    return { items: markers.map((m) => markerItem(m, m.scene, o.markerLength)), sources: sourcesOf(markers.map((m) => m.scene)) };
  }
  const r = await queryScenes(buildSceneFilter(o, favId), find);
  const scenes = r.scenes.filter((s) => hasAny(any, s.tags));
  primeScenes(scenes);
  return { items: scenes.flatMap((s) => sceneItems(s, o)), sources: sourcesOf(scenes) };
}

/** One pool per tag stage (or a single pool). */
export async function collectPools(o: ClipOptions, p: PmvProject, seed: number): Promise<{ pools: MaterialItem[][]; sources: SourceMedia[] }> {
  let favId: string | null = null;
  if (o.favoritesOnly && o.source === "filter") {
    favId = await tagIdByName("Favorite");
    if (!favId) throw new Error(t("“Favorites only”: Stash has no tag “Favorite”."));
  }
  const stages = o.source === "filter" && o.stagesOn && o.stages.length >= 2 ? o.stages : null;
  const runs = stages ? await Promise.all(stages.map((st) => collectOne({ ...o, tags: st.tags, xtags: st.xtags }, p, seed, favId))) : [await collectOne(o, p, seed, favId)];
  const sources = new Map<string, SourceMedia>();
  for (const r of runs) for (const s of r.sources) sources.set(s.sceneId, s);
  return { pools: runs.map((r) => r.items), sources: [...sources.values()] };
}

// ------------------------------------------------------------------ experimental: speed maps & beat sync

const SPEED_V = 1;
const lsGet = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v);
  } catch {
    /* quota */
  }
};

/** Speed map per scene from its Stash preview; cached per browser (scene, file length, preview settings). */
export async function loadSpeedMaps(scenes: Array<{ id: string; duration: number }>, status: Status): Promise<Record<string, SpeedSpot[]>> {
  const cfg = (await previewConfig()) ?? DEFAULT_PREVIEW_CONFIG;
  const sig = [cfg.previewSegments, cfg.previewSegmentDuration, cfg.previewExcludeStart, cfg.previewExcludeEnd].join("|");
  const keyOf = (s: { id: string; duration: number }) => `pmv-creator:speed:${SPEED_V}:${s.id}:${s.duration.toFixed(1)}:${sig}`;
  const maps: Record<string, SpeedSpot[]> = {};
  const todo: Array<{ id: string; duration: number }> = [];
  for (const s of scenes) {
    const hit = lsGet(keyOf(s));
    if (hit === null) todo.push(s);
    else if (hit !== "null") maps[s.id] = JSON.parse(hit) as SpeedSpot[];
  }
  for (let i = 0; i < todo.length; i += 4) {
    status(t("Speed maps from scene previews: {i}/{n}…", { i, n: todo.length }));
    const batch = todo.slice(i, i + 4);
    const res = await grayFrames(batch.map((s) => ({ key: s.id, preview: true, sceneId: s.id, fps: 15 })));
    for (const s of batch) {
      const r = res[s.id];
      const map = r && !r.error ? speedMapFromPreview(decodeGrayFrames(r.data, r.w, r.h, r.fps, r.t0), s.duration, cfg) : null;
      lsSet(keyOf(s), JSON.stringify(map));
      if (map) maps[s.id] = map;
    }
  }
  return maps;
}

const RHYTHM_WINDOW = 2.0;

/** Motion rhythm at the start of each clip (2 s of its source at 30 fps). */
export async function measureRhythms(clips: Clip[], sources: Record<string, SourceMedia>, status: Status): Promise<Record<string, Rhythm | null>> {
  const out: Record<string, Rhythm | null> = {};
  const items = clips.filter((c) => sources[c.sceneId]?.path);
  for (let i = 0; i < items.length; i += 8) {
    status(t("Motion on the beat: {i}/{n} clips measured…", { i, n: items.length }));
    const batch = items.slice(i, i + 8);
    const res = await grayFrames(batch.map((c) => ({ key: c.id, path: sources[c.sceneId].path, start: c.sourceIn, duration: RHYTHM_WINDOW, fps: 30 })));
    for (const c of batch) {
      const r = res[c.id];
      const pts = r && !r.error ? motionCurve(toFrames(decodeGrayFrames(r.data, r.w, r.h, r.fps, r.t0))) : null;
      out[c.id] = pts ? rhythmOf(pts) : null;
    }
  }
  return out;
}

export interface RunOutcome {
  result: GenerationResult;
  stats: GenerationStats;
  /** Clips adjusted by "motion on the beat". */
  synced: number;
  /** Scenes with a speed map (clip speed follows the music). */
  mapped: number;
}

export async function runGenerator(p: PmvProject, s: GeneratorSettings, playhead: number, status: Status): Promise<RunOutcome> {
  const range = generationRange(p, s.target, playhead);
  if (!(range.to > range.from)) throw new Error(t("No range: without music choose “Bars” from the playhead."));

  status(t("Loading clips from Stash…"));
  const { pools, sources } = await collectPools(s.clips, p, s.seed);
  if (!pools.some((x) => x.length)) throw new Error(t("No matching clips – loosen the filters."));

  let energy;
  if (p.audio?.url) {
    status(t("Analysing music…"));
    const a = await getAudioAnalysis(p.audio.url);
    energy = peaksEnergy(a.peaks, a.peaksPerSecond, p.audio);
  }

  let speedMaps: Record<string, SpeedSpot[]> = {};
  if (s.select.paceMatch) {
    const durations = new Map<string, number>();
    for (const src of [...Object.values(p.sources), ...sources]) durations.set(src.sceneId, src.duration);
    const ids = [...new Set(pools.flat().filter((it) => !it.fixedStart).map((it) => it.snippet.sceneId))];
    speedMaps = await loadSpeedMaps(ids.map((id) => ({ id, duration: durations.get(id) ?? 0 })).filter((x) => x.duration > 0), status);
  }
  const speedPct = makePercentile(Object.values(speedMaps).flatMap((m) => m.map((x) => x.speed)));

  status(t("Cutting to the beat…"));
  const built = buildGeneration(p, s, range, { pools, sources, energy, context: { speedMaps, speedPct } });

  let synced = 0;
  if (s.select.beatSync && built.result.clips.length) {
    const all = { ...p.sources, ...Object.fromEntries(sources.map((x) => [x.sceneId, x])) };
    const rhythms = await measureRhythms(built.result.clips, all, status);
    const r = applyBeatSync(built.result.clips, rhythms, p.beatGrid.bpm, (id) => all[id]?.duration ?? 0, (c) => !!c.markerId);
    built.result.clips = r.clips;
    synced = r.synced;
  }
  return { ...built, synced, mapped: Object.keys(speedMaps).length };
}
