/**
 * Picks a browser-playable stream – from the render helper on this PC when it serves the file's folder,
 * otherwise from Stash – and hides the difference between direct, transcoded and helper streams.
 */
import { stashUrl } from "./graphql";
import type { StashSceneCore } from "./types";

export interface StreamInfo {
  url: string;
  /** native = HTTP range seeking; param = transcode restarted with ?start=; mse = helper stream from ?start= */
  seek: "native" | "param" | "mse";
  /** Served by the render helper on this PC. */
  local?: boolean;
  /** Media Source type of a helper stream. */
  mime?: string;
  /** Length of the file (a helper stream's MediaSource spans it). */
  duration?: number;
}

/** The render helper that serves videos to this browser (null = everything from Stash). */
export interface LocalMedia {
  url: string;
  token: string;
  /** Stash path prefixes the helper maps to folders on its PC. */
  prefixes: string[];
}

let local: LocalMedia | null = null;
/** Bumped when the source of the videos changes, so bound players reload. */
let generation = 0;
const listeners = new Set<() => void>();
/** Scenes the helper can't serve (not on the PC, broken) – from Stash for the rest of the session. */
const notLocal = new Set<string>();

export const streamGeneration = () => generation;

export function setLocalMedia(next: LocalMedia | null): void {
  if (JSON.stringify(next) === JSON.stringify(local)) return;
  local = next;
  generation++;
  listeners.forEach((fn) => fn());
}

/** Called when the source of the videos changes (PC ↔ Stash). */
export function onStreamChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

const CODEC_MIME: Record<string, string> = {
  h264: 'video/mp4; codecs="avc1.640028"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"',
  vp8: 'video/webm; codecs="vp8"',
  vp9: 'video/webm; codecs="vp9"',
  av1: 'video/mp4; codecs="av01.0.08M.08"',
};
/** What the helper sends: H.264 High@4.1 (+ AAC LC), see stream_command() in pmv_backend.py. */
const HELPER_MIME = 'video/mp4; codecs="avc1.640029"';
const HELPER_MIME_AUDIO = 'video/mp4; codecs="avc1.640029, mp4a.40.2"';

/** Scenes whose direct stream failed in this browser session. */
const transcodeOnly = new Set<string>();
export const markTranscodeOnly = (sceneId: string) => transcodeOnly.add(sceneId);

let probe: HTMLVideoElement | null = null;
function canPlay(mime: string): boolean {
  probe ??= document.createElement("video");
  return probe.canPlayType(mime) !== "";
}

const mseSupports = (mime: string) => typeof MediaSource !== "undefined" && MediaSource.isTypeSupported(mime);

export function pickStream(scene: StashSceneCore): StreamInfo | null {
  const f = scene.files[0];
  const direct = scene.paths.stream;
  if (local && f?.path && !notLocal.has(scene.id) && local.prefixes.some((p) => f.path.startsWith(p))) {
    const audio = !!f.audio_codec;
    const mime = audio ? HELPER_MIME_AUDIO : HELPER_MIME;
    if (mseSupports(mime)) {
      const url = `${local.url}/v1/stream?k=${encodeURIComponent(local.token)}&path=${encodeURIComponent(f.path)}&a=${audio ? 1 : 0}`;
      return { url, seek: "mse", local: true, mime, duration: f.duration };
    }
  }
  const ext = f?.basename.split(".").pop()?.toLowerCase() ?? "";
  const mime = CODEC_MIME[(f?.video_codec ?? "").toLowerCase()];
  const directOk = !!direct && !transcodeOnly.has(scene.id) && ["mp4", "m4v", "mov", "webm", "mkv"].includes(ext) && !!mime && canPlay(mime);
  if (directOk) return { url: stashUrl(direct!), seek: "native" };
  const mp4 = scene.sceneStreams.find((s) => s.mime_type === "video/mp4" && !/direct/i.test(s.label ?? ""));
  if (mp4) return { url: stashUrl(mp4.url), seek: "param" };
  return direct ? { url: stashUrl(direct), seek: "native" } : null;
}

