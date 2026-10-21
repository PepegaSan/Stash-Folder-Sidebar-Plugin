/** Library-wide marker search: "all markers tagged X" straight into the bin. */
import React, { useCallback, useState } from "react";
import { isMarkerExcluded, isMarkerInBin, sceneToSource, snippetFromMarker } from "../../culling/culling";
import { t, tn } from "../../i18n";
import type { SourceMedia } from "../../model/project";
import { stashUrl } from "../../stash/graphql";
import { findTags, searchMarkers } from "../../stash/queries";
import { type StashMarkerWithScene, type StashRef, markerLabel, sceneTitle } from "../../stash/types";
import { useEditor } from "../../state/store";
import { formatTime } from "../../timeline/time";
import { RefPicker } from "../common";

const PER_PAGE = 50;

export function MarkerBrowser() {
  const { state, dispatch } = useEditor();
  const project = state.present;
  const [q, setQ] = useState("");
  const [tags, setTags] = useState<StashRef[]>([]);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ count: number; markers: StashMarkerWithScene[] } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const searchTags = useCallback(findTags, []);

  const run = async (nextPage = 1) => {
    setBusy(true);
    setError(null);
    try {
      setResult(await searchMarkers({ q, tagIds: tags.map((x) => x.id), page: nextPage, perPage: PER_PAGE }));
      setPage(nextPage);
      setChecked(new Set());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const addToBin = (markers: StashMarkerWithScene[]) => {
    const usable = markers.filter((m) => !isMarkerInBin(project, m.id) && !isMarkerExcluded(project, m.id));
    if (!usable.length) return;
    const sources = usable.map((m) => sceneToSource(m.scene)).filter((s): s is SourceMedia => !!s);
    const snippets = usable.map((m) => snippetFromMarker(m, m.scene.id, m.scene.files[0]?.duration ?? 0, state.ui.markerDefaultLength));
    dispatch({ type: "bin/add", snippets, sources });
    setChecked(new Set());
  };

  const toggle = (id: string) => {
    const next = new Set(checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setChecked(next);
  };

  return (
    <div className="pmv-panel">
      <form
        className="pmv-search"
        onSubmit={(e) => {
          e.preventDefault();
          void run(1);
        }}
      >
        <input className="form-control form-control-sm" placeholder={t("Marker title …")} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        <RefPicker placeholder={t("Marker tags (any of them)")} value={tags} onChange={setTags} search={searchTags} />
        <button className="btn btn-sm btn-primary" type="submit" disabled={busy}>
          {busy ? "…" : t("Search markers")}
        </button>
      </form>
      {error && <div className="pmv-error">{error}</div>}
      {result && (
        <>
          <div className="pmv-row">
            <span className="pmv-li-meta">{tn(result.count, "{n} markers", "1 marker")}</span>
            <span className="pmv-spacer" />
            <button className="btn btn-sm btn-primary" disabled={!checked.size} onClick={() => addToBin(result.markers.filter((m) => checked.has(m.id)))}>
              {t("Checked")} + ({checked.size})
            </button>
            <button className="btn btn-sm btn-secondary" onClick={() => addToBin(result.markers)}>
              {t("Page")} +
            </button>
          </div>
          <ul className="pmv-list">
            {result.markers.map((m) => {
              const inBin = isMarkerInBin(project, m.id);
              const excluded = isMarkerExcluded(project, m.id);
              return (
                <li key={m.id} className={`pmv-list-item ${inBin ? "is-picked" : ""} ${excluded ? "is-excluded" : ""}`} onClick={() => dispatch({ type: "ui", patch: { activeSceneId: m.scene.id, activeSceneSeek: m.seconds } })}>
                  <input type="checkbox" checked={checked.has(m.id)} disabled={inBin || excluded} onClick={(e) => e.stopPropagation()} onChange={() => toggle(m.id)} />
                  {m.screenshot && <img className="pmv-li-img" src={stashUrl(m.screenshot)} alt="" loading="lazy" />}
                  <div className="pmv-li-main">
                    <div className="pmv-li-title">{markerLabel(m)}</div>
                    <div className="pmv-li-meta">
                      {sceneTitle(m.scene)} · {formatTime(m.seconds)}
                      {m.end_seconds != null && ` – ${formatTime(m.end_seconds)}`}
                    </div>
                  </div>
                  {inBin && <span className="pmv-badge">✓</span>}
                </li>
              );
            })}
          </ul>
          <div className="pmv-row pmv-pager">
            <button className="btn btn-sm btn-secondary" disabled={page <= 1 || busy} onClick={() => void run(page - 1)}>
              ‹
            </button>
            <span>{t("Page {page} / {pages}", { page, pages: Math.max(1, Math.ceil(result.count / PER_PAGE)) })}</span>
            <button className="btn btn-sm btn-secondary" disabled={page * PER_PAGE >= result.count || busy} onClick={() => void run(page + 1)}>
              ›
            </button>
          </div>
        </>
      )}
    </div>
  );
}
