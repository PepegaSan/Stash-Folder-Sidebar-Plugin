/**
 * Right-hand panel: the selected clip, otherwise music / beat grid / output. Simple mode shows what a PMV
 * needs; everything else sits in "More…" blocks (open by default in advanced mode).
 */
import React, { useRef, useState } from "react";
import { detectTempo } from "../audio/analysis";
import { t } from "../i18n";
import { type FitMode, TRANSITION_TYPES, type TransitionType, VIDEO_CODECS, type VideoCodec, clipEnd, clipSourceOut } from "../model/project";
import { useEditor } from "../state/store";
import { type ClipLocation, type SpeedKeep, findClip } from "../timeline/ops";
import { beatLength, formatBarBeat, nearestGridTime } from "../timeline/time";
import { LookFields, More, NumField, VolumeSlider, transitionLabel } from "./common";
import { EffectFields } from "./EffectFields";
import { useAudioAnalysis } from "./hooks";
import { LayoutInspector } from "./LayoutFields";
import { useMusic } from "./music";
import { SongLibraryButton } from "./SongLibrary";

export function Inspector() {
  const { state } = useEditor();
  const loc = state.ui.selectedClipId ? findClip(state.present, state.ui.selectedClipId) : null;
  const range = !loc && state.ui.selectedLayoutId ? state.present.layouts.find((x) => x.id === state.ui.selectedLayoutId) : undefined;
  // keyed by the mode: "More…" blocks open up when advanced is switched on
  return (
    <div className="pmv-inspector" key={String(state.ui.advanced)}>
      {loc ? <ClipInspector loc={loc} /> : range ? <LayoutInspector range={range} /> : <ProjectInspector />}
    </div>
  );
}

const fitLabel = (fit: FitMode) => (fit === "cover" ? t("Fill (crop)") : fit === "contain" ? t("Fit (bars)") : t("Fit (blurred edges)"));

