import { describe, expect, it } from "vitest";
import { parseSceneIdInput } from "../src/culling/culling";
import { editorReducer, initialEditorState } from "../src/state/reducer";
import { clip, project } from "./helpers";

describe("editorReducer", () => {
  it("clears the cut in one undo step, preserves project material and respects locked tracks", () => {
    const p = project([clip("1", 0, 2)]);
    p.markers = [{ id: "m", time: 1, label: "Beat" }];
    p.layouts = [{ id: "l", start: 0, duration: 2, kind: "duo", dir: "cols" }];
    const s = initialEditorState(p);
    const after = editorReducer(s, { type: "timeline/clear" });
    expect(after.present.tracks.every((tr) => tr.clips.length === 0)).toBe(true);
    expect(after.present.layouts).toEqual([]);
    expect(after.present.markers).toEqual([]);
    expect(after.present.audio).toBe(p.audio);
    expect(after.present.bin).toBe(p.bin);
    expect(after.present.sources).toBe(p.sources);
    expect(editorReducer(after, { type: "timeline/clear" })).toBe(after);
    expect(editorReducer(after, { type: "undo" }).present).toBe(p);
    const locked = initialEditorState({ ...p, tracks: p.tracks.map((tr) => ({ ...tr, locked: true })) });
    expect(editorReducer(locked, { type: "timeline/clear" })).toBe(locked);
  });

  it("records undoable edits and ignores no-ops", () => {
    const a = clip("1", 0, 2);
    const p = project([a]);
    let s = initialEditorState(p);
    s = editorReducer(s, { type: "clip/move", clipId: a.id, trackId: p.tracks[0].id, start: 0, mode: "clamp" });
    expect(s.past).toHaveLength(0);
    s = editorReducer(s, { type: "clip/move", clipId: a.id, trackId: p.tracks[0].id, start: 3, mode: "clamp" });
    expect(s.past).toHaveLength(1);
    s = editorReducer(s, { type: "undo" });
    expect(s.present.tracks[0].clips[0].start).toBe(0);
    s = editorReducer(s, { type: "redo" });
    expect(s.present.tracks[0].clips[0].start).toBe(3);
  });

  it("coalesces rapid field edits into one undo step", () => {
    const p = project();
    let s = initialEditorState(p);
    s = editorReducer(s, { type: "grid/update", patch: { bpm: 121 } }, 1000);
    s = editorReducer(s, { type: "grid/update", patch: { bpm: 122 } }, 1500);
    s = editorReducer(s, { type: "grid/update", patch: { bpm: 123 } }, 4000);
    expect(s.past).toHaveLength(2);
  });

  it("drops the selection when the clip disappears", () => {
    const a = clip("1", 0, 2);
    let s = initialEditorState(project([a]), { selectedClipId: a.id });
    s = editorReducer(s, { type: "clip/delete", clipId: a.id, ripple: false });
    expect(s.ui.selectedClipId).toBeNull();
  });
});

describe("parseSceneIdInput", () => {
  it("accepts IDs, #IDs and Stash links, de-duplicated in input order", () => {
    expect(parseSceneIdInput("12, 34 #56;http://nas:9999/scenes/78?t=12  12\nhttps://x/scenes/90/")).toEqual({ ids: ["12", "34", "56", "78", "90"], invalid: [] });
  });

  it("reports what it cannot use", () => {
    expect(parseSceneIdInput("abc 12x http://x/performers/5 7")).toEqual({ ids: ["7"], invalid: ["abc", "12x", "http://x/performers/5"] });
    expect(parseSceneIdInput("   ")).toEqual({ ids: [], invalid: [] });
  });
});
