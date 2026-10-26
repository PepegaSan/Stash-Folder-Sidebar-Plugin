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
import { setPollInterval } from "../src/ui/renders";

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
const tagged: unknown[] = [];
const tasks: Array<{ id: string; args: Record<string, unknown> }> = [];
const jobPolls: Record<string, number> = {};
let lastSceneFilter: unknown = null;
const RENDER_DESC = "Running plugin task: Render PMV";

function graphql(body: { query: string; variables?: Record<string, any> }) {
  const q = body.query;
  if (q.includes("runPluginOperation")) {
    const args = body.variables?.args ?? {};
    const out: Record<string, unknown> = {
      ping: { version: "test", ffmpeg: "ffmpeg", ffprobe: "ffprobe", python: "3" },
      load_project: fixtureProject(),
      list_projects: [],
      list_presets: [{ name: "Hypno Mia", settings: { mood: "hypno", clips: { source: "project" } } }],
      list_media: [{ name: "Neon Nights.mp3", path: "/media/neon.mp3", url: "/plugin/pmv-creator/assets/media/neon.mp3", size: 4000000, mtime: 1792000000 }],
      render_result: { status: "done", file: "/renders/Smoke.mp4", scanned: false, pieces: 3, cached: 0, seconds: 1.5 },
      audio_peaks: { pps: 50, peaks: btoa(String.fromCharCode(...Array.from({ length: 6000 }, (_, i) => (i % 50) * 5))), duration: 120, hasAudio: true },
    };
    if (args.op === "save_project") saved.push(args.project);
    return { runPluginOperation: out[args.op] ?? { path: "/x" } };
  }
  if (q.includes("runPluginTask")) {
    const id = String(tasks.length + 41);
    tasks.push({ id, args: body.variables?.args ?? {} });
    return { runPluginTask: id };
  }
  if (q.includes("findJob")) {
    const id = String(body.variables?.id);
    const n = (jobPolls[id] = (jobPolls[id] ?? 0) + 1);
    return { findJob: { id, status: n < 3 ? "RUNNING" : "FINISHED", progress: n < 3 ? 0.5 : 1, description: RENDER_DESC, error: null } };
  }
  if (q.includes("findSavedFilters")) {
    return { findSavedFilters: [{ id: "3", name: "Blondes", find_filter: { q: "", sort: "date", direction: "DESC" }, object_filter: { tags: { modifier: "INCLUDES_ALL", value: { items: [{ id: "9", label: "Tag" }], excluded: [], depth: 0 } } } }] };
  }
  if (q.includes("findSceneMarkers")) return { findSceneMarkers: { count: 0, scene_markers: [] } };
  if (q.includes("findScenes")) {
    const ids: string[] | undefined = body.variables?.ids;
    if (body.variables?.scene_filter) lastSceneFilter = body.variables.scene_filter;
    const pool = [scene, { ...scene, id: "2", title: "Scene Two", scene_markers: [] }];
    const scenes = ids ? pool.filter((s) => ids.includes(s.id)) : [scene];
    return { findScenes: { count: scenes.length, scenes } };
  }
  if (q.includes("findTags")) return { findTags: { tags: [] } };
  if (q.includes("tagCreate")) return { tagCreate: { id: "77" } };
  if (q.includes("bulkSceneUpdate")) {
    tagged.push(body.variables?.input);
    return { bulkSceneUpdate: [{ id: "1" }] };
  }
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
  // a song: clicks every half second (120 BPM), decoded by the fake AudioContext below
  (window as any).AudioContext = class {
    async decodeAudioData() {
      const sr = 8000;
      const n = sr * 20;
      const d = new Float32Array(n);
      for (let i = 0; i < n; i += sr / 2) for (let k = 0; k < 120; k++) d[i + k] = 0.8 * Math.sin(k * 0.7);
      return { duration: 20, sampleRate: sr, numberOfChannels: 1, length: n, getChannelData: () => d };
    }
    close() {
      return Promise.resolve();
    }
  };
  globalThis.fetch = vi.fn(async (url: any, init?: any) => {
    if (String(url).includes("/assets/media/")) return new Response(new ArrayBuffer(16));
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

  it("shows the transition without “More…” and applies one to all clips in one undo step", async () => {
    const v1Lane = $$(".pmv-lane[data-track-id]")[1];
    const first = Array.from(v1Lane.querySelectorAll<HTMLElement>(".pmv-clip")).find((el) => el.style.left === "0px")!;
    await fire(first, new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await fire(window, new MouseEvent("pointerup", { bubbles: true }));
    // the other clips of the same scene are marked; "Edit source" sits above the timeline
    expect($$(".pmv-clip.is-same-scene")).toHaveLength(2);
    expect($(".pmv-tl-toolbar")!.textContent).toContain("✎ Edit source");
    const select = $$(".pmv-inspector select").find((s) => s.querySelector('option[value="wipeleft"]')) as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.closest(".pmv-more")).toBeNull();
    expect(select.querySelector('option[value="wipeleft"]')!.textContent).toBe("Wipe to the left");
    expect($$(".pmv-clip-trans")).toHaveLength(1);
    // the first clip has a hard cut – giving that to all removes the fade of the second clip
    await fire(byText("⇉ Transition for all clips")!, new MouseEvent("click", { bubbles: true }));
    expect($$(".pmv-clip-trans")).toHaveLength(0);
    await fire(document.body, new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect($$(".pmv-clip-trans")).toHaveLength(1);
    await fire(document.body, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
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

  it("links every project scene to its Stash page and fetches the scene anew on return", async () => {
    await fire(byText("Scenes")!, new MouseEvent("click", { bubbles: true }));
    // a selected clip gives the link its spot: c1 (source in 5 s) – from the row and from the bar above the timeline
    const v1Lane = $$(".pmv-lane[data-track-id]")[1];
    const c1 = Array.from(v1Lane.querySelectorAll<HTMLElement>(".pmv-clip")).find((el) => el.style.left === "0px" && el.title.includes("(2.000 s)"))!;
    await fire(c1, new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await fire(window, new MouseEvent("pointerup", { bubbles: true }));
    const barLink = $(".pmv-tl-toolbar a") as HTMLAnchorElement;
    expect(barLink.textContent?.trim()).toBe("↗ Stash");
    expect(barLink.getAttribute("href")).toMatch(/\/scenes\/1\?t=5$/);
    const row = () => $$(".pmv-list-item").find((li) => li.textContent?.includes("Scene One"))!;
    expect(row().querySelector("a")!.getAttribute("href")).toMatch(/\/scenes\/1\?t=5$/);
    await fire(document.body, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($(".pmv-tl-toolbar a")).toBeNull();
    const link = row().querySelector("a") as HTMLAnchorElement;
    expect(link.textContent?.trim()).toBe("↗ Stash");
    // no clip selected: the spot of a clip under the playhead, or none
    expect(link.getAttribute("href")).toMatch(/\/scenes\/1(\?t=\d+(\.\d)?)?$/);
    expect(link.target).toBe("_blank");
    const fetchesOfScene1 = () =>
      (fetch as any).mock.calls.filter((c: any[]) => {
        const body = typeof c[1]?.body === "string" ? JSON.parse(c[1].body) : null;
        return body?.query?.includes("findScenes") && body.variables?.ids?.join() === "1";
      }).length;
    const before = fetchesOfScene1();
    // the browser would open the tab – jsdom must not try to navigate
    window.addEventListener("click", (e) => e.preventDefault(), { capture: true, once: true });
    await fire(link, new MouseEvent("click", { bubbles: true, cancelable: true }));
    // the row's own click (open the scene view) does not fire, nothing is fetched yet
    expect(container.textContent).toContain("Project scenes");
    expect(fetchesOfScene1()).toBe(before);
    // back in the editor: the scene (with its new markers) is fetched again, once
    await fire(window, new Event("focus"));
    await waitFor(() => fetchesOfScene1() === before + 1);
    await fire(window, new Event("focus"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(fetchesOfScene1()).toBe(before + 1);
  });

  it("sets a timeline marker with the ◆ button and removes it with the same button or M", async () => {
    await fire(document.body, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    const advanced = $$(".pmv-adv input[type=checkbox]")[0] as HTMLInputElement;
    expect(advanced).toBeTruthy();
    const wasAdvanced = advanced.checked;
    if (!wasAdvanced) await fire(advanced, new MouseEvent("click", { bubbles: true }));
    const marks = () => $$(".pmv-ruler-marker").length;
    const before = marks();
    const add = byText("◆ Timeline marker")!;
    expect(add).toBeTruthy();
    await fire(add, new MouseEvent("click", { bubbles: true }));
    expect(marks()).toBe(before + 1);
    // the playhead sits on the new marker: the same button now removes it
    await waitFor(() => !!byText("◆ Remove marker"));
    await fire(byText("◆ Remove marker")!, new MouseEvent("click", { bubbles: true }));
    expect(marks()).toBe(before);
    // key M toggles the same way
    await fire(document.body, new KeyboardEvent("keydown", { key: "m", bubbles: true }));
    expect(marks()).toBe(before + 1);
    await fire(document.body, new KeyboardEvent("keydown", { key: "m", bubbles: true }));
    expect(marks()).toBe(before);
    if (!wasAdvanced) await fire(advanced, new MouseEvent("click", { bubbles: true }));
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

  it("puts a whole scene onto the timeline with a labelled button and shows clip audio without “More…”", async () => {
    await fire(byText("Scenes")!, new MouseEvent("click", { bubbles: true }));
    const before = $$(".pmv-clip").length;
    const row = $$(".pmv-list-item").find((li) => li.textContent?.includes("Scene One"))!;
    const toTimeline = Array.from(row.querySelectorAll("button")).find((b) => b.textContent?.trim() === "→ Timeline")!;
    expect(toTimeline).toBeTruthy();
    await fire(toTimeline, new MouseEvent("click", { bubbles: true }));
    expect($$(".pmv-clip")).toHaveLength(before + 1);
    // the whole 120 s scene, not quantised to the beat
    const whole = () => $$(".pmv-clip").find((el) => el.title.includes("(120.000 s)"))!;
    expect(whole()).toBeTruthy();
    expect(whole().querySelector(".pmv-badge")).toBeNull();
    await fire(whole(), new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await fire(window, new MouseEvent("pointerup", { bubbles: true }));
    // the clip audio slider sits in the open part of the inspector
    const slider = $$('.pmv-inspector input[type="range"]').find((i) => i.getAttribute("max") === "2") as HTMLInputElement;
    expect(slider).toBeTruthy();
    expect(slider.closest(".pmv-more")).toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(slider, "0.8");
      slider.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(whole().querySelector(".pmv-badge")!.textContent).toBe("🔊");
    expect(whole().title).toContain("Clip audio 80 %");
    const loud = () => $$(".pmv-clip .pmv-badge").filter((b) => b.textContent === "🔊").length;
    expect(loud()).toBe(1);
    await fire(byText("⇉ Clip audio for all clips")!, new MouseEvent("click", { bubbles: true }));
    expect(loud()).toBe(before + 1);
    // three steps back: all clips, the slider, the insert
    for (let i = 0; i < 3; i++) await fire(document.body, new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect($$(".pmv-clip")).toHaveLength(before);
    expect(loud()).toBe(0);
    await fire(document.body, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  it("draws the clips' sound on demand and shows a scene's waveform in the scene view", async () => {
    expect($(".pmv-clip-waves")).toBeNull();
    const laneHeight = () => $$(".pmv-lane[data-track-id]")[0].style.height;
    expect(laneHeight()).toBe("52px");
    await fire(byText("〰 Waveform")!, new MouseEvent("click", { bubbles: true }));
    expect($$(".pmv-clip-waves")).toHaveLength(2); // one canvas per track lane
    expect(laneHeight()).toBe("76px"); // the tracks grow: the sound gets a band of its own
    expect(localStorage.getItem("pmv-creator:waveforms")).toBe("1");
    await waitFor(() => !container.textContent!.includes("of 1 scenes"));
    await fire(byText("〰 Waveform")!, new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-clip-waves")).toBeNull();
    expect(laneHeight()).toBe("52px");
    // the scene's peaks are there already: the scene view shows them under the bar instead of the button
    await fire(byText("Scenes")!, new MouseEvent("click", { bubbles: true }));
    await fire($$(".pmv-list-item").find((li) => li.textContent?.includes("Scene One"))!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => !!$(".pmv-scrub-wave"));
    expect(byText("〰 Load waveform")).toBeNull();
    await fire(byText("← back")!, new MouseEvent("click", { bubbles: true }));
  });

  it("puts the selected clip on a marker of its scene without moving it on the timeline", async () => {
    const v1Lane = $$(".pmv-lane[data-track-id]")[1];
    const target = () => Array.from(v1Lane.querySelectorAll<HTMLElement>(".pmv-clip")).find((el) => el.style.left === "0px")!;
    const widthBefore = target().style.width;
    await fire(target(), new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await fire(window, new MouseEvent("pointerup", { bubbles: true }));
    await fire(byText("✎ Edit source")!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => container.textContent!.includes("Selected clip"));
    // the scene takes over the main player; the clip's range sits on its scrub bar
    expect($(".pmv-source-host")!.classList.contains("pmv-hidden")).toBe(false);
    expect($(".pmv-source-host .pmv-scrub-clip")).not.toBeNull();
    expect($(".pmv-monitor-tabs .pmv-tab.is-active")!.textContent).toBe("Scene: Scene One");
    // the way back sits where "Edit source" was
    expect(byText("✎ Edit source")).toBeNull();
    expect(byText("← Back to the PMV (Esc)")).not.toBeNull();
    const markerRow = $$(".pmv-list-item").find((li) => li.textContent?.includes("Marker A"))!;
    await fire(markerRow.querySelector<HTMLElement>("button[title^='Put the selected clip on this marker']")!, new MouseEvent("click", { bubbles: true }));
    expect(target().style.width).toBe(widthBefore);
    expect(target().title).toContain("Source 0:10.000");
    await fire(document.body, new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(target().title).toContain("Source 0:05.000");
    // I / O pick a range in the scene player (keys go to the scene, not to the timeline)
    await fire(document.body, new KeyboardEvent("keydown", { key: "i", bubbles: true }));
    expect($(".pmv-source-host .pmv-selection")).not.toBeNull();
    // Esc goes back to the PMV preview first, the clip stays selected; the second Esc clears it
    await fire(document.body, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($(".pmv-source-host")!.classList.contains("pmv-hidden")).toBe(true);
    expect($(".pmv-monitor-tabs .pmv-tab.is-active")!.textContent).toBe("PMV preview");
    expect(byText("✎ Edit source")).not.toBeNull();
    await fire(document.body, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(byText("✎ Edit source")).toBeNull();
  });

  it("re-opening the open scene brings it back to the main player", async () => {
    const v1Lane = $$(".pmv-lane[data-track-id]")[1];
    const clip = Array.from(v1Lane.querySelectorAll<HTMLElement>(".pmv-clip")).find((el) => el.style.left === "0px")!;
    await fire(clip, new MouseEvent("dblclick", { bubbles: true }));
    expect($(".pmv-source-host")!.classList.contains("pmv-hidden")).toBe(false);
    // without a selected clip the inspector offers only the way back
    await fire(byText("← Back to the PMV (Esc)")!, new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-source-host")!.classList.contains("pmv-hidden")).toBe(true);
    expect(byText("← Back to the PMV (Esc)")).toBeNull();
    await fire($$(".pmv-monitor-tabs .pmv-tab")[1], new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-source-host")!.classList.contains("pmv-hidden")).toBe(false);
    await fire($$(".pmv-monitor-tabs button").find((b) => b.title === "Close the scene")!, new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-monitor-tabs")).toBeNull();
    expect($(".pmv-source-host")!.classList.contains("pmv-hidden")).toBe(true);
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

  it("replaces every clip of a scene from the bar above the timeline", async () => {
    // a clip's title starts with its label or its scene (the bin snippet clip is labelled, so the count comes from the button)
    const titles = () => $$(".pmv-clip").map((el) => el.title.split("\n")[0]);
    const before = titles();
    const first = $$(".pmv-clip").find((el) => el.title.startsWith("Scene One"))!;
    await fire(first, new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await fire(window, new MouseEvent("pointerup", { bubbles: true }));
    const replace = () => $$(".pmv-tl-toolbar button").find((b) => b.textContent?.startsWith("⇄ Replace all"))!;
    const n = Number(replace().textContent!.match(/\d+/)![0]);
    expect(n).toBeGreaterThan(1);
    await fire(replace(), new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-swap-pick")!.textContent).toContain(`all ${n} clips of “Scene One”`);
    await fire(document.body, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect($(".pmv-swap-pick")).toBeNull(); // Esc leaves picking, the clip stays selected
    await fire(replace(), new MouseEvent("click", { bubbles: true }));
    const two = $$(".pmv-list-item").find((li) => li.textContent?.includes("Scene Two"))!;
    await fire(two, new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-swap-pick")).toBeNull();
    expect(titles().filter((x) => x === "Scene One")).toHaveLength(0);
    expect(titles().filter((x) => x === "Scene Two")).toHaveLength(n);
    await fire(document.body, new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(titles()).toEqual(before);
    await fire(document.body, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
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

  it("applies a preset, offers the cuts of another PMV and lists the song library", async () => {
    await fire(byText("⚡ Generate PMV")!, new MouseEvent("click", { bubbles: true }));
    const select = $$(".pmv-gen select").find((s) => s.querySelector("option[value='Hypno Mia']")) as HTMLSelectElement;
    expect(select).toBeTruthy();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "Hypno Mia");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const on = () => $$(".pmv-gen .pmv-seg button.is-on").map((b) => b.textContent);
    expect(on()).toContain("Hypno");
    expect(on()).toContain("Project scenes");
    // cuts like another PMV: the PMVs of the library to pick from; without one, nothing to generate yet
    await fire($$(".pmv-gen .pmv-seg button").find((b) => b.textContent === "Like another PMV")!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => $$(".pmv-gen-pmv").length > 0);
    expect(byText("⚡ Generate")!.hasAttribute("disabled")).toBe(true);
    await fire($$(".pmv-gen .pmv-seg button").find((b) => b.textContent === "Every 2 beats")!, new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-gen-template")).toBeNull();
    expect(byText("⚡ Generate")!.hasAttribute("disabled")).toBe(false);
    // Hypno cuts every 2 beats itself: the mood stays; the transitions are offered right here too
    expect(on()).toEqual(expect.arrayContaining(["Hypno", "Every 2 beats"]));
    const kinds = $$(".pmv-gen select").find((s) => s.querySelector("option[value='mix']"));
    expect(kinds && [...kinds.querySelectorAll("option")].map((o) => o.textContent)).toEqual(expect.arrayContaining(["Hard cuts", "Flash", "Crossfade", "Wipe to the left", "Mix – a different one each time"]));
    await fire(byText("Close")!, new MouseEvent("click", { bubbles: true }));
    // the song library next to the upload (inspector, nothing selected)
    await fire(document.body, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await fire(byText("🎵 From the library…")!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => !!$(".pmv-songs")?.textContent?.includes("Neon Nights.mp3"));
    await fire($$(".pmv-songs button").find((b) => b.textContent === "✕")!, new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-songs")).toBeNull();
  });

  it("re-rolls, keeps and takes a scene out from the bar above the timeline", async () => {
    // V1 is the bottom lane (the generated PMV's split screens may have added tracks above it)
    const v1Lane = () => {
      const lanes = $$(".pmv-lane[data-track-id]");
      return lanes[lanes.length - 1];
    };
    const first = () => Array.from(v1Lane().querySelectorAll<HTMLElement>(".pmv-clip")).find((el) => el.style.left === "0px")!;
    const scene = () => first().title.split("\n")[0];
    const button = (text: string) => $$(".pmv-tl-toolbar button").find((b) => b.textContent?.startsWith(text)) ?? null;
    await fire(first(), new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    await fire(window, new MouseEvent("pointerup", { bubbles: true }));
    // 📌 keep (P toggles it, the clip shows it)
    await fire(document.body, new KeyboardEvent("keydown", { key: "p", bubbles: true }));
    expect(first().classList.contains("is-pinned")).toBe(true);
    expect(button("📌 Kept")).not.toBeNull();
    await fire(button("📌 Kept")!, new MouseEvent("click", { bubbles: true }));
    expect(first().classList.contains("is-pinned")).toBe(false);
    // 🎲 another clip: the other project scene, same place and length, one undo step
    const before = { scene: scene(), left: first().style.left, width: first().style.width };
    await fire(button("🎲 Another clip")!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => !$(".pmv-tl-notice"));
    expect(scene()).not.toBe(before.scene);
    expect([first().style.left, first().style.width]).toEqual([before.left, before.width]);
    await fire(document.body, new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(scene()).toBe(before.scene);
    // ⊘ scene out: every clip of it gets the other scene; then the Stash tag for good
    const count = (title: string) => $$(".pmv-clip").filter((el) => el.title.startsWith(title)).length;
    const other = before.scene === "Scene One" ? "Scene Two" : "Scene One";
    const total = count(before.scene) + count(other);
    await fire(button("⊘ Scene out")!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => !!$(".pmv-tl-notice")?.textContent?.includes("is out of this PMV"));
    expect(count(before.scene)).toBe(0);
    expect(count(other)).toBe(total);
    await fire($$(".pmv-tl-notice button").find((b) => b.textContent === "Never use it again")!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => !!$(".pmv-tl-notice")?.textContent?.includes("is never used again"));
    expect(tagged).toEqual([{ ids: [expect.any(String)], tag_ids: { ids: ["77"], mode: "ADD" } }]);
    await fire($$(".pmv-tl-notice button").find((b) => b.title === "Close")!, new MouseEvent("click", { bubbles: true }));
    await fire(document.body, new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(count(before.scene)).toBeGreaterThan(0);
    await fire(document.body, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });

  it("opens the render dialog with a plan summary", async () => {
    await fire(byText("Render")!, new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-modal")?.textContent).toMatch(/\d+ segments/);
    expect($(".pmv-modal")?.textContent).toContain("Label it in Stash");
    await fire($$(".pmv-modal button").find((b) => b.textContent === "✕")!, new MouseEvent("click", { bubbles: true }));
  });

  it("autosaves edits through the backend", async () => {
    await waitFor(() => saved.length > 0, 4000);
    const last = saved[saved.length - 1] as { bin: Array<{ label: string }> };
    expect(last.bin.map((s) => s.label)).toContain("Marker A");
  });

  it("starts a render, lets the dialog close and follows it to the end in the toolbar", async () => {
    setPollInterval(20);
    await fire(byText("Render")!, new MouseEvent("click", { bubbles: true }));
    await fire(byText("Start render")!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => tasks.length === 1 && !!$(".pmv-modal .pmv-progress"));
    expect(tasks[0].args).toMatchObject({ mode: "render", renderId: expect.any(String) });
    expect($(".pmv-modal")!.textContent).toContain("You can close this window");
    await fire($$(".pmv-modal button").find((b) => b.textContent === "✕")!, new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-modal")).toBeNull();
    // the watch goes on without the dialog
    await waitFor(() => !!byText("✓ 1"));
    await fire(byText("✓ 1")!, new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-renders")!.textContent).toContain("Smoke.mp4");
    expect(byText("🎬")).not.toBeNull(); // looked at: no longer counted
    await fire(document.body, new MouseEvent("mousedown", { bubbles: true }));
    expect($(".pmv-renders")).toBeNull();
  });

  it("steps through the cuts with ] and [ (AltGr on German keyboards too)", async () => {
    const key = (k: string, extra: KeyboardEventInit = {}) => fire(document.body, new KeyboardEvent("keydown", { key: k, bubbles: true, ...extra }));
    await key("Escape");
    await key("Home");
    const selected = () => $(".pmv-clip.is-selected");
    await key("]");
    expect(selected()).not.toBeNull();
    const first = selected()!.style.left;
    await key("]", { ctrlKey: true, altKey: true, modifierAltGraph: true } as KeyboardEventInit);
    expect(selected()!.style.left).not.toBe(first);
    await key("ArrowUp");
    expect(selected()!.style.left).toBe(first);
    await key(" ");
    // behind a dialog the arrows belong to the dialog
    await fire(byText("?")!, new MouseEvent("click", { bubbles: true }));
    await key("ArrowDown");
    expect(selected()!.style.left).toBe(first);
    await fire($$(".pmv-modal button").find((b) => b.textContent === "✕")!, new MouseEvent("click", { bubbles: true }));
    await key("Escape");
  });

  it("generates from a filter saved in Stash", async () => {
    await fire(byText("⚡ Generate PMV")!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => $$(".pmv-gen .pmv-seg button").some((b) => b.textContent === "Saved filter"));
    await fire($$(".pmv-gen .pmv-seg button").find((b) => b.textContent === "Saved filter")!, new MouseEvent("click", { bubbles: true }));
    expect(byText("⚡ Generate")!.hasAttribute("disabled")).toBe(true);
    const select = $$(".pmv-gen select").find((s) => s.querySelector("option[value='3']")) as HTMLSelectElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, "3");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => !!$(".pmv-gen")?.textContent?.includes("1 scene matches it right now"));
    await fire(byText("⚡ Generate")!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => !!$(".pmv-gen .pmv-success") || !!$(".pmv-gen .pmv-error"));
    expect($(".pmv-gen .pmv-error")).toBeNull();
    expect(lastSceneFilter).toEqual({ tags: { value: ["9"], modifier: "INCLUDES_ALL", depth: 0 } });
    await fire(byText("Done – fine-tune")!, new MouseEvent("click", { bubbles: true }));
    await fire(document.body, new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
  });

  it("makes several PMVs at once: one project per song, rendered one after another", async () => {
    await fire(byText("Project")!, new MouseEvent("click", { bubbles: true }));
    await fire(byText("📦 Several PMVs at once…")!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => !!$(".pmv-batch"));
    expect($(".pmv-batch")!.textContent).toContain("saved filter “Blondes”");
    await fire($$(".pmv-batch button").find((b) => b.textContent?.startsWith("🎵 From the library"))!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => !!$(".pmv-songs")?.textContent?.includes("Neon Nights.mp3"));
    await fire($$(".pmv-songs .pmv-list-item")[0], new MouseEvent("click", { bubbles: true }));
    await fire(byText("Add 1 song")!, new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-songs")).toBeNull();
    expect($(".pmv-batch-songs")!.textContent).toContain("Neon Nights");
    const before = tasks.length;
    await fire(byText("⚡ Make 1 PMV and render it")!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => !!$(".pmv-batch")?.textContent?.includes("1 PMV is in Stash's queue"), 5000);
    expect(tasks.length).toBe(before + 1);
    const made = saved.find((x: any) => x.name === "PMV – Neon Nights") as any;
    expect(made).toBeTruthy();
    expect(made.audio).toMatchObject({ name: "Neon Nights.mp3", path: "/media/neon.mp3" });
    expect(made.tracks.some((tr: any) => tr.clips.length > 0)).toBe(true);
    expect(made.generator.settings.clips.source).toBe("saved");
    await waitFor(() => !!$(".pmv-batch")?.textContent?.includes("✓ rendered"));
    await fire(byText("Close")!, new MouseEvent("click", { bubbles: true }));
    expect($(".pmv-batch")).toBeNull();
  });

  it("sets the listening volume above the timeline and the music volume at the music lane", async () => {
    const slide = async (el: HTMLInputElement, value: string) =>
      act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      });
    const stored = () => JSON.parse(localStorage.getItem("pmv-creator:listen") ?? "null");
    // 🔊 listening volume: this browser only, remembered, not part of the project
    const listen = $(".pmv-tl-toolbar .pmv-vol input[type=range]") as HTMLInputElement;
    const mute = () => $(".pmv-tl-toolbar .pmv-vol button")!;
    await slide(listen, "0.4");
    expect(stored()).toEqual({ volume: 0.4, muted: false });
    await fire(mute(), new MouseEvent("click", { bubbles: true }));
    expect(stored()).toEqual({ volume: 0.4, muted: true });
    expect(mute().textContent).toBe("🔇");
    expect(listen.value).toBe("0");
    await fire(mute(), new MouseEvent("click", { bubbles: true }));
    expect(stored()).toEqual({ volume: 0.4, muted: false });
    expect(listen.value).toBe("0.4");
    // ♪ music volume: the render's gain, shown as % at the music lane
    await fire(document.body, new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await fire(byText("🎵 From the library…")!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => !!$(".pmv-songs")?.textContent?.includes("Neon Nights.mp3"));
    await fire($$(".pmv-songs li").find((li) => li.textContent?.includes("Neon Nights.mp3"))!, new MouseEvent("click", { bubbles: true }));
    await waitFor(() => !!$(".pmv-tl-head-audio .pmv-vol"));
    const level = () => $(".pmv-tl-head-audio .pmv-vol")!.textContent;
    expect(level()).toBe("100%");
    await slide($(".pmv-tl-head-audio input[type=range]") as HTMLInputElement, "0.5");
    expect(level()).toBe("50%");
    await waitFor(() => (saved[saved.length - 1] as { audio?: { gainDb: number } }).audio?.gainDb === -6, 4000);
    await fire($(".pmv-tl-head-audio input[type=range]")!, new MouseEvent("dblclick", { bubbles: true }));
    expect(level()).toBe("100%");
  });

  it("logged no React errors", () => {
    expect(errors).toEqual([]);
  });
});
