/** Calls into the Python backend (plugin/backend/pmv_backend.py) through Stash's plugin API. */
import type { PmvProject } from "../model/project";
import type { RenderPlan } from "../export/renderPlan";
import { t } from "../i18n";
import { uid } from "../model/ids";
import { gql, stashUrl } from "./graphql";

export const PLUGIN_ID = "pmv-creator";
export const RENDER_TASK = "Render PMV";

/** Synchronous op: Stash runs the plugin once and returns its `output`. */
export async function runOp<T>(args: Record<string, unknown>): Promise<T> {
  const data = await gql<{ runPluginOperation: T }>(
    `mutation PmvOp($id: ID!, $args: Map) { runPluginOperation(plugin_id: $id, args: $args) }`,
    { id: PLUGIN_ID, args },
  );
  return data.runPluginOperation;
}

export interface BackendInfo {
  version: string;
  ffmpeg: string | null;
  ffprobe: string | null;
  python: string;
}

export const ping = () => runOp<BackendInfo>({ op: "ping" });

export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export const saveProject = (project: PmvProject) => runOp<{ path: string }>({ op: "save_project", project });
/** null when no project with that id exists. */
export const loadProject = (id: string) => runOp<unknown | null>({ op: "load_project", id });
export const listProjects = () => runOp<ProjectSummary[]>({ op: "list_projects" });
export const deleteProject = (id: string) => runOp<null>({ op: "delete_project", id });

export interface MediaResult {
  path: string;
  url: string;
  name: string;
  /** Length as ffprobe sees the file on the server (null/absent without ffprobe). */
  duration?: number | null;
  /** Bytes on the server – compared with the uploaded file. */
  size?: number;
}

const CHUNK = 3 * 1024 * 1024;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Uploads a file in chunks into <plugin>/assets/media (served via ui.assets). */
export async function uploadFile(file: Blob, name: string, onProgress: (p: number) => void): Promise<MediaResult> {
  const uploadId = uid("up");
  const total = Math.max(1, Math.ceil(file.size / CHUNK));
  let result: (MediaResult & { done: boolean }) | null = null;
  for (let index = 0; index < total; index++) {
    const data = toBase64(await file.slice(index * CHUNK, (index + 1) * CHUNK).arrayBuffer());
    result = await runOp<MediaResult & { done: boolean }>({ op: "upload_chunk", uploadId, index, total, name, data });
    onProgress((index + 1) / total);
  }
  if (!result?.done) throw new Error(t("Upload incomplete"));
  if (result.size != null && result.size !== file.size) throw new Error(t("Upload incomplete: {got} of {size} bytes arrived on the server", { got: result.size, size: file.size }));
  return result;
}

/** Uploads a local music file. */
export const uploadAudio = (file: File, onProgress: (p: number) => void) => uploadFile(file, file.name, onProgress);

export interface RecordingResult {
  file: string;
  seconds?: number;
  warning?: string;
  /** Stash got a scan of the output folder (plugin setting "Scan after rendering"). */
  scanned?: boolean;
}

/** Moves an uploaded browser recording into the output folder (remuxed by FFmpeg when available) and scans it. */
export const saveRecording = (path: string, name: string) => runOp<RecordingResult>({ op: "save_recording", path, name });

/** Uses a file that already exists on the server (copied into the media folder for the preview). */
export const importAudio = (path: string) => runOp<MediaResult>({ op: "import_audio", path });

export interface LibrarySong {
  name: string;
  path: string;
  url: string;
  size: number;
  /** Seconds since the epoch. */
  mtime: number;
}

/** The song library: songs uploaded before (the media folder on the server), newest first. */
export const listMedia = () => runOp<LibrarySong[]>({ op: "list_media" });

/** The sound of a video on the server as a song in the media folder (another PMV whose cuts are taken over). */
export const extractAudio = (path: string, name: string) => runOp<MediaResult>({ op: "extract_audio", path, name });

export interface PresetEntry {
  name: string;
  settings: Record<string, unknown>;
}

/** Saved generator settings, kept on the server (every browser of this Stash sees them). */
export const listPresets = () => runOp<PresetEntry[]>({ op: "list_presets" });
export const savePreset = (name: string, settings: Record<string, unknown>) => runOp<PresetEntry[]>({ op: "save_preset", name, settings });
export const deletePreset = (name: string) => runOp<PresetEntry[]>({ op: "delete_preset", name });

export const probeKeyframes = (path: string) => runOp<number[]>({ op: "keyframes", path });

