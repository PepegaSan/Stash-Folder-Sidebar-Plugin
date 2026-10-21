import React, { useEffect, useMemo, useRef } from "react";
import { t } from "../../i18n";
import { projectDuration } from "../../model/project";
import { useScenes } from "../../stash/sceneCache";
import { useEditor } from "../../state/store";
import { flattenTimeline, resolveTransitions } from "../../timeline/flatten";
import { formatBarBeat, formatTime } from "../../timeline/time";
import { useTransportPlaying, useTransportTime } from "../hooks";
import { StartPanel } from "../StartPanel";
import { PreviewEngine } from "./engine";

export function PreviewPlayer() {
  const { state, transport } = useEditor();
  const project = state.present;
  const playing = useTransportPlaying(transport);
  const time = useTransportTime(transport, 100);
  const aRef = useRef<HTMLVideoElement>(null);
  const bRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const blurRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<PreviewEngine | null>(null);

  // only what the sequence depends on – culling in the sidebar must not re-cue the players
  const { tracks, output, audio, sources } = project;
  const segs = useMemo(() => flattenTimeline(project), [tracks, output, audio]);
  const trans = useMemo(() => resolveTransitions(project, segs), [segs, sources]);
  const scenes = useScenes(useMemo(() => Object.keys(project.sources), [project.sources]));
  const fps = project.output.fps;

  useEffect(() => {
    const engine = new PreviewEngine([aRef.current!, bRef.current!], overlayRef.current!, blurRef.current);
    engineRef.current = engine;
    const off = transport.subscribe(() => engine.render(transport.time, transport.playing));
    return () => {
      off();
      engine.dispose();
    };
  }, [transport]);

  const fit = project.output.fit;
  useEffect(() => {
    engineRef.current?.setTimeline({ segs, trans, fps, scenes, fit });
    engineRef.current?.render(transport.time, transport.playing);
  }, [segs, trans, fps, scenes, fit, transport]);

  const cuts = useMemo(() => segs.map((s) => s.startFrame / fps), [segs, fps]);
  const jump = (dir: 1 | -1) => {
    const t = transport.time;
    const target = dir > 0 ? cuts.find((c) => c > t + 1e-3) : [...cuts].reverse().find((c) => c < t - 1e-3);
    transport.seek(target ?? (dir > 0 ? projectDuration(project) : 0));
  };
  const step = (frames: number) => transport.seek(Math.round(transport.time * fps + frames) / fps);

  return (
    <div className="pmv-preview">
      <div className="pmv-stage" style={{ ["--pmv-ar" as string]: project.output.width / project.output.height }} onClick={() => transport.toggle()}>
        <canvas ref={blurRef} className="pmv-stage-blur" />
        <video ref={aRef} muted playsInline preload="auto" />
        <video ref={bRef} muted playsInline preload="auto" />
        <div ref={overlayRef} className="pmv-stage-overlay" />
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
      </div>
    </div>
  );
}
