/**
 * The main player area shows the PMV preview or – while a scene is open in the sidebar – that scene
 * big ("source monitor"). The scene drill-down owns the scene player and portals it into the host
 * element provided here, so its state (selection, keyframes, slot) stays in one component.
 */
import React, { createContext, useState } from "react";
import { t, tn } from "../i18n";
import type { Clip, PmvProject } from "../model/project";
import { SKIP_TAG } from "../stash/library";
import { useScene } from "../stash/sceneCache";
import { sceneTitle } from "../stash/types";
import type { UiState } from "../state/reducer";
import { useEditor } from "../state/store";
import { findClip } from "../timeline/ops";
import { anotherClip, sceneOut, skipForever } from "./clipActions";
import { PreviewPlayer } from "./preview/PreviewPlayer";
import { StashLink } from "./sidebar/StashLink";

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
 * Where a scene is in the PMV player right now, in source seconds: the selected clip of it (its spot under the
 * playhead, else its in-point), otherwise the topmost clip of it under the playhead – null when none is there.
 */
export function sceneSpotInPlayer(p: PmvProject, ui: UiState, sceneId: string, time: number): number | null {
  const inside = (c: Clip) => time >= c.start && time < c.start + c.duration;
  const spot = (c: Clip) => c.sourceIn + (inside(c) ? (time - c.start) * c.speed : 0);
  const sel = ui.selectedClipId ? findClip(p, ui.selectedClipId)?.clip : null;
  if (sel && sel.sceneId === sceneId) return spot(sel);
  for (const tr of p.tracks) for (const c of tr.clips) if (c.sceneId === sceneId && inside(c)) return spot(c);
  return null;
}

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

/**
 * Next to "Edit source": 🎲 another clip (N), 📌 keep it when generating again (P), ⊘ the scene out of this PMV,
 * ↗ the clip's scene in Stash at the spot the player shows. 🎲 and ⊘ ask Stash for candidates of the last generator run.
 */
export function ClipActions() {
  const { state, getState, dispatch, transport } = useEditor();
  const ui = state.ui;
  const clip = !ui.swapFrom && ui.selectedClipId ? findClip(state.present, ui.selectedClipId)?.clip : null;
  if (!clip) return null;
  const busy = !!ui.clipTask && !ui.clipTask.error;
  const title = state.present.sources[clip.sceneId]?.title ?? clip.sceneId;
  return (
    <>
      <button
        className="btn btn-sm btn-secondary"
        disabled={busy}
        title={t("Another clip for this spot – picked like the generator picks (same tags and performers), place and length stay (N)")}
        onClick={() => void anotherClip(getState, dispatch, [clip.id])}
      >
        🎲 {t("Another clip")}
      </button>
      <button
        className={`btn btn-sm ${clip.pinned ? "btn-primary" : "btn-secondary"}`}
        title={clip.pinned ? t("Kept: “Generate again” and “Another variant” leave this clip where it is – click to let it go (P)") : t("Keep this clip: “Generate again” and “Another variant” leave it where it is and fill around it (P)")}
        onClick={() => dispatch({ type: "clips/pin", clipIds: [clip.id], pinned: !clip.pinned })}
      >
        📌 {clip.pinned ? t("Kept") : t("Keep")}
      </button>
      <button
        className="btn btn-sm btn-secondary"
        disabled={busy}
        title={t("Takes “{title}” out of this PMV: all its clips get another clip, the generator skips it from now on (Ctrl+Z undoes it)", { title })}
        onClick={() => void sceneOut(getState, dispatch, clip.sceneId)}
      >
        ⊘ {t("Scene out")}
      </button>
      <StashLink
        sceneId={clip.sceneId}
        at={() => sceneSpotInPlayer(getState().present, getState().ui, clip.sceneId, transport.time)}
        title={t("This clip's scene in Stash in a new tab, at the spot the PMV player shows – add a marker there, say; the editor picks the change up when you come back")}
      />
    </>
  );
}

/** One line under the bar: what the clip actions are doing, and the offer to skip a removed scene for good. */
export function ClipNotice() {
  const { state, dispatch } = useEditor();
  const { clipTask, sceneOut: out } = state.ui;
  const [tagging, setTagging] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  if (!clipTask && !out) return null;
  const never = async () => {
    if (!out) return;
    setTagging({ busy: true, error: null });
    try {
      await skipForever(out.sceneId);
      dispatch({ type: "ui", patch: { sceneOut: { ...out, tagged: true } } });
      setTagging({ busy: false, error: null });
    } catch (e) {
      setTagging({ busy: false, error: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <div className="pmv-tl-notice">
      {out && (
        <span>
          ⊘{" "}
          {out.tagged
            ? t("“{title}” is never used again (Stash tag “{tag}” – the scene on the left takes it off again).", { title: out.title, tag: SKIP_TAG })
            : `${t("“{title}” is out of this PMV", { title: out.title })} – ${tn(out.replaced, "{n} clips replaced", "1 clip replaced")}.`}{" "}
          {!out.tagged && (
            <button className="btn btn-sm btn-secondary" disabled={tagging.busy} title={t("Gives the scene the Stash tag “{tag}” – no generator run uses it again, in any project", { tag: SKIP_TAG })} onClick={() => void never()}>
              {t("Never use it again")}
            </button>
          )}{" "}
          {tagging.error && <span className="pmv-error">⚠ {tagging.error}</span>}
        </span>
      )}
      {clipTask && <span className={clipTask.error ? "pmv-error" : "pmv-li-meta"}>{clipTask.error ? "⚠ " : "⏳ "}{clipTask.text}</span>}
      <span className="pmv-spacer" />
      <button className="btn btn-sm btn-link" title={t("Close")} onClick={() => dispatch({ type: "ui", patch: { clipTask: null, sceneOut: null } })}>
        ✕
      </button>
    </div>
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
