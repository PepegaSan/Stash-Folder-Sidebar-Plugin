/** Split screens: fields, layout ranges on the timeline, what flatten / the render plan / the effects make of them. */
import { describe, expect, it } from "vitest";
import { buildEdl } from "../src/export/edl";
import { buildOtio } from "../src/export/otio";
import { buildRenderPlan } from "../src/export/renderPlan";
import { effectFrame, effectTimeline } from "../src/fx/timeline";
import { DEFAULT_EFFECTS } from "../src/model/effects";
import { type LayoutRange, carveLayouts, cleanLayouts, dividerRects, fieldRect, fitInField, layoutFields } from "../src/model/layouts";
import { migrateProject } from "../src/model/project";
import { editorReducer, initialEditorState } from "../src/state/reducer";
import { flattenTimeline, resolveTransitions, segmentUnits } from "../src/timeline/flatten";
import { ensureTracks, putLayout } from "../src/timeline/ops";
import { clip, project } from "./helpers";

const GRID = { bpm: 120, offset: 0, beatsPerBar: 4 }; // beat = 0.5 s, bar = 2 s
const lay = (start: number, duration: number, kind: LayoutRange["kind"] = "tri", id = `lay_${start}`): LayoutRange => ({ id, start, duration, kind, dir: "cols" });

/** Three tracks (V3 on top, V1 at the bottom), a tri split screen over [2, 6). */
function splitProject() {
  const p = ensureTracks(project([], [clip("1", 0, 2), clip("1", 2, 3, { sourceIn: 20 }), clip("1", 5, 3, { sourceIn: 40 })]), 3);
  p.tracks[1].clips = [clip("2", 2, 4, { sourceIn: 30 })]; // V2
  p.tracks[0].clips = [clip("3", 2, 1.5), clip("3", 3.5, 2.5, { sourceIn: 50 })]; // V3
  p.layouts = [lay(2, 4)];
  p.beatGrid = GRID;
  return p;
}

describe("fields", () => {
  it("tile the picture in even pixels; 3-way mirrored shows one clip left and right", () => {
    const tri = layoutFields("tri", "cols").map((f) => fieldRect(f, 1920, 1080));
    expect(tri).toEqual([
      [0, 0, 640, 1080],
      [640, 0, 640, 1080],
      [1280, 0, 640, 1080],
    ]);
    expect(layoutFields("trim", "rows").map((f) => [f.group, f.fy])).toEqual([
      [0, false],
      [1, false],
      [0, true],
    ]);
    expect(layoutFields("kaleido", "cols").map((f) => [f.group, f.fx, f.fy])).toEqual([
      [0, false, false],
      [0, true, false],
      [0, false, true],
      [0, true, true],
    ]);
  });

  it("an odd output size: the render plan's fields fit into the even picture the backend renders", () => {
    const p = splitProject();
    p.output = { ...p.output, width: 1279, height: 719 };
    const { plan } = buildRenderPlan(p);
    for (const piece of plan.pieces) {
      if (piece.kind !== "layout") continue;
      for (const f of piece.fields) {
        const [x, y, w, h] = f.rect;
        expect(x + w <= 1278 && y + h <= 718 && w % 2 === 0 && h % 2 === 0).toBe(true);
      }
      expect(piece.fields.reduce((n, f) => n + f.rect[2], 0)).toBe(1278);
    }
  });

  it("a clip close to its field's shape fills it; dividers lie on the inner edges", () => {
    expect(fitInField("blur", 9 / 16, 640 / 1080)).toBe("cover");
    expect(fitInField("blur", 16 / 9, 640 / 1080)).toBe("blur");
    expect(fitInField("contain", 1, 1.1)).toBe("cover");
    expect(dividerRects(layoutFields("quad", "cols"), 1920, 1080)).toEqual([
      [959, 0, 3, 540],
      [0, 539, 960, 3],
      [959, 540, 3, 540],
      [960, 539, 960, 3],
    ]);
  });
});