export function withStart(url: string, t: number): string {
  const u = new URL(url);
  u.searchParams.set("start", t.toFixed(3));
  return u.toString();
}

/** Buffer at most this far ahead of the playhead – FFmpeg on the PC waits meanwhile. */
const AHEAD = 20;
/** Drop what lies further behind the playhead than this. */
const BEHIND = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Plays a helper stream through Media Source Extensions. Stash's Content-Security-Policy allows media only from
 * Stash or blob:, but fetch() may reach the helper (connect-src in pmv-creator.yml). Every stream begins exactly
 * at its ?start= with timestamp 0, so the SourceBuffer is shifted there and the element runs in source time.
 */
class HelperFeed {
  /** The running stream starts here (source seconds). */
  private from = 0;
  /** Requested time while the first data is on its way. */
  private target = 0;
  private loading = false;
  private ctl: AbortController | null = null;
  private timer = 0;
  private lastOpen = 0;

  constructor(
    private el: HTMLVideoElement,
    private fail: () => void,
  ) {}

  get time(): number {
    return this.loading ? this.target : this.el.currentTime || 0;
  }

  /** Can t be reached in what is buffered or arriving? Then only the playhead moves. */
  seek(t: number): boolean {
    if (this.loading) {
      if (t < this.from - 0.05 || t > this.from + 3) return false;
      this.target = t;
      return true;
    }
    const b = this.el.buffered;
    for (let i = 0; i < b.length; i++) {
      if (t >= b.start(i) - 0.05 && t <= b.end(i) + 1) {
        if (Math.abs(this.el.currentTime - t) > 0.01) this.el.currentTime = t;
        return true;
      }
    }
    return false;
  }

  open(info: StreamInfo, t: number): void {
    this.close();
    this.from = t;
    this.target = t;
    this.loading = true;
    // scrubbing: a burst of seeks starts one stream, not one per mouse move
    const now = performance.now();
    const wait = now - this.lastOpen < 250 ? 150 : 0;
    this.lastOpen = now;
    this.timer = window.setTimeout(() => this.start(info, t), wait);
  }

  close(): void {
    window.clearTimeout(this.timer);
    this.ctl?.abort(); // the helper stops FFmpeg when the connection closes
    this.ctl = null;
    this.loading = false;
  }

  private start(info: StreamInfo, t: number): void {
    const ms = new MediaSource();
    const ctl = new AbortController();
    this.ctl = ctl;
    const src = URL.createObjectURL(ms);
    ms.addEventListener(
      "sourceopen",
      () => {
        URL.revokeObjectURL(src);
        this.pump(ms, ctl.signal, info, t).catch(() => {
          if (!ctl.signal.aborted) this.fail();
        });
      },
      { once: true },
    );
    this.el.src = src;
  }

  private async pump(ms: MediaSource, signal: AbortSignal, info: StreamInfo, t: number): Promise<void> {
    if (info.duration && info.duration > t) ms.duration = info.duration;
    const sb = ms.addSourceBuffer(info.mime!);
    sb.timestampOffset = t;
    const res = await fetch(withStart(info.url, t), { signal, cache: "no-store" });
    if (!res.ok || !res.body) throw new Error(`helper HTTP ${res.status}`);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done || signal.aborted) break;
      await append(sb, value as Uint8Array<ArrayBuffer>, this.el);
      if (this.loading) {
        this.loading = false;
        this.el.currentTime = this.target;
      }
      while (!signal.aborted && sb.buffered.length && sb.buffered.end(sb.buffered.length - 1) - this.el.currentTime > AHEAD) await sleep(400);
      if (signal.aborted) break;
      const b = sb.buffered;
      if (b.length && this.el.currentTime - b.start(0) > BEHIND) await settle(sb, () => sb.remove(b.start(0), this.el.currentTime - AHEAD));
    }
    if (!signal.aborted && ms.readyState === "open") {
      await settle(sb, () => undefined);
      ms.endOfStream();
    }
  }
}

