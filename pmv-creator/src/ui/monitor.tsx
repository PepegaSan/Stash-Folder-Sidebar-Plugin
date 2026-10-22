/**
 * The main player area shows the PMV preview or – while a scene is open in the sidebar – that scene
 * big ("source monitor"). The scene drill-down owns the scene player and portals it into the host
 * element provided here, so its state (selection, keyframes, slot) stays in one component.
 */
import React, { createContext } from "react";
import { t } from "../i18n";
import { useScene } from "../stash/sceneCache";
import { sceneTitle } from "../stash/types";
import { useEditor } from "../state/store";
import { findClip } from "../timeline/ops";
import { PreviewPlayer } from "./preview/PreviewPlayer";

/** Element the scene player is portalled into; null until the monitor has mounted. */
export const SourceHostContext = createContext<HTMLElement | null>(null);

/** Keys of the scene player while it is shown (Space, I/O, arrows, Esc) – returns true when it took the key. */
export const sourceKeys: { handle: ((key: string, e: KeyboardEvent) => boolean) | null } = { handle: null };

export function Monitor({ hostRef }: { hostRef: (el: HTMLDivElement | null) => void }) {
  const { state } = useEditor();
  const { activeSceneId, sceneInPlayer } = state.ui;
  const showScene = !!activeSceneId && sceneInPlayer;
  return (
    <div className="pmv-monitor">
      {activeSceneId && <MonitorTabs sceneId={activeSceneId} showScene={showScene} />}
      <div className="pmv-monitor-body">
        <PreviewPlayer />
        <div ref={hostRef} className={`pmv-source-host ${showScene ? "" : "pmv-hidden"}`} />
      </div>
    </div>
  );
}

/**
 * "Edit source" and the way back in one central spot above the timeline – where the clip is picked, between the
 * player and the timeline (Esc does the same). Without a clip only the way back shows.
 */
export function SourceToggle() {
  const { state, dispatch } = useEditor();
  const ui = state.ui;
  if (ui.activeSceneId && ui.sceneInPlayer) {
    return (
      <button className="btn btn-sm btn-primary pmv-source-toggle" title={t("Back to the PMV preview – the scene stays open on the left")} onClick={() => dispatch({ type: "ui", patch: { sceneInPlayer: false } })}>
        ← {t("Back to the PMV (Esc)")}
      </button>
    );
  }
  const clip = ui.selectedClipId ? findClip(state.present, ui.selectedClipId)?.clip : null;
  if (!clip) return null;
  return (
    <button
      className="btn btn-sm btn-primary pmv-source-toggle"
      onClick={() => dispatch({ type: "ui", patch: { activeSceneId: clip.sceneId, activeSceneSeek: clip.sourceIn } })}
      title={t("Shows the clip's scene in the big player – pick another spot, a marker or another scene for it there (also: double-click the clip)")}
    >
      ✎ {t("Edit source")}
    </button>
  );
}

/** How many clips of a scene the PMV has. */
export const clipsOfScene = (p: { tracks: Array<{ clips: Array<{ sceneId: string }> }> }, sceneId: string) => p.tracks.reduce((n, tr) => n + tr.clips.filter((c) => c.sceneId === sceneId).length, 0);

/**
 * Next to "Edit source": replace every clip of the selected clip's scene with another scene – the scene list on
 * the left switches to picking it (see SceneBrowser). Only while that scene is in the PMV more than once.
 */
export function ReplaceAllButton() {
  const { state, dispatch } = useEditor();
  const ui = state.ui;
  if (ui.swapFrom) {
    return (
      <button className="btn btn-sm btn-secondary" title="Esc" onClick={() => dispatch({ type: "ui", patch: { swapFrom: null } })}>
        ✕ {t("Cancel replacing")}
      </button>
    );
  }
  const clip = ui.selectedClipId ? findClip(state.present, ui.selectedClipId)?.clip : null;
  const n = clip ? clipsOfScene(state.present, clip.sceneId) : 0;
  if (!clip || n < 2) return null;
  const title = state.present.sources[clip.sceneId]?.title ?? clip.sceneId;
  return (
    <button
      className="btn btn-sm btn-secondary"
      title={t("Replaces all {n} clips of “{title}” with another scene: pick it in the list on the left (places and lengths stay, one undo step)", { n, title })}
      onClick={() => dispatch({ type: "ui", patch: { swapFrom: clip.sceneId, sidebarTab: "scenes", activeSceneId: null } })}
    >
      ⇄ {t("Replace all {n}…", { n })}
    </button>
  );
}

function MonitorTabs({ sceneId, showScene }: { sceneId: string; showScene: boolean }) {
  const { dispatch } = useEditor();
  const scene = useScene(sceneId);
  return (
    <div className="pmv-tabs pmv-monitor-tabs">
      <button className={`pmv-tab ${showScene ? "" : "is-active"}`} title={t("The PMV as it will be rendered (Esc)")} onClick={() => dispatch({ type: "ui", patch: { sceneInPlayer: false } })}>
        {t("PMV preview")}
      </button>
      <button className={`pmv-tab ${showScene ? "is-active" : ""}`} title={t("The scene open on the left – pick the part for the PMV here")} onClick={() => dispatch({ type: "ui", patch: { sceneInPlayer: true } })}>
        {t("Scene: {title}", { title: scene ? sceneTitle(scene) : sceneId })}
      </button>
      <button className="btn btn-sm btn-link" title={t("Close the scene")} onClick={() => dispatch({ type: "ui", patch: { activeSceneId: null } })}>
        ✕
      </button>
    </div>
  );
}
