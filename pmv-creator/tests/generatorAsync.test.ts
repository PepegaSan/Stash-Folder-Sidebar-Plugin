import { describe, expect, it } from "vitest";
import { finishAsync } from "../src/generator/cooperate";
import { buildGeneration, buildGenerationAsync, defaultSettings } from "../src/generator/generate";
import { FULL_ONLY } from "../src/generator/layouts";
import type { MaterialItem } from "../src/generator/material";
import { project } from "./helpers";

describe("responsive generation", () => {
  it("lets browser timers run between slices of a busy calculation", async () => {
    let completed = 0;
    function* busy() {
      while (completed < 12) {
        const until = performance.now() + 2;
        while (performance.now() < until) { /* simulate work without relying on machine speed */ }
        completed++;
        yield completed / 12;
      }
      return completed;
    }
    const result = finishAsync(busy());
    const observed = await new Promise<number>((resolve) => setTimeout(() => resolve(completed), 0));
    expect(observed).toBeGreaterThan(0);
    expect(observed).toBeLessThan(12);
    expect(await result).toBe(12);
  });

  it("generates thousands of cuts from one exhausted video quickly, with identical sync/async picks", async () => {
    const p = project();
    const settings = defaultSettings(p.tracks[1].id);
    settings.style.layouts = FULL_ONLY;
    settings.cut = { ...settings.cut, mode: "fixed", every: 1 };
    const item: MaterialItem = { snippet: { id: "short", sceneId: "1", markerId: null, in: 0, out: 30, label: "Short", tags: [] }, performers: [], fixedStart: false };
    const input = { pools: [[item]], sources: [], context: { speedMaps: {}, speedPct: () => null } };
    const range = { from: 0, to: 1200 };
    const started = performance.now();
    const sync = buildGeneration(p, settings, range, input);
    // A deliberately generous budget catches the previous cubic fallback without depending on fast hardware.
    expect(performance.now() - started).toBeLessThan(2000);
    expect(sync.result.clips.length).toBeGreaterThan(2000);
    const progress: number[] = [];
    const async = await buildGenerationAsync(p, settings, range, input, (x) => progress.push(x));
    const material = (r: typeof sync) => r.result.clips.map(({ id, ...c }) => c);
    expect(material(async)).toEqual(material(sync));
    expect(progress[progress.length - 1]).toBe(1);
    expect(async.result.clips.every((c) => c.sourceIn >= 0 && c.sourceIn + c.duration * c.speed <= 30 + 1e-6)).toBe(true);
  });
});