function ClipInspector({ loc }: { loc: ClipLocation }) {
  const { state, dispatch, transport } = useEditor();
  const project = state.present;
  const ui = state.ui;
  const adv = ui.advanced;
  const { clip, track } = loc;
  const [keep, setKeep] = useState<SpeedKeep>("duration");
  const src = project.sources[clip.sceneId];
  const beat = beatLength(project.beatGrid);
  const mode = ui.editMode;
  const id = clip.id;
  const step = beat * ui.snapDivision;
  const sameScene = project.tracks.reduce((n, tr) => n + tr.clips.filter((c) => c.sceneId === clip.sceneId).length, 0);

  return (
    <div className="pmv-panel">
      <div className="pmv-section-head is-static">
        {t("Clip")}
        <span className="pmv-spacer" />
        <button className="btn btn-sm btn-link" onClick={() => dispatch({ type: "ui", patch: { selectedClipId: null } })} title={t("Clear selection (Esc)")}>
          ✕
        </button>
      </div>
      <input
        className="form-control form-control-sm"
        key={id}
        defaultValue={clip.label}
        placeholder={src?.title ?? clip.sceneId}
        onBlur={(e) => e.target.value !== clip.label && dispatch({ type: "clip/update", clipId: id, patch: { label: e.target.value } })}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
      <div className="pmv-li-meta">
        {src?.title ?? t("Scene {id} (not in the project)", { id: clip.sceneId })} · {t("Track {name}", { name: track.name })}
        {track.locked && ` · ${t("locked")}`}
        {sameScene > 1 && ` · ${t("{n} clips from this scene", { n: sameScene })}`}
      </div>

      <div className="pmv-grid2">
        <label>{t("Start")}</label>
        <NumField value={clip.start} min={0} onCommit={(v) => dispatch({ type: "clip/move", clipId: id, trackId: track.id, start: v, mode })} suffix="s" />
        <label>{t("Duration")}</label>
        <NumField value={clip.duration} min={0.01} onCommit={(v) => dispatch({ type: "clip/trim", clipId: id, edge: "end", time: clip.start + v, mode })} suffix="s" />
        <label>{t("Speed")}</label>
        <span className="pmv-row">
          <NumField value={clip.speed} min={0.1} max={10} step={0.05} onCommit={(v) => dispatch({ type: "clip/speed", clipId: id, speed: v, keep, mode })} suffix="×" />
          {adv && (
            <select className="form-control form-control-sm" value={keep} onChange={(e) => setKeep(e.target.value as SpeedKeep)} title={t("What a speed change keeps: the duration on the timeline (beat-safe) or the source range")}>
              <option value="duration">{t("Keep duration")}</option>
              <option value="range">{t("Keep range")}</option>
            </select>
          )}
        </span>
        <label>{t("Framing")}</label>
        <select className="form-control form-control-sm" value={clip.fit ?? ""} onChange={(e) => dispatch({ type: "clip/update", clipId: id, patch: { fit: (e.target.value || null) as FitMode | null } })}>
          <option value="">{t("Project ({fit})", { fit: fitLabel(project.output.fit) })}</option>
          <option value="blur">{t("Fit (blurred edges)")}</option>
          <option value="cover">{t("Fill (crop)")}</option>
          <option value="contain">{t("Fit (bars)")}</option>
        </select>
        <label>{t("Clip audio")}</label>
        {src && !src.hasAudio ? (
          <span className="pmv-li-meta">{t("This scene has no sound track.")}</span>
        ) : (
          <VolumeSlider value={clip.volume} onChange={(v) => dispatch({ type: "clip/update", clipId: id, patch: { volume: v } })} title={t("The clip's own sound under the music (100 % = as loud as in the file)")} />
        )}
        <label />
        <span>
          <button
            className="btn btn-sm btn-secondary"
            title={t("Gives every clip this clip audio (locked tracks keep theirs). One step – Ctrl+Z undoes it.")}
            onClick={() => dispatch({ type: "clips/volume", volume: clip.volume })}
          >
            ⇉ {t("Clip audio for all clips")}
          </button>
        </span>
        <label>{t("Transition")}</label>
        <select
          className="form-control form-control-sm"
          value={clip.transitionIn?.type ?? ""}
          title={t("How this clip comes in after the one before it")}
          onChange={(e) => {
            const type = e.target.value as TransitionType | "";
            dispatch({ type: "clip/update", clipId: id, patch: { transitionIn: type ? { type, duration: clip.transitionIn?.duration ?? Math.min(0.5, beat / 2) } : null } });
          }}
        >
          <option value="">{t("Hard cut")}</option>
          {TRANSITION_TYPES.map((x) => (
            <option key={x} value={x}>
              {transitionLabel(x)}
            </option>
          ))}
        </select>
        {clip.transitionIn && (
          <>
            <label>{t("Transition length")}</label>
            <NumField value={clip.transitionIn.duration} min={0.02} max={10} onCommit={(v) => dispatch({ type: "clip/update", clipId: id, patch: { transitionIn: { ...clip.transitionIn!, duration: v } } })} suffix="s" />
          </>
        )}
        <label />
        <span>
          <button
            className="btn btn-sm btn-secondary"
            title={t("Gives every clip this transition (type and length); the first clip of a track keeps its own. One step – Ctrl+Z undoes it.")}
            onClick={() => dispatch({ type: "clips/transition", transition: clip.transitionIn })}
          >
            ⇉ {t("Transition for all clips")}
          </button>
        </span>
      </div>
      <div className="pmv-li-meta">{t("Another part of the scene never changes the clip's place on the timeline: “Edit source” and drag the orange range.")}</div>

      <More defaultOpen={adv}>
        <div className="pmv-grid2">
          <label />
          <span className="pmv-li-meta">{t("Bar {pos}", { pos: formatBarBeat(clip.start, project.beatGrid) })}</span>
          <label>{t("Duration")}</label>
          <NumField value={clip.duration / beat} min={0.0625} step={0.25} onCommit={(v) => dispatch({ type: "clip/trim", clipId: id, edge: "end", time: clip.start + v * beat, mode })} suffix={t("beats")} />
          <label>{t("In (source)")}</label>
          <NumField value={clip.sourceIn} min={0} onCommit={(v) => dispatch({ type: "clip/slip", clipId: id, sourceIn: v })} suffix="s" title={t("Another part of the scene – position and length on the timeline stay")} />
          <label>{t("Out (source)")}</label>
          <NumField
            value={clipSourceOut(clip)}
            min={clip.duration * clip.speed}
            onCommit={(v) => dispatch({ type: "clip/slip", clipId: id, sourceIn: v - clip.duration * clip.speed })}
            suffix="s"
            title={t("Another part of the scene – position and length on the timeline stay (change the length with “Duration”)")}
          />
        </div>
        <div className="pmv-row pmv-wrap">
          <button
            className="btn btn-sm btn-secondary"
            title={t("Put start and end on the snap grid")}
            onClick={() => {
              const s = nearestGridTime(clip.start, project.beatGrid, ui.snapDivision);
              const e = Math.max(s + step, nearestGridTime(clipEnd(clip), project.beatGrid, ui.snapDivision));
              dispatch({ type: "clip/move", clipId: id, trackId: track.id, start: s, mode });
              dispatch({ type: "clip/trim", clipId: id, edge: "end", time: e, mode });
            }}
          >
            ⌗ {t("To the grid")}
          </button>
          <button className="btn btn-sm btn-secondary" onClick={() => dispatch({ type: "clip/split", clipId: id, time: transport.time })} title={t("Split at the playhead (S)")}>
            ✂ {t("Split")}
          </button>
          <button className="btn btn-sm btn-secondary" disabled={!ui.selectedSnippetId} onClick={() => ui.selectedSnippetId && dispatch({ type: "clip/replace", clipId: id, snippetId: ui.selectedSnippetId })} title={t("Replace with the clip selected under “My clips” (R)")}>
            ⇄ {t("Replace")}
          </button>
        </div>
      </More>

      <div className="pmv-row pmv-wrap">
        <button className="btn btn-sm btn-danger" onClick={() => dispatch({ type: "clip/delete", clipId: id, ripple: false })} title={t("Del · Shift+Del = ripple")}>
          {t("Delete")}
        </button>
      </div>
    </div>
  );
}

