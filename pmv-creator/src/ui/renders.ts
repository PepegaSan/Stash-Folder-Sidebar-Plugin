/**
 * 🔔 Renders in flight, watched outside the render dialog: their progress for the dialog and the toolbar list, the
 * 🏷 label once a video is done, and a signal for whoever left the tab – the tab title, a chime and, where the browser
 * allows it (HTTPS or localhost), a desktop notification. Kept per browser, so renders started earlier (a batch
 * queued for the night) are picked up again when the editor opens; Stash renders them whether the tab is open or not.
 */
import { t } from "../i18n";
import { type JobStatus, RENDER_TASK, type RenderResult, findJob, renderResult } from "../stash/backend";
import { type LabelJob, type LabelStatus, queueLabel, waitForScene, watchLabel } from "./labels";

export type RenderState = "queued" | "running" | "done" | "error" | "cancelled";

export interface WatchedRender {
  jobId: string;
  /** When Stash queued that job, noted at the first look – a later job with the same id (after a restart) is another one. */
  jobAdded?: string;
  renderId: string;
  name: string;
  projectId: string;
  /** Name of the PC that renders it (render helper), null = the Stash server. */
  pc: string | null;
  /** 🏷 What the video gets in Stash once it is scanned (the path is filled in then); null = no label. */
  label: Omit<LabelJob, "path" | "queued"> | null;
  /** Several PMVs at once: the batch it belongs to. */
  batch?: string;
  started: number;
  state: RenderState;
  progress: number;
  result?: RenderResult;
  error?: string;
  /** The finished video as Stash sees it. */
  file?: string;
  /** Its scene, once Stash has scanned (and labeled) it. */
  sceneId?: string;
  finished?: number;
  /** Looked at in the list – the toolbar no longer counts it. */
  seen?: boolean;
}

export const isActive = (r: WatchedRender) => r.state === "queued" || r.state === "running";

const LS_RENDERS = "pmv-creator:renders";
const LS_NOTIFY = "pmv-creator:notify";
let pollMs = 2000;
/** Tests poll faster. */
export const setPollInterval = (ms: number): void => void (pollMs = ms);
const KEEP_MS = 3 * 24 * 3600 * 1000;
const MAX_KEPT = 40;

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

/** The list as last read; without storage (private mode) it only lives here. */
let renders: WatchedRender[] = [];
let renderedFrom: string | null = null;
const listeners = new Set<() => void>();
/** Renders this page has seen queued or running – only they make a sound when they finish. */
const watchedLive = new Set<string>();

/** Read fresh every time: another tab with the editor (classic Stash and Stash UI side by side) changes it too. */
function all(): WatchedRender[] {
  const raw = lsGet(LS_RENDERS);
  if (raw === null || raw === renderedFrom) return renders;
  renderedFrom = raw;
  try {
    const v = JSON.parse(raw);
    renders = Array.isArray(v) ? (v as WatchedRender[]).filter((r) => r && r.renderId && Date.now() - r.started < KEEP_MS) : [];
  } catch {
    renders = [];
  }
  return renders;
}

function changed(): void {
  listeners.forEach((l) => l());
  updateTitle();
}

function commit(next: WatchedRender[]): void {
  // the oldest finished ones go; a render that is still on its way stays (a big batch is longer than the list)
  let finished = 0;
  renders = next.filter((r) => isActive(r) || ++finished <= MAX_KEPT);
  renderedFrom = JSON.stringify(renders);
  lsSet(LS_RENDERS, renderedFrom);
  changed();
}

function patch(renderId: string, p: Partial<WatchedRender>): void {
  commit(all().map((r) => (r.renderId === renderId ? { ...r, ...p } : r)));
}

export const listRenders = (): WatchedRender[] => all();
export const getRender = (renderId: string): WatchedRender | null => all().find((r) => r.renderId === renderId) ?? null;

