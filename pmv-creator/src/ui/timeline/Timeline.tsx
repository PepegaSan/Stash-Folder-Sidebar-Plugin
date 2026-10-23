/**
 * Track-based timeline. Gestures never mutate anything while in flight: a drag only produces a
 * pending EditAction, the timeline renders applyEdit(project, pending) (exact WYSIWYG incl. ripple
 * and clamping), and pointer-up dispatches that same action -> one undo step per gesture.
 */
import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { overlapsExclusion } from "../../culling/culling";
import { uid } from "../../model/ids";
import { type Clip, type Track, audioEnd, clipEnd, clipSourceOut, projectDuration } from "../../model/project";
import { t } from "../../i18n";
import { useScenes } from "../../stash/sceneCache";
import type { StashScene } from "../../stash/types";
import { type EditAction, applyEdit } from "../../state/reducer";
import { useEditor } from "../../state/store";
import { clipFromSnippet, findClip } from "../../timeline/ops";
import { EPS, beatLength, clamp, formatBarBeat, formatTime, snapRange, snapTime } from "../../timeline/time";
import { SpriteThumb, sceneHue, transitionLabel } from "../common";
import { ClipActions, ClipNotice, ReplaceAllButton, SourceToggle } from "../monitor";
import { currentSnippetDrag, dropDuration, endSnippetDrag, snapOptions } from "../editing";
import { useAudioAnalysis, useSprites, useTransportTime } from "../hooks";
import { reviewCut } from "../review";
import { Waveform } from "./Waveform";

const HEAD_W = 120;
const RULER_H = 30;
const AUDIO_H = 56;
const LANE_H = 52;

type DragKind = "move" | "trim-start" | "trim-end" | "slip";

interface DragState {
  kind: DragKind;
  clip: Clip;
  trackId: string;
  x0: number;
  y0: number;
  moved: boolean;
}

function rulerStep(zoom: number): number {
  for (const s of [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120]) if (s * zoom >= 70) return s;
  return 300;
}

