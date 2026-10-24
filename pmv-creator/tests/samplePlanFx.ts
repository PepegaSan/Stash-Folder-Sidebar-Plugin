// Prints the render plan of a small project with every beat and drop effect (bundled + run by tests/backend_e2e.py).
// Source paths are placeholders the Python test replaces with generated media. The song is quiet for 4 s, then loud:
// a drop at 4 s (beat 8 at 120 BPM) with tunnel, word, negative, glitch and a hard RGB split.
import { buildRenderPlan } from "../src/export/renderPlan";
import { effectTimeline } from "../src/fx/timeline";
import { DEFAULT_EFFECTS } from "../src/model/effects";
import { clip, project } from "./helpers";

const p = project(
  [],
  [
    clip("1", 0, 3, { sourceIn: 1 }),
    clip("2", 3, 2.5, { sourceIn: 2, transitionIn: { type: "fade", duration: 0.3 } }),
    // gap from 5.5 to 6 -> black (effects on black too)
    clip("1", 6, 3, { sourceIn: 5, fit: "blur" }),
  ],
);
p.output = { ...p.output, width: 640, height: 360, fps: 30, crf: 30, preset: "ultrafast", look: "warm" };
p.sources["1"] = { ...p.sources["1"], path: "{A}", duration: 12, hasAudio: true };
p.sources["2"] = { ...p.sources["2"], path: "{B}", duration: 10, hasAudio: false };
p.audio = { name: "music", path: "{M}", url: null, duration: 9, sourceIn: 0, start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0 };
p.effects = { ...DEFAULT_EFFECTS, zoom: true, shake: true, stutter: true, strobe: true, rgb: true, glitch: true, tunnel: true, invert: true, echo: true, text: true, hue: true, words: "Drop it" };

const tl = effectTimeline(p, (t0) => (t0 >= 4 - 1e-9 ? 1 : 0.1));
console.log(JSON.stringify(buildRenderPlan(p, tl)));
