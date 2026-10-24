/** Beat and drop effects: when they fire, what a frame shows, the stutter cuts and what the render plan carries. */
import { describe, expect, it } from "vitest";
import { MAX_FX_FRAMES, buildRenderPlan, pieceFx } from "../src/export/renderPlan";
import { type EffectTimeline, TEXT_SECONDS, effectFrame, effectTimeline, fxHash, textSize, withStutters } from "../src/fx/timeline";
import { applyGeneration, defaultSettings, moodEffects } from "../src/generator/generate";
import type { EnergyFn } from "../src/generator/rhythm";
import { DEFAULT_EFFECTS, type EffectSettings, effectWords } from "../src/model/effects";
import { createAudioTrack, migrateProject } from "../src/model/project";
import { flattenTimeline } from "../src/timeline/flatten";
import { clip, project } from "./helpers";

/** 120 BPM, 32 s: quiet for 12 s, then loud – a drop on beat 24 (12 s). */
const song: EnergyFn = (t0) => (t0 >= 12 - 1e-9 ? 1 : 0.1);

function fxProject(fx: Partial<EffectSettings>, clips = [clip("1", 0, 32, { sourceIn: 10 })]) {
  const p = project([], clips);
  p.audio = createAudioTrack("song", "/music/song.mp3", "/m/song.mp3", 32);
  p.effects = { ...DEFAULT_EFFECTS, ...fx };
  return p;
}

const all: Partial<EffectSettings> = { zoom: true, shake: true, stutter: true, strobe: true, rgb: true, glitch: true, tunnel: true, invert: true, echo: true, text: true, hue: true, words: "drop it, wow" };

describe("effect timeline", () => {
  it("is null without an effect", () => {
    expect(effectTimeline(fxProject({}), song)).toBeNull();
  });

  it("fires the drop effects on the drop and the loud ones in the loud part", () => {
    const tl = effectTimeline(fxProject(all), song)!;
    expect(tl.tunnels.map((x) => x.t)).toEqual([12]);
    expect(tl.rgb.find((x) => x.t === 12)?.amt).toBeCloseTo(26 / 1280);
    expect(tl.glitches[0].t0).toBe(12);
    expect(tl.inverts[0]).toEqual({ t0: 12, t1: 12 + 4 / 30 });
    expect(tl.texts[0]).toMatchObject({ t: 12 });
    expect(["DROP IT", "WOW"]).toContain(tl.texts[0].word);
    // nothing loud before the drop
    for (const list of [tl.shakes, tl.strobes, tl.glitches, tl.inverts, tl.echoes]) expect(list.every((x) => x.t0 >= 12)).toBe(true);
    expect(tl.stutters.every((t) => t > 12)).toBe(true);
    // stutters on every other half beat, never on the drop beat itself
    expect(tl.stutters.length).toBeGreaterThan(5);
    for (const t of tl.stutters) expect(Math.round(((t - 0.25) / 0.5) % 2)).toBe(1);
    // the strobe: on the beat and half beats, 1–2 frames each
    expect(tl.strobes.every((s) => s.t1 - s.t0 > 0 && s.t1 - s.t0 <= 2 / 30 + 1e-9)).toBe(true);
  });

  it("is the same every time (randomness from hashes, not Math.random)", () => {
    const a = effectTimeline(fxProject(all), song);
    const b = effectTimeline(fxProject(all), song);
    expect(a).toEqual(b);
    expect(fxHash(123, 4, 1)).toBe(fxHash(123, 4, 1));
    expect(fxHash(123, 4, 1)).not.toBe(fxHash(124, 4, 1));
  });

  it("without music: beat effects only", () => {
    const tl = effectTimeline(fxProject(all))!;
    expect(tl.pulses.length).toBeGreaterThan(60);
    expect(tl.tunnels).toEqual([]);
    expect(tl.texts).toEqual([]);
  });
});

