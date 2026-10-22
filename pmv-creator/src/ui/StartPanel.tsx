/** Shown in the preview while the timeline is empty: the three steps to a PMV, with the first two as buttons. */
import React, { useRef } from "react";
import { t, tn } from "../i18n";
import { useEditor } from "../state/store";
import { useMusic } from "./music";
import { SongLibraryButton } from "./SongLibrary";

export function StartPanel() {
  const { state, dispatch } = useEditor();
  const p = state.present;
  const music = useMusic();
  const fileRef = useRef<HTMLInputElement>(null);
  const scenes = Object.keys(p.sources).length;
  return (
    <div className="pmv-start" onClick={(e) => e.stopPropagation()}>
      <div className="pmv-start-title">{t("A PMV in three steps")}</div>
      <ol className="pmv-start-steps">
        <li className={p.audio ? "is-done" : ""}>
          <div className="pmv-start-h">{t("Music")}</div>
          {p.audio ? (
            <div className="pmv-li-meta">
              ✓ {p.audio.name} · {Math.round(p.beatGrid.bpm * 10) / 10} BPM
            </div>
          ) : (
            <div className="pmv-li-meta">{t("The song sets the length and the beat the clips are cut to.")}</div>
          )}
          <div className="pmv-row pmv-wrap">
            <input ref={fileRef} type="file" accept="audio/*" className="pmv-hidden" onChange={(e) => e.target.files?.[0] && void music.upload(e.target.files[0])} />
            <button className={`btn btn-sm ${p.audio ? "btn-secondary" : "btn-primary"}`} disabled={!music.online} onClick={() => fileRef.current?.click()}>
              {p.audio ? t("Other song…") : t("Upload song…")}
            </button>
            {music.online && <SongLibraryButton current={p.audio?.name} onPick={(s) => void music.adoptSong(s)} />}
            {music.status && <span className="pmv-li-meta">{music.status}</span>}
          </div>
          {!music.online && <div className="pmv-li-meta">{t("Backend unreachable – Stash needs Python for this plugin (Settings → System → Python path).")}</div>}
        </li>
        <li>
          <div className="pmv-start-h">{t("Clips")}</div>
          <div className="pmv-li-meta">{t("The generator picks clips by tags and performers and cuts them to the beat – or pick scenes on the left yourself.")}</div>
          <div className="pmv-row pmv-wrap">
            <button className={`btn btn-sm ${p.audio ? "btn-primary" : "btn-secondary"}`} onClick={() => dispatch({ type: "ui", patch: { generator: {} } })}>
              ⚡ {t("Generate PMV")}
            </button>
            {state.ui.clipPreset && <span className="pmv-li-meta">{t("with {name}", { name: state.ui.clipPreset.label })}</span>}
            {scenes > 0 && <span className="pmv-li-meta">{tn(scenes, "{n} scenes in the project", "1 scene in the project")}</span>}
          </div>
        </li>
        <li>
          <div className="pmv-start-h">{t("Fine-tune & render")}</div>
          <div className="pmv-li-meta">{t("Click a clip to see and change it, drag it to move it – then Render (top right). Everything can be undone with Ctrl+Z.")}</div>
        </li>
      </ol>
    </div>
  );
}