export function subscribeRenders(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Starts watching a render that was just handed to Stash. */
export function watchRender(r: Omit<WatchedRender, "state" | "progress" | "started">): void {
  watchedLive.add(r.renderId);
  commit([{ ...r, state: "queued", progress: 0, started: Date.now() }, ...all().filter((x) => x.renderId !== r.renderId)]);
  loop();
}

/** Editor start: renders that were still on their way when the editor was closed, and scenes not found yet. */
export function resumeRenders(): void {
  if (all().some(isActive)) loop();
  // Stash scans after the renders queued before the scan – after a batch that can be hours, the tab closed meanwhile
  for (const r of all()) if (r.state === "done" && r.result?.scanned && r.file && !r.sceneId) seekScene(r.renderId, r.file);
}

export function markSeen(): void {
  if (all().some((r) => !isActive(r) && !r.seen)) commit(all().map((r) => (isActive(r) || r.seen ? r : { ...r, seen: true })));
}

export function forgetFinished(renderId?: string): void {
  commit(all().filter((r) => isActive(r) || (renderId != null && r.renderId !== renderId)));
}

// ------------------------------------------------------------------ polling

let timer = 0;
let polling = false;

function loop(): void {
  if (timer || polling) return;
  timer = window.setTimeout(() => void tick(), 50);
}

async function tick(): Promise<void> {
  timer = 0;
  polling = true;
  try {
    for (const r of all().filter(isActive)) await pollOne(r).catch(() => undefined); // one odd entry must not stop the rest
  } finally {
    polling = false;
  }
  if (all().some(isActive)) timer = window.setTimeout(() => void tick(), pollMs);
}

/**
 * Stash numbers its jobs from 1 again after a restart – a job with our id is ours if it was queued when noted at the
 * first look (right after the start it is certainly ours; an entry without that note: if it is a render task).
 */
const isOurs = (r: WatchedRender, j: JobStatus | null): j is JobStatus =>
  !!j && (r.jobAdded != null ? j.addTime === r.jobAdded : watchedLive.has(r.renderId) || (j.description ?? "").includes(RENDER_TASK));

async function pollOne(r: WatchedRender): Promise<void> {
  let job: JobStatus | null;
  try {
    job = await findJob(r.jobId);
  } catch {
    return; // Stash not reachable just now – asked again in a moment
  }
  const ours = (j: JobStatus | null): j is JobStatus => isOurs(r, j);
  if (ours(job) && r.jobAdded == null && job.addTime) patch(r.renderId, { jobAdded: job.addTime });
  if (ours(job) && (job.status === "READY" || job.status === "RUNNING" || job.status === "STOPPING")) {
    const state: RenderState = job.status === "READY" ? "queued" : "running";
    watchedLive.add(r.renderId);
    if (state !== r.state || Math.abs((job.progress ?? 0) - r.progress) > 0.001) patch(r.renderId, { state, progress: job.progress ?? 0 });
    return;
  }
  // finished, or no longer in Stash's list (it forgets finished jobs after a while): the result file tells
  let result: RenderResult | null;
  try {
    result = await renderResult(r.renderId);
  } catch {
    return;
  }
  if (result?.status === "done") return finish(r, { state: "done", progress: 1, result, file: result.stashFile ?? result.file });
  // a stopped task is killed (on Windows without a word) – its result file may still say "running"
  if ((ours(job) && job.status === "CANCELLED") || result?.error === "Cancelled") return finish(r, { state: "cancelled", error: t("Cancelled."), result: result ?? undefined });
  // the task writes its result before it ends; one more look in case the file was just being written
  if (result?.status === "running" && ours(job) && job.status === "FINISHED" && !lateResult.has(r.renderId)) return void lateResult.add(r.renderId);
  let error: string;
  if (result?.error) error = result.error;
  else if (ours(job)) error = job.error || (job.status === "FAILED" ? t("The render task failed – see Stash's log (Settings → Logs).") : t("The render task ended without a result."));
  else error = result?.status === "running" ? t("The render task is gone – was Stash restarted?") : t("The render never started – was Stash restarted?");
  finish(r, { state: "error", error, result: result ?? undefined });
}

/** Renders whose task ended while the result still said "running" – looked at once more. */
const lateResult = new Set<string>();

function finish(r: WatchedRender, p: Partial<WatchedRender>): void {
  // read again after the awaits: another tab with the editor may have finished it meanwhile (labels, chime once)
  const now = getRender(r.renderId);
  if (!now || !isActive(now)) return;
  patch(r.renderId, { ...p, finished: Date.now(), seen: false });
  const done = getRender(r.renderId);
  if (!done) return;
  if (done.state === "done" && done.result?.scanned && done.file) {
    if (done.label) {
      queueLabel({ ...done.label, path: done.file, queued: Date.now() });
      const off = watchLabel(done.file, (s: LabelStatus) => {
        if (s.state === "done") {
          patch(r.renderId, { sceneId: s.sceneId });
          off();
        }
      });
    } else {
      seekScene(r.renderId, done.file); // no label, but "Open in Stash" still wants the scene
    }
  }
  if (watchedLive.has(r.renderId) && done.state !== "cancelled") signal(done);
}

const seeking = new Set<string>();

/** Waits for the scene of a finished render (Stash's scan) and notes it for "Open in Stash". */
function seekScene(renderId: string, file: string): void {
  if (seeking.has(renderId)) return;
  seeking.add(renderId);
  void waitForScene(file)
    .then((s) => s && getRender(renderId) && patch(renderId, { sceneId: s.id }))
    .catch(() => undefined)
    .finally(() => seeking.delete(renderId));
}

// ------------------------------------------------------------------ 🔔 signal

export const notifyOn = (): boolean => lsGet(LS_NOTIFY) !== "0";
export const setNotifyOn = (on: boolean): void => lsSet(LS_NOTIFY, on ? "1" : "0");

/** Desktop notifications need a secure page (HTTPS or localhost) – Stash on a LAN address over HTTP has none. */
export const desktopNotifications = (): "granted" | "default" | "denied" | "unavailable" =>
  typeof Notification === "undefined" || !window.isSecureContext ? "unavailable" : Notification.permission;

let audio: AudioContext | null = null;
let sceneHref: (sceneId: string) => string = (id) => id;
let onOpenList: (() => void) | null = null;

/** Set by the editor: where a scene opens, and how the toolbar list opens (a click on a notification). */
export function configureRenders(o: { sceneHref: (sceneId: string) => string; openList: () => void }): () => void {
  sceneHref = o.sceneHref;
  onOpenList = o.openList;
  return () => {
    if (onOpenList === o.openList) onOpenList = null;
  };
}

/**
 * Called from the click that starts a render: a browser only lets a page make sounds and ask for notifications
 * after the user did something on it.
 */
export function primeSignal(): void {
  if (!notifyOn()) return;
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    audio ??= new Ctx();
    void audio.resume().catch(() => undefined);
  } catch {
    audio = null;
  }
  if (desktopNotifications() === "default") void Notification.requestPermission().catch(() => undefined);
}

