/** Calls into the Python backend (plugin/backend/pmv_backend.py) through Stash's plugin API. */
import type { PmvProject } from "../model/project";
import type { RenderPlan } from "../export/renderPlan";
import { t } from "../i18n";
import { uid } from "../model/ids";
import { gql } from "./graphql";

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
  duration?: number;
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
  return result;
}

/** Uploads a local music file. */
export const uploadAudio = (file: File, onProgress: (p: number) => void) => uploadFile(file, file.name, onProgress);

export interface RecordingResult {
  file: string;
  seconds?: number;
  warning?: string;
}

/** Moves an uploaded browser recording into the output folder (remuxed by FFmpeg when available) and scans it. */
export const saveRecording = (path: string, name: string) => runOp<RecordingResult>({ op: "save_recording", path, name });

/** Uses a file that already exists on the server (copied into the media folder for the preview). */
export const importAudio = (path: string) => runOp<MediaResult>({ op: "import_audio", path });

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

export async function startRender(plan: RenderPlan): Promise<RenderJob> {
  const renderId = uid("render");
  const data = await gql<{ runPluginTask: string }>(
    `mutation PmvRender($id: ID!, $task: String!, $args: Map) { runPluginTask(plugin_id: $id, task_name: $task, args_map: $args) }`,
    { id: PLUGIN_ID, task: RENDER_TASK, args: { mode: "render", renderId, plan: JSON.stringify(plan) } },
  );
  return { jobId: data.runPluginTask, renderId };
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
  pieces?: number;
  cached?: number;
  seconds?: number;
}

export const renderResult = (renderId: string) => runOp<RenderResult | null>({ op: "render_result", renderId });
