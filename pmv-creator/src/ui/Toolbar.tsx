import React, { useEffect, useMemo, useRef, useState } from "react";
import { buildEdl } from "../export/edl";
import { buildOtio } from "../export/otio";
import { buildRenderPlan } from "../export/renderPlan";
import { t, tn } from "../i18n";
import { uid } from "../model/ids";
import { type PmvProject, createProject, migrateProject } from "../model/project";
import { type JobStatus, type ProjectSummary, type RecordingResult, type RenderResult, deleteProject, ffmpegScript, findJob, listProjects, renderResult, saveRecording, startRender, stopJob, uploadFile } from "../stash/backend";
import { useScenes } from "../stash/sceneCache";
import { rememberAdvanced } from "../state/prefs";
import { openProject, useEditor } from "../state/store";
import { formatTime } from "../timeline/time";
import type { EditMode } from "../timeline/ops";
import { Menu, Seg } from "./common";
import { downloadText, safeName } from "./download";
import { PcRender } from "./PcRender";
import { RecordCancelled, type RecordProgress, recordSequence, recordingSupported } from "./preview/recorder";

// label functions, not constants: t() needs the language, which is known only once the app runs
const modes = (): Array<[EditMode, string, string]> => [
  ["clamp", t("Snap to neighbours"), t("Clips stop at their neighbours – nothing else changes")],
  ["ripple", t("Ripple"), t("Later clips on the track move along")],
  ["overwrite", t("Overwrite"), t("Overlapped clips are trimmed or split")],
];

const divisions = (): Array<[number, string]> => [
  [4, t("Bar")],
  [2, t("½ bar")],
  [1, t("Beat")],
  [0.5, "⅛"],
  [0.25, "1/16"],
];