describe("layout ranges", () => {
  it("a later one wins where two overlap; carving cuts across", () => {
    expect(cleanLayouts([lay(4, 4, "duo", "b"), lay(0, 6, "quad", "a")]).map((x) => [x.id, x.start, x.duration])).toEqual([
      ["a", 0, 4],
      ["b", 4, 4],
    ]);
    const carved = carveLayouts([lay(0, 10, "duo", "a")], 3, 5);
    expect(carved.map((x) => [x.start, x.duration])).toEqual([
      [0, 3],
      [5, 5],
    ]);
    expect(carved[0].id).toBe("a");
    expect(carved[1].id).not.toBe("a");
  });

  it("putting one replaces what lies there and adds the tracks its fields need (new ones on top)", () => {
    const p = project([], [clip("1", 0, 8)]);
    const bottom = p.tracks[1].id;
    const q = putLayout({ ...p, layouts: [lay(0, 8, "duo", "old")] }, lay(2, 2, "quad", "new"));
    expect(q.layouts.map((x) => [x.id, x.start, x.duration, x.kind])).toEqual([
      ["old", 0, 2, "duo"],
      ["new", 2, 2, "quad"],
      [expect.any(String), 4, 4, "duo"],
    ]);
    expect(q.tracks).toHaveLength(4);
    expect(q.tracks[3].id).toBe(bottom);
  });

  it("are undoable edits; the selection goes when its range does", () => {
    let st = initialEditorState(project([], [clip("1", 0, 8)]));
    st = editorReducer(st, { type: "layout/put", layout: lay(2, 2, "duo", "x") });
    st = editorReducer(st, { type: "ui", patch: { selectedLayoutId: "x" } });
    expect(st.present.layouts).toHaveLength(1);
    st = editorReducer(st, { type: "layout/remove", layoutId: "x" });
    expect(st.present.layouts).toHaveLength(0);
    expect(st.ui.selectedLayoutId).toBeNull();
    st = editorReducer(st, { type: "undo" });
    expect(st.present.layouts).toHaveLength(1);
    // a clip or a split screen is selected, never both
    const clipId = st.present.tracks[1].clips[0].id;
    st = editorReducer(st, { type: "ui", patch: { selectedLayoutId: "x" } });
    st = editorReducer(st, { type: "ui", patch: { selectedClipId: clipId } });
    expect([st.ui.selectedClipId, st.ui.selectedLayoutId]).toEqual([clipId, null]);
    st = editorReducer(st, { type: "ui", patch: { selectedLayoutId: "x" } });
    expect([st.ui.selectedClipId, st.ui.selectedLayoutId]).toEqual([null, "x"]);
  });

  it("projects saved before split screens get none; broken ones from a file are left out or mended", () => {
    const { layouts: _l, ...old } = project();
    expect(migrateProject(old).layouts).toEqual([]);
    const broken = { ...project(), layouts: [lay(-2, 4, "duo", "a"), { id: "b", start: 5, duration: 1, kind: "hexa", dir: "cols" }, null, { start: 8, duration: "x" }, { start: 9, duration: 1, kind: "quad", dir: "up" }] };
    expect(migrateProject(broken).layouts.map((x) => [x.start, x.duration, x.kind, x.dir])).toEqual([
      [0, 2, "duo", "cols"],
      [9, 1, "quad", "cols"],
    ]);
    expect(migrateProject(broken).layouts[1].id).toMatch(/^lay/);
  });
});

describe("flatten with split screens", () => {
  it("cuts a segment wherever a field changes; each field clip goes on while the others cut", () => {
    const p = splitProject();
    const segs = flattenTimeline(p);
    const split = segs.filter((s) => s.layout);
    expect(split.map((s) => [s.startFrame, s.endFrame])).toEqual([
      [60, 105],
      [105, 150],
      [150, 180],
    ]);
    // V2's clip is one segment object through the whole range
    expect(new Set(split.map((s) => s.layout!.groups[1])).size).toBe(1);
    expect(split[0].layout!.groups.map((g) => g!.clip!.sceneId)).toEqual(["1", "2", "3"]);
    expect(split[2].layout!.groups[0]!.clip!.sourceIn).toBe(40);
    expect(segmentUnits(split[0])).toHaveLength(3);
    // outside: full screen, the top track wins as before
    expect(segs[0].clip!.sceneId).toBe("1");
    expect(segs[segs.length - 1].clip!.sourceIn).toBe(40);
  });

  it("split screens cut hard: no transition into, inside or out of them", () => {
    const p = splitProject();
    const fade = { type: "fade" as const, duration: 0.5 };
    p.tracks[2].clips = [clip("1", 0, 2), clip("1", 2, 3, { transitionIn: fade }), clip("1", 5, 1, { sourceIn: 40 }), clip("1", 6, 2, { transitionIn: fade })];
    expect(resolveTransitions(p, flattenTimeline(p)).every((x) => x === null)).toBe(true);
    // without the split screen the clip after it fades in
    const full = { ...p, layouts: [] };
    expect(resolveTransitions(full, flattenTimeline(full)).some((x) => x !== null)).toBe(true);
  });

  it("a field without a clip is black (null)", () => {
    const p = splitProject();
    p.tracks[0].clips = [];
    const split = flattenTimeline(p).filter((s) => s.layout);
    expect(split[0].layout!.groups[2]).toBeNull();
  });
});