describe("effect frame", () => {
  it("zoom pulse: peaks on the beat, eases in just before, dies away after", () => {
    const tl = effectTimeline(fxProject({ zoom: true }), song)!;
    const at = (t: number) => effectFrame(tl, t).zoom;
    // the drop beat: 0.03 + 0.07 + 0.1
    expect(at(12)).toBeCloseTo(1.2, 5);
    expect(at(12 - 0.055)).toBeGreaterThan(1.01);
    expect(at(12 - 0.055)).toBeLessThan(at(12));
    expect(at(12.2)).toBeCloseTo(1 + 0.2 * Math.exp(-5.5 * 0.2), 5);
    // quiet beats pulse little
    expect(at(2)).toBeCloseTo(1.03, 5);
  });

  it("zoom pulse on the bar only (drops always), with its strength", () => {
    const tl = effectTimeline(fxProject({ zoom: true, pulseOn: "bar", pulseAmount: 0.5 }), song)!;
    expect(tl.pulses.map((x) => x.t).filter((t) => t < 12)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(effectFrame(tl, 12).zoom).toBeCloseTo(1.1, 5);
  });

  it("shaking stays inside the picture: the zoom covers the shift", () => {
    const tl = effectTimeline(fxProject({ shake: true }), song)!;
    let seen = 0;
    for (let f = 360; f < 960; f++) {
      const fr = effectFrame(tl, f / 30);
      if (!fr.shake) continue;
      seen++;
      expect(fr.zoom).toBeGreaterThanOrEqual(1 + 2 * Math.abs(fr.dx) - 1e-9);
      expect(fr.zoom).toBeGreaterThanOrEqual(1 + (2 * Math.abs(fr.dy) * 1920) / 1080 - 1e-9);
    }
    expect(seen).toBeGreaterThan(50);
  });

  it("tunnel fades from 1 to 0.1, the word slams in and goes", () => {
    const tl = effectTimeline(fxProject({ tunnel: true, text: true, words: "wow" }), song)!;
    expect(effectFrame(tl, 12).tunnel).toBe(1);
    const dur = tl.tunnels[0].dur;
    expect(effectFrame(tl, 12 + dur - 1 / 30).tunnel).toBeGreaterThan(0.1);
    expect(effectFrame(tl, 12 + dur).tunnel).toBe(0);
    expect(effectFrame(tl, 12 + 0.2).text).toMatchObject({ word: "WOW", tt: expect.closeTo(0.2, 6) });
    expect(effectFrame(tl, 12 + TEXT_SECONDS).text).toBeNull();
  });

  it("colour rush turns on smoothly (no jumps between beats)", () => {
    const tl = effectTimeline(fxProject({ hue: true }), song)!;
    let last = effectFrame(tl, 0).hue!;
    for (let f = 1; f < 900; f++) {
      const h = effectFrame(tl, f / 30).hue!;
      expect(h - last).toBeGreaterThan(0);
      expect(h - last).toBeLessThan(140 / 30 + 1e-6);
      last = h;
    }
  });
});

describe("stutter", () => {
  it("cuts the clip at each stutter and jumps back a quarter of its time", () => {
    const p = fxProject({ stutter: true });
    const tl = effectTimeline(p, song)!;
    const segs = withStutters(flattenTimeline(p), tl, 30);
    expect(segs.length).toBe(1 + tl.stutters.length);
    const s = segs[1];
    const f = Math.round(tl.stutters[0] * 30);
    expect(s.startFrame).toBe(f);
    expect(s.clipStartFrame).toBe(f);
    expect(s.clip!.sourceIn).toBeCloseTo(10 + 0.25 * (f / 30), 6);
    expect(s.clip!.transitionIn).toBeNull();
    // contiguous, frame-exact
    for (let i = 1; i < segs.length; i++) expect(segs[i].startFrame).toBe(segs[i - 1].endFrame);
  });

  it("not right at a cut and not in a gap", () => {
    const tl: EffectTimeline = { ...effectTimeline(fxProject({ stutter: true }), song)!, stutters: [1 / 30, 5, 9 + 1 / 30] };
    const p = fxProject({ stutter: true }, [clip("1", 0, 4), clip("2", 9, 4)]);
    const segs = withStutters(flattenTimeline(p), tl, 30);
    expect(segs).toEqual(flattenTimeline(p));
  });
});

describe("render plan with effects", () => {
  const p = fxProject(all);
  const tl = effectTimeline(p, song)!;
  const { plan } = buildRenderPlan(p, tl);

  it("pieces carry their effects per frame and still add up", () => {
    expect(plan.pieces.reduce((n, x) => n + x.frames, 0)).toBe(plan.totalFrames);
    let at = 0;
    for (const piece of plan.pieces) {
      const fx = piece.fx!;
      expect(fx.at).toBe(at);
      for (const k of ["zoom", "hue", "echo", "rgb"] as const) if (fx[k]) expect(fx[k]!.length).toBe(piece.frames);
      expect(piece.frames).toBeLessThanOrEqual(MAX_FX_FRAMES);
      at += piece.frames;
    }
    expect(plan.fontUrl).toBe("/plugin/pmv-creator/assets/fonts/Anton-Regular.ttf");
  });

  it("the per-frame values are the preview's (effectFrame) at that frame", () => {
    const piece = plan.pieces.find((x) => x.fx?.rgb)!;
    const i = piece.fx!.rgb!.findIndex((v) => v > 0);
    const fr = effectFrame(tl, (piece.fx!.at + i) / 30);
    expect(piece.fx!.rgb![i]).toBeCloseTo(fr.rgb, 5);
    expect(piece.fx!.zoom![i]).toBeCloseTo(fr.zoom, 5);
  });

  it("a long clip is cut into pieces that go on frame-exactly; stutters jump back", () => {
    const clips = plan.pieces.filter((x) => x.kind === "clip");
    for (let i = 1; i < clips.length; i++) {
      const a = clips[i - 1];
      const b = clips[i];
      if (a.kind !== "clip" || b.kind !== "clip") continue;
      const next = a.src.in + a.frames / 30;
      // either the clip goes on, or a stutter took it back
      if (Math.abs(b.src.in - next) > 1e-5) expect(b.src.in).toBeLessThan(next);
    }
    expect(clips.length).toBeGreaterThan(Math.ceil(960 / MAX_FX_FRAMES));
  });

  it("without effects nothing changes: no fx, the same pieces as before", () => {
    const plain = fxProject({});
    expect(buildRenderPlan(plain, effectTimeline(plain, song)).plan).toEqual(buildRenderPlan(plain).plan);
    expect(buildRenderPlan(plain).plan.pieces.some((x) => "fx" in x)).toBe(false);
  });

  it("windows and events are in the piece's own frames", () => {
    const fx = pieceFx(tl, 350, 30)!;
    expect(fx.at).toBe(350);
    // the drop at frame 360: tunnel and word start 10 frames in
    expect(fx.tunnel![0][0]).toBe(10);
    expect(fx.text![0].from).toBe(10);
    expect(fx.invert![0]).toEqual([10, 14]);
  });
});

describe("settings", () => {
  it("old projects get the effects switched off; words are cleaned", () => {
    expect(migrateProject({ tracks: [] }).effects).toEqual(DEFAULT_EFFECTS);
    expect(migrateProject({ tracks: [], effects: { zoom: true } }).effects).toEqual({ ...DEFAULT_EFFECTS, zoom: true });
    expect(effectWords("good girl,  DROP!; o'neil:x\\y,\nwow, ")).toEqual(["GOOD GIRL", "DROP!", "ONEILXY", "WOW"]);
  });

  it("a word fits: a third of the short side, at most 86 % of the width", () => {
    expect(textSize("WOW", 16 / 9)).toBeCloseTo(0.34, 5);
    const long = "A VERY LONG SENTENCE INDEED";
    const em = 23 * 0.47 + 4 * 0.23; // its width at size 1 without a measure: letters and spaces
    expect(textSize(long, 16 / 9) * em).toBeCloseTo((0.86 * 16) / 9, 3);
    expect(textSize(long, 16 / 9, () => 10)).toBeCloseTo((0.086 * 16) / 9, 3);
    expect(textSize("WOW", 9 / 16)).toBeCloseTo(0.34 * (9 / 16), 4);
  });

  it("generating puts the run's effects into the project", () => {
    const p = fxProject({});
    const settings = { ...defaultSettings(p.tracks[1].id), style: { ...defaultSettings(p.tracks[1].id).style, fx: moodEffects("hypno") } };
    const r = { trackId: p.tracks[1].id, from: 0, to: 2, replaceTrack: false, clips: [clip("2", 0, 2)], layouts: [], fields: [], snippets: [], sources: [], seed: 1, settings };
    expect(applyGeneration(p, r).effects).toEqual(moodEffects("hypno"));
  });
});
