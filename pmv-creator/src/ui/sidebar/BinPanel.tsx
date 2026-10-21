/** The culled selection ("bin"): drag to the timeline, append, replace, reorder, generate from it. */
import React from "react";
import { overlapsExclusion } from "../../culling/culling";
import { t, tn } from "../../i18n";
import type { Snippet } from "../../model/project";
import { useScenes } from "../../stash/sceneCache";
import { useEditor } from "../../state/store";
import { formatTime } from "../../timeline/time";
import { SpriteThumb } from "../common";
import { endSnippetDrag, insertAction, startSnippetDrag } from "../editing";
import { useSprites } from "../hooks";

function SnippetThumb({ vtt, at, fallback }: { vtt: string | null | undefined; at: number; fallback: string | null | undefined }) {
  const sheet = useSprites(vtt);
  return <SpriteThumb sheet={sheet} t={at} height={36} fallback={fallback} />;
}

export function BinPanel() {
  const { state, dispatch, transport } = useEditor();
  const project = state.present;
  const ui = state.ui;
  const scenes = useScenes([...new Set(project.bin.map((s) => s.sceneId))]);
  const total = project.bin.reduce((n, s) => n + (s.out - s.in), 0);

  const append = (s: Snippet) => {
    const action = insertAction(project, ui, s, transport.time);
    if (!action) return;
    dispatch(action);
    if (action.type === "clip/insert") transport.seek(action.clip.start + action.clip.duration);
  };

  return (
    <div className="pmv-panel">
      <div className="pmv-row">
        <span className="pmv-li-meta">
          {tn(project.bin.length, "{n} snippets", "1 snippet")} · {formatTime(total)}
        </span>
        <span className="pmv-spacer" />
        <button
          className="btn btn-sm btn-secondary"
          disabled={!project.bin.length}
          title={t("Open the generator with these snippets as its source")}
          onClick={() => dispatch({ type: "ui", patch: { generator: { source: "bin" } } })}
        >
          ⚡ {t("Generate")}
        </button>
      </div>
      <ul className="pmv-list">
        {project.bin.length === 0 && <li className="pmv-empty">{t("Empty. Pick markers or ranges in a scene with +.")}</li>}
        {project.bin.map((s, i) => {
          const scene = scenes[s.sceneId];
          const excluded = overlapsExclusion(project.exclusions, s.sceneId, s.in, s.out);
          const selected = ui.selectedSnippetId === s.id;
          return (
            <li
              key={s.id}
              className={`pmv-list-item ${selected ? "is-selected" : ""} ${excluded ? "is-excluded" : ""}`}
              draggable
              onDragStart={(e) => {
                startSnippetDrag(s.id);
                e.dataTransfer.setData("text/plain", s.id);
                e.dataTransfer.effectAllowed = "copy";
              }}
              onDragEnd={endSnippetDrag}
              onClick={() => dispatch({ type: "ui", patch: { selectedSnippetId: selected ? null : s.id } })}
              onDoubleClick={() => dispatch({ type: "ui", patch: { activeSceneId: s.sceneId, activeSceneSeek: s.in } })}
              title={t("Drag: onto the timeline · double-click: open in the scene")}
            >
              <SnippetThumb vtt={scene?.paths.vtt} at={s.in} fallback={scene?.paths.screenshot} />
              <div className="pmv-li-main">
                <div className="pmv-li-title">{s.label}</div>
                <div className="pmv-li-meta">
                  {project.sources[s.sceneId]?.title ?? s.sceneId} · {formatTime(s.in)} ({(s.out - s.in).toFixed(1)} s)
                </div>
              </div>
              <div className="pmv-li-actions" onClick={(e) => e.stopPropagation()}>
                <button className="btn btn-sm btn-secondary" title={t("Insert at the playhead")} onClick={() => append(s)}>
                  →
                </button>
                <button
                  className="btn btn-sm btn-secondary"
                  title={t("Replace the selected clip (key R)")}
                  disabled={!ui.selectedClipId}
                  onClick={() => ui.selectedClipId && dispatch({ type: "clip/replace", clipId: ui.selectedClipId, snippetId: s.id })}
                >
                  ⇄
                </button>
                <button className="btn btn-sm btn-secondary" disabled={i === 0} onClick={() => dispatch({ type: "bin/reorder", snippetId: s.id, toIndex: i - 1 })}>
                  ↑
                </button>
                <button className="btn btn-sm btn-secondary" disabled={i === project.bin.length - 1} onClick={() => dispatch({ type: "bin/reorder", snippetId: s.id, toIndex: i + 1 })}>
                  ↓
                </button>
                <button className="btn btn-sm btn-link" onClick={() => dispatch({ type: "bin/remove", snippetId: s.id })}>
                  ✕
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
