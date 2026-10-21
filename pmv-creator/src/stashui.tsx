/**
 * Stash UI extension module (Extension API v2). Stash UI imports /plugin/pmv-creator/assets/stashui.js
 * and calls setup(): a "PMV Creator" entry under Watch, the editor as a full-screen overlay page, and
 * entry points in the player's gear menu, its info bar and the selection bar of scene lists.
 * This bundle carries its own React – Stash UI has no PluginApi.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { stashuiHost } from "./host";
import { setLang, t } from "./i18n";
import { App } from "./ui/App";

const PLUGIN = "pmv-creator";

/** Stash UI keeps its language choice in localStorage ("auto" = Stash's interface language, read by the app itself). */
function readStashUiLang(): string {
  try {
    const v = (localStorage.getItem("stashui.lang") ?? "").replace(/^"|"$/g, "");
    return v && v !== "auto" ? v : navigator.language;
  } catch {
    return navigator.language;
  }
}

/** What Stash UI hands to setup() – only the parts used here. */
interface StashUI {
  version: number;
  has(feature: string): boolean;
  addNavItem(def: { id: string; label: string; icon: string; route: string; group: string }): void;
  addRoute(def: { path: string; title: string; overlay?: boolean; render(el: HTMLElement, ctx: { query?: unknown; signal: AbortSignal }): () => void }): void;
  addSlot(name: string, def: { id: string; title?: string; match?(ctx: SlotCtx): boolean; mount(el: HTMLElement, ctx: SlotCtx): void | (() => void) }): void;
  go(path: string): void;
  ui: { icon(name: string): string };
}

interface SlotCtx {
  kind?: string;
  id?: string | number;
  time?: () => number;
  ids?: () => Array<string | number>;
}

function ensureCss(): void {
  if (document.querySelector("link[data-pmv-css]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `/plugin/${PLUGIN}/css`;
  link.dataset.pmvCss = "1";
  document.head.appendChild(link);
}

/** Stash UI passes the route query as an object; be lenient about the shape. */
function toParams(q: unknown): URLSearchParams {
  if (q instanceof URLSearchParams) return q;
  if (typeof q === "string") return new URLSearchParams(q.replace(/^\?/, ""));
  if (q && typeof q === "object") return new URLSearchParams(Object.entries(q as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  return new URLSearchParams();
}

export default function setup(stashui: StashUI): void {
  const open = (params: Record<string, string>) => stashui.go(`p/${PLUGIN}/editor?${new URLSearchParams(params)}`);

  stashui.addNavItem({ id: "editor", label: "PMV Creator", icon: "scissors", route: "editor", group: "Watch" });

  stashui.addRoute({
    path: "editor",
    title: "PMV Creator",
    overlay: true,
    render(el, { query }) {
      ensureCss();
      const mount = document.createElement("div");
      el.appendChild(mount);
      const root = createRoot(mount);
      root.render(<App host={stashuiHost(toParams(query))} />);
      return () => {
        root.unmount();
        mount.remove();
      };
    },
  });

  const button = (label: string, run: () => void, cls = "kb-btn") => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = cls;
    b.innerHTML = `${stashui.ui.icon("scissors")}<span>${label}</span>`;
    b.onclick = run;
    return b;
  };
  const sceneAt = (ctx: SlotCtx) => {
    const t = ctx.time?.() ?? 0;
    open({ scenes: String(ctx.id), t: (Math.round(t * 10) / 10).toString() });
  };

  // player: gear menu + info bar section – the scene opens in the editor at the current time
  // Stash UI's own language choice wins here; it is read on each mount, so a later switch is picked up
  const lang = () => setLang(readStashUiLang());
  const label = () => (lang(), t("Open in PMV Creator"));
  if (stashui.has("slot:scene.menu")) {
    stashui.addSlot("scene.menu", { id: "pmv", title: "PMV Creator", mount: (el, ctx) => void el.appendChild(button(label(), () => sceneAt(ctx), "kb-btn is-ghost")) });
  }
  if (stashui.has("slot:scene.info")) {
    stashui.addSlot("scene.info", {
      id: "pmv",
      title: "PMV Creator",
      mount(el, ctx) {
        const hint = document.createElement("p");
        hint.className = "kb-hint";
        hint.textContent = (lang(), t("Open this scene in the PMV editor – at the current spot, to pick and cut."));
        el.append(hint, button(label(), () => sceneAt(ctx)));
      },
    });
  }
  // scene lists: the selection goes into the project pool
  if (stashui.has("slot:bulk.actions")) {
    stashui.addSlot("bulk.actions", {
      id: "pmv",
      match: (ctx) => ctx.kind === "scene",
      mount(el, ctx) {
        el.appendChild(
          button("PMV Creator", () => {
            const ids = (ctx.ids?.() ?? []).map(String);
            if (ids.length) open({ scenes: ids.join(",") });
          }),
        );
      },
    });
  }
}
