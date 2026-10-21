/** Picks a browser-playable Stash stream and hides the difference between direct and transcoded seeking. */
import { stashUrl } from "./graphql";
import type { StashSceneCore } from "./types";

export interface StreamInfo {
  url: string;
  /** native = HTTP range seeking; param = transcode restarted with ?start= */
  seek: "native" | "param";
}

const CODEC_MIME: Record<string, string> = {
  h264: 'video/mp4; codecs="avc1.640028"',
  hevc: 'video/mp4; codecs="hvc1.1.6.L120.90"',
  vp8: 'video/webm; codecs="vp8"',
  vp9: 'video/webm; codecs="vp9"',
  av1: 'video/mp4; codecs="av01.0.08M.08"',
};

/** Scenes whose direct stream failed in this browser session. */
const transcodeOnly = new Set<string>();
export const markTranscodeOnly = (sceneId: string) => transcodeOnly.add(sceneId);

let probe: HTMLVideoElement | null = null;
function canPlay(mime: string): boolean {
  probe ??= document.createElement("video");
  return probe.canPlayType(mime) !== "";
}

export function pickStream(scene: StashSceneCore): StreamInfo | null {
  const f = scene.files[0];
  const direct = scene.paths.stream;
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

/**
 * One <video> element bound to whichever scene it currently shows. `time` is always the absolute
 * source time, also for transcoded streams that restart at ?start=.
 */
export class VideoSlot {
  sceneId: string | null = null;
  private scene: StashSceneCore | null = null;
  private info: StreamInfo | null = null;
  private base = 0;

  constructor(readonly el: HTMLVideoElement) {
    el.addEventListener("error", this.onError);
  }

  get time(): number {
    return this.base + (this.el.currentTime || 0);
  }

  get ready(): boolean {
    return this.el.readyState >= 2;
  }

  assign(scene: StashSceneCore, t: number): void {
    if (this.sceneId === scene.id && this.info) {
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
    const rel = t - this.base;
    const buffered = this.el.buffered.length ? this.el.buffered.end(this.el.buffered.length - 1) : 0;
    if (rel < 0 || rel > buffered + 0.5) this.load(t);
    else this.el.currentTime = rel;
  }

  release(): void {
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
    if (info.seek === "native") {
      this.base = 0;
      this.el.src = info.url;
      this.el.currentTime = t;
    } else {
      this.base = t;
      this.el.src = withStart(info.url, t);
    }
  }

  /** Direct stream not decodable here -> remember and retry with a transcode. */
  private onError = () => {
    if (!this.scene || this.info?.seek !== "native") return;
    const scene = this.scene;
    const t = this.time;
    markTranscodeOnly(scene.id);
    this.sceneId = null;
    this.assign(scene, t);
  };
}
