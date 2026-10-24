import { describe, expect, it } from "vitest";
import { applyMood, buildGeneration, defaultSettings, generationRange } from "../src/generator/generate";
import type { MaterialItem } from "../src/generator/material";
import { analyzeBeats } from "../src/generator/rhythm";
import { type TimedFrame, detectCuts, snapToBeat, templateShift, templateSlots } from "../src/generator/template";
import type { CutTemplate } from "../src/model/project";
import { project } from "./helpers";

const GRID = { bpm: 120, offset: 0, beatsPerBar: 4 }; // beat 0.5 s, bar 2 s
const W = 16;
const H = 9;

/** A shot: a picture that drifts a little from frame to frame (motion, no cut). */
const shot = (base: (x: number, y: number) => number) => (i: number) => {
  const px = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = Math.max(0, Math.min(255, base(x, y) + (i % 3)));
  return px;
};
const A = shot((x) => 100 + x * 10); // bright, with contrast (no flash)
const B = shot((_x, y) => 40 + y * 5); // dark
const C = shot((x, y) => 30 + ((x + y) % 2) * 40); // dark checker
const WHITE = () => new Uint8Array(W * H).fill(250);

/** 4 s at 30 fps: A, cut to B at 1 s, a two-frame flash at 2 s, cut to C at 3 s. */
function pmvFrames(): TimedFrame[] {
  const frames: TimedFrame[] = [];
  for (let i = 0; i < 120; i++) {
    const px = i < 30 ? A(i) : i === 60 || i === 61 ? WHITE() : i < 90 ? B(i) : C(i);
    frames.push({ t: i / 30, px });
  }
  return frames;
}

describe("cuts like another PMV: measuring", () => {
  it("finds the cuts and the flash (Pepega's rules), nothing in plain motion", () => {
    const { cuts, flashes } = detectCuts(pmvFrames(), W, H);
    expect(cuts).toEqual([1, 3]);
    expect(flashes).toEqual([2]);
  });

  it("a cut to a bright clip is a cut, not a flash; a long white picture is no flash either", () => {
    const frames: TimedFrame[] = [];
    for (let i = 0; i < 90; i++) frames.push({ t: i / 30, px: i < 30 ? B(i) : i < 60 ? A(i) : WHITE() });
    const { cuts, flashes } = detectCuts(frames, W, H);
    expect(cuts).toEqual([1, 2]);
    expect(flashes).toEqual([]);
  });

  it("two cuts closer than 0.15 s count once", () => {
    const frames = pmvFrames();
    frames[32] = { t: frames[32].t, px: C(32) }; // a 1-frame blip right after the cut at 1 s …
    frames[33] = { t: frames[33].t, px: B(33) };
    expect(detectCuts(frames, W, H).cuts.filter((c) => c < 1.5)).toEqual([1]);
  });

  it("snaps to a beat within 80 ms only", () => {
    expect(snapToBeat(1.04, GRID)).toBe(1);
    expect(snapToBeat(2.43, GRID)).toBe(2.5);
    expect(snapToBeat(2.75, GRID)).toBe(2.75);
  });
});

describe("cuts like another PMV: slots", () => {
  it("one slot per cut and flash, snapped, the flash marked, bar position from the beats", () => {
    const beats = analyzeBeats(GRID, 0, 8);
    const slots = templateSlots(beats, GRID, 0, 8, [1.03, 2.49, 2.75, 5.2], [4.0]);
    expect(slots.map((s) => [s.start, Number(s.duration.toFixed(3))])).toEqual([
      [0, 1],
      [1, 1.5],
      [2.5, 0.25],
      [2.75, 1.25],
      [4, 1.2],
      [5.2, 2.8],
    ]);
    expect(slots.map((s) => !!s.flash)).toEqual([false, false, false, false, true, false]);
    expect(slots.filter((s) => s.downbeat).map((s) => s.start)).toEqual([0, 4]);
  });

  it("drops cuts outside the range and ones closer than the minimum length", () => {
    const beats = analyzeBeats(GRID, 2, 6);
    const slots = templateSlots(beats, GRID, 2, 6, [1, 2.05, 3, 3.05, 7], []);
    expect(slots.map((s) => s.start)).toEqual([2, 3]);
  });
});

describe("cuts like another PMV: generating", () => {
  const item = (sceneId: string): MaterialItem => ({ snippet: { id: `sn_${sceneId}`, sceneId, markerId: null, in: 0, out: 100, label: sceneId, tags: [] }, performers: [], fixedStart: false });
  const pools = [["1", "2", "3"].map(item)];
  const tpl: CutTemplate = { sceneId: "9", title: "Other PMV", duration: 6, cuts: [1, 2.5, 4], flashes: [3], music: "other.m4a" };
  const withSong = (name: string) => {
    const p = project();
    p.beatGrid = GRID;
    p.audio = { name, path: "/m.m4a", url: null, duration: 32, sourceIn: 0, start: 10, gainDb: 0, fadeIn: 0, fadeOut: 0 };
    p.cutTemplate = tpl;
    return p;
  };
  const settings = (p: ReturnType<typeof project>) => {
    const s = defaultSettings(p.tracks[1].id);
    return { ...s, cut: { ...s.cut, mode: "template" as const } };
  };

  it("its own music: the clips change where the original cuts, the flash becomes a white flash, the range ends with it", () => {
    const p = withSong("other.m4a");
    const s = settings(p);
    const { result } = buildGeneration(p, s, generationRange(p, s.target, 0), { pools, sources: [], context: { speedMaps: {}, speedPct: () => null } });
    expect(result.clips.map((c) => c.start)).toEqual([10, 11, 12.5, 13, 14]);
    expect(result.clips.map((c) => c.transitionIn?.type ?? null)).toEqual([null, null, null, "fadewhite", null]);
    expect(result.to).toBe(16);
  });

  it("a song of its own: the cuts start with the generated range", () => {
    const p = withSong("mine.mp3");
    expect(templateShift(tpl, p.audio, 10)).toBe(10);
    const s = settings(p);
    const { result } = buildGeneration(p, s, generationRange(p, s.target, 0), { pools, sources: [], context: { speedMaps: {}, speedPct: () => null } });
    expect(result.clips[0].start).toBe(10);
    expect(result.clips.length).toBe(5);
  });

  it("a mood keeps the cuts of the PMV and only changes the style", () => {
    const s = settings(project());
    const m = applyMood(s, "maximal");
    expect(m.cut.mode).toBe("template");
    expect(m.style).toMatchObject({ transitionOn: "bar", transitionType: "fadewhite" });
  });
});