function chime(ok: boolean): void {
  const ctx = audio;
  if (!ctx) return;
  void ctx.resume().catch(() => undefined);
  const notes = ok ? [880, 1318.5] : [440, 330];
  notes.forEach((f, i) => {
    const at = ctx.currentTime + 0.05 + i * 0.18;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(at);
    osc.stop(at + 0.4);
  });
}

function signal(r: WatchedRender): void {
  if (!notifyOn()) return;
  const ok = r.state === "done";
  chime(ok);
  if (desktopNotifications() !== "granted") return;
  try {
    const file = (r.file ?? "").split(/[\\/]/).pop() ?? "";
    const n = new Notification(ok ? t("{name} is rendered", { name: r.name }) : t("Render of “{name}” failed", { name: r.name }), {
      body: ok ? `${file}\n${t("Click: open it in Stash")}` : (r.error ?? ""),
      tag: `pmv-render-${r.renderId}`,
    });
    n.onclick = () => {
      window.focus();
      n.close();
      const id = getRender(r.renderId)?.sceneId;
      if (id) window.open(sceneHref(id), "_blank", "noopener");
      else onOpenList?.();
    };
  } catch {
    /* some browsers only allow notifications from a service worker */
  }
}

// ------------------------------------------------------------------ tab title while the tab is in the background

let plainTitle: string | null = null;
/** Finished renders the user has been back on the tab for since – the title no longer announces them. */
const announced = new Set<string>();

function titleText(): string | null {
  if (typeof document === "undefined" || !document.hidden) return null;
  const list = all();
  const fresh = list.filter((r) => !isActive(r) && !r.seen && r.state !== "cancelled" && watchedLive.has(r.renderId) && !announced.has(r.renderId));
  const failed = fresh.find((r) => r.state === "error");
  if (failed) return `⚠ ${t("Render failed")} – ${failed.name}`;
  const active = list.filter(isActive);
  if (fresh.length && !active.length) return `✓ ${fresh.length > 1 ? t("{n} PMVs rendered", { n: fresh.length }) : t("{name} is rendered", { name: fresh[0].name })}`;
  const running = active.find((r) => r.state === "running");
  if (running) return `⏳ ${Math.round(running.progress * 100)} % · ${running.name}${active.length > 1 ? ` (+${active.length - 1})` : ""}`;
  return null;
}

function updateTitle(): void {
  if (typeof document === "undefined") return;
  const text = titleText();
  if (text) {
    plainTitle ??= document.title;
    if (document.title !== text) document.title = text;
  } else if (plainTitle !== null) {
    document.title = plainTitle;
    plainTitle = null;
  }
}

if (typeof window !== "undefined") {
  // another tab started, finished or cleared renders
  window.addEventListener("storage", (e) => {
    if (e.key !== LS_RENDERS) return;
    changed();
    if (all().some(isActive)) loop();
  });
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) for (const r of all()) if (!isActive(r)) announced.add(r.renderId);
    updateTitle();
  });
}