export interface GrayItem {
  key: string;
  fps: number;
  /** Stash scene preview of `sceneId` … */
  preview?: boolean;
  sceneId?: string;
  /** … or a stretch of a source file. */
  path?: string;
  start?: number;
  duration?: number;
}

export interface GrayResult {
  w: number;
  h: number;
  fps: number;
  t0: number;
  data: string;
  error?: string;
}

/** Small grayscale frames (long side 64 px) for the generator's motion analysis. */
export const grayFrames = (items: GrayItem[]) => runOp<Record<string, GrayResult>>({ op: "gray_frames", items });

export const ffmpegScript = (plan: RenderPlan, shell: "sh" | "cmd") => runOp<string>({ op: "ffmpeg_script", plan, shell });

export interface RenderJob {
  jobId: string;
  renderId: string;
}

/** helper = id of a render helper on a PC: the Stash task then only hands the job to that PC. */
export async function startRender(plan: RenderPlan, helper?: string): Promise<RenderJob> {
  const renderId = uid("render");
  const args = helper ? { mode: "pc", helper, renderId, plan: JSON.stringify(plan) } : { mode: "render", renderId, plan: JSON.stringify(plan) };
  const data = await gql<{ runPluginTask: string }>(
    `mutation PmvRender($id: ID!, $task: String!, $args: Map) { runPluginTask(plugin_id: $id, task_name: $task, args_map: $args) }`,
    { id: PLUGIN_ID, task: RENDER_TASK, args },
  );
  return { jobId: data.runPluginTask, renderId };
}

export interface HelperMapping {
  from: string;
  to: string;
}

export interface HelperConfig {
  /** Folder on the PC; empty = the helper's default. */
  outputDir: string;
  /** Optional: Stash path prefix -> PC path (e.g. "/data/" -> "Y:\"); without one the PC reads over Stash. */
  mappings: HelperMapping[];
}

/** A render helper on a PC (plugin/backend/pmv_backend.py in "helper" mode). */
export interface RenderHelper {
  id: string;
  name: string;
  online: boolean;
  lastSeen: number;
  version?: string;
  ffmpeg?: string;
  defaultOutput?: string;
  config: HelperConfig;
  /** Its media server for the preview (helper 0.7+): videos of the mapped folders come from the PC. */
  serve?: { url: string; token: string };
}

export const listHelpers = () => runOp<RenderHelper[]>({ op: "helper_list" });
export const setHelperConfig = (id: string, config: HelperConfig) => runOp<HelperConfig>({ op: "helper_config", name: id, config });

/** The backend file with the Stash address (and API key) filled in – a double-click starts the helper. */
export async function helperScript(apiKey: string): Promise<string> {
  const res = await fetch(stashUrl(`/plugin/${PLUGIN_ID}/assets/helper/pmv_backend.py`), { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const src = await res.text();
  const marker = "HELPER_DEFAULTS: Dict[str, str] = {}";
  if (!src.includes(marker)) throw new Error("helper template not found");
  const stash = stashUrl("/").replace(/\/$/, "");
  return src.replace(marker, `HELPER_DEFAULTS: Dict[str, str] = ${JSON.stringify({ stash, apiKey: apiKey.trim() })}`);
}

export interface JobStatus {
  id: string;
  status: "READY" | "RUNNING" | "FINISHED" | "STOPPING" | "CANCELLED" | "FAILED";
  progress: number | null;
  description: string;
  error: string | null;
}

export async function findJob(id: string): Promise<JobStatus | null> {
  const data = await gql<{ findJob: JobStatus | null }>(
    `query PmvJob($id: ID!) { findJob(input: { id: $id }) { id status progress description error } }`,
    { id },
  );
  return data.findJob;
}

export const stopJob = (id: string) => gql(`mutation PmvStop($id: ID!) { stopJob(job_id: $id) }`, { id });

export interface RenderResult {
  status: "running" | "done" | "error";
  file?: string;
  error?: string;
  /** Render succeeded, but e.g. the scan afterwards could not run. */
  warning?: string;
  /** Rendered by the helper on this PC (file is a path on that PC). */
  helper?: string;
  /** Stash got a scan of the output folder (plugin setting "Scan after rendering"). */
  scanned?: boolean;
  /** PC render into a mapped folder: the file as Stash sees it. */
  stashFile?: string;
  pieces?: number;
  cached?: number;
  seconds?: number;
}

export const renderResult = (renderId: string) => runOp<RenderResult | null>({ op: "render_result", renderId });
