import React, { useEffect, useRef, useState } from "react";
import { sceneToSource } from "../culling/culling";
import { type Host, HostProvider, classicHost, useHost } from "../host";
import { detectLang, t } from "../i18n";
import { gql } from "../stash/graphql";
import { uid } from "../model/ids";
import { type SourceMedia, createProject, projectDuration } from "../model/project";
import { fetchScenes, performerRef, tagRef } from "../stash/queries";
import { primeScenes } from "../stash/sceneCache";
import { EditorProvider, useEditor } from "../state/store";
import { findClip } from "../timeline/ops";
import { clamp } from "../timeline/time";
import { anotherClip } from "./clipActions";
import { GeneratorDialog } from "./generator/GeneratorDialog";
import { Inspector } from "./Inspector";
import { resumeLabels } from "./labels";
import { useLocalMediaPolling } from "./localMedia";
import { Monitor, SourceHostContext, sourceKeys } from "./monitor";
import { Sidebar } from "./sidebar/Sidebar";
import { Timeline } from "./timeline/Timeline";
import { Toolbar } from "./Toolbar";

/** Stash's interface language, e.g. "de-DE"; null when Stash can't be asked. */
async function interfaceLanguage(): Promise<string | null> {
  const data = await gql<{ configuration: { interface: { language: string | null } } }>(`query PmvLang { configuration { interface { language } } }`);
  return data.configuration.interface.language;
}

