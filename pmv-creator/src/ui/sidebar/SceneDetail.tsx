/**
 * Drill-down for one scene. The sidebar keeps the facts and the marker list; the player, the scrub bar
 * with markers/exclusions/keyframes and the range/clip actions are portalled into the main player area.
 */
import React, { useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  exclusionFromRange,
  isMarkerExcluded,
  isMarkerInBin,
  markerRange,
  sceneToSource,
  snippetFromMarker,
  snippetFromRange,
} from "../../culling/culling";
import { useHost } from "../../host";
import { t, tn } from "../../i18n";
import { clipEnd } from "../../model/project";
import { probeKeyframes } from "../../stash/backend";
import { stashUrl } from "../../stash/graphql";
import { invalidateScene, useScene } from "../../stash/sceneCache";
import { VideoSlot, onStreamChange } from "../../stash/streams";
import { type StashMarker, type StashScene, markerLabel, sceneTitle } from "../../stash/types";
import { useEditor } from "../../state/store";
import { type ClipSourceInput, findClip } from "../../timeline/ops";
import { clamp, formatTime } from "../../timeline/time";
import { NumField, SpriteThumb } from "../common";
import { insertAction } from "../editing";
import { useSprites } from "../hooks";
import { LocalMediaBadge } from "../localMedia";
import { SourceHostContext, sourceKeys } from "../monitor";

const nearest = (list: number[], x: number) => list.reduce((best, v) => (Math.abs(v - x) < Math.abs(best - x) ? v : best), list[0] ?? x);

export function SceneDetail({ sceneId, onBack }: { sceneId: string; onBack: () => void }) {
  const scene = useScene(sceneId);
  if (!scene) {
    return (
      <div className="pmv-panel">
        <button className="btn btn-sm btn-link" onClick={onBack}>
          ← {t("back")}
        </button>
        <div className="pmv-empty">{t("Loading scene…")}</div>
      </div>
    );
  }
  // keyed: switching scenes remounts, which resets selection, keyframes and the video slot
  return <SceneDetailView key={scene.id} scene={scene} onBack={onBack} />;
}