describe("render plan", () => {
  it("a split screen piece: every group's clip from the piece's first frame, fields in pixels, dividers", () => {
    const p = splitProject();
    const { plan } = buildRenderPlan(p);
    const pieces = plan.pieces.filter((x) => x.kind === "layout");
    expect(pieces).toHaveLength(3);
    const second = pieces[1] as Extract<(typeof pieces)[number], { kind: "layout" }>;
    expect(second.frames).toBe(45);
    // V3's second clip starts here; V1 and V2 go on (1.5 s in)
    expect(second.groups.map((g) => g && [g.sceneId, g.in])).toEqual([
      ["1", 21.5],
      ["2", 31.5],
      ["3", 50],
    ]);
    expect(second.fields.map((f) => f.rect)).toEqual([
      [0, 0, 640, 1080],
      [640, 0, 640, 1080],
      [1280, 0, 640, 1080],
    ]);
    expect(second.dividers).toEqual([
      [639, 0, 3, 1080],
      [1279, 0, 3, 1080],
    ]);
    expect(plan.totalFrames).toBe(240);
    expect(plan.pieces.reduce((n, x) => n + x.frames, 0)).toBe(240);
  });
});

describe("exports", () => {
  it("EDL: the first field with a comment; OTIO: every track, and a marker over each split screen", () => {
    const p = splitProject();
    const edl = buildEdl(p);
    expect(edl).toContain("* PMV SPLIT SCREEN: tri (cols)");
    const otio = buildOtio(p) as { tracks: { children: unknown[]; markers: Array<{ name: string; color: string; marked_range: { start_time: { value: number }; duration: { value: number } } }> } };
    expect(otio.tracks.children).toHaveLength(3);
    const m = otio.tracks.markers.find((x) => x.name.startsWith("Split screen"))!;
    expect([m.name, m.color, m.marked_range.start_time.value, m.marked_range.duration.value]).toEqual(["Split screen: tri (cols)", "PINK", 60, 120]);
  });
});

describe("split screen effects", () => {
  const loudFrom16 = (t0: number) => (t0 < 16 ? 0.1 : 1);

  it("flash where a split screen begins and ends, and on its field cuts in loud parts (pink on the bar's one)", () => {
    const p = ensureTracks(project([], [clip("1", 0, 18), clip("1", 18, 2), clip("1", 20, 12)]), 3);
    p.tracks[1].clips = [clip("2", 18, 1), clip("2", 19, 3)];
    p.tracks[0].clips = [clip("3", 18, 4)];
    p.layouts = [lay(18, 4)];
    p.beatGrid = GRID;
    p.effects = { ...DEFAULT_EFFECTS, flash: true };
    const tl = effectTimeline(p, loudFrom16)!;
    expect(tl.flashes.map((x) => [x.t, Math.round(x.a * 1e6) / 1e6, x.color])).toEqual([
      [18, 0.35, [255, 255, 255]],
      [19, 0.45, [255, 255, 255]],
      [20, 0.45, [255, 62, 138]],
      [22, 0.35, [255, 255, 255]],
    ]);
    const f = effectFrame(tl, 20 + 2 / 30);
    expect(f.flash!.color).toEqual([255, 62, 138]);
    expect(f.flash!.a).toBeCloseTo(0.45 * Math.exp(-9 * (2 / 30)), 6);
  });

  it("the dividers glow on every beat and fade within half a second", () => {
    const p = splitProject();
    p.effects = { ...DEFAULT_EFFECTS, lines: true };
    const tl = effectTimeline(p)!;
    expect(tl.glow!.slice(0, 3)).toEqual([0, 0.5, 1]);
    expect(effectFrame(tl, 2).lines).toBeCloseTo(0.9, 6);
    expect(effectFrame(tl, 2.1).lines).toBeCloseTo(0.9 * Math.exp(-0.7), 6);
    expect(effectFrame(tl, 2.45).lines).toBe(0);
    // the render plan: the beats of the piece (from its start) and the one before it; full screen has no dividers
    const { plan } = buildRenderPlan(p, tl);
    const first = plan.pieces.find((x) => x.kind === "layout")!;
    expect(first.fx?.glow).toEqual([-0.5, 0, 0.5, 1]);
    expect(plan.pieces[0].fx).toBeUndefined();
  });
});