function rulerLabel(t: number, step: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${(step < 1 ? s.toFixed(2) : Math.round(s).toString()).padStart(step < 1 ? 5 : 2, "0")}`;
}

export function Timeline() {
  const { state, getState, dispatch, transport } = useEditor();
  const project = state.present;
  const ui = state.ui;
  const zoom = ui.zoom;
  const [pending, setPendingState] = useState<EditAction | null>(null);
  const pendingRef = useRef<EditAction | null>(null);
  const setPending = (a: EditAction | null) => {
    pendingRef.current = a;
    setPendingState(a);
  };
  const view = useMemo(() => (pending ? applyEdit(project, pending) : project), [project, pending]);
  const selectedScene = ui.selectedClipId ? findClip(project, ui.selectedClipId)?.clip.sceneId ?? null : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const latest = useRef({ project, ui });
  latest.current = { project, ui };
  const [vp, setVp] = useState({ left: 0, width: 1000 });
  const scenes = useScenes(useMemo(() => Object.keys(project.sources), [project.sources]));
  const { analysis } = useAudioAnalysis(project.audio?.url);
  const now = useTransportTime(transport, 100);

  const contentDur = Math.max(projectDuration(view) + 30, 60);
  const width = contentDur * zoom;

  useEffect(() => {
    const el = scrollRef.current!;
    let raf = 0;
    const update = () => {
      raf = 0;
      setVp({ left: el.scrollLeft, width: Math.max(0, el.clientWidth - HEAD_W) });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    el.addEventListener("scroll", onScroll);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    update();
    return () => {
      el.removeEventListener("scroll", onScroll);
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);

  // Playhead outside React: 60 fps without re-rendering the timeline.
  useEffect(() => {
    const update = () => {
      const x = transport.time * latest.current.ui.zoom;
      if (playheadRef.current) playheadRef.current.style.transform = `translateX(${x}px)`;
      const el = scrollRef.current;
      if (el && transport.playing) {
        const visible = el.clientWidth - HEAD_W;
        if (x > el.scrollLeft + visible - 30 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 60);
      }
    };
    update();
    return transport.subscribe(update);
  }, [transport, zoom]);

  // wheel = horizontal scroll, shift+wheel = vertical, ctrl+wheel = zoom around the cursor
  useEffect(() => {
    const el = scrollRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        const rect = el.getBoundingClientRect();
        const x = e.clientX - rect.left - HEAD_W;
        const z0 = latest.current.ui.zoom;
        const t = (el.scrollLeft + x) / z0;
        const z = clamp(z0 * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 4, 1000);
        dispatch({ type: "ui", patch: { zoom: z } });
        requestAnimationFrame(() => (el.scrollLeft = t * z - x));
      } else if (e.shiftKey) {
        el.scrollTop += e.deltaY;
      } else {
        el.scrollLeft += e.deltaY + e.deltaX;
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [dispatch]);

  const timeAt = (clientX: number) => {
    const el = scrollRef.current!;
    return Math.max(0, (clientX - el.getBoundingClientRect().left - HEAD_W + el.scrollLeft) / latest.current.ui.zoom);
  };
  const trackAt = (clientX: number, clientY: number): string | null => {
    const hit = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    return hit?.closest<HTMLElement>("[data-track-id]")?.dataset.trackId ?? null;
  };

  // ------------------------------------------------------------------ clip drag / trim / slip
  const onMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3 && Math.abs(e.clientY - d.y0) < 3) return;
    d.moved = true;
    const { project: p, ui: u } = latest.current;
    const dx = (e.clientX - d.x0) / u.zoom;
    const opts = e.shiftKey ? null : snapOptions(p, u, transport.time, d.clip.id);
    const snap = (t: number) => (opts ? snapTime(t, opts) : t);
    const c = d.clip;
    let action: EditAction;
    switch (d.kind) {
      case "move": {
        const raw = Math.max(0, c.start + dx);
        const start = opts ? snapRange(raw, c.duration, opts) : raw;
        action = { type: "clip/move", clipId: c.id, trackId: trackAt(e.clientX, e.clientY) ?? d.trackId, start: Math.max(0, start), mode: u.editMode };
        break;
      }
      case "trim-start":
        action = { type: "clip/trim", clipId: c.id, edge: "start", time: snap(c.start + dx), mode: u.editMode };
        break;
      case "trim-end":
        action = { type: "clip/trim", clipId: c.id, edge: "end", time: snap(clipEnd(c) + dx), mode: u.editMode };
        break;
      case "slip":
        action = { type: "clip/slip", clipId: c.id, sourceIn: c.sourceIn - dx * c.speed };
        break;
    }
    setPending(action);
  };

  // A plain click shows the clip in the player: the playhead jumps to its start unless it is already inside.
  const showClip = (c: Clip) => {
    if (transport.time < c.start - EPS || transport.time >= clipEnd(c) - EPS) transport.seek(c.start);
  };

  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.moved && pendingRef.current) dispatch(pendingRef.current);
    else if (d && !d.moved && d.kind === "move") showClip(d.clip);
    setPending(null);
  };

  const beginDrag = (e: React.PointerEvent, clip: Clip, track: Track, kind: DragKind) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    dispatch({ type: "ui", patch: { selectedClipId: clip.id } });
    if (track.locked) {
      showClip(clip);
      return;
    }
    dragRef.current = { kind: kind === "move" && e.altKey ? "slip" : kind, clip, trackId: track.id, x0: e.clientX, y0: e.clientY, moved: false };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  };
  // Stable identities so memoised ClipBlocks only re-render when their own clip changes.
  const handlers = useRef({ beginDrag, openSource: (c: Clip) => dispatch({ type: "ui", patch: { activeSceneId: c.sceneId, activeSceneSeek: c.sourceIn } }) });
  handlers.current.beginDrag = beginDrag;
  const stable = useMemo(
    () => ({
      beginDrag: (e: React.PointerEvent, c: Clip, t: Track, k: DragKind) => handlers.current.beginDrag(e, c, t, k),
      openSource: (c: Clip) => handlers.current.openSource(c),
    }),
    [],
  );

  // ------------------------------------------------------------------ drop from the bin
  const dropAction = (e: React.DragEvent): EditAction | null => {
    const payload = currentSnippetDrag();
    if (!payload) return null;
    const { project: p, ui: u } = latest.current;
    const s = p.bin.find((x) => x.id === payload.snippetId);
    const trackId = trackAt(e.clientX, e.clientY);
    if (!s || !trackId) return null;
    const duration = dropDuration(p, u, s);
    const opts = snapOptions(p, u, transport.time);
    const raw = timeAt(e.clientX);
    const start = opts ? snapRange(raw, duration, opts) : raw;
    return { type: "clip/insert", trackId, clip: { ...clipFromSnippet(s, start, { duration }), id: payload.clipId }, mode: u.editMode };
  };

  // ------------------------------------------------------------------ rendering helpers
  const g = view.beatGrid;
  const beatPx = beatLength(g) * zoom;
  const barPx = beatPx * g.beatsPerBar;
  const gridStyle: React.CSSProperties =
    beatPx >= 5
      ? {
          backgroundImage: `linear-gradient(to right, var(--pmv-grid-bar) 1px, transparent 1px), linear-gradient(to right, var(--pmv-grid-beat) 1px, transparent 1px)`,
          backgroundSize: `${barPx}px 100%, ${beatPx}px 100%`,
          backgroundPosition: `${(g.offset % (beatLength(g) * g.beatsPerBar)) * zoom}px 0, ${(g.offset % beatLength(g)) * zoom}px 0`,
          width,
        }
      : { width };

  const step = rulerStep(zoom);
  const t0 = vp.left / zoom;
  const t1 = (vp.left + vp.width) / zoom;
  const ticks: number[] = [];
  for (let t = Math.floor(t0 / step) * step; t <= t1 + step; t += step) ticks.push(t);
  const bars: number[] = [];
  if (barPx >= 28) {
    const first = Math.floor((t0 - g.offset) / (beatLength(g) * g.beatsPerBar));
    for (let b = first; ; b++) {
      const t = g.offset + b * beatLength(g) * g.beatsPerBar;
      if (t > t1) break;
      if (t >= 0) bars.push(t);
    }
  }

  const seekFromPointer = (e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    transport.seek(timeAt(e.clientX));
  };

  return (
    <div className="pmv-timeline">
      <div className="pmv-tl-toolbar">
        <span className="pmv-mono">{formatTime(now)}</span>
        <span className="pmv-mono pmv-dim">{formatBarBeat(now, project.beatGrid)}</span>
        <span className="pmv-btn-group">
          <button className="btn btn-sm btn-secondary" title={t("Previous cut: selects the clip and plays from a second before it ([ or ↑)")} onClick={() => reviewCut(getState(), dispatch, transport, -1)}>
            ⏮
          </button>
          <button className="btn btn-sm btn-secondary" title={t("Next cut: selects the clip and plays from a second before it (] or ↓) – press again for the one after")} onClick={() => reviewCut(getState(), dispatch, transport, 1)}>
            ⏭
          </button>
        </span>
        <span className="pmv-spacer" />
        <SourceToggle />
        <ReplaceAllButton />
        <ClipActions />
        <span className="pmv-spacer" />
        {ui.advanced && (
          <>
            <button className="btn btn-sm btn-secondary" title={t("Timeline marker at the playhead")} onClick={() => dispatch({ type: "marker/add", marker: { id: uid("mrk"), time: transport.time, label: `M${project.markers.length + 1}` } })}>
              ◆ {t("Marker")}
            </button>
            <button className="btn btn-sm btn-secondary" onClick={() => dispatch({ type: "track/add" })}>
              + {t("Track")}
            </button>
          </>
        )}
        <button className="btn btn-sm btn-secondary" title={t("Zoom out")} onClick={() => dispatch({ type: "ui", patch: { zoom: clamp(zoom / 1.5, 4, 1000) } })}>
          −
        </button>
        <button className="btn btn-sm btn-secondary" title={t("Zoom in")} onClick={() => dispatch({ type: "ui", patch: { zoom: clamp(zoom * 1.5, 4, 1000) } })}>
          +
        </button>
        <button
          className="btn btn-sm btn-secondary"
          title={t("Fit the whole sequence")}
          onClick={() => {
            const dur = Math.max(10, projectDuration(project));
            dispatch({ type: "ui", patch: { zoom: clamp((vp.width - 20) / dur, 4, 1000) } });
            if (scrollRef.current) scrollRef.current.scrollLeft = 0;
          }}
        >
          {t("Fit")}
        </button>
      </div>
      <ClipNotice />

      <div
        className="pmv-tl-scroll"
        ref={scrollRef}
        onDragOver={(e) => {
          const a = dropAction(e);
          if (!a) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
          setPending(a);
        }}
        onDragLeave={(e) => {
          if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setPending(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          const a = dropAction(e) ?? pendingRef.current;
          if (a) dispatch(a);
          setPending(null);
          endSnippetDrag();
        }}
      >
        <div className="pmv-tl-grid" style={{ width: width + HEAD_W }}>
          <div className="pmv-tl-row pmv-tl-ruler-row" style={{ height: RULER_H }}>
            <div className="pmv-tl-head">{project.beatGrid.bpm} BPM</div>
            <div className="pmv-ruler" style={{ width }} onPointerDown={seekFromPointer} onPointerMove={(e) => e.buttons === 1 && transport.seek(timeAt(e.clientX))}>
              {ticks.map((t) => (
                <span key={`t${t}`} className="pmv-ruler-tick" style={{ left: t * zoom }}>
                  {rulerLabel(t, step)}
                </span>
              ))}
              {bars.map((t) => (
                <span key={`b${t}`} className="pmv-ruler-bar" style={{ left: t * zoom }}>
                  {Math.round((t - g.offset) / (beatLength(g) * g.beatsPerBar)) + 1}
                </span>
              ))}
              {project.markers.map((m) => (
                <span
                  key={m.id}
                  className="pmv-ruler-marker"
                  style={{ left: m.time * zoom }}
                  title={t("{label} – double-click removes it", { label: m.label })}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    transport.seek(m.time);
                  }}
                  onDoubleClick={() => dispatch({ type: "marker/remove", markerId: m.id })}
                >
                  ◆
                </span>
              ))}
            </div>
          </div>

          <div className="pmv-tl-row" style={{ height: AUDIO_H }}>
            <div className="pmv-tl-head" title={project.audio?.name}>
              ♪ {project.audio ? project.audio.name || t("Music") : t("no music")}
            </div>
            <div className="pmv-lane pmv-lane-audio" style={{ ...gridStyle, height: AUDIO_H }} onPointerDown={seekFromPointer}>
              {project.audio && (
                <>
                  <div className="pmv-audio-region" style={{ left: project.audio.start * zoom, width: (audioEnd(project.audio) - project.audio.start) * zoom }} />
                  <Waveform audio={project.audio} analysis={analysis} zoom={zoom} left={vp.left} width={vp.width} height={AUDIO_H} />
                </>
              )}
            </div>
          </div>

          {view.tracks.map((track) => (
            <div key={track.id} className={`pmv-tl-row ${track.muted ? "is-muted" : ""} ${track.locked ? "is-locked" : ""}`} style={{ height: LANE_H }}>
              <TrackHead track={track} canRemove={view.tracks.length > 1} />
              <div
                className="pmv-lane"
                data-track-id={track.id}
                style={{ ...gridStyle, height: LANE_H }}
                onPointerDown={(e) => {
                  if (e.target !== e.currentTarget) return;
                  dispatch({ type: "ui", patch: { selectedClipId: null } });
                  seekFromPointer(e);
                }}
              >
                {track.clips.map((c) => (
                  <ClipBlock
                    key={c.id}
                    clip={c}
                    track={track}
                    zoom={zoom}
                    scene={scenes[c.sceneId]}
                    sourceTitle={view.sources[c.sceneId]?.title ?? null}
                    excluded={overlapsExclusion(view.exclusions, c.sceneId, c.sourceIn, clipSourceOut(c))}
                    selected={ui.selectedClipId === c.id}
                    sameScene={c.sceneId === selectedScene && ui.selectedClipId !== c.id}
                    ghost={pending !== null && "clipId" in pending && pending.clipId === c.id}
                    onPointerDown={stable.beginDrag}
                    onOpenSource={stable.openSource}
                  />
                ))}
              </div>
            </div>
          ))}

          <div className="pmv-playhead" ref={playheadRef} style={{ left: HEAD_W }} />
        </div>
      </div>
    </div>
  );
}

function TrackHead({ track, canRemove }: { track: Track; canRemove: boolean }) {
  const { dispatch } = useEditor();
  const [editing, setEditing] = useState(false);
  return (
    <div className="pmv-tl-head" data-track-id={track.id}>
      {editing ? (
        <input
          className="form-control form-control-sm"
          autoFocus
          defaultValue={track.name}
          onBlur={(e) => {
            setEditing(false);
            if (e.target.value.trim()) dispatch({ type: "track/update", trackId: track.id, patch: { name: e.target.value.trim() } });
          }}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" || e.key === "Escape") (e.target as HTMLInputElement).blur();
          }}
        />
      ) : (
        <span className="pmv-track-name" onDoubleClick={() => setEditing(true)} title={t("Double-click: rename")}>
          {track.name}
        </span>
      )}
      <button className={`pmv-tbtn ${track.muted ? "is-on" : ""}`} title={t("Hide track")} onClick={() => dispatch({ type: "track/update", trackId: track.id, patch: { muted: !track.muted } })}>
        M
      </button>
      <button className={`pmv-tbtn ${track.locked ? "is-on" : ""}`} title={t("Lock track")} onClick={() => dispatch({ type: "track/update", trackId: track.id, patch: { locked: !track.locked } })}>
        L
      </button>
      {canRemove && (
        <button className="pmv-tbtn" title={t("Delete track")} onClick={() => (track.clips.length === 0 || window.confirm(t("Delete track {name} with {n} clips?", { name: track.name, n: track.clips.length }))) && dispatch({ type: "track/remove", trackId: track.id })}>
          ✕
        </button>
      )}
    </div>
  );
}

interface ClipBlockProps {
  clip: Clip;
  track: Track;
  zoom: number;
  scene: StashScene | undefined;
  sourceTitle: string | null;
  excluded: boolean;
  selected: boolean;
  /** Same scene as the selected clip – shows which clips "all clips of that scene" would change. */
  sameScene: boolean;
  ghost: boolean;
  onPointerDown: (e: React.PointerEvent, clip: Clip, track: Track, kind: DragKind) => void;
  onOpenSource: (clip: Clip) => void;
}

const ClipBlock = memo(function ClipBlock({ clip, track, zoom, scene, sourceTitle, excluded, selected, sameScene, ghost, onPointerDown, onOpenSource }: ClipBlockProps) {
  const sprites = useSprites(scene?.paths.vtt);
  const width = Math.max(2, clip.duration * zoom);
  const missing = sourceTitle === null;
  const title = [
    clip.label || sourceTitle,
    `${formatTime(clip.start)} → ${formatTime(clipEnd(clip))} (${clip.duration.toFixed(3)} s)`,
    t("Source {from} – {to}", { from: formatTime(clip.sourceIn), to: formatTime(clipSourceOut(clip)) }),
    clip.speed !== 1 ? t("Speed {speed}×", { speed: clip.speed }) : "",
    excluded ? t("⚠ overlaps an excluded range") : "",
    clip.pinned ? t("📌 kept when generating again") : "",
    t("Drag: move · edges: trim · Alt+drag: slip · Shift: no snapping · double-click: edit the source"),
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <div
      className={`pmv-clip ${selected ? "is-selected" : ""} ${sameScene ? "is-same-scene" : ""} ${ghost ? "is-ghost" : ""} ${excluded ? "is-excluded" : ""} ${missing ? "is-missing" : ""} ${clip.pinned ? "is-pinned" : ""}`}
      style={{ left: clip.start * zoom, width, ["--hue" as string]: sceneHue(clip.sceneId) }}
      title={title}
      onPointerDown={(e) => onPointerDown(e, clip, track, "move")}
      onDoubleClick={() => onOpenSource(clip)}
    >
      {width > 40 && (
        <div className="pmv-clip-thumb">
          <SpriteThumb sheet={sprites} t={clip.sourceIn} height={LANE_H - 18} fallback={scene?.paths.screenshot} />
        </div>
      )}
      <div className="pmv-clip-label">
        {clip.pinned && <span className="pmv-badge">📌</span>}
        {clip.speed !== 1 && <span className="pmv-badge">{Number(clip.speed.toFixed(2))}×</span>}
        {clip.label || sourceTitle || clip.sceneId}
      </div>
      {clip.transitionIn && <div className="pmv-clip-trans" style={{ width: Math.min(width / 2, (clip.transitionIn.duration / 2) * zoom) }} title={transitionLabel(clip.transitionIn.type)} />}
      <div className="pmv-clip-handle is-left" onPointerDown={(e) => onPointerDown(e, clip, track, "trim-start")} />
      <div className="pmv-clip-handle is-right" onPointerDown={(e) => onPointerDown(e, clip, track, "trim-end")} />
    </div>
  );
});
