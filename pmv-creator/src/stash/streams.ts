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

/** The stream URL from t on; `until` (source seconds) lets a helper 0.9.8+ stop its FFmpeg there instead of at the file's end. */
export function withStart(url: string, t: number, until?: number): string {
  const u = new URL(url);
  u.searchParams.set("start", t.toFixed(3));
  if (until !== undefined && until > t) u.searchParams.set("end", until.toFixed(3));
  return u.toString();
}

/** Buffer at most this far ahead of the playhead – FFmpeg on the PC waits meanwhile. */
const AHEAD = 20;
/** Drop what lies further behind the playhead than this. */
const BEHIND = 40;
/** The helper answers 503 while all its FFmpeg processes are taken: ask again this often before giving up on it. */
const BUSY_RETRIES = 6;
const BUSY_WAIT = 400;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Plays a helper stream through Media Source Extensions. Stash's Content-Security-Policy allows media only from
 * Stash or blob:, but fetch() may reach the helper (connect-src in pmv-creator.yml). Every stream begins exactly
 * at its ?start= with timestamp 0, so the SourceBuffer is shifted there and the element runs in source time.
 * A stream is one connection to the helper and one FFmpeg process there; the browser allows six connections to
 * a host, so a stream that is not needed is suspended (the connection closed, the buffer and the picture kept).
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
  /** The stream was stopped while its player was idle: what is buffered stays playable, nothing more comes. */
  private suspended = false;
  /** The stream came to its end (the helper stopped at `until` or at the file's end). */
  private done = false;

  constructor(
    private el: HTMLVideoElement,
    private fail: () => void,
  ) {}

  get time(): number {
    return this.loading ? this.target : this.el.currentTime || 0;
  }

  /** The first data of a new stream is still on its way. */
  get pending(): boolean {
    return this.loading;
  }

  /** A connection to the helper is open or about to be. */
  get streaming(): boolean {
    return this.timer !== 0 || (!!this.ctl && !this.ctl.signal.aborted);
  }

  /** Is t buffered or arriving? Then a seek only moves the playhead. */
  reaches(t: number): boolean {
    if (this.loading) return t >= this.from - 0.05 && t <= this.from + 3;
    const b = this.el.buffered;
    // a running stream brings the next second soon; a suspended or finished one has only what is there
    const slack = this.suspended || this.done ? -0.05 : 1;
    for (let i = 0; i < b.length; i++) if (t >= b.start(i) - 0.05 && t <= b.end(i) + slack) return true;
    return false;
  }

  seek(t: number): boolean {
    if (!this.reaches(t)) return false;
    if (this.loading) this.target = t;
    else if (Math.abs(this.el.currentTime - t) > 0.01) this.el.currentTime = t;
    return true;
  }

  open(info: StreamInfo, t: number, until?: number): void {
    this.close();
    this.from = t;
    this.target = t;
    this.loading = true;
    // scrubbing: a burst of seeks starts one stream, not one per mouse move
    const now = performance.now();
    const wait = now - this.lastOpen < 250 ? 150 : 0;
    this.lastOpen = now;
    this.timer = window.setTimeout(() => this.start(info, t, until), wait);
  }

  /** Closes the connection (the helper stops FFmpeg); the picture and what is buffered stay on the element. */
  suspend(): void {
    if (!this.streaming) return;
    this.close();
    this.suspended = true;
  }

  close(): void {
    window.clearTimeout(this.timer);
    this.timer = 0;
    this.ctl?.abort(); // the helper stops FFmpeg when the connection closes
    this.ctl = null;
    this.loading = false;
    this.suspended = false;
    this.done = false;
  }

  private start(info: StreamInfo, t: number, until?: number): void {
    this.timer = 0;
    const ms = new MediaSource();
    const ctl = new AbortController();
    this.ctl = ctl;
    const src = URL.createObjectURL(ms);
    ms.addEventListener(
      "sourceopen",
      () => {
        URL.revokeObjectURL(src);
        this.pump(ms, ctl.signal, info, t, until).catch(() => {
          if (!ctl.signal.aborted) this.fail();
        });
      },
      { once: true },
    );
    this.el.src = src;
  }

  /** Asks for the stream; a helper with all its FFmpeg processes taken (503) is asked again a few times. */
  private async request(info: StreamInfo, t: number, until: number | undefined, signal: AbortSignal): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(withStart(info.url, t, until), { signal, cache: "no-store" });
      if (res.status !== 503 || attempt >= BUSY_RETRIES) return res;
      await sleep(BUSY_WAIT);
      if (signal.aborted) return res;
    }
  }

  private async pump(ms: MediaSource, signal: AbortSignal, info: StreamInfo, t: number, until?: number): Promise<void> {
    if (info.duration && info.duration > t) ms.duration = info.duration;
    const sb = ms.addSourceBuffer(info.mime!);
    sb.timestampOffset = t;
    const res = await this.request(info, t, until, signal);
    if (signal.aborted) return;
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
    if (!signal.aborted) {
      this.done = true;
      this.ctl = null;
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
 * source time, also for transcoded streams that restart at ?start=. The slot knows whether it has a
 * picture yet and measures how long its seeks and new streams take, so a player can aim where its clock
 * will be once the picture is there.
 */
export class VideoSlot {
  sceneId: string | null = null;
  private scene: StashSceneCore | null = null;
  private info: StreamInfo | null = null;
  private base = 0;
  private gen = -1;
  private feed: HelperFeed | null = null;
  /** A frame of the current stream is decoded (false from a new source until its first picture). */
  private picture = false;
  /** Target that waits for the seek on its way, so every seek gets to show its frame (scrubbing). */
  private queued: number | null = null;
  /** Start of the seek or load on its way (0 = none), to measure it. */
  private opStart = 0;
  private opLoad = false;
  /** Seconds until a picture after a seek in the open stream / after opening a new one (running averages). */
  private seekSecs = 0.15;
  private loadSecs = 0.6;

  constructor(readonly el: HTMLVideoElement) {
    el.addEventListener("error", this.onError);
    el.addEventListener("loadstart", this.onLoadStart);
    el.addEventListener("loadeddata", this.onFrame);
    el.addEventListener("seeked", this.onFrame);
  }

  get time(): number {
    if (this.info?.seek === "mse" && this.feed) return this.feed.time;
    return this.base + (this.el.currentTime || 0);
  }

  /** There is a picture of this slot's stream – an older one while a seek is on its way. */
  get hasPicture(): boolean {
    return !!this.info && this.picture;
  }

  /** A seek or a new stream is on its way; `time` is its target meanwhile. */
  get busy(): boolean {
    if (!this.info) return false;
    if (this.info.seek === "mse") return !!this.feed?.pending || this.el.seeking;
    return this.el.seeking || !this.picture;
  }

  /** A helper stream is coming in (a connection to the helper, an FFmpeg process there). */
  get streaming(): boolean {
    return this.info?.seek === "mse" && !!this.feed?.streaming;
  }

  /**
   * The player is not needed any more (its clip is over): its connection is given up so the clips coming up get one –
   * the browser allows six per host. A helper stream is cut off, its picture and buffer stay (a seek beyond them opens
   * a new stream). A file from Stash is let go altogether: the browser keeps a paused player's connection for some
   * 17 s and closes it only for a new source (preload "none" is ignored once the file has played), so the picture
   * goes with it – the engine keeps the players whose picture it may still need.
   */
  suspend(): void {
    if (!this.info) return;
    if (this.info.seek === "mse") {
      if (this.feed?.streaming) this.feed.suspend();
    } else {
      this.release();
    }
  }

  /** Expected seconds until a picture of scene `sceneId` at source time t shows in this slot. */
  eta(sceneId: string, t: number): number {
    const info = this.info;
    if (!info || this.sceneId !== sceneId || this.stale) return this.loadSecs;
    if (info.seek === "native") return this.seekSecs;
    if (info.seek === "mse") return this.feed?.reaches(t) ? this.seekSecs : this.loadSecs;
    return this.inTranscode(t) ? this.seekSecs : this.loadSecs;
  }

  /** Length of the loaded file in source time (0 = unknown). */
  get duration(): number {
    const d = this.el.duration;
    if (this.info && this.info.seek !== "param" && Number.isFinite(d) && d > 0) return d;
    return this.scene?.files[0]?.duration ?? 0;
  }

  /** The videos' source changed (PC ↔ Stash) since this slot loaded – assign() reloads it. */
  get stale(): boolean {
    return !!this.info && this.gen !== generation;
  }

  /**
   * Shows scene `scene` at source time t. `until` (source seconds) is how far the clip needs the stream – a helper
   * 0.9.8+ then stops its FFmpeg there instead of encoding on to the end of the file.
   */
  assign(scene: StashSceneCore, t: number, until?: number): void {
    if (this.sceneId === scene.id && this.info && !this.stale) {
      this.seek(t, false, until);
      return;
    }
    this.scene = scene;
    this.sceneId = scene.id;
    this.info = pickStream(scene);
    if (this.info) this.load(t, until);
  }

  /**
   * While a seek is on its way, t waits until it is through (`force` starts over at once): an interrupted
   * seek never shows its frame, and slow seeks interrupted on every frame left the picture frozen.
   * The helper's stream handles this itself.
   */
  seek(t: number, force = false, until?: number): void {
    const info = this.info;
    if (!info) return;
    if (info.seek === "mse") {
      if (!this.feed?.seek(t)) this.load(t, until);
      return;
    }
    if (this.el.seeking && !force) {
      this.queued = t;
      return;
    }
    this.queued = null;
    if (info.seek === "native") {
      if (Math.abs(this.el.currentTime - t) > 0.01) this.measure(false, () => (this.el.currentTime = t));
    } else if (this.inTranscode(t)) {
      this.measure(false, () => (this.el.currentTime = t - this.base));
    } else {
      this.load(t);
    }
  }

  release(): void {
    this.feed?.close();
    this.el.pause();
    this.el.removeAttribute("src");
    this.el.load();
    this.sceneId = null;
    this.scene = null;
    this.info = null;
    this.picture = false;
    this.queued = null;
    this.opStart = 0;
  }

  dispose(): void {
    this.el.removeEventListener("error", this.onError);
    this.el.removeEventListener("loadstart", this.onLoadStart);
    this.el.removeEventListener("loadeddata", this.onFrame);
    this.el.removeEventListener("seeked", this.onFrame);
    this.release();
  }

  /** A transcoded stream restarted at `base` has t buffered (or about to). */
  private inTranscode(t: number): boolean {
    const rel = t - this.base;
    const b = this.el.buffered;
    return rel >= 0 && rel <= (b.length ? b.end(b.length - 1) : 0) + 0.5;
  }

  private measure(load: boolean, op: () => void): void {
    this.opStart = performance.now();
    this.opLoad = load;
    op();
  }

  private load(t: number, until?: number): void {
    const info = this.info!;
    this.gen = generation;
    this.queued = null;
    this.picture = false;
    this.opStart = performance.now();
    this.opLoad = true;
    if (info.seek === "mse") {
      this.base = 0;
      this.feed ??= new HelperFeed(this.el, this.onError);
      this.feed.open(info, t, until);
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

  private onLoadStart = () => {
    this.picture = false;
  };

  /** A picture arrived (a stream's first frame, a finished seek): note how long it took, then the queued target. */
  private onFrame = () => {
    if (this.el.readyState < 2) return;
    this.picture = true;
    if (this.el.seeking) return;
    if (this.opStart) {
      const secs = Math.min(5, Math.max(0.02, (performance.now() - this.opStart) / 1000));
      if (this.opLoad) this.loadSecs = (this.loadSecs + secs) / 2;
      else this.seekSecs = (this.seekSecs + secs) / 2;
      this.opStart = 0;
    }
    if (this.queued !== null) {
      const t = this.queued;
      this.queued = null;
      if (Math.abs(this.time - t) > 0.01) this.seek(t);
    }
  };

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
