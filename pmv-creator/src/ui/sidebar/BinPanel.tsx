/** The culled selection ("bin"): drag to the timeline, append, replace, reorder, generate from it. */
import React, { useMemo, useState } from "react";
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
  const [query, setQuery] = useState("");
  const scenes = useScenes([...new Set(project.bin.map((s) => s.sceneId))]);
  const searching = query.trim().length > 0;
  const visible = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return project.bin.map((s, i) => ({ s, i })).filter(({ s }) => {
      const source = project.sources[s.sceneId];
      const scene = scenes[s.sceneId];
      const text = [s.label, s.sceneId, ...s.tags, source?.title, source?.path, scene?.title,
        scene?.studio?.name, ...(scene?.performers.map((p) => p.name) ?? []),
        ...(scene?.tags.map((tag) => tag.name) ?? [])].join(" ").toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }, [project.bin, project.sources, scenes, query]);
  const total = visible.reduce((n, { s }) => n + (s.out - s.in), 0);

  const append = (s: Snippet) => {
    const action = insertAction(project, ui, s, transport.time);
    if (!action) return;
    dispatch(action);
    if (action.type === "clip/insert") transport.seek(action.clip.start + action.clip.duration);
  };

  return (
    <div className="pmv-panel">
      <div className="pmv-li-meta">{t("Saved selection for project: {name}", { name: project.name })}</div>
      <div className="pmv-row">
        <input
          type="search"
          className="form-control form-control-sm"
          aria-label={t("Search My clips")}
          placeholder={t("Clip, video, tag or performer…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        {query && <button className="btn btn-sm btn-secondary" title={t("Clear search")} onClick={() => setQuery("")}>✕</button>}
      </div>
      <div className="pmv-row">
        <span className="pmv-li-meta" role="status">
          {searching ? t("{shown} of {total} clips", { shown: visible.length, total: project.bin.length }) : tn(project.bin.length, "{n} clips", "1 clip")} · {formatTime(total)}
        </span>
        <span className="pmv-spacer" />
        <button
          className="btn btn-sm btn-secondary"
          disabled={!project.bin.length}
          title={t("Open the generator with all clips saved in this project")}
          onClick={() => dispatch({ type: "ui", patch: { generator: { source: "bin" } } })}
        >
          ⚡ {t("Generate from these")}
        </button>
      </div>
      {searching && <div className="pmv-li-meta">{t("Search filters this list. The generator still uses all saved clips.")}</div>}
      <details className="pmv-li-meta">
        <summary>{t("Where do these clips come from?")}</summary>
        <p>{t("Markers and ranges you add are saved here. Generator runs also add their used segments when “Used segments into My clips” is enabled (on by default).")}</p>
        <p>{t("Generating again keeps the saved selection. A new project starts empty; duplicated projects and batch projects using project material inherit the selection.")}</p>
      </details>
      <ul className="pmv-list">
        {project.bin.length === 0 && <li className="pmv-empty">{t("Empty. Open a scene under “Scenes” and pick markers (+) or ranges (I/O, Shift+drag).")}</li>}
        {project.bin.length > 0 && visible.length === 0 && <li className="pmv-empty">{t("No clips match your search.")}</li>}
        {visible.map(({ s, i }) => {
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
