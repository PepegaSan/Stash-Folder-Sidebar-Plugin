// @vitest-environment jsdom
/**
 * Mounts the real plugin UI against a mocked Stash (PluginApi + GraphQL) and drives the main
 * workflows once: load project, select/delete/undo a clip, culling tabs, drill-down, render dialog,
 * autosave. Catches runtime errors the type checker cannot see.
 */
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createProject } from "../src/model/project";

const scene = {
  id: "1",
  title: "Scene One",
  date: "2024-01-01",
  rating100: 80,
  files: [{ id: "11", path: "/media/one.mp4", basename: "one.mp4", duration: 120, width: 1920, height: 1080, frame_rate: 30, video_codec: "h264", audio_codec: "aac" }],
  paths: { screenshot: "/scene/1/screenshot", stream: "/scene/1/stream", preview: null, sprite: null, vtt: null },
  sceneStreams: [{ url: "http://localhost/scene/1/stream.mp4", mime_type: "video/mp4", label: "MP4" }],
  studio: { id: "5", name: "Studio" },
  performers: [{ id: "7", name: "Performer" }],
  tags: [{ id: "9", name: "Tag" }],
  scene_markers: [{ id: "100", title: "Marker A", seconds: 10, end_seconds: 18, primary_tag: { id: "9", name: "Tag" }, tags: [], screenshot: null, preview: null, stream: null }],
};

function fixtureProject() {
  const p = createProject("Smoke");
  p.id = "pmv_smoke";
  p.sources["1"] = { sceneId: "1", fileId: "11", path: "/media/one.mp4", title: "Scene One", duration: 120, fps: 30, width: 1920, height: 1080, hasAudio: true, videoCodec: "h264" };
  const base = { sceneId: "1", snippetId: null, markerId: null, speed: 1, volume: 0, transitionIn: null, fit: null, label: "" };
  p.tracks[1].clips = [
    { ...base, id: "c1", start: 0, duration: 2, sourceIn: 5 },
    { ...base, id: "c2", start: 2, duration: 2, sourceIn: 30, transitionIn: { type: "fade" as const, duration: 0.4 } },
  ];
  p.tracks[0].clips = [{ ...base, id: "c3", start: 1, duration: 1, sourceIn: 60 }];
  p.bin = [{ id: "s1", sceneId: "1", markerId: null, in: 40, out: 44, label: "Snippet One", tags: [] }];
  return p;
}

const saved: unknown[] = [];

function graphql(body: { query: string; variables?: Record<string, any> }) {
  const q = body.query;
  if (q.includes("runPluginOperation")) {
    const args = body.variables?.args ?? {};
    const out: Record<string, unknown> = {
      ping: { version: "test", ffmpeg: "ffmpeg", ffprobe: "ffprobe", python: "3" },
      load_project: fixtureProject(),
      list_projects: [],
    };
    if (args.op === "save_project") saved.push(args.project);
    return { runPluginOperation: out[args.op] ?? { path: "/x" } };
  }
  if (q.includes("findSceneMarkers")) return { findSceneMarkers: { count: 0, scene_markers: [] } };
  if (q.includes("findScenes")) {
    const ids: string[] | undefined = body.variables?.ids;
    const pool = [scene, { ...scene, id: "2", title: "Scene Two", scene_markers: [] }];
    const scenes = ids ? pool.filter((s) => ids.includes(s.id)) : [scene];
    return { findScenes: { count: scenes.length, scenes } };
  }
  if (q.includes("findTags")) return { findTags: { tags: [] } };
  if (q.includes("PmvLang")) return { configuration: { interface: { language: "en-US" } } };
  return {};
}

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
const errors: unknown[] = [];

const $ = (sel: string) => container.querySelector(sel) as HTMLElement | null;
const $$ = (sel: string) => Array.from(container.querySelectorAll(sel)) as HTMLElement[];
const byText = (text: string, sel = "button") => $$(sel).find((el) => el.textContent?.trim().startsWith(text)) ?? null;

async function waitFor(check: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!check()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timed out");
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

async function fire(el: Element | Window, ev: Event) {
  await act(async () => {
    el.dispatchEvent(ev);
  });
}

beforeAll(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  (globalThis as any).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => undefined;
  HTMLMediaElement.prototype.load = () => undefined;
  HTMLCanvasElement.prototype.getContext = (() => null) as any;
  document.elementFromPoint = () => null;
  vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
  globalThis.fetch = vi.fn(async (_url: any, init?: any) => {
    const body = JSON.parse(init?.body ?? "{}");
    return new Response(JSON.stringify({ data: graphql(body) }), { headers: { "Content-Type": "application/json" } });
  }) as any;
  localStorage.setItem("pmv-creator:last-project", "pmv_smoke");

  let page: React.ComponentType | null = null;
  (window as any).PluginApi = {
    React,
    libraries: { ReactRouterDOM: { Link: (p: any) => <a href={p.to}>{p.children}</a> } },
    register: { route: (_path: string, c: React.ComponentType) => (page = c) },
    patch: { before: () => undefined },
  };
  await import("../src/index");
  expect(page).not.toBeNull();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const Page = page!;
  await act(async () => root.render(<Page />));
});

afterAll(() => {
  act(() => root.unmount());
});

