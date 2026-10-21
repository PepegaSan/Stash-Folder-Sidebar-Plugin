// Prints the render plan of a small multi-track project (bundled + run by tests/backend_e2e.py).
// Source paths are placeholders the Python test replaces with generated media.
import { buildRenderPlan } from "../src/export/renderPlan";
import { clip, project } from "./helpers";

const p = project(
  // V2 overlay with a flash transition, partly covering two V1 clips
  [clip("3", 2.6, 0.8, { sourceIn: 1, transitionIn: { type: "fadewhite", duration: 0.2 } })],
  [
    clip("1", 0, 1.5, { sourceIn: 1, transitionIn: { type: "fadeblack", duration: 0.4 }, volume: 0.7 }),
    clip("2", 1.5, 1.6, { sourceIn: 2, speed: 2, transitionIn: { type: "fade", duration: 0.3 } }),
    clip("1", 3.1, 1.2, { sourceIn: 6, speed: 0.75, transitionIn: { type: "slideleft", duration: 0.25 } }),
    // gap from 4.3 to 4.6 -> black
    clip("2", 4.6, 1.0, { sourceIn: 8.5, fit: "contain" }),
  ],
);
p.output = { ...p.output, width: 640, height: 360, fps: 30, crf: 30, preset: "ultrafast" };
p.sources["1"] = { ...p.sources["1"], path: "{A}", duration: 12, hasAudio: true };
p.sources["2"] = { ...p.sources["2"], path: "{B}", duration: 10, hasAudio: false };
p.sources["3"] = { ...p.sources["3"], path: "{C}", duration: 6, hasAudio: true };
p.audio = { name: "music", path: "{M}", url: null, duration: 20, sourceIn: 0.5, start: 0, gainDb: -2, fadeIn: 0.2, fadeOut: 0.5 };

console.log(JSON.stringify(buildRenderPlan(p)));
