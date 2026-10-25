import { describe, expect, it } from "vitest";
import { createProject, migrateProject } from "../src/model/project";
import type { UiState } from "../src/state/reducer";
import { insertAction, wholeSceneAction } from "../src/ui/editing";
import { project } from "./helpers";

/** Only what the actions read. */
const ui = { selectedClipId: null, editMode: "clamp", snap: true, quantizeDrops: true, snapDivision: 1 } as unknown as UiState;

describe("clip audio of new clips", () => {
  it("a snippet from the bin starts with the project's clip audio", () => {
    const p = { ...project(), clipVolume: 0.7 };
    const a = insertAction(p, ui, { id: "s1", sceneId: "1", markerId: null, in: 10, out: 12, label: "x", tags: [] }, 4);
    expect(a?.type).toBe("clip/insert");
    if (a?.type === "clip/insert") expect(a.clip).toMatchObject({ sceneId: "1", start: 4, sourceIn: 10, volume: 0.7 });
  });

  it("old project files get 0, values are clamped to 0–200 %", () => {
    expect(migrateProject({ tracks: [] }).clipVolume).toBe(0);
    expect(migrateProject({ tracks: [], clipVolume: 0.5 }).clipVolume).toBe(0.5);
    expect(migrateProject({ tracks: [], clipVolume: 7 }).clipVolume).toBe(2);
    expect(migrateProject({ tracks: [], clipVolume: "loud" }).clipVolume).toBe(0);
    expect(createProject("x").clipVolume).toBe(0);
  });
});

describe("whole scene onto the timeline", () => {
  it("full length, not quantised, the scene comes along in the same step", () => {
    const p = { ...createProject("c"), clipVolume: 1 };
    const src = { sceneId: "7", fileId: null, path: "/media/7.mp4", title: "Seven", duration: 100.3, fps: 30, width: 1920, height: 1080, hasAudio: true, videoCodec: "h264" };
    const a = wholeSceneAction(p, ui, src, 12.5);
    expect(a?.type).toBe("clip/insert");
    if (a?.type !== "clip/insert") return;
    expect(a.trackId).toBe(p.tracks[p.tracks.length - 1].id); // V1
    expect(a.clip).toMatchObject({ sceneId: "7", start: 12.5, duration: 100.3, sourceIn: 0, speed: 1, volume: 1, snippetId: null, label: "Seven" });
    expect(a.sources).toEqual([src]);
  });

  it("nothing for a scene without length or without an unlocked track", () => {
    const p = createProject("c");
    const src = { sceneId: "7", fileId: null, path: "/x", title: "x", duration: 0, fps: 30, width: 1, height: 1, hasAudio: false, videoCodec: null };
    expect(wholeSceneAction(p, ui, src, 0)).toBeNull();
    const locked = { ...p, tracks: p.tracks.map((t) => ({ ...t, locked: true })) };
    expect(wholeSceneAction(locked, ui, { ...src, duration: 10 }, 0)).toBeNull();
  });
});