function SceneDetailView({ scene, onBack }: { scene: StashScene; onBack: () => void }) {
  const { state, dispatch, transport, backend } = useEditor();
  const host = useHost();
  const monitorEl = useContext(SourceHostContext);
  const project = state.present;
  const ui = state.ui;
  const sceneId = scene.id;
  const sprites = useSprites(scene.paths.vtt);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const slotRef = useRef<VideoSlot | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [time, setTime] = useState(ui.activeSceneSeek);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(true);
  const [sel, setSel] = useState<{ in: number; out: number } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [keyframes, setKeyframes] = useState<number[] | null>(null);
  const [kfState, setKfState] = useState<string | null>(null);
  const [snapKf, setSnapKf] = useState(false);
  const shown = !!monitorEl && ui.sceneInPlayer;

  // the <video> lives in the main player (portal): bind a slot whenever that element appears
  useEffect(() => {
    if (!videoEl) return;
    const slot = new VideoSlot(videoEl);
    slotRef.current = slot;
    slot.assign(scene, time);
    const onTime = () => setTime(slot.time);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    videoEl.addEventListener("timeupdate", onTime);
    videoEl.addEventListener("seeked", onTime);
    videoEl.addEventListener("play", onPlay);
    videoEl.addEventListener("pause", onPause);
    return () => {
      videoEl.removeEventListener("timeupdate", onTime);
      videoEl.removeEventListener("seeked", onTime);
      videoEl.removeEventListener("play", onPlay);
      videoEl.removeEventListener("pause", onPause);
      slot.dispose();
      slotRef.current = null;
    };
    // only the element: the component is keyed by scene id
  }, [videoEl]);

  // PC ↔ Stash: the same spot from the new source
  useEffect(() => onStreamChange(() => slotRef.current?.sceneId && slotRef.current.assign(scene, slotRef.current.time)), []);

  // the scene replaces the PMV preview in the main player – only one of them plays
  useEffect(() => {
    if (shown) transport.pause();
    else videoEl?.pause();
  }, [shown, videoEl, transport]);

  const file = scene.files[0];
  const duration = file?.duration ?? 0;
  const fps = file?.frame_rate || 30;
  const source = sceneToSource(scene);
  const pct = (x: number) => `${duration > 0 ? (x / duration) * 100 : 0}%`;
  const now = () => slotRef.current?.time ?? time;
  const seek = (x: number) => {
    const to = clamp(x, 0, duration);
    slotRef.current?.seek(to);
    setTime(to);
  };
  const pick = (x: number) => (snapKf && keyframes?.length ? nearest(keyframes, x) : x);
  const timeAt = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, ((clientX - r.left) / r.width) * duration));
  };
  const togglePlay = () => (playing ? videoEl?.pause() : void videoEl?.play());
  /** From the sidebar (marker list): seek and bring the scene to the front. */
  const showAt = (x: number) => {
    if (!ui.sceneInPlayer) dispatch({ type: "ui", patch: { sceneInPlayer: true } });
    seek(x);
  };
  const markIn = () => {
    const x = pick(now());
    setSel((s) => ({ in: x, out: Math.max(x + 0.1, s?.out ?? Math.min(duration, x + ui.markerDefaultLength)) }));
  };
  const markOut = () => {
    const x = pick(now());
    setSel((s) => ({ in: Math.min(s?.in ?? Math.max(0, x - ui.markerDefaultLength), x - 0.1), out: x }));
  };

  // opening this scene again (another clip, marker, …) jumps to the requested spot
  const request = useRef(ui.sceneRequest);
  useEffect(() => {
    if (request.current === ui.sceneRequest) return;
    request.current = ui.sceneRequest;
    seek(ui.activeSceneSeek);
  }, [ui.sceneRequest]);

  // while the scene is in the main player it gets Space, I/O, ←/→ and Esc; the rest stays with the timeline
  const keys = useRef<(key: string, e: KeyboardEvent) => boolean>(() => false);
  keys.current = (key, e) => {
    if (e.altKey) return false; // Alt+←/→ nudges the selected timeline clip
    switch (key) {
      case " ":
        togglePlay();
        return true;
      case "i":
        markIn();
        return true;
      case "o":
        markOut();
        return true;
      case "ArrowLeft":
      case "ArrowRight":
        seek(now() + (key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 1 : 1 / fps));
        return true;
      case "Escape":
        dispatch({ type: "ui", patch: { sceneInPlayer: false } });
        return true;
      default:
        return false;
    }
  };
  useEffect(() => {
    if (!shown) return;
    const handle = (key: string, e: KeyboardEvent) => keys.current(key, e);
    sourceKeys.handle = handle;
    return () => {
      if (sourceKeys.handle === handle) sourceKeys.handle = null;
    };
  }, [shown]);

  const markers = [...scene.scene_markers].sort((a, b) => a.seconds - b.seconds);
  const exclusions = project.exclusions.filter((x) => x.sceneId === sceneId);
  const snippets = project.bin.filter((s) => s.sceneId === sceneId);
  const sources = source ? [source] : [];

  const addMarker = (m: StashMarker) => dispatch({ type: "bin/add", snippets: [snippetFromMarker(m, sceneId, duration, ui.markerDefaultLength)], sources });
  const toggleExclude = (m: StashMarker) => {
    const existing = project.exclusions.find((x) => x.markerId === m.id);
    if (existing) dispatch({ type: "exclusion/remove", exclusionId: existing.id });
    else {
      const [a, b] = markerRange(m, duration, ui.markerDefaultLength);
      dispatch({ type: "exclusion/add", exclusion: exclusionFromRange(sceneId, a, b, m.id), sources });
    }
  };
  const selLabel = () => `${sceneTitle(scene)} @ ${formatTime(sel!.in)}`;
  const selectionToBin = () => sel && dispatch({ type: "bin/add", snippets: [snippetFromRange(sceneId, sel.in, sel.out, selLabel())], sources });
  const selectionToTimeline = () => {
    if (!sel) return;
    const s = snippetFromRange(sceneId, sel.in, sel.out, selLabel());
    dispatch({ type: "bin/add", snippets: [s], sources });
    const action = insertAction({ ...project, sources: { ...project.sources, ...(source ? { [sceneId]: source } : {}) } }, ui, s, transport.time);
    if (action) dispatch(action);
  };
  // ---- the clip selected on the timeline: other material, same slot (A → B on the timeline stays)
  const selected = ui.selectedClipId ? findClip(project, ui.selectedClipId)?.clip ?? null : null;
  const linked = selected && selected.sceneId === sceneId ? selected : null;
  const clipLen = linked ? linked.duration * linked.speed : 0;
  const [dragIn, setDragIn] = useState<number | null>(null);
  const dragRef = useRef<{ x0: number; in0: number; width: number; value: number } | null>(null);
  const clipIn = dragIn ?? linked?.sourceIn ?? 0;
  const setSource = (src: Omit<ClipSourceInput, "sceneId">, fit = false) =>
    selected && dispatch({ type: "clip/source", clipId: selected.id, source: { sceneId, ...src }, fit, sources });
  const fitSpeed = selected && sel ? Math.abs(sel.out - sel.in) / selected.duration : 1;
  /** How often the selected clip's scene is in the PMV – all of them can get this scene at once. */
  const sameScene = selected ? project.tracks.reduce((n, tr) => n + tr.clips.filter((c) => c.sceneId === selected.sceneId).length, 0) : 0;

  const loadKeyframes = async () => {
    if (!file) return;
    setKfState(t("loading…"));
    try {
      const kf = await probeKeyframes(file.path);
      setKeyframes(kf);
      setKfState(tn(kf.length, "{n} keyframes", "1 keyframe"));
    } catch (e) {
      setKfState(String(e));
    }
  };

  const player = (
    <div className="pmv-src">
      <div className="pmv-src-video" onClick={togglePlay}>
        <video ref={setVideoEl} muted={muted} playsInline preload="metadata" />
      </div>

      <div className="pmv-filmstrip">
        {Array.from({ length: 16 }, (_, i) => {
          const x = ((i + 0.5) / 16) * duration;
          return (
            <button key={i} onClick={() => seek(x)} title={formatTime(x)}>
              <SpriteThumb sheet={sprites} t={x} height={40} fallback={i === 0 ? scene.paths.screenshot : null} />
            </button>
          );
        })}
      </div>

      <div
        className="pmv-scrub"
        ref={barRef}
        onPointerDown={(e) => {
          e.preventDefault(); // shift+drag must not extend a text selection
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
          const x = timeAt(e.clientX);
          if (e.shiftKey) setSel({ in: pick(x), out: pick(x) });
          else seek(x);
        }}
        onPointerMove={(e) => {
          const x = timeAt(e.clientX);
          setHover(x);
          if (e.buttons !== 1) return;
          if (e.shiftKey && sel) setSel({ in: sel.in, out: pick(x) });
          else if (!e.shiftKey) seek(x);
        }}
        onPointerLeave={() => setHover(null)}
        title={t("Click/drag: scrub · Shift+drag: pick a range")}
      >
        {exclusions.map((x) => (
          <div key={x.id} className="pmv-scrub-excl" style={{ left: pct(x.in), width: pct(x.out - x.in) }} />
        ))}
        {markers.map((m) => {
          const [a, b] = markerRange(m, duration, ui.markerDefaultLength);
          return <div key={m.id} className={`pmv-scrub-marker ${isMarkerInBin(project, m.id) ? "is-picked" : ""}`} style={{ left: pct(a), width: pct(b - a) }} title={markerLabel(m)} />;
        })}
        {snippets.map((s) => (
          <div key={s.id} className="pmv-scrub-snip" style={{ left: pct(s.in), width: pct(s.out - s.in) }} />
        ))}
        {keyframes?.map((k, i) => <div key={i} className="pmv-scrub-kf" style={{ left: pct(k) }} />)}
        {sel && <div className="pmv-scrub-sel" style={{ left: pct(Math.min(sel.in, sel.out)), width: pct(Math.abs(sel.out - sel.in)) }} />}
        {linked && (
          <div
            className={`pmv-scrub-clip ${dragIn !== null ? "is-dragging" : ""}`}
            style={{ left: pct(clipIn), width: pct(clipLen) }}
            title={t("Selected clip – drag: another part, its place on the timeline stays")}
            onPointerDown={(e) => {
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              dragRef.current = { x0: e.clientX, in0: linked.sourceIn, width: barRef.current!.getBoundingClientRect().width || 1, value: linked.sourceIn };
            }}
            onPointerMove={(e) => {
              e.stopPropagation();
              const d = dragRef.current;
              if (!d) return;
              d.value = pick(clamp(d.in0 + ((e.clientX - d.x0) / d.width) * duration, 0, Math.max(0, duration - clipLen)));
              setDragIn(d.value);
              seek(d.value);
            }}
            onPointerUp={(e) => {
              e.stopPropagation();
              const d = dragRef.current;
              dragRef.current = null;
              setDragIn(null);
              if (d && Math.abs(d.value - d.in0) > 1e-3) dispatch({ type: "clip/slip", clipId: linked.id, sourceIn: d.value });
            }}
          />
        )}
        <div className="pmv-scrub-head" style={{ left: pct(time) }} />
        {hover !== null && (
          <div className="pmv-scrub-hover" style={{ left: pct(hover) }}>
            <SpriteThumb sheet={sprites} t={hover} height={90} />
            <span>{formatTime(hover)}</span>
          </div>
        )}
      </div>

      <div className="pmv-src-controls">
        <button className="btn btn-sm btn-secondary" title={t("1 frame back (←)")} onClick={() => seek(now() - 1 / fps)}>
          ‹
        </button>
        <button className="btn btn-sm btn-primary pmv-play" title={t("Play/pause (Space)")} onClick={togglePlay}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button className="btn btn-sm btn-secondary" title={t("1 frame forward (→)")} onClick={() => seek(now() + 1 / fps)}>
          ›
        </button>
        <button className="btn btn-sm btn-secondary" onClick={() => setMuted(!muted)} title={t("Sound")}>
          {muted ? "🔇" : "🔊"}
        </button>
        <span className="pmv-mono">
          {formatTime(time)} / {formatTime(duration)}
        </span>
        <button className="btn btn-sm btn-secondary" title={t("Range starts here – in point (I)")} onClick={markIn}>
          I
        </button>
        <button className="btn btn-sm btn-secondary" title={t("Range ends here – out point (O)")} onClick={markOut}>
          O
        </button>
        {!sel && <span className="pmv-li-meta">{t("I / O or Shift+drag on the bar picks a range")}</span>}
        <LocalMediaBadge />
        {ui.advanced && (
          <>
            <button className="btn btn-sm btn-secondary" disabled={backend !== "online"} onClick={() => void loadKeyframes()} title={t("I-frames via ffprobe (backend)")}>
              {t("Load keyframes")}
            </button>
            <label className="pmv-check">
              <input type="checkbox" checked={snapKf} disabled={!keyframes} onChange={(e) => setSnapKf(e.target.checked)} /> {t("Snap I/O")}
            </label>
            {kfState && <span className="pmv-li-meta">{kfState}</span>}
          </>
        )}
      </div>

      {(selected || sel) && (
        <div className="pmv-src-actions">
          {selected && (
            <div className="pmv-clip-link">
              <div className="pmv-li-meta">
                <strong>{t("Selected clip")}</strong> · {t("timeline {from} → {to} stays", { from: formatTime(selected.start), to: formatTime(clipEnd(selected)) })}
                {linked ? ` · ${t("source {from} – {to}", { from: formatTime(clipIn), to: formatTime(clipIn + clipLen) })}` : ` · ${t("comes from “{title}”", { title: project.sources[selected.sceneId]?.title ?? selected.sceneId })}`}
              </div>
              <div className="pmv-row pmv-wrap">
                <button
                  className="btn btn-sm btn-primary"
                  title={linked ? t("The clip starts at the player position – place and length on the timeline stay") : t("Put this scene from the player position into the clip – place and length on the timeline stay")}
                  onClick={() => setSource({ sourceIn: pick(now()), markerId: null, label: linked ? undefined : sceneTitle(scene) })}
                >
                  {linked ? t("Start clip here") : t("Use this scene here")}
                </button>
                {!linked && sameScene > 1 && (
                  <button
                    className="btn btn-sm btn-primary"
                    title={t("Every clip of “{title}” gets this scene: places and lengths on the timeline stay, each clip takes the same relative spot here. One step – Ctrl+Z undoes it.", { title: project.sources[selected.sceneId]?.title ?? selected.sceneId })}
                    onClick={() => dispatch({ type: "scene/swap", from: selected.sceneId, to: sceneId, label: sceneTitle(scene), sources })}
                  >
                    ⇄ {t("Use it in all {n} clips of that scene", { n: sameScene })}
                  </button>
                )}
                {linked && (
                  <button className="btn btn-sm btn-secondary" title={t("Player to the start of the clip")} onClick={() => seek(linked.sourceIn)}>
                    ▶ {t("Jump to clip start")}
                  </button>
                )}
                {sel && ui.advanced && (
                  <button
                    className="btn btn-sm btn-secondary"
                    title={t("The clip starts at the beginning of the range, speed stays – place and length on the timeline stay")}
                    onClick={() => setSource({ sourceIn: Math.min(sel.in, sel.out), markerId: null, label: linked ? undefined : selLabel() })}
                  >
                    {t("Use range")}
                  </button>
                )}
                {sel && (
                  <button
                    className="btn btn-sm btn-secondary"
                    title={t("Play exactly the range in the clip – the speed adapts ({speed}×), place and length stay", { speed: fitSpeed.toFixed(2) })}
                    onClick={() => setSource({ sourceIn: Math.min(sel.in, sel.out), sourceOut: Math.max(sel.in, sel.out), markerId: null, label: linked ? undefined : selLabel() }, true)}
                  >
                    {t("Fit range ({speed}×)", { speed: fitSpeed.toFixed(2) })}
                  </button>
                )}
                <button
                  className="btn btn-sm btn-secondary"
                  title={t("Pick another scene on the left – it opens here, then “Use this scene here”")}
                  onClick={() => dispatch({ type: "ui", patch: { activeSceneId: null, sidebarTab: "scenes" } })}
                >
                  {t("Other scene…")}
                </button>
              </div>
              {linked && <div className="pmv-li-meta">{t("Drag the orange range on the bar to take another spot.")}</div>}
            </div>
          )}

          {sel && (
            <div className="pmv-selection">
              <div className="pmv-row">
                <NumField value={Math.min(sel.in, sel.out)} onCommit={(v) => setSel({ in: v, out: Math.max(sel.in, sel.out) })} min={0} max={duration} suffix={t("in")} />
                <NumField value={Math.max(sel.in, sel.out)} onCommit={(v) => setSel({ in: Math.min(sel.in, sel.out), out: v })} min={0} max={duration} suffix={t("out")} />
                <span className="pmv-li-meta">{Math.abs(sel.out - sel.in).toFixed(2)} s</span>
              </div>
              <div className="pmv-row pmv-wrap">
                <button className="btn btn-sm btn-primary" onClick={selectionToBin} title={t("Keep this range under “My clips”")}>
                  + {t("My clips")}
                </button>
                <button className="btn btn-sm btn-secondary" onClick={selectionToTimeline} title={t("Put this range onto the timeline at the playhead")}>
                  → {t("Timeline")}
                </button>
                <button className="btn btn-sm btn-danger" onClick={() => dispatch({ type: "exclusion/add", exclusion: exclusionFromRange(sceneId, sel.in, sel.out), sources })}>
                  ⊘ {t("Exclude")}
                </button>
                <button className="btn btn-sm btn-link" onClick={() => setSel(null)}>
                  ✕
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="pmv-panel pmv-scene-detail">
      {monitorEl && createPortal(player, monitorEl)}
      <div className="pmv-row">
        <button className="btn btn-sm btn-link" onClick={onBack}>
          ← {t("back")}
        </button>
        <a className="btn btn-sm btn-link" href={host.sceneHref(scene.id)} target="_blank" rel="noreferrer" title={host.kind === "stashui" ? t("Open in Stash UI") : t("Open in Stash")}>
          ↗
        </a>
        <button className="btn btn-sm btn-link" title={t("Reload (e.g. after changing markers in Stash)")} onClick={() => invalidateScene(scene.id)}>
          ↻
        </button>
      </div>
      <div className="pmv-li-title">{sceneTitle(scene)}</div>
      <div className="pmv-li-meta">
        {[scene.studio?.name, scene.date, formatTime(duration), file && `${file.width}×${file.height}`, file && `${Math.round(file.frame_rate * 100) / 100} fps`, file?.video_codec].filter(Boolean).join(" · ")}
      </div>
      <div className="pmv-chips">
        {scene.performers.map((p) => (
          <span key={p.id} className="pmv-chip pmv-chip-performer">
            {p.name}
          </span>
        ))}
        {scene.tags.slice(0, 12).map((x) => (
          <span key={x.id} className="pmv-chip">
            {x.name}
          </span>
        ))}
      </div>
      {shown ? (
        <div className="pmv-li-meta">{t("The scene plays in the big player – pick the part for the PMV there.")}</div>
      ) : (
        <button className="btn btn-sm btn-primary" onClick={() => dispatch({ type: "ui", patch: { sceneInPlayer: true } })} title={t("The main player shows this scene instead of the PMV")}>
          ▶ {t("Show in the player")}
        </button>
      )}

      <div className="pmv-section-head is-static">
        {t("Markers")} ({markers.length})
        <span className="pmv-spacer" />
        {ui.advanced && <NumField value={ui.markerDefaultLength} onCommit={(v) => dispatch({ type: "ui", patch: { markerDefaultLength: v } })} min={0.5} max={120} step={0.5} digits={1} suffix="s" title={t("Length for markers without an end")} />}
        <button className="btn btn-sm btn-secondary" disabled={!markers.length} onClick={() => dispatch({ type: "bin/add", snippets: markers.filter((m) => !isMarkerExcluded(project, m.id)).map((m) => snippetFromMarker(m, sceneId, duration, ui.markerDefaultLength)), sources })}>
          {t("All")} +
        </button>
      </div>
      <ul className="pmv-list">
        {markers.length === 0 && <li className="pmv-empty">{t("No markers – cut ranges with I/O or Shift+drag.")}</li>}
        {markers.map((m) => {
          const [a, b] = markerRange(m, duration, ui.markerDefaultLength);
          const inBin = isMarkerInBin(project, m.id);
          const excluded = isMarkerExcluded(project, m.id);
          return (
            <li key={m.id} className={`pmv-list-item ${excluded ? "is-excluded" : ""} ${inBin ? "is-picked" : ""}`} onClick={() => showAt(a)}>
              {m.screenshot && <img className="pmv-li-img" src={stashUrl(m.screenshot)} alt="" loading="lazy" />}
              <div className="pmv-li-main">
                <div className="pmv-li-title">{markerLabel(m)}</div>
                <div className="pmv-li-meta">
                  {formatTime(a)} – {formatTime(b)}
                  {m.end_seconds == null && ` (${t("default length")})`}
                  {m.tags.length > 0 && ` · ${m.tags.map((x) => x.name).join(", ")}`}
                </div>
              </div>
              <div className="pmv-li-actions" onClick={(e) => e.stopPropagation()}>
                <button className={`btn btn-sm ${inBin ? "btn-success" : "btn-secondary"}`} disabled={inBin || excluded} title={t("Add to “My clips”")} onClick={() => addMarker(m)}>
                  {inBin ? "✓" : "+"}
                </button>
                {(ui.advanced || excluded) && (
                  <button className={`btn btn-sm ${excluded ? "btn-danger" : "btn-secondary"}`} title={excluded ? t("Include again") : t("Exclude")} onClick={() => toggleExclude(m)}>
                    ⊘
                  </button>
                )}
                {ui.advanced && (
                  <button
                    className="btn btn-sm btn-secondary"
                    title={t("Take as the range to cut")}
                    onClick={() => {
                      setSel({ in: a, out: b });
                      showAt(a);
                    }}
                  >
                    ✂
                  </button>
                )}
                {selected && (
                  <button
                    className="btn btn-sm btn-secondary"
                    title={t("Put the selected clip on this marker – place and length on the timeline stay")}
                    disabled={excluded}
                    onClick={() => setSource({ sourceIn: a, markerId: m.id, label: markerLabel(m) })}
                  >
                    ↦
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {(snippets.length > 0 || exclusions.length > 0) && (
        <>
          <div className="pmv-section-head is-static">{t("In this project")}</div>
          <ul className="pmv-list">
            {snippets.map((s) => (
              <li
                key={s.id}
                className="pmv-list-item is-picked"
                onClick={() => {
                  setSel({ in: s.in, out: s.out });
                  showAt(s.in);
                }}
              >
                <div className="pmv-li-main">
                  <div className="pmv-li-title">{s.label}</div>
                  <div className="pmv-li-meta">
                    {formatTime(s.in)} – {formatTime(s.out)}
                  </div>
                </div>
                <button className="btn btn-sm btn-link" onClick={(e) => (e.stopPropagation(), dispatch({ type: "bin/remove", snippetId: s.id }))}>
                  ✕
                </button>
              </li>
            ))}
            {exclusions.map((x) => (
              <li key={x.id} className="pmv-list-item is-excluded">
                <div className="pmv-li-main">
                  <div className="pmv-li-title">{t("Excluded")}</div>
                  <div className="pmv-li-meta">
                    {formatTime(x.in)} – {formatTime(x.out)}
                  </div>
                </div>
                <button className="btn btn-sm btn-link" onClick={() => dispatch({ type: "exclusion/remove", exclusionId: x.id })}>
                  ↺
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
