/**
 * 🏷 After a render: once Stash has scanned the new video, its scene gets the project's name as title, a short
 * description, the performers of the clips' scenes, the tags most of them share and the tag "PMV Creator". Runs in
 * the browser (the scan only starts after the render task ends). A pending label is remembered per browser, so
 * closing the editor before the scan is through only delays it to the next start.
 */
import { t } from "../i18n";
import type { PmvProject } from "../model/project";
import { PMV_TAG, SKIP_TAG, type SceneLabels, ensureTag, findSceneByFile, updateScene } from "../stash/library";
import { fetchScenes } from "../stash/queries";
import type { StashSceneCore } from "../stash/types";

export interface LabelJob {
  /** The video as Stash sees it. */
  path: string;
  title: string;
  details: string;
  sceneIds: string[];
  queued: number;
}

export type LabelStatus = { state: "waiting" } | { state: "done"; sceneId: string; performers: number; tags: number } | { state: "error"; error: string };

const LS_JOBS = "pmv-creator:label-jobs";
const LS_ON = "pmv-creator:label";
/**
 * How long the open editor waits for the scan. Stash runs one task at a time, so with several renders queued the
 * scan of the first one only runs after the last render – hours later; the asking slows down meanwhile.
 */
const WAIT_MS = 12 * 3600 * 1000;
const POLL_MS = 3000;
const POLL_MAX_MS = 30000;
/** Jobs older than this are given up. */
const KEEP_MS = 3 * 24 * 3600 * 1000;

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

export const labelingOn = (): boolean => lsGet(LS_ON) !== "0";
export const setLabelingOn = (on: boolean): void => lsSet(LS_ON, on ? "1" : "0");

function loadJobs(): LabelJob[] {
  try {
    const v = JSON.parse(lsGet(LS_JOBS) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
const saveJobs = (jobs: LabelJob[]) => lsSet(LS_JOBS, JSON.stringify(jobs));
const dropJob = (path: string) => saveJobs(loadJobs().filter((j) => j.path !== path));

/** What the PMV gets in Stash, taken from the project at render time (the video's path comes once it exists). */
export function labelFor(p: PmvProject): Omit<LabelJob, "path" | "queued"> {
  const clips = p.tracks.filter((tr) => !tr.muted).flatMap((tr) => tr.clips);
  const sceneIds = [...new Set(clips.map((c) => c.sceneId))];
  const parts = [t("Made with PMV Creator.")];
  if (p.audio) parts.push(t("Song: {song} ({bpm} BPM).", { song: p.audio.name, bpm: Math.round(p.beatGrid.bpm) }));
  parts.push(t("{clips} clips from {scenes} scenes.", { clips: clips.length, scenes: sceneIds.length }));
  return { title: p.name, details: parts.join(" "), sceneIds };
}

export const labelJob = (p: PmvProject, path: string): LabelJob => ({ ...labelFor(p), path, queued: Date.now() });

/**
 * The scene update: title and description of the job, the performers of all source scenes, the tags at least a
 * quarter of them share (at least two scenes), the PMV tag – added to what the scene has already.
 */
export function labelUpdate(job: LabelJob, scene: SceneLabels, sources: Array<Pick<StashSceneCore, "performers" | "tags">>, pmvTagId: string) {
  const performers = new Set(scene.performers.map((x) => x.id));
  for (const s of sources) for (const x of s.performers) performers.add(x.id);
  const counts = new Map<string, number>();
  for (const s of sources) for (const x of s.tags) if (x.name !== SKIP_TAG && x.name !== PMV_TAG) counts.set(x.id, (counts.get(x.id) ?? 0) + 1);
  const need = sources.length <= 1 ? 1 : Math.max(2, Math.ceil(sources.length / 4));
  const common = [...counts].filter(([, n]) => n >= need).map(([id]) => id);
  const tags = new Set([...scene.tags.map((x) => x.id), ...common, pmvTagId]);
  return {
    input: { id: scene.id, title: job.title, details: job.details, performer_ids: [...performers], tag_ids: [...tags] },
    performers: performers.size,
    tags: common.length,
  };
}

const listeners = new Set<(path: string, s: LabelStatus) => void>();
const last = new Map<string, LabelStatus>();
const running = new Set<string>();

function emit(path: string, s: LabelStatus): void {
  last.set(path, s);
  listeners.forEach((l) => l(path, s));
}

/** Status of the job for `path` (now and whenever it changes); returns the unsubscribe. */
export function watchLabel(path: string, cb: (s: LabelStatus) => void): () => void {
  const l = (p: string, s: LabelStatus) => p === path && cb(s);
  listeners.add(l);
  const now = last.get(path);
  if (now) cb(now);
  return () => listeners.delete(l);
}

const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/** The scene of a fresh video once Stash has scanned it; asked more slowly the longer it takes. null after maxMs. */
export async function waitForScene(path: string, maxMs = WAIT_MS): Promise<SceneLabels | null> {
  const until = Date.now() + maxMs;
  let scene = await findSceneByFile(path).catch(() => null);
  for (let wait = POLL_MS; !scene && Date.now() < until; wait = Math.min(POLL_MAX_MS, wait * 1.2)) {
    await sleep(wait);
    scene = await findSceneByFile(path).catch(() => null);
  }
  return scene;
}

async function work(job: LabelJob): Promise<void> {
  if (running.has(job.path)) return;
  running.add(job.path);
  emit(job.path, { state: "waiting" });
  try {
    const scene = await waitForScene(job.path);
    if (!scene) {
      emit(job.path, { state: "error", error: t("Stash hasn't scanned the video yet – it gets labeled the next time the editor opens.") });
      return;
    }
    const sources = await fetchScenes(job.sceneIds);
    const plan = labelUpdate(job, scene, sources, await ensureTag(PMV_TAG));
    await updateScene(plan.input);
    dropJob(job.path);
    emit(job.path, { state: "done", sceneId: scene.id, performers: plan.performers, tags: plan.tags });
  } catch (e) {
    emit(job.path, { state: "error", error: e instanceof Error ? e.message : String(e) });
  } finally {
    running.delete(job.path);
  }
}

/** Remembers the job and starts waiting for the scan. */
export function queueLabel(job: LabelJob): void {
  saveJobs([...loadJobs().filter((j) => j.path !== job.path), job]);
  void work(job);
}

/** Editor start: labels that were still waiting when the editor was closed. */
export function resumeLabels(): void {
  const jobs = loadJobs();
  const fresh = jobs.filter((j) => Date.now() - j.queued < KEEP_MS);
  if (fresh.length !== jobs.length) saveJobs(fresh);
  for (const j of fresh) void work(j);
}