/** Runs an operation on the SourceBuffer and waits until it is through. */
function settle(sb: SourceBuffer, op: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (ok: boolean) => {
      sb.removeEventListener("updateend", onEnd);
      sb.removeEventListener("error", onErr);
      if (ok) resolve();
      else reject(new Error("SourceBuffer error"));
    };
    const onEnd = () => finish(true);
    const onErr = () => finish(false);
    sb.addEventListener("updateend", onEnd);
    sb.addEventListener("error", onErr);
    if (!sb.updating) {
      op();
      if (!sb.updating) finish(true);
    }
  });
}

/** Appends a chunk; a full buffer makes room behind the playhead once. */
async function append(sb: SourceBuffer, data: Uint8Array<ArrayBuffer>, el: HTMLVideoElement): Promise<void> {
  try {
    await settle(sb, () => sb.appendBuffer(data));
  } catch (e) {
    const b = sb.buffered;
    if (!(e instanceof DOMException && e.name === "QuotaExceededError") || !b.length) throw e;
    await settle(sb, () => sb.remove(b.start(0), Math.max(b.start(0) + 1, el.currentTime - 5)));
    await settle(sb, () => sb.appendBuffer(data));
  }
}

/**
 * One <video> element bound to whichever scene it currently shows. `time` is always the absolute
 * source time, also for transcoded streams that restart at ?start=.
 */
export class VideoSlot {
  sceneId: string | null = null;
  private scene: StashSceneCore | null = null;
  private info: StreamInfo | null = null;
  private base = 0;
  private gen = -1;
  private feed: HelperFeed | null = null;

  constructor(readonly el: HTMLVideoElement) {
    el.addEventListener("error", this.onError);
  }

  get time(): number {
    if (this.info?.seek === "mse" && this.feed) return this.feed.time;
    return this.base + (this.el.currentTime || 0);
  }

  get ready(): boolean {
    return this.el.readyState >= 2;
  }

  /** The videos' source changed (PC ↔ Stash) since this slot loaded – assign() reloads it. */
  get stale(): boolean {
    return !!this.info && this.gen !== generation;
  }

  assign(scene: StashSceneCore, t: number): void {
    if (this.sceneId === scene.id && this.info && !this.stale) {
      this.seek(t);
      return;
    }
    this.scene = scene;
    this.sceneId = scene.id;
    this.info = pickStream(scene);
    if (this.info) this.load(t);
  }

  seek(t: number): void {
    if (!this.info) return;
    if (this.info.seek === "native") {
      if (Math.abs(this.el.currentTime - t) > 0.01) this.el.currentTime = t;
      return;
    }
    if (this.info.seek === "mse") {
      if (!this.feed?.seek(t)) this.load(t);
      return;
    }
    const rel = t - this.base;
    const buffered = this.el.buffered.length ? this.el.buffered.end(this.el.buffered.length - 1) : 0;
    if (rel < 0 || rel > buffered + 0.5) this.load(t);
    else this.el.currentTime = rel;
  }

  release(): void {
    this.feed?.close();
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load();
    this.sceneId = null;
    this.scene = null;
    this.info = null;
  }

  dispose(): void {
    this.el.removeEventListener("error", this.onError);
    this.release();
  }

  private load(t: number): void {
    const info = this.info!;
    this.gen = generation;
    if (info.seek === "mse") {
      this.base = 0;
      this.feed ??= new HelperFeed(this.el, this.onError);
      this.feed.open(info, t);
      return;
    }
    this.feed?.close();
    if (info.seek === "native") {
      this.base = 0;
      this.el.src = info.url;
      this.el.currentTime = t;
    } else {
      this.base = t;
      this.el.src = withStart(info.url, t);
    }
  }

  /** Fallbacks: the helper can't serve it → Stash; Stash's direct stream not decodable → Stash's transcode. */
  private onError = () => {
    const info = this.info;
    if (!this.scene || !info) return;
    const scene = this.scene;
    const t = this.time;
    if (info.local) notLocal.add(scene.id);
    else if (info.seek === "native") markTranscodeOnly(scene.id);
    else return;
    this.feed?.close();
    this.sceneId = null;
    this.assign(scene, t);
  };
}
