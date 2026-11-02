// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createProject } from "../src/model/project";
import { FULL_ONLY, withLayouts } from "../src/generator/layouts";
import { buildSceneFilter } from "../src/generator/material";
import { applyMood, defaultSettings } from "../src/generator/generate";
import { readSuperSimple, rememberSuperSimple } from "../src/state/prefs";
import { emptySuperDraft, loadSuperDraft, saveSuperDraft, superSettings } from "../src/ui/superSetup";
import { project } from "./helpers";

beforeEach(() => localStorage.clear());

describe("super simple setup", () => {
  it("keeps the existing view unless the extra guide is explicitly selected", () => {
    localStorage.setItem("pmv-creator:advanced", "1");
    expect(readSuperSimple()).toBe(false);
    rememberSuperSimple(true);
    expect(readSuperSimple()).toBe(true);
    rememberSuperSimple(false);
    expect(readSuperSimple()).toBe(false);
    expect(localStorage.getItem("pmv-creator:advanced")).toBe("1");
  });

  it("starts with project scenes when there are some, otherwise with the library", () => {
    expect(superSettings(project(), emptySuperDraft()).clips.source).toBe("project");
    expect(superSettings(createProject(), emptySuperDraft()).clips.source).toBe("filter");
  });

  it("uses full videos, a full-song target and light effects without inheriting custom generator settings", () => {
    localStorage.setItem("pmv-creator:generator", JSON.stringify({ cut: { mode: "template" }, clips: { materialMode: "markers" }, mood: "maximal" }));
    const p = project();
    const before = JSON.stringify(p);
    const s = superSettings(p, emptySuperDraft());
    const original = applyMood(defaultSettings(s.target.trackId), "clean");
    expect(s).toEqual({ ...original, clips: { ...original.clips, source: "project", limit: 40 }, style: { ...original.style, layouts: FULL_ONLY } });
    expect(s.clips.materialMode).toBe("whole");
    expect(s.target.range).toBe("song");
    expect(s.style.layouts).toEqual(FULL_ONLY);
    expect(s.cut.mode).toBe("auto");
    expect(s.select.beatSync).toBe(false);
    expect(s.style.speedRamps).toBe(false);
    expect(s.style.fx.strobe).toBeFalsy();
    expect(JSON.stringify(p)).toBe(before);
  });

  it("honours explicit tags and performers rather than silently using all project scenes", () => {
    const p = project();
    const tags = [{ id: "4", name: "Chosen tag" }], performers = [{ id: "5", name: "Chosen performer" }];
    const s = superSettings(p, { ...emptySuperDraft(), tags, performers });
    expect(s.clips.source).toBe("filter");
    expect(s.clips.tags).toEqual(tags);
    expect(s.clips.performers).toEqual(performers);
  });

  it("restores a per-project material draft, while an explicit deep link takes priority", () => {
    const draft = { ...emptySuperDraft(), source: "library" as const, tags: [{ id: "8", name: "Tag" }], limit: 13, variance: 0, layout: "both" as const, transition: "mix" as const };
    saveSuperDraft("a", draft);
    expect(loadSuperDraft("a")).toEqual(draft);
    expect(loadSuperDraft("b")).toEqual(emptySuperDraft());
    expect(loadSuperDraft("a", { tags: [], performers: [{ id: "9", name: "From link" }] }).performers[0].id).toBe("9");
    expect(loadSuperDraft("a", { tags: [], performers: [] })).toMatchObject({ limit: 13, variance: 0, layout: "both", transition: "mix" });
  });

  it("opens old material drafts with their filters and the original defaults", () => {
    const tags = [{ id: "4", name: "Old tag" }];
    localStorage.setItem("pmv-creator:super-draft:a", JSON.stringify({ source: "library", tags, performers: [] }));
    expect(loadSuperDraft("a")).toEqual({ ...emptySuperDraft(), source: "library", tags });
  });

  it.each([["all", "any"], ["any", "all"], ["all", "all"], ["any", "any"]] as const)(
    "restores tag matching %s and performer matching %s independently in the Stash query", (tagMode, perfMode) => {
      const tags = [{ id: "1", name: "A" }, { id: "2", name: "B" }];
      const performers = [{ id: "3", name: "C" }, { id: "4", name: "D" }];
      saveSuperDraft("filters", { ...emptySuperDraft(), tags, tagMode, performers, perfMode });
      const { clips } = superSettings(project(), loadSuperDraft("filters"));
      expect(clips.source).toBe("filter");
      expect(buildSceneFilter(clips, null)).toMatchObject({
        tags: { value: ["1", "2"], modifier: tagMode === "all" ? "INCLUDES_ALL" : "INCLUDES" },
        performers: { value: ["3", "4"], modifier: perfMode === "all" ? "INCLUDES_ALL" : "INCLUDES" },
      });
    });

  it("passes only the chosen sources, variance, layouts and transitions to the generator", () => {
    const draft = { ...emptySuperDraft(), limit: 7, variance: 35, layout: "both" as const, transition: "fadeblack" as const };
    const p = project();
    const s = superSettings(p, draft);
    expect(s.clips).toMatchObject({ source: "project", limit: 7, limitProjectScenes: true });
    expect(s.select.variance).toBe(35);
    expect(s.style).toMatchObject({ transitionOn: "cut", transitionType: "fadeblack", layouts: withLayouts(["full", "duo"]) });
    expect(superSettings(p, { ...draft, layout: "duo" }).style).toMatchObject({ transitionOn: "none", layouts: withLayouts(["duo"]) });
    p.tracks[0].locked = true;
    expect(superSettings(p, draft).style.layouts).toEqual(FULL_ONLY);
    expect(superSettings(createProject(), draft).clips).toMatchObject({ source: "filter", limit: 7 });
  });

  it("handles corrupt browser data and unavailable storage without blocking the editor", () => {
    localStorage.setItem("pmv-creator:super-draft:a", "broken json");
    expect(loadSuperDraft("a")).toEqual(emptySuperDraft());
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    expect(() => saveSuperDraft("a", emptySuperDraft())).not.toThrow();
    expect(() => rememberSuperSimple(true)).not.toThrow();
    write.mockRestore();
  });

  it("avoids locked or muted tracks and reports when none is usable", () => {
    const p = project();
    p.tracks[1].locked = true;
    expect(superSettings(p, emptySuperDraft()).target.trackId).toBe(p.tracks[0].id);
    p.tracks[0].muted = true;
    expect(() => superSettings(p, emptySuperDraft())).toThrow("No usable video track");
  });
});
