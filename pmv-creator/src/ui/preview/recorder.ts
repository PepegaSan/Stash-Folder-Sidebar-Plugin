/**
 * "Quick record": plays the sequence once in real time on hidden <video> elements (the same PreviewEngine
 * as the on-screen preview), composites every frame onto a canvas and records canvas + mixed audio with
 * MediaRecorder. Fast and server-free, but not frame-exact – a stutter or a slow stream ends up in the
 * file. The frame-exact path is the FFmpeg render.
 */
import type { PmvProject } from "../../model/project";
import { projectDuration } from "../../model/project";
import type { StashScene } from "../../stash/types";
import type { Transport } from "../../state/transport";
import { flattenTimeline, resolveTransitions } from "../../timeline/flatten";
import { PreviewEngine } from "./engine";

export interface RecordProgress {
  time: number;
  duration: number;
}

export interface Recording {
  blob: Blob;
  mime: string;
  seconds: number;
}

const MIMES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];

export function recordingSupported(): boolean {
  return typeof MediaRecorder !== "undefined" && typeof HTMLCanvasElement.prototype.captureStream === "function" && MIMES.some((m) => MediaRecorder.isTypeSupported(m));
}

// one AudioContext per page; a media element can be captured only once, the node then owns its output
let audioCtx: AudioContext | null = null;
const sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();
function captureElement(el: HTMLMediaElement, toSpeakers: boolean): MediaElementAudioSourceNode {
  audioCtx ??= new AudioContext();
  let node = sources.get(el);
  if (!node) {
    node = audioCtx.createMediaElementSource(el);
    if (toSpeakers) node.connect(audioCtx.destination);
    sources.set(el, node);
  }
  return node;
}

export class RecordCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

export async function recordSequence(project: PmvProject, scenes: Record<string, StashScene>, transport: Transport, onProgress: (p: RecordProgress) => void, signal?: AbortSignal): Promise<Recording> {
  const { width, height, fps, fit } = project.output;
  const duration = projectDuration(project);
  const mime = MIMES.find((m) => MediaRecorder.isTypeSupported(m))!;

  // hidden players – off screen but laid out, so they decode
  const host = document.createElement("div");
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:${height}px;overflow:hidden;pointer-events:none`;
  const videos = [0, 1].map(() => {
    const v = document.createElement("video");
    v.playsInline = true;
    v.preload = "auto";
    v.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
    host.appendChild(v);
    return v;
  }) as [HTMLVideoElement, HTMLVideoElement];
  const overlay = document.createElement("div");
  host.appendChild(overlay);
  document.body.appendChild(host);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext("2d")!;
  const engine = new PreviewEngine(videos, overlay);
  const segs = flattenTimeline(project);
  engine.setTimeline({ segs, trans: resolveTransitions(project, segs), fps, scenes, fit });

  // audio: music (also to the speakers, as always) + the hidden players' clip audio (recording only)
  const ctx = (audioCtx ??= new AudioContext());
  await ctx.resume().catch(() => undefined);
  const dest = ctx.createMediaStreamDestination();
  const nodes = [captureElement(transport.audio, true), ...videos.map((v) => captureElement(v, false))];
  nodes.forEach((n) => n.connect(dest));

  const stream = new MediaStream([...canvas.captureStream(fps).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.min(20e6, Math.max(3e6, Math.round(width * height * fps * 0.12))), audioBitsPerSecond: 192000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const draw = () => {
    g.fillStyle = "#000";
    g.fillRect(0, 0, width, height);
    // same stacking as the DOM preview: z-index, then opacity
    const order = [...videos].sort((a, b) => Number(a.style.zIndex || 1) - Number(b.style.zIndex || 1));
    for (const v of order) {
      const alpha = Number(v.style.opacity || 0);
      if (alpha <= 0 || v.readyState < 2 || !v.videoWidth) continue;
      g.globalAlpha = alpha;
      // the engine marks each slot with the clip's framing
      const clipFit: typeof fit = v.classList.contains("is-blur") ? "blur" : v.classList.contains("is-contain") ? "contain" : "cover";
      const cover = Math.max(width / v.videoWidth, height / v.videoHeight);
      const contain = Math.min(width / v.videoWidth, height / v.videoHeight);
      if (clipFit === "blur") {
        g.filter = `blur(${Math.round(Math.min(width, height) / 40)}px) brightness(0.85)`;
        g.drawImage(v, (width - v.videoWidth * cover) / 2, (height - v.videoHeight * cover) / 2, v.videoWidth * cover, v.videoHeight * cover);
        g.filter = "none";
      }
      const scale = clipFit === "cover" ? cover : contain;
      const w = v.videoWidth * scale;
      const h = v.videoHeight * scale;
      g.drawImage(v, (width - w) / 2, (height - h) / 2, w, h);
    }
    g.globalAlpha = Number(overlay.style.opacity || 0);
    if (g.globalAlpha > 0) {
      g.fillStyle = overlay.style.background || "#000";
      g.fillRect(0, 0, width, height);
    }
    g.globalAlpha = 1;
  };

  const cleanup = () => {
    transport.pause();
    nodes.forEach((n) => {
      try {
        n.disconnect(dest);
      } catch {
        /* already gone */
      }
    });
    stream.getTracks().forEach((tr) => tr.stop());
    engine.dispose();
    host.remove();
  };

  try {
    // pre-roll: cue the first picture before the recorder starts
    transport.pause();
    transport.seek(0);
    engine.render(0, false);
    const t0 = performance.now();
    while (performance.now() - t0 < 4000 && !videos.some((v) => v.readyState >= 2)) await new Promise((r) => setTimeout(r, 50));
    if (signal?.aborted) throw new RecordCancelled();

    const blob = await new Promise<Blob>((resolve, reject) => {
      let finished = false;
      let raf = 0;
      const finish = (err?: Error) => {
        if (finished) return;
        finished = true;
        cancelAnimationFrame(raf);
        off();
        signal?.removeEventListener("abort", onAbort);
        rec.onstop = () => (err ? reject(err) : resolve(new Blob(chunks, { type: mime })));
        if (rec.state !== "inactive") rec.stop();
        else rec.onstop(new Event("stop"));
      };
      const onAbort = () => finish(new RecordCancelled());
      signal?.addEventListener("abort", onAbort);
      const off = transport.subscribe(() => {
        onProgress({ time: transport.time, duration });
        if (!transport.playing) {
          // the clock stops at the end by itself; a pause before that (space bar) cancels
          finish(transport.time >= duration - 0.05 ? undefined : new RecordCancelled());
        }
      });
      const frame = () => {
        engine.render(transport.time, transport.playing);
        draw();
        raf = requestAnimationFrame(frame);
      };
      rec.onerror = () => finish(new Error("MediaRecorder error"));
      rec.start(1000);
      transport.play();
      raf = requestAnimationFrame(frame);
    });
    return { blob, mime, seconds: duration };
  } finally {
    cleanup();
  }
}