export function Toolbar() {
  const { state, dispatch, backend } = useEditor();
  const p = state.present;
  const ui = state.ui;
  const [renderOpen, setRenderOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [openDialog, setOpenDialog] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const base = safeName(p.name);
  const MODES = modes();

  const load = (project: PmvProject) => dispatch({ type: "project/load", project });
  const exportScript = async (shell: "sh" | "cmd") => {
    try {
      downloadText(`${base}.${shell === "sh" ? "sh" : "cmd"}`, await ffmpegScript(buildRenderPlan(p).plan, shell));
    } catch (e) {
      window.alert(t("Script export failed: {error}", { error: String(e) }));
    }
  };
  const saveLabel = { saved: t("saved"), dirty: t("changed"), saving: t("saving…"), error: t("save failed") }[ui.saveState];

  return (
    <div className="pmv-toolbar">
      <strong className="pmv-brand">PMV Creator</strong>
      <input
        className="form-control form-control-sm pmv-name"
        value={p.name}
        onChange={(e) => dispatch({ type: "project/rename", name: e.target.value })}
        onKeyDown={(e) => e.stopPropagation()}
        title={t("Project name")}
      />
      <Menu label={t("Project")}>
        {(close) => (
          <>
            <button
              className="pmv-menu-item"
              onClick={() => {
                load(createProject());
                close();
              }}
            >
              {t("New")}
            </button>
            <button
              className="pmv-menu-item"
              onClick={() => {
                setOpenDialog(true);
                close();
              }}
            >
              {t("Open…")}
            </button>
            <button
              className="pmv-menu-item"
              onClick={() => {
                importRef.current?.click();
                close();
              }}
            >
              {t("Import (.pmv.json)…")}
            </button>
            <button
              className="pmv-menu-item"
              onClick={() => {
                load({ ...structuredClone(p), id: uid("pmv"), name: t("{name} (copy)", { name: p.name }), createdAt: new Date().toISOString() });
                close();
              }}
            >
              {t("Duplicate")}
            </button>
          </>
        )}
      </Menu>
      <input
        ref={importRef}
        type="file"
        accept=".json,application/json"
        className="pmv-hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          try {
            load(migrateProject(JSON.parse(await f.text())));
          } catch (err) {
            window.alert(String(err));
          }
        }}
      />
      <span className={`pmv-save is-${ui.saveState}`} title={backend === "online" ? t("Saves on the Stash server") : t("Backend unreachable – saved in this browser only")}>
        {saveLabel}
        {backend !== "online" && ` ${t("(local)")}`}
      </span>

      <div className="pmv-btn-group">
        <button className="btn btn-sm btn-secondary" disabled={!state.past.length} onClick={() => dispatch({ type: "undo" })} title={t("Undo (Ctrl+Z)")}>
          ↶
        </button>
        <button className="btn btn-sm btn-secondary" disabled={!state.future.length} onClick={() => dispatch({ type: "redo" })} title={t("Redo (Ctrl+Y)")}>
          ↷
        </button>
      </div>

      {ui.advanced && (
        <>
          <select className="form-control form-control-sm pmv-select" value={ui.editMode} onChange={(e) => dispatch({ type: "ui", patch: { editMode: e.target.value as EditMode } })} title={MODES.find((m) => m[0] === ui.editMode)?.[2]}>
            {MODES.map(([id, label, hint]) => (
              <option key={id} value={id} title={hint}>
                {label}
              </option>
            ))}
          </select>
          <label className="pmv-check" title={t("Snap to the grid, clip edges, markers and the playhead (Shift while dragging = off)")}>
            <input type="checkbox" checked={ui.snap} onChange={(e) => dispatch({ type: "ui", patch: { snap: e.target.checked } })} /> {t("Snap")}
          </label>
          <select className="form-control form-control-sm pmv-select" value={ui.snapDivision} onChange={(e) => dispatch({ type: "ui", patch: { snapDivision: +e.target.value } })}>
            {divisions().map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
          <label className="pmv-check" title={t("Clips dropped from “My clips” get a length in whole grid steps")}>
            <input type="checkbox" checked={ui.quantizeDrops} onChange={(e) => dispatch({ type: "ui", patch: { quantizeDrops: e.target.checked } })} /> {t("Quantize length")}
          </label>
        </>
      )}

      <span className="pmv-spacer" />

      <button className="btn btn-sm btn-primary" title={t("Pick clips by criteria and cut them to the beat automatically – editable afterwards")} onClick={() => dispatch({ type: "ui", patch: { generator: {} } })}>
        ⚡ {t("Generate PMV")}
      </button>
      <Menu label={t("Export")} className="is-right">
        {(close) => (
          <>
            <button className="pmv-menu-item" onClick={() => (downloadText(`${base}.pmv.json`, JSON.stringify(p, null, 2), "application/json"), close())}>
              {t("Project (.pmv.json)")}
            </button>
            <button className="pmv-menu-item" onClick={() => (downloadText(`${base}.edl`, buildEdl(p)), close())}>
              EDL (CMX3600)
            </button>
            <button className="pmv-menu-item" onClick={() => (downloadText(`${base}.otio`, JSON.stringify(buildOtio(p), null, 2), "application/json"), close())}>
              OpenTimelineIO (.otio)
            </button>
            <button className="pmv-menu-item" onClick={() => (downloadText(`${base}.render-plan.json`, JSON.stringify(buildRenderPlan(p).plan, null, 2), "application/json"), close())}>
              {t("Render plan (.json)")}
            </button>
            <button className="pmv-menu-item" disabled={backend !== "online"} onClick={() => (void exportScript("sh"), close())}>
              {t("FFmpeg script (bash)")}
            </button>
            <button className="pmv-menu-item" disabled={backend !== "online"} onClick={() => (void exportScript("cmd"), close())}>
              {t("FFmpeg script (Windows)")}
            </button>
          </>
        )}
      </Menu>
      <button className="btn btn-sm btn-primary" onClick={() => setRenderOpen(true)}>
        {t("Render")}
      </button>
      <label className="pmv-check pmv-adv" title={t("Show all settings and tools")}>
        <input
          type="checkbox"
          checked={ui.advanced}
          onChange={(e) => {
            rememberAdvanced(e.target.checked);
            dispatch({ type: "ui", patch: { advanced: e.target.checked } });
          }}
        />{" "}
        {t("Advanced")}
      </label>
      <button className="btn btn-sm btn-secondary" title={t("Help: controls and shortcuts")} onClick={() => setHelpOpen(true)}>
        ?
      </button>
      {renderOpen && <RenderDialog onClose={() => setRenderOpen(false)} />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
      {openDialog && (
        <OpenDialog
          onClose={() => setOpenDialog(false)}
          onOpen={(project) => {
            load(project);
            setOpenDialog(false);
          }}
        />
      )}
    </div>
  );
}

