import { describe, expect, it } from "vitest";
import { computePeaks, detectTempo } from "../src/audio/analysis";
import { mulberry32 } from "../src/generator/random";

function clickTrack(bpm: number, offset: number, seconds: number, sr = 44100): Float32Array {
  const out = new Float32Array(seconds * sr);
  const rnd = mulberry32(7);
  for (let i = 0; i < out.length; i++) out[i] = 0.05 * Math.sin((2 * Math.PI * 220 * i) / sr);
  for (let t = offset; t < seconds; t += 60 / bpm) {
    const s = Math.round(t * sr);
    for (let k = 0; k < sr * 0.03 && s + k < out.length; k++) out[s + k] += (rnd() * 2 - 1) * Math.exp(-k / (sr * 0.006));
  }
  return out;
}

/** Distance between two beat phases, modulo the beat length. */
const phaseError = (a: number, b: number, bpm: number) => {
  const beat = 60 / bpm;
  const d = Math.abs(a - b) % beat;
  return Math.min(d, beat - d);
};

describe("detectTempo", () => {
  for (const [bpm, offset, sr] of [
    [128, 0.3, 44100],
    [90, 0.12, 48000],
    [174, 0.05, 44100],
    [140, 0.333, 48000],
    [100.5, 0.21, 44100],
  ] as const) {
    it(`finds ${bpm} BPM and its phase`, () => {
      const est = detectTempo(clickTrack(bpm, offset, 40, sr), sr)!;
      expect(Math.abs(est.bpm - bpm)).toBeLessThan(0.2);
      expect(phaseError(est.offset, offset, bpm)).toBeLessThan(0.012);
    });
  }

  it("returns null for very short input", () => {
    expect(detectTempo(new Float32Array(1000), 44100)).toBeNull();
  });
});

describe("computePeaks", () => {
  it("keeps the maximum per bucket", () => {
    const x = new Float32Array(400);
    x[150] = -0.9;
    const peaks = computePeaks(x, 400, 4);
    expect(Array.from(peaks)).toEqual([0, Math.fround(0.9), 0, 0]);
  });
});
