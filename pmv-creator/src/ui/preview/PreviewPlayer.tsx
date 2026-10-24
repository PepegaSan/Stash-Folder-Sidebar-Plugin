import React, { useEffect, useMemo, useRef } from "react";
import { withStutters } from "../../fx/timeline";
import { t } from "../../i18n";
import { colorGrade } from "../../model/look";
import { projectDuration } from "../../model/project";
import { useScenes } from "../../stash/sceneCache";
import { useEditor } from "../../state/store";
import { flattenTimeline, resolveTransitions } from "../../timeline/flatten";
import { formatBarBeat, formatTime } from "../../timeline/time";
import { useTransportPlaying, useTransportTime } from "../hooks";
import { onStreamChange } from "../../stash/streams";
import { LocalMediaBadge } from "../localMedia";
import { StartPanel } from "../StartPanel";
import { useEffects } from "../effects";
import { Compositor } from "./compositor";
import { PREVIEW_SLOTS, PreviewEngine } from "./engine";

/** The canvas is drawn at screen resolution, at most at the PMV's own. */
const MAX_DPR = 2;

export function PreviewPlayer() {
  const { state, transport } = useEditor();
  const project = state.present;
  const playing = useTransportPlaying(transport);
  const time = useTransportTime(transport, 100);
  const videoRefs = useRef<HTMLVideoElement[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);
  const drawRef = useRef<() => void>(() => undefined);

  // only what the sequence depends on – culling in the sidebar must not re-cue the players
  const { tracks, output, audio, sources } = project;
  const fx = useEffects(project);
  const fxRef = useRef(fx);
  fxRef.current = fx;
  // a stutter is a jump back inside a clip: one more segment, cued in another player like any cut
  const segs = useMemo(() => withStutters(flattenTimeline(project), fx, output.fps), [tracks, output, audio, fx]);
  const trans = useMemo(() => resolveTransitions(project, segs), [segs, sources]);
  const scenes = useScenes(useMemo(() => Object.keys(project.sources), [project.sources]));
  const fps = project.output.fps;

  const grade = useMemo(() => colorGrade(output), [output]);
  const gradeRef = useRef(grade);
  gradeRef.current = grade;

  useEffect(() => {
    const compositor = new Compositor(canvasRef.current!);
    // a paused preview is worked out and drawn again when a picture arrives (a stream opened, a seek through): the clip
    // that was waiting for it takes over from the last picture held meanwhile
    const engine = new PreviewEngine(videoRefs.current.slice(0, PREVIEW_SLOTS), { listen: () => transport.listenLevel, onPicture: () => (transport.playing ? draw() : update()) });
    const draw = () => compositor.draw(engine.view, gradeRef.current, fxRef.current ? { tl: fxRef.current, t: transport.time } : null);
    engineRef.current = engine;
    drawRef.current = draw;
    const update = () => {
      engine.render(transport.time, transport.playing);
      draw();
    };
    const off = transport.subscribe(update);
    // PC ↔ Stash: re-cue the players, also while paused
    const offStream = onStreamChange(update);
    // the canvas follows the stage's size (screen pixels, at most the PMV's resolution)
    const stage = stageRef.current!;
    const fitCanvas = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      const w = Math.max(2, Math.round(stage.clientWidth * dpr));
      const h = Math.max(2, Math.round(stage.clientHeight * dpr));
      const c = compositor.canvas;
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
        draw();
      }
    };
    fitCanvas();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(fitCanvas) : null;
    ro?.observe(stage);
    return () => {
      off();
      offStream();
      ro?.disconnect();
      engine.dispose();
    };
  }, [transport]);

  const fit = project.output.fit;
  useEffect(() => {
    engineRef.current?.setTimeline({ segs, trans, fps, scenes, fit });
    engineRef.current?.render(transport.time, transport.playing);
    drawRef.current();
  }, [segs, trans, fps, scenes, fit, transport, grade, fx]);

  const cuts = useMemo(() => segs.map((s) => s.startFrame / fps), [segs, fps]);
  const jump = (dir: 1 | -1) => {
    const t = transport.time;
    const target = dir > 0 ? cuts.find((c) => c > t + 1e-3) : [...cuts].reverse().find((c) => c < t - 1e-3);
    transport.seek(target ?? (dir > 0 ? projectDuration(project) : 0));
  };
  const step = (frames: number) => transport.seek(Math.round(transport.time * fps + frames) / fps);

  return (
    <div className="pmv-preview">
      <div ref={stageRef} className="pmv-stage" style={{ ["--pmv-ar" as string]: project.output.width / project.output.height }} onClick={() => transport.toggle()}>
        {/* the players stay in the page (they decode there) but are invisible – the canvas shows them */}
        {Array.from({ length: PREVIEW_SLOTS }, (_, k) => (
          <video key={k} ref={(el) => void (el && (videoRefs.current[k] = el))} muted playsInline preload="auto" />
        ))}
        <canvas ref={canvasRef} className="pmv-stage-canvas" />
        {!tracks.some((tr) => tr.clips.length) && (
          <div className="pmv-stage-empty" title={t("The timeline is empty")}>
            <StartPanel />
          </div>
        )}
      </div>
      <div className="pmv-transport">
        <button className="btn btn-sm btn-secondary" title={t("Previous cut")} onClick={() => jump(-1)}>
          ⏮
        </button>
        <button className="btn btn-sm btn-secondary" title={t("1 frame back (←)")} onClick={() => step(-1)}>
          ‹
        </button>
        <button className="btn btn-sm btn-primary pmv-play" title={t("Play/pause (Space)")} onClick={() => transport.toggle()}>
          {playing ? "❚❚" : "▶"}
        </button>
        <button className="btn btn-sm btn-secondary" title={t("1 frame forward (→)")} onClick={() => step(1)}>
          ›
        </button>
        <button className="btn btn-sm btn-secondary" title={t("Next cut")} onClick={() => jump(1)}>
          ⏭
        </button>
        <span className="pmv-mono">
          {formatTime(time)} / {formatTime(projectDuration(project))}
        </span>
        <span className="pmv-mono pmv-dim">{formatBarBeat(time, project.beatGrid)}</span>
        <LocalMediaBadge />
      </div>
    </div>
  );
}