/** Controls and shortcuts at a glance; the README has the long version. */
function HelpDialog({ onClose }: { onClose: () => void }) {
  const rows: Array<[string, string]> = [
    [t("Play / pause"), "Space"],
    [t("Frame ± / beat ±"), "← → / Shift+← →"],
    [t("Nudge the selected clip by a frame/beat"), "Alt+← → / Alt+Shift+← →"],
    [t("Move / trim / slip a clip"), t("drag · drag the edges · Alt+drag")],
    [t("Without snapping"), t("Shift while dragging")],
    [t("Open a clip's source"), t("double-click the clip")],
    [t("Scene in the player: in / out point · back to the PMV"), "I / O · Esc"],
    [t("Split at the playhead · replace with the selected snippet"), "S · R"],
    [t("Delete · ripple delete"), "Del · Shift+Del"],
    [t("Timeline marker"), t("M (double-click in the ruler removes it)")],
    [t("Clear selection"), "Esc"],
    [t("Undo / redo"), "Ctrl+Z / Ctrl+Y"],
    [t("Zoom"), t("Ctrl+wheel, + / − · wheel = scroll horizontally")],
    [t("Start / end"), "Home / End"],
  ];
  const steps = [
    t("Music: in the inspector (nothing selected) upload a file or enter a server path, then Detect BPM."),
    t("Scenes: search in the sidebar and add with +, or paste scene ids / Stash links. Click a scene to pick markers and ranges (I/O, Shift+drag)."),
    t("Arrange: drag snippets from the selection onto a track, or let the ⚡ Generator cut to the beat – everything stays editable."),
    t("Fine-tune: click a clip; the inspector sets start, duration, source in/out, speed, transition. Another part of the scene never moves the clip on the timeline."),
    t("Render with FFmpeg (exact) or Quick record in the browser (real time), or export EDL/OTIO."),
  ];
  return (
    <div className="pmv-modal" onClick={onClose}>
      <div className="pmv-modal-body" onClick={(e) => e.stopPropagation()}>
        <div className="pmv-section-head is-static">
          {t("Help")} <span className="pmv-spacer" />
          <button className="btn btn-sm btn-link" onClick={onClose}>
            ✕
          </button>
        </div>
        <ol className="pmv-help-steps">
          {steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
        <table className="pmv-help-keys">
          <tbody>
            {rows.map(([what, how]) => (
              <tr key={what}>
                <td>{what}</td>
                <td>
                  <code>{how}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="pmv-li-meta">
          {t("Every button has a tooltip – hover over it.")}{" "}
          <a href="https://github.com/PepegaSan/Stash-Folder-Sidebar-Plugin/blob/main/pmv-creator/README.md" target="_blank" rel="noreferrer">
            {t("Full manual (README)")}
          </a>
        </div>
      </div>
    </div>
  );
}

function OpenDialog({ onClose, onOpen }: { onClose: () => void; onOpen: (p: PmvProject) => void }) {
  const { backend, state } = useEditor();
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    if (backend !== "online") return setError(t("Backend unreachable – only import is possible."));
    listProjects().then(setList, (e) => setError(String(e)));
  };
  useEffect(refresh, [backend]);
  return (
    <div className="pmv-modal" onClick={onClose}>
      <div className="pmv-modal-body" onClick={(e) => e.stopPropagation()}>
        <div className="pmv-section-head is-static">
          {t("Open project")} <span className="pmv-spacer" />
          <button className="btn btn-sm btn-link" onClick={onClose}>
            ✕
          </button>
        </div>
        {error && <div className="pmv-error">{error}</div>}
        <ul className="pmv-list">
          {list?.length === 0 && <li className="pmv-empty">{t("No saved projects.")}</li>}
          {list?.map((x) => (
            <li key={x.id} className={`pmv-list-item ${x.id === state.present.id ? "is-selected" : ""}`} onClick={() => openProject(x.id, true).then(onOpen, (e) => setError(String(e)))}>
              <div className="pmv-li-main">
                <div className="pmv-li-title">{x.name}</div>
                <div className="pmv-li-meta">{new Date(x.updatedAt).toLocaleString()}</div>
              </div>
              {x.id !== state.present.id && (
                <button
                  className="btn btn-sm btn-link"
                  title={t("Delete")}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (window.confirm(t("Delete project “{name}”?", { name: x.name }))) void deleteProject(x.id).then(refresh);
                  }}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

type RenderTarget = "server" | "pc";
const LS_TARGET = "pmv-creator:render-target";

function readTarget(): RenderTarget {
  try {
    return localStorage.getItem(LS_TARGET) === "pc" ? "pc" : "server";
  } catch {
    return "server";
  }
}

function RenderDialog({ onClose }: { onClose: () => void }) {
  const { state, backend, ffmpegAvailable } = useEditor();
  const [{ plan, warnings }] = useState(() => buildRenderPlan(state.present));
  // where it renders: in Stash (server) or on a PC with the render helper (opt-in, remembered per browser)
  const [target, setTargetState] = useState<RenderTarget>(readTarget);
  const [helper, setHelper] = useState<{ id: string; name: string } | null>(null);
  const setTarget = (v: RenderTarget) => {
    setTargetState(v);
    try {
      localStorage.setItem(LS_TARGET, v);
    } catch {
      /* private mode */
    }
  };
  const [job, setJob] = useState<{ jobId: string; renderId: string } | null>(null);
  const [status, setStatus] = useState<JobStatus | null>(null);
  const [result, setResult] = useState<RenderResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const fps = plan.output.fps;

  useEffect(() => {
    if (!job) return;
    let alive = true;
    const poll = async () => {
      try {
        const s = await findJob(job.jobId);
        if (!alive) return;
        setStatus(s);
        // finished jobs disappear from the queue after a while, the result file stays
        if (!s || ["FINISHED", "FAILED", "CANCELLED"].includes(s.status)) {
          setResult(await renderResult(job.renderId));
          return;
        }
      } catch (e) {
        setError(String(e));
      }
      if (alive) window.setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      alive = false;
    };
  }, [job]);

  const start = async () => {
    setError(null);
    try {
      setJob(await startRender(plan, target === "pc" ? helper?.id : undefined));
    } catch (e) {
      setError(String(e));
    }
  };
  const running = (!!job && !result) || recording;
  const pc = target === "pc";
  const counts = plan.pieces.reduce<Record<string, number>>((acc, x) => ((acc[x.kind] = (acc[x.kind] ?? 0) + 1), acc), {});
  const yes = (b: boolean) => (b ? t("yes") : t("no"));

  return (
    <div className="pmv-modal" onClick={() => !running && onClose()}>
      <div className="pmv-modal-body" onClick={(e) => e.stopPropagation()}>
        <div className="pmv-section-head is-static">
          {t("Render")} <span className="pmv-spacer" />
          <button className="btn btn-sm btn-link" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="pmv-li-meta">
          {plan.output.width}×{plan.output.height} @ {fps} fps · {plan.output.videoCodec} CRF {plan.output.crf} · {(plan.totalFrames / fps).toFixed(2)} s ({tn(plan.totalFrames, "{n} frames", "1 frame")})
          <br />
          {t("{n} segments ({clips} clips, {xfades} transitions, {black} black)", { n: plan.pieces.length, clips: counts.clip ?? 0, xfades: counts.xfade ?? 0, black: counts.black ?? 0 })} · {t("music")}: {yes(!!plan.audio)} · {t("clip audio")}: {yes(plan.clipAudio)}
        </div>
        {warnings.length > 0 && (
          <ul className="pmv-warnings">
            {warnings.map((w) => (
              <li key={w}>⚠ {w}</li>
            ))}
          </ul>
        )}
        <div className="pmv-row pmv-wrap">
          <span className="pmv-gen-label">{t("Render on")}</span>
          <Seg<RenderTarget>
            value={target}
            disabled={running}
            onChange={setTarget}
            options={[
              ["server", t("Stash server"), t("FFmpeg in Stash renders the video into the output folder of the plugin settings")],
              ["pc", t("My PC"), t("The render helper on your PC renders with the PC's FFmpeg and saves the video on the PC")],
            ]}
          />
        </div>
        {pc && backend === "online" && <PcRender disabled={running} onHelper={(id, name) => setHelper(id && name ? { id, name } : null)} />}
        {backend !== "online" && <div className="pmv-error">{t("Backend unreachable. Export the render plan and render with the CLI (see README).")}</div>}
        {!pc && backend === "online" && !ffmpegAvailable && <div className="pmv-error">{t("FFmpeg was not found on the server – set its path in the plugin settings.")}</div>}
        {status && !result && (
          <div className="pmv-progress">
            <div style={{ width: `${Math.round((status.progress ?? 0) * 100)}%` }} />
            <span>
              {pc && !status.progress && status.status === "RUNNING" ? t("waiting for {pc}…", { pc: helper?.name ?? "PC" }) : `${status.status} ${Math.round((status.progress ?? 0) * 100)} %`}
            </span>
          </div>
        )}
        {result?.status === "done" && (
          <div className="pmv-success">
            {result.helper ? t("Done on {pc}:", { pc: helper?.name ?? result.helper }) : t("Done:")} <code>{result.file}</code>
            <br />
            {t("{pieces} segments, {cached} from the cache, {seconds} s", { pieces: result.pieces ?? 0, cached: result.cached ?? 0, seconds: result.seconds?.toFixed(1) ?? "?" })}
          </div>
        )}
        {result?.status === "done" && result.warning && (
          <ul className="pmv-warnings">
            <li>⚠ {result.warning}</li>
          </ul>
        )}
        {result?.status === "error" && <div className="pmv-error">{result.error}</div>}
        {status?.status === "CANCELLED" && <div className="pmv-error">{t("Cancelled.")}</div>}
        {error && <div className="pmv-error">{error}</div>}
        <div className="pmv-row">
          {!running ? (
            <button className="btn btn-sm btn-primary" disabled={backend !== "online" || !plan.pieces.length || (pc && !helper)} onClick={() => void start()}>
              {pc && helper ? t("Render on {pc}", { pc: helper.name }) : result ? t("Render again") : t("Start render")}
            </button>
          ) : (
            <button className="btn btn-sm btn-danger" onClick={() => job && void stopJob(job.jobId)}>
              {t("Cancel")}
            </button>
          )}
          <span className="pmv-li-meta">{t("Runs as a Stash task (also visible under Settings → Tasks).")}</span>
        </div>
        <QuickRecord disabled={running || !plan.pieces.length} onBusy={setRecording} />
      </div>
    </div>
  );
}

type RecordPhase = { kind: "idle" } | { kind: "recording"; p: RecordProgress } | { kind: "uploading"; pct: number } | { kind: "done"; result: RecordingResult | null; name: string } | { kind: "error"; error: string };

/**
 * Real-time browser recording of the preview (MediaRecorder, WebM). Needs no FFmpeg on the server;
 * saved to the output folder when the backend is reachable, otherwise offered as a download.
 */
function QuickRecord({ disabled, onBusy }: { disabled: boolean; onBusy: (busy: boolean) => void }) {
  const { state, transport, backend } = useEditor();
  const project = state.present;
  const scenes = useScenes(useMemo(() => Object.keys(project.sources), [project.sources]));
  const [phase, setPhase] = useState<RecordPhase>({ kind: "idle" });
  const abortRef = useRef<AbortController | null>(null);
  const supported = recordingSupported();
  const busy = phase.kind === "recording" || phase.kind === "uploading";
  useEffect(() => onBusy(busy), [busy, onBusy]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = async () => {
    const ctl = new AbortController();
    abortRef.current = ctl;
    setPhase({ kind: "recording", p: { time: 0, duration: 0 } });
    try {
      const rec = await recordSequence(project, scenes, transport, (p) => setPhase({ kind: "recording", p }), ctl.signal);
      const name = `${safeName(project.name)}.webm`;
      if (backend === "online") {
        setPhase({ kind: "uploading", pct: 0 });
        const up = await uploadFile(rec.blob, name, (pct) => setPhase({ kind: "uploading", pct }));
        setPhase({ kind: "done", result: await saveRecording(up.path, project.name), name });
      } else {
        const url = URL.createObjectURL(rec.blob);
        const a = Object.assign(document.createElement("a"), { href: url, download: name });
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setPhase({ kind: "done", result: null, name });
      }
    } catch (e) {
      setPhase(e instanceof RecordCancelled ? { kind: "idle" } : { kind: "error", error: String(e) });
    }
  };

  return (
    <div className="pmv-quickrec">
      <div className="pmv-section-head is-static">{t("Quick record (browser)")}</div>
      <div className="pmv-li-meta">{t("Plays the sequence once in this browser and records it as WebM – real time, not frame-exact: a stutter or a slow stream ends up in the video. The FFmpeg render above is the exact one.")}</div>
      {!supported && <div className="pmv-error">{t("This browser cannot record (MediaRecorder/canvas capture missing).")}</div>}
      {phase.kind === "recording" && (
        <div className="pmv-progress">
          <div style={{ width: `${phase.p.duration ? Math.round((phase.p.time / phase.p.duration) * 100) : 0}%` }} />
          <span>
            {t("Recording")} {formatTime(phase.p.time)} / {formatTime(phase.p.duration)}
          </span>
        </div>
      )}
      {phase.kind === "uploading" && (
        <div className="pmv-progress">
          <div style={{ width: `${Math.round(phase.pct * 100)}%` }} />
          <span>{t("Upload {pct} %", { pct: Math.round(phase.pct * 100) })}</span>
        </div>
      )}
      {phase.kind === "done" && (
        <div className="pmv-success">
          {t("Done:")} <code>{phase.result?.file ?? phase.name}</code>
          {phase.result?.seconds != null && <> · {phase.result.seconds.toFixed(1)} s</>}
          {!phase.result && <> · {t("downloaded (backend unreachable)")}</>}
        </div>
      )}
      {phase.kind === "done" && phase.result?.warning && (
        <ul className="pmv-warnings">
          <li>⚠ {phase.result.warning}</li>
        </ul>
      )}
      {phase.kind === "error" && <div className="pmv-error">{phase.error}</div>}
      <div className="pmv-row">
        {!busy ? (
          <button className="btn btn-sm btn-secondary" disabled={disabled || !supported} onClick={() => void start()}>
            ⏺ {phase.kind === "done" ? t("Record again") : t("Record")}
          </button>
        ) : (
          <button className="btn btn-sm btn-danger" onClick={() => abortRef.current?.abort()}>
            {t("Cancel")}
          </button>
        )}
        <span className="pmv-li-meta">{t("Keep this tab in the foreground while it records.")}</span>
      </div>
    </div>
  );
}