describe("PMV Creator UI (mocked Stash)", () => {
  it("loads the last project from the backend", async () => {
    await waitFor(() => $$(".pmv-clip").length === 3);
    expect(($(".pmv-name") as HTMLInputElement).value).toBe("Smoke");
    expect(container.textContent).toContain("Detect BPM");
  });

  it("selects, deletes and restores a clip", async () => {
    const clip = $$(".pmv-clip")[0];
    await fire(clip, new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await fire(window, new MouseEvent("pointerup", { bubbles: true }));
    expect(container.textContent).toContain("Framing");
    await fire(document.body, new KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    expect($$(".pmv-clip")).toHaveLength(2);
    await fire(document.body, new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect($$(".pmv-clip")).toHaveLength(3);
  });

  it("drags a clip with live preview and commits one undo step", async () => {
    const top = () => $$(".pmv-clip").find((el) => el.style.left === "60px" || el.style.left === "180px")!;
    expect(top().style.left).toBe("60px"); // c3 starts at 1 s, zoom 60 px/s
    await fire(top(), new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 200, clientY: 10 }));
    await fire(window, new MouseEvent("pointermove", { bubbles: true, clientX: 320, clientY: 10 }));
    expect(top().style.left).toBe("180px"); // previewed before commit (+2 s, on the beat grid)
    expect(top().classList.contains("is-ghost")).toBe(true);
    await fire(window, new MouseEvent("pointerup", { bubbles: true }));
    expect(top().classList.contains("is-ghost")).toBe(false);
    await fire(document.body, new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(top().style.left).toBe("60px");
  });

  it("appends a bin snippet at the playhead", async () => {
    await fire(document.body, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await fire(byText("My clips")!, new MouseEvent("click", { bubbles: true }));
    expect(container.textContent).toContain("Snippet One");
    await fire($$("button").find((b) => b.title === "Insert at the playhead")!, new MouseEvent("click", { bubbles: true }));
    expect($$(".pmv-clip")).toHaveLength(4);
  });

  it("drills into a scene and picks a marker", async () => {
    await fire(byText("Scenes")!, new MouseEvent("click", { bubbles: true }));
    await fire($$(".pmv-list-item")[0], new MouseEvent("click", { bubbles: true }));
    await waitFor(() => container.textContent!.includes("Marker A"));
    await fire($$("button").find((b) => b.title === "Add to “My clips”")!, new MouseEvent("click", { bubbles: true }));
    await fire(byText("← back")!, new MouseEvent("click", { bubbles: true }));
    await fire(byText("My clips")!, new MouseEvent("click", { bubbles: true }));
    expect(container.textContent).toContain("Marker A");
  });

  it("puts the selected clip on a marker of its scene without moving it on the timeline", async () => {
    const v1Lane = $$(".pmv-lane[data-track-id]")[1];
    const target = () => Array.from(v1Lane.querySelectorAll<HTMLElement>(".pmv-clip")).find((el) => el.style.left === "0px")!;
    const widthBefore = target().style.width;
    await fire(target(), new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await fire(window, new MouseEvent("pointerup", { bubbles: true }));
    await fire(byText("Open source")!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => container.textContent!.includes("Selected clip"));
    expect($(".pmv-scrub-clip")).not.toBeNull(); // the clip's range on the scene's scrub bar
    const markerRow = $$(".pmv-list-item").find((li) => li.textContent?.includes("Marker A"))!;
    await fire(markerRow.querySelector<HTMLElement>("button[title^='Put the selected clip on this marker']")!, new MouseEvent("click", { bubbles: true }));
    expect(target().style.width).toBe(widthBefore);
    expect(target().title).toContain("Source 0:10.000");
    await fire(document.body, new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(target().title).toContain("Source 0:05.000");
    await fire(document.body, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  it("adds scenes by ID and reports unknown input", async () => {
    await fire(byText("Scenes")!, new MouseEvent("click", { bubbles: true }));
    const input = $$("input").find((i) => i.getAttribute("placeholder")?.startsWith("Scene id")) as HTMLInputElement;
    // React tracks the value through the native setter
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, "http://stash:9999/scenes/2, 1 99 abc");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await fire(byText("+ ID")!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => container.textContent!.includes("not found: 99"));
    expect(container.textContent).toContain("1 added · 1 already in the project · not found: 99 · invalid: abc");
    expect(container.textContent).toContain("Project scenes (2)");
    expect(input.value).toBe("99, abc");
  });

  it("generates a PMV into the timeline as one undo step", async () => {
    const before = $$(".pmv-clip").length;
    await fire(byText("⚡ Generate PMV")!, new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-gen")).not.toBeNull();
    await fire($$(".pmv-gen .pmv-seg button").find((b) => b.textContent === "Project scenes")!, new MouseEvent("click", { bubbles: true }));
    await fire(byText("⚡ Generate")!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => !!$(".pmv-gen .pmv-success") || !!$(".pmv-gen .pmv-error"));
    expect($(".pmv-gen .pmv-error")).toBeNull();
    expect($(".pmv-gen .pmv-success")!.textContent).toMatch(/✓ \d+ clips from \d+ scenes/);
    await fire(byText("Done – fine-tune")!, new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-gen")).toBeNull();
    const after = $$(".pmv-clip").length;
    expect(after).toBeGreaterThan(before);
    await fire(document.body, new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect($$(".pmv-clip").length).toBe(before);
    await fire(document.body, new KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true }));
    expect($$(".pmv-clip").length).toBe(after);
  });

  it("opens the render dialog with a plan summary", async () => {
    await fire(byText("Render")!, new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-modal")?.textContent).toMatch(/\d+ segments/);
    await fire($$(".pmv-modal button").find((b) => b.textContent === "✕")!, new MouseEvent("click", { bubbles: true }));
  });

  it("autosaves edits through the backend", async () => {
    await waitFor(() => saved.length > 0, 4000);
    const last = saved[saved.length - 1] as { bin: Array<{ label: string }> };
    expect(last.bin.map((s) => s.label)).toContain("Marker A");
  });

  it("logged no React errors", () => {
    expect(errors).toEqual([]);
  });
});