const FPS_PRESETS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
const RESOLUTIONS: Array<[number, number, string]> = [
  [1920, 1080, "1080p 16:9"],
  [2560, 1440, "1440p 16:9"],
  [3840, 2160, "4K 16:9"],
  [1280, 720, "720p 16:9"],
  [1080, 1920, "1080×1920 9:16"],
  [1080, 1080, "1080 1:1"],
];

function ProjectInspector() {
  const { state, dispatch } = useEditor();
  const adv = state.ui.advanced;
  const o = state.present.output;
  const res = RESOLUTIONS.find(([w, h]) => w === o.width && h === o.height);
  return (
    <div className="pmv-panel">
      <AudioSection />
      <ClipAudioSection />
      <GridSection />
      <div className="pmv-section-head is-static">{t("Output")}</div>
      <div className="pmv-grid2">
        <label>{t("Format")}</label>
        <select
          className="form-control form-control-sm"
          value={res ? `${res[0]}x${res[1]}` : ""}
          onChange={(e) => {
            const [w, h] = e.target.value.split("x").map(Number);
            if (w && h) dispatch({ type: "output/update", patch: { width: w, height: h } });
          }}
        >
          {!res && <option value="">{`${o.width}×${o.height}`}</option>}
          {RESOLUTIONS.map(([w, h, label]) => (
            <option key={label} value={`${w}x${h}`}>
              {label}
            </option>
          ))}
        </select>
        <label>{t("Framing")}</label>
        <select className="form-control form-control-sm" value={o.fit} onChange={(e) => dispatch({ type: "output/update", patch: { fit: e.target.value as FitMode } })}>
          <option value="blur">{t("Fit (blurred edges)")}</option>
          <option value="cover">{t("Fill (crop)")}</option>
          <option value="contain">{t("Fit (bars)")}</option>
        </select>
        <LookFields output={o} onChange={(patch) => dispatch({ type: "output/update", patch })} />
      </div>
      <div className="pmv-section-head is-static" title={t("They count for the whole PMV – preview, quick record and render")}>
        {t("Effects")}
      </div>
      <EffectFields fx={state.present.effects} music={!!state.present.audio} onChange={(patch) => dispatch({ type: "effects/update", patch })} />
      <More defaultOpen={adv}>
        <div className="pmv-grid2">
          <label>FPS</label>
          <select className="form-control form-control-sm" value={o.fps} onChange={(e) => dispatch({ type: "output/update", patch: { fps: +e.target.value } })}>
            {FPS_PRESETS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <label>{t("Codec")}</label>
          <select className="form-control form-control-sm" value={o.videoCodec} onChange={(e) => dispatch({ type: "output/update", patch: { videoCodec: e.target.value as VideoCodec } })}>
            {VIDEO_CODECS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <label>{t("Quality (CRF/CQ)")}</label>
          <NumField value={o.crf} min={0} max={51} step={1} digits={0} onCommit={(v) => dispatch({ type: "output/update", patch: { crf: Math.round(v) } })} />
          <label>{t("Preset")}</label>
          <select className="form-control form-control-sm" value={o.preset} onChange={(e) => dispatch({ type: "output/update", patch: { preset: e.target.value } })}>
            {["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"].map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <label>{t("Audio bitrate")}</label>
          <select className="form-control form-control-sm" value={o.audioBitrate} onChange={(e) => dispatch({ type: "output/update", patch: { audioBitrate: e.target.value } })}>
            {["128k", "192k", "256k", "320k"].map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>
      </More>
    </div>
  );
}

function AudioSection() {
  const { state, dispatch } = useEditor();
  const adv = state.ui.advanced;
  const music = useMusic();
  const audio = music.audio;
  const [serverPath, setServerPath] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const { error } = useAudioAnalysis(audio?.url);

  return (
    <>
      <div className="pmv-section-head is-static">{t("Music")}</div>
      {audio ? (
        <div className="pmv-li-meta" title={audio.path ?? ""}>
          ♪ {audio.name} ({audio.duration.toFixed(1)} s)
        </div>
      ) : (
        <div className="pmv-li-meta">{t("No music yet – upload the song here.")}</div>
      )}
      {error && <div className="pmv-error">{t("Audio can't be loaded: {error}", { error })}</div>}
      <div className="pmv-row pmv-wrap">
        <input ref={fileRef} type="file" accept="audio/*" className="pmv-hidden" onChange={(e) => e.target.files?.[0] && void music.upload(e.target.files[0])} />
        <button className={`btn btn-sm ${audio ? "btn-secondary" : "btn-primary"}`} disabled={!music.online} onClick={() => fileRef.current?.click()}>
          {audio ? t("Other song…") : t("Upload song…")}
        </button>
        {music.online && <SongLibraryButton current={audio?.name} onPick={(s) => void music.adoptSong(s)} />}
        {audio && (
          <button className="btn btn-sm btn-link" onClick={music.remove}>
            {t("Remove")}
          </button>
        )}
      </div>
      {music.status && <div className="pmv-li-meta">{music.status}</div>}
      <More defaultOpen={adv}>
        <div className="pmv-row">
          <input className="form-control form-control-sm" placeholder={t("Path of a file on the Stash server")} value={serverPath} onChange={(e) => setServerPath(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button className="btn btn-sm btn-secondary" disabled={!music.online || !serverPath.trim()} onClick={() => void music.usePath(serverPath)}>
            {t("Use")}
          </button>
        </div>
        {audio && (
          <div className="pmv-grid2">
            <label>{t("Start (timeline)")}</label>
            <NumField value={audio.start} min={0} onCommit={(v) => dispatch({ type: "audio/update", patch: { start: v } })} suffix="s" />
            <label>{t("From (in file)")}</label>
            <NumField value={audio.sourceIn} min={0} max={audio.duration} onCommit={(v) => dispatch({ type: "audio/update", patch: { sourceIn: v } })} suffix="s" />
            <label>{t("Level")}</label>
            <NumField value={audio.gainDb} min={-60} max={24} step={0.5} digits={1} onCommit={(v) => dispatch({ type: "audio/update", patch: { gainDb: v } })} suffix="dB" />
            <label>{t("Fade-in / -out")}</label>
            <span className="pmv-row">
              <NumField value={audio.fadeIn} min={0} max={30} step={0.1} digits={2} onCommit={(v) => dispatch({ type: "audio/update", patch: { fadeIn: v } })} suffix="s" />
              <NumField value={audio.fadeOut} min={0} max={30} step={0.1} digits={2} onCommit={(v) => dispatch({ type: "audio/update", patch: { fadeOut: v } })} suffix="s" />
            </span>
          </div>
        )}
      </More>
    </>
  );
}

/** The clips' own sound: the level new clips start with, and one button for all clips that are there. */
function ClipAudioSection() {
  const { state, dispatch } = useEditor();
  const p = state.present;
  const clips = p.tracks.reduce((n, tr) => n + tr.clips.length, 0);
  return (
    <>
      <div className="pmv-section-head is-static">{t("Clip audio")}</div>
      <div className="pmv-li-meta">{t("The clips' own sound under the music. New clips start with this level; every clip can have its own in the inspector.")}</div>
      <div className="pmv-row pmv-wrap">
        <VolumeSlider value={p.clipVolume} onChange={(v) => dispatch({ type: "project/clipVolume", volume: v })} title={t("The clip's own sound under the music (100 % = as loud as in the file)")} />
        <button
          className="btn btn-sm btn-secondary"
          disabled={!clips}
          title={t("Gives every clip this clip audio (locked tracks keep theirs). One step – Ctrl+Z undoes it.")}
          onClick={() => dispatch({ type: "clips/volume", volume: p.clipVolume })}
        >
          ⇉ {t("Apply to all clips ({n})", { n: clips })}
        </button>
      </div>
    </>
  );
}

function GridSection() {
  const { state, dispatch, transport } = useEditor();
  const adv = state.ui.advanced;
  const p = state.present;
  const g = p.beatGrid;
  const { analysis } = useAudioAnalysis(p.audio?.url);
  const taps = useRef<number[]>([]);
  const [info, setInfo] = useState<string | null>(null);
  const beat = beatLength(g);
  const norm = (x: number, b = beat) => ((x % b) + b) % b;

  const detect = () => {
    if (!analysis || !p.audio) return;
    const sr = analysis.sampleRate;
    const from = Math.floor(p.audio.sourceIn * sr);
    const est = detectTempo(analysis.mono.subarray(from, from + 120 * sr), sr);
    if (!est) return setInfo(t("Too short for detection"));
    dispatch({ type: "grid/update", patch: { bpm: est.bpm, offset: norm(p.audio.start + est.offset, 60 / est.bpm) } });
    setInfo(t("{bpm} BPM detected", { bpm: est.bpm }) + (est.confidence < 1.5 ? ` ${t("(uncertain – try ×2/÷2)")}` : ""));
  };
  const tap = () => {
    const now = performance.now();
    const list = taps.current.filter((x) => now - x < 2500);
    list.push(now);
    taps.current = list.slice(-8);
    if (taps.current.length >= 4) {
      const span = taps.current[taps.current.length - 1] - taps.current[0];
      const bpm = Math.round((60000 / (span / (taps.current.length - 1))) * 10) / 10;
      dispatch({ type: "grid/update", patch: { bpm } });
      setInfo(t("Tap: {bpm} BPM", { bpm }));
    } else setInfo(t("Tap {n}/4", { n: taps.current.length }));
  };

  return (
    <>
      <div className="pmv-section-head is-static">{t("Beat")}</div>
      <div className="pmv-grid2">
        <label>BPM</label>
        <span className="pmv-row">
          <NumField value={g.bpm} min={20} max={300} step={0.1} digits={2} onCommit={(v) => dispatch({ type: "grid/update", patch: { bpm: v } })} />
          <button className="btn btn-sm btn-secondary" title={t("Halve")} onClick={() => dispatch({ type: "grid/update", patch: { bpm: g.bpm / 2 } })}>
            ÷2
          </button>
          <button className="btn btn-sm btn-secondary" title={t("Double")} onClick={() => dispatch({ type: "grid/update", patch: { bpm: g.bpm * 2 } })}>
            ×2
          </button>
        </span>
      </div>
      <div className="pmv-row pmv-wrap">
        <button className="btn btn-sm btn-secondary" disabled={!analysis} onClick={detect} title={t("Detects the tempo from the song; was done automatically when the song was added")}>
          {t("Detect BPM")}
        </button>
        <button className="btn btn-sm btn-secondary" onClick={tap} title={t("Tap four times to the beat")}>
          {t("Tap")}
        </button>
        {info && <span className="pmv-li-meta">{info}</span>}
      </div>
      <More defaultOpen={adv}>
        <div className="pmv-grid2">
          <label>{t("Offset")}</label>
          <span className="pmv-row">
            <NumField value={g.offset} min={0} step={0.005} onCommit={(v) => dispatch({ type: "grid/update", patch: { offset: v } })} suffix="s" />
            <button className="btn btn-sm btn-secondary" title={t("Put a beat on the playhead")} onClick={() => dispatch({ type: "grid/update", patch: { offset: norm(transport.time) } })}>
              = {t("Playhead")}
            </button>
          </span>
          <label>{t("Beats per bar")}</label>
          <NumField value={g.beatsPerBar} min={1} max={16} step={1} digits={0} onCommit={(v) => dispatch({ type: "grid/update", patch: { beatsPerBar: Math.round(v) } })} />
        </div>
      </More>
    </>
  );
}
