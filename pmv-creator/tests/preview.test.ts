// @vitest-environment jsdom
/**
 * The PMV preview engine against fake <video> elements whose loading and seeking the test controls: clips coming
 * up are loaded ahead, a slow seek is not chased, the last picture stays while a file opens, edits keep the players.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PmvProject } from "../src/model/project";
import { VideoSlot } from "../src/stash/streams";
import type { StashScene } from "../src/stash/types";
import { flattenTimeline, resolveTransitions } from "../src/timeline/flatten";
import { ensureTracks } from "../src/timeline/ops";
import { PREVIEW_SLOTS, PreviewEngine } from "../src/ui/preview/engine";
import { clip, project } from "./helpers";

interface Media {
  readyState: number;
  seeking: boolean;
  currentTime: number;
  duration: number;
  paused: boolean;
  src: string;
  /** currentTime assignments once the file is open (= seeks). */
  seeks: number[];
}

type FakeVideo = HTMLVideoElement & { m: Media };

function fakeVideo(): FakeVideo {
  const el = document.createElement("video") as FakeVideo;
  const m: Media = { readyState: 0, seeking: false, currentTime: 0, duration: NaN, paused: true, src: "", seeks: [] };
  const prop = (name: string, get: () => unknown, set?: (v: never) => void) => Object.defineProperty(el, name, { configurable: true, get, set });
  prop("readyState", () => m.readyState);
  prop("seeking", () => m.seeking);
  prop("duration", () => m.duration);
  prop("paused", () => m.paused);
  prop("ended", () => false);
  prop("buffered", () => ({ length: 0, start: () => 0, end: () => 0 }));
  prop("currentTime", () => m.currentTime, (v: number) => {
    m.currentTime = v;
    if (m.readyState >= 1) {
      m.seeking = true;
      m.seeks.push(v);
    }
  });
  prop("src", () => m.src, (v: string) => {
    m.src = v;
    m.readyState = 0;
    m.seeking = false;
    m.duration = NaN;
  });
  el.play = () => {
    m.paused = false;
    return Promise.resolve();
  };
  el.pause = () => void (m.paused = true);
  el.m = m;
  return el;
}

/** The file is open and shows its first picture. */
function open(v: FakeVideo): void {
  v.m.readyState = 4;
  v.m.duration = 100;
  v.dispatchEvent(new Event("loadeddata"));
}

function finishSeek(v: FakeVideo): void {
  v.m.seeking = false;
  v.dispatchEvent(new Event("seeked"));
}

function scene(id: string): StashScene {
  return {
    id,
    title: null,
    date: null,
    rating100: null,
    files: [{ id: `f${id}`, path: `/media/${id}.mp4`, basename: `${id}.mp4`, duration: 100, width: 1920, height: 1080, frame_rate: 30, video_codec: "h264", audio_codec: "aac" }],
    paths: { screenshot: null, stream: `/scene/${id}/stream`, preview: null, sprite: null, vtt: null },
    sceneStreams: [],
    studio: null,
    performers: [],
    tags: [],
    scene_markers: [],
  };
}

const scenes = Object.fromEntries(["1", "2", "3", "4", "5", "6", "7"].map((id) => [id, scene(id)]));
const sceneOf = (v: FakeVideo) => /\/scene\/(\d+)\//.exec(v.m.src)?.[1] ?? null;

function setup(p: PmvProject) {
  const videos = Array.from({ length: PREVIEW_SLOTS }, fakeVideo);
  const engine = new PreviewEngine(videos);
  const timeline = () => {
    const segs = flattenTimeline(p);
    engine.setTimeline({ segs, trans: resolveTransitions(p, segs), fps: 30, scenes, fit: "cover" });
  };
  timeline();
  const visible = () => videos.filter((v) => v.dataset.op === "1");
  return { videos, engine, timeline, visible };
}

/** One clip per second: scenes 1, 2, 3, 1, 2, 3 from 10 s on. */
const sixClips = () => project([], ["1", "2", "3", "1", "2", "3"].map((id, k) => clip(id, k, 1)));

beforeAll(() => {
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
});

