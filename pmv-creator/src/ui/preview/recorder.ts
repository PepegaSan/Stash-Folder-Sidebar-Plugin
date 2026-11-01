/**
 * "Quick record": plays the sequence once in real time on hidden <video> elements (the same PreviewEngine
 * and compositor as the on-screen preview), draws every frame onto a canvas and records canvas + mixed audio with
 * MediaRecorder. Fast and server-free, but not frame-exact – a stutter or a slow stream ends up in the
 * file. The frame-exact path is the FFmpeg render.
 */
import { type EffectTimeline, withStutters } from "../../fx/timeline";
import { colorGrade } from "../../model/look";
import type { PmvProject } from "../../model/project";
import { projectDuration } from "../../model/project";
import type { StashScene } from "../../stash/types";
import type { Transport } from "../../state/transport";
import { flattenTimeline, resolveTransitions } from "../../timeline/flatten";
import { Compositor } from "./compositor";
import { PREVIEW_SLOTS, PreviewEngine } from "./engine";
import { captureElement, mediaAudioContext } from "./audio";

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

const musicSpeakers = new WeakSet<HTMLMediaElement>();

/** The music keeps playing to the speakers – through the listening volume, which the recording never gets. */
function captureMusic(transport: Transport): MediaElementAudioSourceNode {
  const known = musicSpeakers.has(transport.audio);
  const node = captureElement(transport.audio);
  if (!known) {
    const ctx = mediaAudioContext()!;
    const speaker = ctx.createGain();
    node.connect(speaker).connect(ctx.destination);
    transport.routeSpeaker(speaker);
    musicSpeakers.add(transport.audio);
  }
  return node;
}

export class RecordCancelled extends Error {
  constructor() {
    super("cancelled");
  }
}

/** `fx`: the project's effect timeline (loadEffects) – the one the preview draws. */
export async function recordSequence(project: PmvProject, scenes: Record<string, StashScene>, transport: Transport, onProgress: (p: RecordProgress) => void, signal?: AbortSignal, fx: EffectTimeline | null = null): Promise<Recording> {
  const { width, height, fps, fit } = project.output;
  const duration = projectDuration(project);
  const mime = MIMES.find((m) => MediaRecorder.isTypeSupported(m))!;
  const ctx = mediaAudioContext();
  if (!ctx) throw new Error("Web Audio is unavailable");
  await ctx.resume();
  const dest = ctx.createMediaStreamDestination();

  // hidden players – tiny, in the corner and (nearly) transparent: off screen Chrome renders them on a slow timer
  const host = document.createElement("div");
  host.style.cssText = "position:fixed;left:0;top:0;width:64px;height:36px;overflow:hidden;pointer-events:none;z-index:2147483647";
  const videos = Array.from({ length: PREVIEW_SLOTS }, () => {
    const v = document.createElement("video");
    v.playsInline = true;
    v.preload = "auto";
    v.style.cssText = "position:absolute;inset:0;width:100%;height:100%";
    host.appendChild(v);
    return v;
  });
  document.body.appendChild(host);

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const compositor = new Compositor(canvas);
  const grade = colorGrade(project.output);
  const engine = new PreviewEngine(videos, { audioDestination: dest });
  const segs = withStutters(flattenTimeline(project), fx, fps);
  engine.setTimeline({ segs, trans: resolveTransitions(project, segs), fps, scenes, fit });

  // audio: music (also to the speakers, as always) + the hidden players' clip audio (recording only)
  const nodes = [captureMusic(transport)];
  nodes.forEach((n) => n.connect(dest));

  const stream = new MediaStream([...canvas.captureStream(fps).getVideoTracks(), ...dest.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.min(20e6, Math.max(3e6, Math.round(width * height * fps * 0.12))), audioBitsPerSecond: 192000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const draw = (t: number) => compositor.draw(engine.view, grade, fx ? { tl: fx, t } : null);

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
        const t = transport.time;
        engine.render(t, transport.playing);
        draw(t);
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
