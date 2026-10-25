// @vitest-environment jsdom
/** The clip waveform store: on-demand loading two scenes at a time, decoding, and the peaks of a time range. */
import { afterEach, describe, expect, it, vi } from "vitest";

const pending: Array<{ path: string; resolve: (r: unknown) => void; reject: (e: unknown) => void }> = [];
vi.mock("../src/stash/backend", () => ({
  audioPeaks: (path: string) => new Promise((resolve, reject) => pending.push({ path, resolve, reject })),
}));

import { decodePeaks, peakAt, peakLevel, peaksOf, peaksProgress, requestPeaks, resetPeaks } from "../src/ui/peaks";

const tick = () => new Promise((r) => setTimeout(r, 0));
const b64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

afterEach(() => {
  resetPeaks();
  pending.length = 0;
});

describe("clip waveform store", () => {
  it("loads two scenes at a time, in the order asked, and keeps the result", async () => {
    requestPeaks("1", "/m/1.mp4");
    requestPeaks("2", "/m/2.mp4");
    requestPeaks("3", "/m/3.mp4");
    requestPeaks("1", "/m/1.mp4"); // asked again: nothing happens
    expect(pending.map((p) => p.path)).toEqual(["/m/1.mp4", "/m/2.mp4"]);
    expect([peaksOf("1").status, peaksOf("2").status, peaksOf("3").status]).toEqual(["loading", "loading", "queued"]);
    expect(peaksProgress()).toEqual({ loading: 3, total: 3 });
    pending[0].resolve({ pps: 50, peaks: b64([0, 128, 255, 10]), duration: 0.08, hasAudio: true });
    await tick();
    expect(peaksOf("1").status).toBe("ready");
    expect(Array.from(peaksOf("1").peaks!)).toEqual([0, 128, 255, 10]);
    expect(peaksOf("1").max).toBe(1);
    expect(pending.map((p) => p.path)).toEqual(["/m/1.mp4", "/m/2.mp4", "/m/3.mp4"]); // the third started once a slot was free
    pending[1].resolve({ pps: 50, peaks: "", duration: 0, hasAudio: false });
    pending[2].reject(new Error("ffmpeg missing"));
    await tick();
    expect(peaksOf("2").status).toBe("none");
    expect(peaksOf("3")).toMatchObject({ status: "error", error: "Error: ffmpeg missing" });
    expect(peaksProgress()).toEqual({ loading: 0, total: 3 });
    // an error may be retried, a finished scene is not asked for again
    requestPeaks("3", "/m/3.mp4");
    requestPeaks("2", "/m/2.mp4");
    expect(pending).toHaveLength(4);
    expect(peaksOf("3").status).toBe("loading");
  });

  it("the drawn height is relative to the file's loudest moment on a 40 dB scale", () => {
    // a quiet recording: loudest bucket 40 of 255 -> drawn full height; -20 dB of that -> half; -40 dB and below -> nothing
    const p = { status: "ready" as const, peaks: decodePeaks(b64([40, 4, 1, 0])), pps: 50, max: 40 / 255 };
    expect(peakLevel(p, 0, 0.02)).toBeCloseTo(1);
    expect(peakLevel(p, 0.02, 0.04)).toBeCloseTo(0.5, 2);
    expect(peakLevel(p, 0.04, 0.06)).toBeCloseTo(1 + Math.log10(1 / 40) / 2, 3); // ~0.2
    expect(peakLevel(p, 0.06, 0.08)).toBe(0);
    expect(peakLevel({ status: "idle", peaks: null, pps: 50, max: 0 }, 0, 1)).toBe(0);
  });

  it("peakAt takes the loudest bucket of a range and nothing outside the file", () => {
    const p = { status: "ready" as const, peaks: decodePeaks(b64([10, 200, 30, 40])), pps: 50, max: 200 / 255 };
    expect(peakAt(p, 0, 0.02)).toBeCloseTo(10 / 255); // first bucket only
    expect(peakAt(p, 0, 0.04)).toBeCloseTo(200 / 255);
    expect(peakAt(p, 0.045, 0.046)).toBeCloseTo(30 / 255); // a range inside one bucket still reads it
    expect(peakAt(p, 1, 2)).toBe(0);
    expect(peakAt({ status: "idle", peaks: null, pps: 50, max: 0 }, 0, 1)).toBe(0);
  });
});
