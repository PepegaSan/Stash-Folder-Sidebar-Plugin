import { describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../src/generator/generate";
import { initialEditorState, type Action } from "../src/state/reducer";
import { clip, project } from "./helpers";

vi.mock("../src/ui/generator/run", () => ({ collectPools: vi.fn(async () => ({ pools: [[]], sources: [] })) }));
const { anotherClip } = await import("../src/ui/clipActions");
const { collectPools } = await import("../src/ui/generator/run");

describe("another clip respects the generator material pool", () => {
  it.each(["legacy-whole", "markers", "ranges"] as const)("does not expand an empty %s pool to unfiltered project scenes", async (mode) => {
    const c = clip("1", 0, 2), p = project([], [c]);
    const settings = defaultSettings(p.tracks[1].id);
    settings.seed = mode === "legacy-whole" ? 101 : mode === "markers" ? 102 : 103;
    if (mode === "legacy-whole") { delete settings.clips.materialMode; settings.clips.kind = "markers"; settings.clips.preferMarkers = true; }
    else { settings.clips.materialMode = mode; if (mode === "ranges") settings.clips.source = "bin"; }
    p.generator = { settings, from: 0, to: 10 };
    const state = initialEditorState(p), actions: Action[] = [];
    await anotherClip(() => state, (a) => actions.push(a), [c.id]);
    expect(actions.some((a) => a.type === "clips/material")).toBe(false);
    expect(actions.some((a) => a.type === "ui" && a.patch.clipTask?.error)).toBe(true);
    expect(collectPools).toHaveBeenLastCalledWith(expect.objectContaining({ materialMode: mode === "legacy-whole" ? "whole" : mode }), p, settings.seed);
  });

  it("can still use project scenes for a project that has never been generated", async () => {
    const c = clip("1", 0, 2), p = project([], [c]);
    const state = initialEditorState(p), actions: Action[] = [];
    await anotherClip(() => state, (a) => actions.push(a), [c.id]);
    expect(actions.some((a) => a.type === "clips/material")).toBe(true);
  });
});
