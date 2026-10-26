import React, { useCallback, useState } from "react";
import { isSourceUsed, parseSceneIdInput, sceneToSource } from "../../culling/culling";
import { t, tn } from "../../i18n";
import type { SourceMedia } from "../../model/project";
import { stashUrl } from "../../stash/graphql";
import { type SceneSearch, type SceneSort, fetchScenes, findPerformers, findTags, searchScenes } from "../../stash/queries";
import { primeScenes } from "../../stash/sceneCache";
import { type StashRef, type StashScene, sceneTitle } from "../../stash/types";
import { useEditor } from "../../state/store";
import { formatTime } from "../../timeline/time";
import { RefPicker } from "../common";
import { endSnippetDrag, startSceneDrag, wholeSceneAction } from "../editing";
import { clipsOfScene } from "../monitor";
import { StashLink } from "./StashLink";

const PER_PAGE = 30;

export function SceneBrowser() {
  const { state, dispatch, transport } = useEditor();
  const project = state.present;
  const [q, setQ] = useState("");
  const [tags, setTags] = useState<StashRef[]>([]);
  const [performers, setPerformers] = useState<StashRef[]>([]);
  const [hasMarkers, setHasMarkers] = useState(false);
  const [sort, setSort] = useState<SceneSort>("date");
  const [seed, setSeed] = useState(1);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<{ count: number; scenes: StashScene[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [poolOpen, setPoolOpen] = useState(true);

  const run = async (nextPage = 1) => {
    const search: SceneSearch = { q, tagIds: tags.map((x) => x.id), performerIds: performers.map((p) => p.id), hasMarkers, sort, seed, page: nextPage, perPage: PER_PAGE };
    setBusy(true);
    setError(null);
    try {
      const r = await searchScenes(search);
      primeScenes(r.scenes);
      setResult(r);
      setPage(nextPage);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const swapFrom = state.ui.swapFrom;
  const swapCount = swapFrom ? clipsOfScene(project, swapFrom) : 0;
  /** While picking for "replace all", a click puts the scene into every clip of the old one. */
  const pick = (src: SourceMedia | null) => {
    if (!swapFrom || !src || src.sceneId === swapFrom) return;
    dispatch({ type: "scene/swap", from: swapFrom, to: src.sceneId, label: src.title, sources: [src] });
    dispatch({ type: "ui", patch: { swapFrom: null } });
  };
  const open = (id: string) => dispatch({ type: "ui", patch: { activeSceneId: id, activeSceneSeek: 0 } });
  const addToPool = (s: StashScene) => {
    const src = sceneToSource(s);
    if (src) dispatch({ type: "sources/add", sources: [src] });
  };
  /** The whole scene onto the timeline at the playhead; the playhead moves to its end, so the next scene follows. */
  const toTimeline = (src: SourceMedia | null) => {
    const action = src && wholeSceneAction(project, state.ui, src, transport.time);
    if (!action) return;
    dispatch(action);
    if (action.type === "clip/insert") transport.seek(action.clip.start + action.clip.duration);
  };
  const dragStart = (e: React.DragEvent, src: SourceMedia | null) => {
    if (!src) return e.preventDefault();
    startSceneDrag(src);
    e.dataTransfer.setData("text/plain", src.sceneId);
    e.dataTransfer.effectAllowed = "copy";
  };
  const rowTitle = (inSwap: boolean) => (inSwap ? t("Replace with this scene") : t("Click: open the scene · drag: the whole scene onto the timeline"));
  const timelineButton = (src: SourceMedia | null) => (
    <button
      className="btn btn-sm btn-secondary"
      title={t("The whole scene onto the timeline at the playhead – press it on the next scene and that one follows")}
      onClick={(e) => {
        e.stopPropagation();
        toTimeline(src);
      }}
    >
      → {t("Timeline")}
    </button>
  );
  const pool = Object.values(project.sources);
  const searchTags = useCallback(findTags, []);
  const searchPerformers = useCallback(findPerformers, []);

  const [idInput, setIdInput] = useState("");
  const [idStatus, setIdStatus] = useState<string | null>(null);
  const addById = async () => {
    const { ids, invalid } = parseSceneIdInput(idInput);
    if (!ids.length) {
      setIdStatus(invalid.length ? t("No valid scene id: {list}", { list: invalid.join(", ") }) : null);
      return;
    }
    setIdStatus(t("Loading…"));
    try {
      const scenes = await fetchScenes(ids);
      primeScenes(scenes);
      const sources = scenes.map(sceneToSource).filter((s): s is SourceMedia => !!s);
      const known = sources.filter((s) => project.sources[s.sceneId]).length;
      if (sources.length) dispatch({ type: "sources/add", sources });
      const found = new Set(scenes.map((s) => s.id));
      const missing = ids.filter((id) => !found.has(id));
      const noFile = scenes.filter((s) => !s.files.length).map((s) => s.id);
      const parts = [
        sources.length - known > 0 && t("{n} added", { n: sources.length - known }),
        known > 0 && t("{n} already in the project", { n: known }),
        missing.length > 0 && t("not found: {list}", { list: missing.join(", ") }),
        noFile.length > 0 && t("without a file: {list}", { list: noFile.join(", ") }),
        invalid.length > 0 && t("invalid: {list}", { list: invalid.join(", ") }),
      ].filter(Boolean);
      setIdStatus(parts.join(" · "));
      // keep only what still needs attention in the field
      setIdInput([...missing, ...invalid].join(", "));
      setPoolOpen(true);
      if (ids.length === 1 && sources.length === 1) open(ids[0]);
    } catch (e) {
      setIdStatus(String(e));
    }
  };

  return (
    <div className="pmv-panel">
      {swapFrom && (
        <div className="pmv-swap-pick">
          <span>{t("Pick the scene that replaces all {n} clips of “{title}” – places and lengths stay, Ctrl+Z undoes it.", { n: swapCount, title: project.sources[swapFrom]?.title ?? swapFrom })}</span>
          <button className="btn btn-sm btn-link" title={t("Cancel replacing")} onClick={() => dispatch({ type: "ui", patch: { swapFrom: null } })}>
            ✕
          </button>
        </div>
      )}
      <section>
        <button className="pmv-section-head" onClick={() => setPoolOpen(!poolOpen)}>
          {poolOpen ? "▾" : "▸"} {t("Project scenes")} ({pool.length})
        </button>
        {poolOpen && (
          <ul className="pmv-list">
            {pool.length === 0 && <li className="pmv-empty">{t("No scenes yet. Search below and add them with + – or let the generator pick them.")}</li>}
            {pool.map((s) => (
              <li
                key={s.sceneId}
                className={`pmv-list-item ${swapFrom ? (s.sceneId === swapFrom ? "is-excluded" : "is-pickable") : ""}`}
                title={rowTitle(!!swapFrom && s.sceneId !== swapFrom)}
                draggable={!swapFrom}
                onDragStart={(e) => dragStart(e, s)}
                onDragEnd={endSnippetDrag}
                onClick={() => (swapFrom ? pick(s) : open(s.sceneId))}
              >
                <div className="pmv-li-main">
                  <div className="pmv-li-title">{s.title}</div>
                  <div className="pmv-li-meta">
                    {formatTime(s.duration)} · {s.width}×{s.height}
                    {project.bin.some((b) => b.sceneId === s.sceneId) && ` · ${tn(project.bin.filter((b) => b.sceneId === s.sceneId).length, "{n} clips", "1 clip")}`}
                  </div>
                </div>
                {!swapFrom && (
                  <div className="pmv-li-actions is-col">
                    {timelineButton(s)}
                    <StashLink sceneId={s.sceneId} />
                  </div>
                )}
                {!isSourceUsed(project, s.sceneId) && (
                  <button
                    className="btn btn-sm btn-link"
                    title={t("Remove from the project")}
                    onClick={(e) => {
                      e.stopPropagation();
                      dispatch({ type: "sources/remove", sceneId: s.sceneId });
                    }}
                  >
                    ✕
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <form
          className="pmv-row"
          onSubmit={(e) => {
            e.preventDefault();
            void addById();
          }}
        >
          <input
            className="form-control form-control-sm"
            placeholder={t("Scene id(s) or Stash link, e.g. 123, 456")}
            value={idInput}
            onChange={(e) => setIdInput(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            title={t("Separate several ids with commas/spaces; links like …/scenes/123 are recognised")}
          />
          <button className="btn btn-sm btn-secondary" type="submit" disabled={!idInput.trim()}>
            + ID
          </button>
        </form>
        {idStatus && <div className="pmv-li-meta">{idStatus}</div>}
      </section>

      <section className="pmv-search">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(1);
          }}
        >
          <input className="form-control form-control-sm" placeholder={t("Search (title, path …)")} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <RefPicker placeholder={t("Tags (all)")} value={tags} onChange={setTags} search={searchTags} />
          <RefPicker placeholder={t("Performers (all)")} value={performers} onChange={setPerformers} search={searchPerformers} />
          <div className="pmv-row">
            {state.ui.advanced && (
              <label className="pmv-check">
                <input type="checkbox" checked={hasMarkers} onChange={(e) => setHasMarkers(e.target.checked)} /> {t("with markers only")}
              </label>
            )}
            <select className="form-control form-control-sm" value={sort} onChange={(e) => setSort(e.target.value as SceneSort)}>
              <option value="date">{t("Date")}</option>
              <option value="created_at">{t("Added")}</option>
              <option value="rating">{t("Rating")}</option>
              <option value="title">{t("Title")}</option>
              <option value="duration">{t("Duration")}</option>
              <option value="random">{t("Random (seed)")}</option>
            </select>
            {sort === "random" && <input className="form-control form-control-sm pmv-seed" type="number" value={seed} onChange={(e) => setSeed(+e.target.value || 0)} title={t("Seed: same number = same order")} />}
            <button className="btn btn-sm btn-primary" type="submit" disabled={busy}>
              {busy ? "…" : t("Search")}
            </button>
          </div>
        </form>
        {error && <div className="pmv-error">{error}</div>}
        {result && (
          <>
            <div className="pmv-li-meta">{tn(result.count, "{n} results", "1 result")}</div>
            <ul className="pmv-list">
              {result.scenes.map((s) => {
                const inPool = !!project.sources[s.id];
                return (
                  <li
                    key={s.id}
                    className={`pmv-list-item ${swapFrom ? (s.id === swapFrom ? "is-excluded" : "is-pickable") : ""}`}
                    title={rowTitle(!!swapFrom && s.id !== swapFrom)}
                    draggable={!swapFrom}
                    onDragStart={(e) => dragStart(e, sceneToSource(s))}
                    onDragEnd={endSnippetDrag}
                    onClick={() => (swapFrom ? pick(sceneToSource(s)) : open(s.id))}
                  >
                    {s.paths.screenshot && <img className="pmv-li-img" src={stashUrl(s.paths.screenshot)} alt="" loading="lazy" />}
                    <div className="pmv-li-main">
                      <div className="pmv-li-title">{sceneTitle(s)}</div>
                      <div className="pmv-li-meta">
                        {formatTime(s.files[0]?.duration ?? 0)} · {tn(s.scene_markers.length, "{n} markers", "1 marker")}
                        {s.performers.length > 0 && ` · ${s.performers.map((p) => p.name).join(", ")}`}
                      </div>
                    </div>
                    {!swapFrom && (
                      <div className="pmv-li-actions is-col">
                        <button
                          className={`btn btn-sm ${inPool ? "btn-success" : "btn-secondary"}`}
                          title={inPool ? t("In the project – the generator may pick it") : t("Into the project – the generator picks from these scenes, and they are listed under “Project scenes”")}
                          disabled={inPool}
                          onClick={(e) => {
                            e.stopPropagation();
                            addToPool(s);
                          }}
                        >
                          {inPool ? "✓" : "+"} {t("Project")}
                        </button>
                        {timelineButton(sceneToSource(s))}
                      </div>
                    )}
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
      </section>
    </div>
  );
}
