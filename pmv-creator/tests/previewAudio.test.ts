// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flattenTimeline, resolveTransitions } from "../src/timeline/flatten";
import { clip, project } from "./helpers";

class Node {
  gain = { value: 1 };
  connections: Node[] = [];
  constructor(public context: Context) {}
  connect(to: Node) { this.connections.push(to); return to; }
  disconnect(to?: Node) { this.connections = to ? this.connections.filter((n) => n !== to) : []; }
}
class Context {
  static latest: Context;
  destination = new Node(this);
  state = "suspended";
  sources = new Map<HTMLMediaElement, Node>();
  gains: Node[] = [];
  constructor() { Context.latest = this; }
  createMediaElementSource(el: HTMLMediaElement) {
    if (this.sources.has(el)) throw new Error("element already captured");
    const source = new Node(this);
    this.sources.set(el, source);
    return source;
  }
  createGain() { const gain = new Node(this); this.gains.push(gain); return gain; }
  async resume() { this.state = "running"; }
}

beforeEach(() => { vi.resetModules(); vi.stubGlobal("AudioContext", Context); });
afterEach(() => vi.unstubAllGlobals());

describe("clip audio output", () => {
  it("amplifies above 100 %, reuses captured elements after remount and disconnects disposed routes", async () => {
    const { ClipAudioOutput } = await import("../src/ui/preview/audio");
    const el = document.createElement("video");
    const output = new ClipAudioOutput();
    output.setLevel(el, 1.5, true);
    const ctx = Context.latest;
    const source = ctx.sources.get(el)!;
    expect(ctx.gains[0].gain.value).toBe(1.5);
    expect(el.volume).toBe(1);
    expect(ctx.state).toBe("running");
    output.setLevel(el, 0.4, true);
    expect(ctx.gains[0].gain.value).toBe(0.4);
    expect(ctx.sources.size).toBe(1);
    output.dispose();
    expect(source.connections).toEqual([]);
    expect(ctx.gains[0].connections).toEqual([]);
    const remounted = new ClipAudioOutput();
    remounted.setLevel(el, 0.8, false);
    expect(ctx.sources.size).toBe(1);
    expect(ctx.gains[1].gain.value).toBe(0.8);
    remounted.dispose();
  });

  it("routes the full clip level to the recording without connecting it to the speakers", async () => {
    const { ClipAudioOutput, mediaAudioContext } = await import("../src/ui/preview/audio");
    mediaAudioContext();
    const ctx = Context.latest;
    const recording = new Node(ctx);
    const output = new ClipAudioOutput(recording as unknown as AudioNode);
    const el = document.createElement("video");
    output.setLevel(el, 2, true);
    expect(ctx.gains[0].gain.value).toBe(2);
    expect(ctx.gains[0].connections).toEqual([recording]);
    expect(el.volume).toBe(1);
    output.setLevel(el, 0, true);
    expect(ctx.gains[0].gain.value).toBe(0);
    expect(el.muted).toBe(true);
    output.dispose();
  });

  it("keeps native playback and reports its limit when Web Audio cannot be created", async () => {
    let attempts = 0;
    vi.stubGlobal("AudioContext", class { constructor() { attempts++; throw new Error("unavailable"); } });
    const { ClipAudioOutput } = await import("../src/ui/preview/audio");
    const output = new ClipAudioOutput();
    const el = document.createElement("video");
    output.setLevel(el, 1.5, true);
    expect(output.limited).toBe(true);
    expect(el.volume).toBe(1);
    expect(el.muted).toBe(false);
    output.setLevel(el, 2, true);
    expect(attempts).toBe(1);
  });

  it("multiplies the full clip gain by listening volume and mutes the graph when the clip ends", async () => {
    const { PreviewEngine } = await import("../src/ui/preview/engine");
    const p = project([], [clip("1", 0, 2, { volume: 1.5 })]);
    const el = document.createElement("video");
    el.load = () => undefined;
    el.play = () => Promise.resolve();
    el.pause = () => undefined;
    let listen = 1;
    const engine = new PreviewEngine([el], { listen: () => listen });
    const segs = flattenTimeline(p);
    engine.setTimeline({ segs, trans: resolveTransitions(p, segs), fps: 30, fit: "cover", scenes: { "1": {
      id: "1", files: [{ id: "f1", duration: 100, basename: "1.mp4", path: "/1.mp4", video_codec: "h264", audio_codec: "aac" }],
      paths: { stream: "/scene/1/stream" }, sceneStreams: [],
    } } as any });
    engine.render(0, true);
    const gain = Context.latest.gains[0];
    expect(gain.gain.value).toBe(1.5);
    listen = 0.4;
    engine.render(0, true);
    expect(gain.gain.value).toBeCloseTo(0.6);
    listen = 0;
    engine.render(0, true);
    expect(gain.gain.value).toBe(0);
    listen = 1;
    engine.render(2, true);
    expect(gain.gain.value).toBe(0);
    engine.dispose();
  });
});
