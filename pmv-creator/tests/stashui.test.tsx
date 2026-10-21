// @vitest-environment jsdom
/** The Stash UI extension module against a fake of Stash UI's extension API (ext.js, API v2). */
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import setup from "../src/stashui";

type Fn = (...args: any[]) => any;

function fakeStashUI() {
  const nav: any[] = [];
  const routes: any[] = [];
  const slots: Record<string, any> = {};
  const gone: string[] = [];
  return {
    nav,
    routes,
    slots,
    gone,
    api: {
      version: 2,
      has: (f: string) => ["route", "navItem", "slot:scene.menu", "slot:scene.info", "slot:bulk.actions"].includes(f),
      addNavItem: (d: any) => nav.push(d),
      addRoute: (d: any) => routes.push(d),
      addSlot: (name: string, d: any) => (slots[name] = d),
      go: (p: string) => gone.push(p),
      ui: { icon: (n: string) => `<svg data-icon="${n}"></svg>` },
    },
  };
}

afterEach(() => {
  document.body.innerHTML = "";
  document.head.querySelectorAll("link[data-pmv-css]").forEach((l) => l.remove());
});

describe("Stash UI extension module", () => {
  it("registers a Watch entry, the overlay page and the player/selection slots", () => {
    const f = fakeStashUI();
    setup(f.api as any);
    expect(f.nav).toEqual([{ id: "editor", label: "PMV Creator", icon: "scissors", route: "editor", group: "Watch" }]);
    expect(f.routes[0]).toMatchObject({ path: "editor", overlay: true });
    expect(Object.keys(f.slots).sort()).toEqual(["bulk.actions", "scene.info", "scene.menu"]);
  });

  it("the player slot opens the editor with the scene at the current time; the selection slot with all ids", () => {
    const f = fakeStashUI();
    setup(f.api as any);
    const el = document.createElement("div");
    f.slots["scene.info"].mount(el, { id: 6, time: () => 20.04 });
    (el.querySelector("button") as HTMLButtonElement).click();
    expect(f.gone).toEqual(["p/pmv-creator/editor?scenes=6&t=20"]);
    const bulk = document.createElement("div");
    expect(f.slots["bulk.actions"].match({ kind: "image" })).toBe(false);
    f.slots["bulk.actions"].mount(bulk, { kind: "scene", ids: () => [23, "3", 4] });
    (bulk.querySelector("button") as HTMLButtonElement).click();
    expect(f.gone[1]).toBe("p/pmv-creator/editor?scenes=23%2C3%2C4");
  });

  it("renders the editor into the overlay element in Stash UI mode and unmounts on cleanup", async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
    HTMLMediaElement.prototype.pause = () => undefined;
    HTMLMediaElement.prototype.load = () => undefined;
    HTMLCanvasElement.prototype.getContext = (() => null) as any;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // no Stash: every GraphQL call fails -> the editor runs in its offline mode
    globalThis.fetch = vi.fn(async () => { throw new Error("offline"); }) as Fn;
    const f = fakeStashUI();
    setup(f.api as any);
    const host = document.createElement("div");
    document.body.appendChild(host);
    let cleanup: (() => void) | undefined;
    await act(async () => {
      cleanup = f.routes[0].render(host, { query: { scenes: "1" }, signal: new AbortController().signal });
    });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    const root = host.querySelector(".pmv-root") as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.dataset.host).toBe("stashui");
    expect(root.style.top).toBe("0px");
    expect(document.querySelector("link[data-pmv-css]")?.getAttribute("href")).toBe("/plugin/pmv-creator/css");
    expect(host.textContent).toContain("(local)"); // offline badge: Stash UI mode never saved to the address bar
    await act(async () => cleanup!());
    expect(host.querySelector(".pmv-root")).toBeNull();
  });
});
