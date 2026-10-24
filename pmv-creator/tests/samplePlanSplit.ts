// Prints the render plan of a small project with split screens (bundled + run by tests/backend_e2e.py): a 3-way, a 4-way
// with an empty field, a kaleidoscope and a mirrored 3-way stacked – with the zoom pulse, flashes and glowing dividers.
// Source paths are placeholders the Python test replaces with generated media.
import { buildRenderPlan } from "../src/export/renderPlan";
import { effectTimeline } from "../src/fx/timeline";
import { DEFAULT_EFFECTS } from "../src/model/effects";
import { ensureTracks } from "../src/timeline/ops";
import { clip, project } from "./helpers";

const p = ensureTracks(project([], [clip("1", 0, 8, { sourceIn: 1 })]), 4);
p.tracks[2].clips = [clip("2", 1, 3, { sourceIn: 2 }), clip("3", 4, 4, { sourceIn: 0.5 })]; // V2
p.tracks[1].clips = [clip("3", 1, 3.5, { sourceIn: 1, volume: 1 })]; // V3 (its sound plays in the fields)
// V4 stays empty: the 4-way's last field is black
p.layouts = [
  { id: "l1", start: 1, duration: 2, kind: "tri", dir: "cols" },
  { id: "l2", start: 3, duration: 1.5, kind: "quad", dir: "cols" },
  { id: "l3", start: 4.5, duration: 1.5, kind: "kaleido", dir: "cols" },
  { id: "l4", start: 6, duration: 1.5, kind: "trim", dir: "rows" },
];
p.output = { ...p.output, width: 640, height: 360, fps: 30, crf: 30, preset: "ultrafast" };
p.sources["1"] = { ...p.sources["1"], path: "{A}", duration: 12, width: 640, height: 360, hasAudio: true };
p.sources["2"] = { ...p.sources["2"], path: "{B}", duration: 10, width: 1280, height: 720, hasAudio: false };
p.sources["3"] = { ...p.sources["3"], path: "{C}", duration: 6, width: 360, height: 640, hasAudio: true };
p.audio = { name: "music", path: "{M}", url: null, duration: 8, sourceIn: 0, start: 0, gainDb: 0, fadeIn: 0, fadeOut: 0 };
p.effects = { ...DEFAULT_EFFECTS, zoom: true, flash: true, lines: true };

const tl = effectTimeline(p, (t0) => (t0 >= 3 - 1e-9 ? 1 : 0.1));
console.log(JSON.stringify(buildRenderPlan(p, tl)));