export function App({ host }: { host?: Host }) {
  const [fallback] = useState(classicHost);
  const h = host ?? fallback;
  const [top, setTop] = useState(() => h.topOffset());
  // the language has to be known before anything renders – t() is a plain function
  const [langReady, setLangReady] = useState(false);
  useEffect(() => {
    let alive = true;
    detectLang({ stashui: h.kind === "stashui", interfaceLanguage }).finally(() => alive && setLangReady(true));
    return () => {
      alive = false;
    };
  }, [h]);
  // Fill the viewport below the host's chrome (classic: Stash's fixed navbar), whatever its height is.
  useEffect(() => {
    const measure = () => setTop(h.topOffset());
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [h]);
  if (!langReady) return null;
  return (
    <HostProvider value={h}>
      <div className="pmv-root" data-host={h.kind} style={{ top }}>
        <EditorProvider>
          <Workspace />
        </EditorProvider>
      </div>
    </HostProvider>
  );
}

function Workspace() {
  const { state, backend } = useEditor();
  // state, not a ref: the scene drill-down re-renders into the host once it exists
  const [sourceHost, setSourceHost] = useState<HTMLDivElement | null>(null);
  useShortcuts();
  useDeepLinkScenes();
  useDeepLinkClipPreset();
  useLocalMediaPolling(backend === "online");
  // 🏷 labels of renders whose scan was not through when the editor was closed
  useEffect(() => resumeLabels(), []);
  return (
    <SourceHostContext.Provider value={sourceHost}>
      {state.ui.generator && <GeneratorDialog />}
      <Toolbar />
      <div className="pmv-main">
        <aside className="pmv-sidebar">
          <Sidebar />
        </aside>
        <section className="pmv-center">
          <div className="pmv-upper">
            <Monitor hostRef={setSourceHost} />
            <Inspector />
          </div>
          <Timeline />
        </section>
      </div>
    </SourceHostContext.Provider>
  );
}

/** ?scenes=12,34 adds those scenes to the project pool; a single scene with ?t=<s> opens at that time. */
function useDeepLinkScenes() {
  const { dispatch } = useEditor();
  const host = useHost();
  useEffect(() => {
    const ids = (host.query.get("scenes") ?? "").split(",").filter((x) => /^\d+$/.test(x));
    if (!ids.length) return;
    const t = parseFloat(host.query.get("t") ?? "");
    host.clearQueryParams?.(["scenes", "t"]);
    fetchScenes(ids).then(
      (scenes) => {
        primeScenes(scenes);
        dispatch({ type: "sources/add", sources: scenes.map(sceneToSource).filter((s): s is SourceMedia => !!s) });
        if (ids.length === 1 && scenes.length) dispatch({ type: "ui", patch: { sidebarTab: "scenes", activeSceneId: ids[0], activeSceneSeek: Number.isFinite(t) ? Math.max(0, t) : 0 } });
      },
      () => undefined,
    );
  }, [dispatch, host]);
}

/**
 * ?performer=<id> / ?tag=<id> ("PMV with this performer" in Stash): a new project named after them, and the
 * generator opens with them as its filter – after the song, or right away when the project has music.
 */
function useDeepLinkClipPreset() {
  const { dispatch } = useEditor();
  const host = useHost();
  useEffect(() => {
    const performer = host.query.get("performer") ?? "";
    const tag = host.query.get("tag") ?? "";
    if (!/^\d+$/.test(performer) && !/^\d+$/.test(tag)) return;
    host.clearQueryParams?.(["performer", "tag"]);
    void (async () => {
      const [p, tg] = await Promise.all([/^\d+$/.test(performer) ? performerRef(performer) : null, /^\d+$/.test(tag) ? tagRef(tag) : null]);
      const label = [p?.name, tg?.name].filter(Boolean).join(" · ");
      if (!label) return;
      dispatch({ type: "project/load", project: createProject(t("PMV – {name}", { name: label })) });
      dispatch({ type: "ui", patch: { clipPreset: { performers: p ? [p] : [], tags: tg ? [tg] : [], label } } });
    })().catch(() => undefined);
  }, [dispatch, host]);
}

function useShortcuts() {
  const { state, getState, dispatch, transport } = useEditor();
  const latest = useRef(state);
  latest.current = state;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) return;
      const { present: p, ui } = latest.current;
      const sel = ui.selectedClipId;
      const beat = 60 / p.beatGrid.bpm;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      let handled = true;
      if (!mod && sourceKeys.handle?.(key, e)) {
        // the scene in the main player took the key
      } else if (mod && key === "z") dispatch({ type: e.shiftKey ? "redo" : "undo" });
      else if (mod && key === "y") dispatch({ type: "redo" });
      else if (mod) handled = false;
      else
        switch (key) {
          case " ":
            transport.toggle();
            break;
          case "Delete":
          case "Backspace":
            if (sel) dispatch({ type: "clip/delete", clipId: sel, ripple: e.shiftKey });
            break;
          case "s":
            if (sel) dispatch({ type: "clip/split", clipId: sel, time: transport.time });
            break;
          case "r":
            if (sel && ui.selectedSnippetId) dispatch({ type: "clip/replace", clipId: sel, snippetId: ui.selectedSnippetId });
            break;
          case "n":
            if (sel && !e.repeat) void anotherClip(getState, dispatch, [sel]);
            break;
          case "p": {
            const loc = sel ? findClip(p, sel) : null;
            if (loc) dispatch({ type: "clips/pin", clipIds: [loc.clip.id], pinned: !loc.clip.pinned });
            break;
          }
          case "m":
            dispatch({ type: "marker/add", marker: { id: uid("mrk"), time: transport.time, label: `M${p.markers.length + 1}` } });
            break;
          case "Escape":
            // first leave "replace all" picking, then clear the selection
            dispatch({ type: "ui", patch: ui.swapFrom ? { swapFrom: null } : { selectedClipId: null, selectedSnippetId: null } });
            break;
          case "Home":
            transport.seek(0);
            break;
          case "End":
            transport.seek(projectDuration(p));
            break;
          case "+":
            dispatch({ type: "ui", patch: { zoom: clamp(ui.zoom * 1.5, 4, 1000) } });
            break;
          case "-":
            dispatch({ type: "ui", patch: { zoom: clamp(ui.zoom / 1.5, 4, 1000) } });
            break;
          case "ArrowLeft":
          case "ArrowRight": {
            const dir = key === "ArrowLeft" ? -1 : 1;
            const step = e.shiftKey ? beat : 1 / p.output.fps;
            const loc = sel && e.altKey ? findClip(p, sel) : null;
            if (loc) dispatch({ type: "clip/move", clipId: loc.clip.id, trackId: loc.track.id, start: loc.clip.start + dir * step, mode: ui.editMode });
            else transport.seek(transport.time + dir * step);
            break;
          }
          default:
            handled = false;
        }
      if (handled) {
        e.preventDefault();
        // capture phase + stop: Stash's global shortcuts must not see keys we use
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dispatch, getState, transport]);
}