describe("PreviewEngine", () => {
  it("loads the clips coming up ahead, two files at a time and the nearest first", () => {
    const { videos, engine } = setup(sixClips());
    engine.render(0, false);
    expect(videos.map(sceneOf)).toEqual(["1", "2", null, null, null, null, null, null]);
    expect(videos[1].m.currentTime).toBe(10);
    open(videos[0]);
    open(videos[1]);
    engine.render(0, false);
    expect(videos.map(sceneOf)).toEqual(["1", "2", "3", "1", null, null, null, null]);
    expect(videos[3].m.currentTime).toBe(10);
    expect(videos.every((v) => v.m.paused)).toBe(true);
  });

  it("lets a slow seek arrive instead of starting over on every frame", () => {
    const { videos, engine } = setup(sixClips());
    engine.render(0, false);
    open(videos[0]);
    // playing, but the picture does not move: after a quarter second behind, one seek – aimed ahead of the clock
    let t = 0;
    for (; t < 0.4; t += 1 / 60) engine.render(t, true);
    expect(videos[0].m.paused).toBe(false);
    expect(videos[0].m.seeks).toHaveLength(1);
    expect(videos[0].m.seeks[0]).toBeGreaterThan(10.25);
    // the seek takes its time: no new one while it is on its way …
    for (; t < 0.9; t += 1 / 60) engine.render(t, true);
    expect(videos[0].m.seeks).toHaveLength(1);
    // … and none once it is through and close to the clock
    videos[0].m.currentTime = 10 + t;
    finishSeek(videos[0]);
    videos[0].m.seeks = [];
    engine.render(t, true);
    expect(videos[0].m.seeks).toHaveLength(0);
  });

  it("keeps the last picture on screen while the next clip's file is still opening", () => {
    const { videos, engine, visible } = setup(sixClips());
    engine.render(0, false);
    open(videos[0]);
    engine.render(0.5, true);
    expect(visible()).toEqual([videos[0]]);
    // the cut to clip 2 (scene 2): its player has no picture yet
    engine.render(1.02, true);
    expect(visible()).toEqual([videos[0]]);
    expect(videos[0].m.paused).toBe(true);
    open(videos[1]);
    engine.render(1.04, true);
    expect(visible()).toEqual([videos[1]]);
    expect(videos[1].m.paused).toBe(false);
  });

  it("starts the next clip unseen and silent just before its cut, so it is moving when it shows", () => {
    const p = sixClips();
    p.tracks[1].clips[1].volume = 1;
    const { videos, engine, visible } = setup(p);
    engine.render(0, false);
    open(videos[0]);
    open(videos[1]);
    engine.render(0.5, true);
    expect(videos[1].m.paused).toBe(true);
    engine.render(0.93, true);
    expect(videos[1].m.paused).toBe(false);
    expect(videos[1].muted).toBe(true);
    expect(visible()).toEqual([videos[0]]);
    expect(videos[1].m.seeks).toHaveLength(0);
    engine.render(1.0, true);
    expect(visible()).toEqual([videos[1]]);
    expect(videos[1].muted).toBe(false);
  });

  it("keeps its players when the timeline changes – an edit costs a seek, not a reload", () => {
    const p = sixClips();
    const { videos, engine, timeline } = setup(p);
    // everything coming up loaded (two files at a time)
    for (let k = 0; k < 4; k++) {
      engine.render(0, false);
      videos.forEach(open);
    }
    const before = videos.map((v) => v.m.src);
    p.tracks[1].clips[0] = { ...p.tracks[1].clips[0], sourceIn: 20 };
    timeline();
    engine.render(0, false);
    expect(videos.map((v) => v.m.src)).toEqual(before);
    expect(videos[0].m.seeks).toEqual([20]);
  });

  it("scrubbing: a seek waits for the one on its way, then the newest target follows", () => {
    const v = fakeVideo();
    const slot = new VideoSlot(v);
    slot.assign(scenes["1"], 10);
    open(v);
    slot.seek(20);
    slot.seek(30);
    slot.seek(40);
    expect(v.m.seeks).toEqual([20]);
    expect(slot.busy).toBe(true);
    finishSeek(v);
    expect(v.m.seeks).toEqual([20, 40]);
    finishSeek(v);
    expect(slot.busy).toBe(false);
    // a player that has to start over says so
    slot.seek(50);
    slot.seek(60, true);
    expect(v.m.seeks).toEqual([20, 40, 50, 60]);
  });

  it("a split screen plays the clip of every field, each in its own field", () => {
    const p = ensureTracks(project([], [clip("1", 0, 2)]), 3);
    p.tracks[1].clips = [clip("2", 0, 2)];
    p.tracks[0].clips = [clip("3", 0, 2)];
    p.layouts = [{ id: "lay", start: 0, duration: 2, kind: "tri", dir: "cols" }];
    const { videos, engine } = setup(p);
    engine.render(0.5, false);
    videos.forEach(open);
    engine.render(0.5, true);
    expect(engine.view.layout).toEqual({ kind: "tri", dir: "cols" });
    expect(engine.view.layers.map((l) => [l.field?.group, sceneOf(l.el as FakeVideo)])).toEqual([
      [0, "1"],
      [1, "2"],
      [2, "3"],
    ]);
    expect(videos.filter((v) => !v.m.paused).map(sceneOf).sort()).toEqual(["1", "2", "3"]);
  });

  it("a field clip that comes in never takes the player of a field that goes on", () => {
    // a 4-way over [0, 4): V1 cuts at 2 s, V2…V4 play through; full screen after it (fills the look-ahead)
    const p = ensureTracks(project([], [clip("7", 0, 2), clip("3", 2, 2), clip("1", 4, 1), clip("2", 5, 1), clip("1", 6, 1), clip("2", 7, 1)]), 4);
    p.tracks[2].clips = [clip("4", 0, 4)];
    p.tracks[1].clips = [clip("5", 0, 4)];
    p.tracks[0].clips = [clip("6", 0, 4)];
    p.layouts = [{ id: "lay", start: 0, duration: 4, kind: "quad", dir: "cols" }];
    const { videos, engine } = setup(p);
    for (let k = 0; k < 6; k++) {
      engine.render(3, false);
      videos.forEach(open);
    }
    const fields = videos.slice(1, 4).map(sceneOf);
    expect(fields).toEqual(["4", "5", "6"]);
    expect(videos.every((v) => v.m.src)).toBe(true);
    // back to 1 s: V1's other clip was not loaded ahead – it must not take V2's, V3's or V4's player
    engine.render(1, true);
    expect(videos.slice(1, 4).map(sceneOf)).toEqual(fields);
    expect(engine.view.layers.map((l) => sceneOf(l.el as FakeVideo))).toEqual(["7", "4", "5", "6"]);
  });

  it("plays both sides of a transition", () => {
    const p = project([], [clip("1", 0, 1), clip("2", 1, 1, { transitionIn: { type: "fade", duration: 0.4 } })]);
    const { videos, engine } = setup(p);
    engine.render(0, false);
    videos.forEach(open);
    engine.render(0.9, true);
    const playing = videos.filter((v) => !v.m.paused).map(sceneOf);
    expect(playing.sort()).toEqual(["1", "2"]);
  });
});
