// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLang } from "../src/i18n";
import { createProject } from "../src/model/project";
import { editorReducer, initialEditorState } from "../src/state/reducer";
import { Sidebar } from "../src/ui/sidebar/Sidebar";

const mocks = vi.hoisted(() => ({ editor: null as any, scenes: {} as Record<string, any> }));
vi.mock("../src/state/store", () => ({ useEditor: () => mocks.editor }));
vi.mock("../src/stash/sceneCache", () => ({ useScenes: () => mocks.scenes }));
vi.mock("../src/ui/hooks", () => ({ useSprites: () => null }));
vi.mock("../src/ui/sidebar/SceneBrowser", () => ({ SceneBrowser: () => null }));
vi.mock("../src/ui/sidebar/MarkerBrowser", () => ({ MarkerBrowser: () => null }));
vi.mock("../src/ui/sidebar/SceneDetail", () => ({ SceneDetail: () => null }));

let root: Root;
let container: HTMLDivElement;
const input = () => container.querySelector<HTMLInputElement>('input[type="search"]')!;
const rows = () => [...container.querySelectorAll(".pmv-list-item")];
async function render() { await act(async () => root.render(<Sidebar />)); }
async function search(text: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  setLang("en");
  const project = createProject("First project");
  project.bin = [
    { id: "first", sceneId: "1", markerId: null, in: 0, out: 4, label: "Beach sunrise", tags: ["Outdoors"] },
    { id: "middle", sceneId: "2", markerId: "marker", in: 10, out: 15, label: "Night lights", tags: ["Neon"] },
    { id: "last", sceneId: "1", markerId: null, in: 20, out: 23, label: "Ocean", tags: [] },
  ];
  project.sources["2"] = { sceneId: "2", fileId: "f2", title: "City walk", path: "C:/media/city.mp4", duration: 120, fps: 30, width: 1920, height: 1080, hasAudio: false, videoCodec: null };
  mocks.scenes = { "1": { title: "Holiday", paths: {}, studio: { name: "Studio North" }, performers: [{ name: "Alice" }], tags: [{ name: "Summer" }] } };
  mocks.editor = { state: initialEditorState(project, { sidebarTab: "bin" }), dispatch: vi.fn(), transport: { time: 0, seek: vi.fn() } };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await render();
});

afterEach(async () => { await act(async () => root.unmount()); container.remove(); setLang("en"); });

describe("My clips", () => {
  it("searches clip labels, saved video metadata, tags and live scene metadata with all words", async () => {
    const original = structuredClone(mocks.editor.state.present);
    for (const [query, labels] of [
      [" SUNRISE outdoors ", ["Beach sunrise"]],
      ["CITY walk", ["Night lights"]],
      ["city.mp4 neon", ["Night lights"]],
      ["holiday alice summer north", ["Beach sunrise", "Ocean"]],
      ["2", ["Night lights"]],
    ] as const) {
      await search(query);
      expect(rows().map((r) => r.querySelector(".pmv-li-title")!.textContent)).toEqual(labels);
    }
    expect(mocks.editor.state.present).toEqual(original);
    expect(mocks.editor.dispatch).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')!.textContent).toContain("1 of 3 clips");
    expect(container.textContent).toContain("The generator still uses all saved clips");
  });

  it("distinguishes no matches from an empty project and clears the search", async () => {
    await search("missing");
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain("No clips match your search.");
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Clear search"]')!.click());
    expect(input().value).toBe("");
    expect(rows()).toHaveLength(3);
  });

  it("keeps actions bound to the original clip and its original order while filtered", async () => {
    await search("night");
    const buttons = [...rows()[0].querySelectorAll("button")];
    expect(buttons.find((b) => b.textContent?.trim() === "↑")!.disabled).toBe(false);
    expect(buttons.find((b) => b.textContent?.trim() === "↓")!.disabled).toBe(false);
    await act(async () => buttons.find((b) => b.textContent?.trim() === "↑")!.click());
    expect(mocks.editor.dispatch).toHaveBeenLastCalledWith({ type: "bin/reorder", snippetId: "middle", toIndex: 0 });
    await act(async () => buttons.find((b) => b.textContent?.trim() === "✕")!.click());
    expect(mocks.editor.dispatch).toHaveBeenLastCalledWith({ type: "bin/remove", snippetId: "middle" });
  });

  it("loads only the next project's collection and resets search when switching projects", async () => {
    await search("sunrise");
    const second = createProject("Second project");
    second.bin = [{ id: "second", sceneId: "3", markerId: null, in: 0, out: 3, label: "Fresh clip", tags: [] }];
    mocks.editor.state = editorReducer(mocks.editor.state, { type: "project/load", project: second });
    await render();
    expect(input().value).toBe("");
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain("Fresh clip");
    expect(container.textContent).toContain("Saved selection for project: Second project");
    expect(container.textContent).not.toContain("Beach sunrise");
    mocks.editor.state = editorReducer(mocks.editor.state, { type: "project/load", project: createProject("Empty project") });
    await render();
    expect(rows()).toHaveLength(0);
    expect(container.textContent).toContain("Empty. Open a scene");
    expect(container.textContent).not.toContain("No clips match");
  });

  it("explains persistence and exposes German search and project labels", async () => {
    setLang("de-DE");
    await render();
    expect(input().getAttribute("aria-label")).toBe("Meine Clips durchsuchen");
    expect(container.textContent).toContain("Gespeicherte Auswahl für Projekt: First project");
    expect(container.querySelector("summary")!.textContent).toBe("Woher kommen diese Clips?");
    await search("nothing");
    expect(container.textContent).toContain("0 von 3 Clips");
    expect(container.textContent).toContain("Keine Clips passen zu deiner Suche.");
  });
});
