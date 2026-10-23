import React, { useEffect, useMemo, useRef, useState } from "react";
import { buildEdl } from "../export/edl";
import { buildOtio } from "../export/otio";
import { buildRenderPlan } from "../export/renderPlan";
import { t, tn } from "../i18n";
import { uid } from "../model/ids";
import { type PmvProject, createProject, migrateProject } from "../model/project";
import { type ProjectSummary, type RecordingResult, deleteProject, ffmpegScript, listProjects, saveRecording, startRender, stopJob, uploadFile } from "../stash/backend";
import { useScenes } from "../stash/sceneCache";
import { rememberAdvanced } from "../state/prefs";
import { openProject, useEditor } from "../state/store";
import { formatTime } from "../timeline/time";
import type { EditMode } from "../timeline/ops";
import { Menu, Seg } from "./common";
import { downloadText, safeName } from "./download";
import { PcRender } from "./PcRender";
import { useHost } from "../host";
import { type LabelStatus, labelFor, labelJob, labelingOn, queueLabel, setLabelingOn, watchLabel } from "./labels";
import { desktopNotifications, isActive, listRenders, notifyOn, primeSignal, setNotifyOn, watchRender } from "./renders";
import { RenderTray, useRenders } from "./RenderTray";
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
            <button
              className="pmv-menu-item"
              disabled={backend !== "online"}
              title={t("Pick several songs – each becomes a PMV with the same generator settings, rendered one after another")}
              onClick={() => {
                dispatch({ type: "ui", patch: { batch: { settings: null } } });
                close();
              }}
            >
              📦 {t("Several PMVs at once…")}
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
      <RenderTray />
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
  // the keys depend on what the main player shows: the PMV or a scene (Space, ←/→ and Esc differ)
  const sections: Array<[string, Array<[string, string]>]> = [
    [
      t("Timeline and PMV preview"),
      [
        [t("Play / pause"), t("Space")],
        [t("Frame ± / beat ±"), "← → / Shift+← →"],
        [t("Nudge the selected clip by a frame/beat"), "Alt+← → / Alt+Shift+← →"],
        [t("Move / trim / slip a clip"), t("drag · drag the edges · Alt+drag")],
        [t("Without snapping"), t("Shift while dragging")],
        [t("Show a clip's scene in the big player"), t("✎ Edit source · double-click the clip")],
        [t("Split at the playhead · replace with the clip selected under “My clips”"), "S · R"],
        [t("Another clip for the selected one · keep it when generating again"), "N · P"],
        [t("Previous / next cut: select the clip, play from a second before it"), t("[ ] or ↑ ↓ · ⏮ ⏭ above the timeline")],
        [t("Delete · ripple delete"), t("Del · Shift+Del")],
        [t("Timeline marker"), t("M (double-click in the ruler removes it)")],
        [t("Clear selection"), "Esc"],
        [t("Undo / redo"), t("Ctrl+Z / Ctrl+Y")],
        [t("Zoom"), t("Ctrl+wheel, + / − · wheel = scroll horizontally")],
        [t("Start / end"), t("Home / End")],
      ],
    ],
    [
      t("Scene in the big player"),
      [
        [t("Play / pause the scene"), t("Space")],
        [t("Frame ± / second ±"), "← → / Shift+← →"],
        [t("In / out point of the range"), "I / O"],
        [t("Pick a range with the mouse"), t("Shift+drag on the bar")],
        [t("Another part for the selected clip"), t("drag the orange range")],
        [t("Back to the PMV preview"), t("Esc · “Back to the PMV” above the timeline")],
      ],
    ],
  ];
  const steps = [
    t("Music: in the inspector (nothing selected) upload a file or enter a server path, then Detect BPM."),
    t("Scenes: search in the sidebar and add with +, or paste scene ids / Stash links. Click a scene to pick markers and ranges (I/O, Shift+drag)."),
    t("Arrange: drag snippets from the selection onto a track, or let the ⚡ Generator cut to the beat – everything stays editable."),
    t("Fine-tune: click a clip; the inspector sets start, duration, speed and framing. “✎ Edit source” shows its scene in the big player – pick another spot there, the clip keeps its place on the timeline."),
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
          {sections.map(([title, rows]) => (
            <tbody key={title}>
              <tr>
                <th colSpan={2}>{title}</th>
              </tr>
              {rows.map(([what, how]) => (
                <tr key={what}>
                  <td>{what}</td>
                  <td>
                    <code>{how}</code>
                  </td>
                </tr>
              ))}
            </tbody>
          ))}
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

export type RenderTarget = "server" | "pc";
const LS_TARGET = "pmv-creator:render-target";

export function readTarget(): RenderTarget {
  try {
    return localStorage.getItem(LS_TARGET) === "pc" ? "pc" : "server";
  } catch {
    return "server";
  }
}

export function rememberTarget(v: RenderTarget): void {
  try {
    localStorage.setItem(LS_TARGET, v);
  } catch {
    /* private mode */
  }
}

export function RenderTargetSeg({ value, disabled, onChange }: { value: RenderTarget; disabled: boolean; onChange: (v: RenderTarget) => void }) {
  return (
    <Seg<RenderTarget>
      value={value}
      disabled={disabled}
      onChange={onChange}
      options={[
        ["server", t("Stash server"), t("FFmpeg in Stash renders the video into the output folder of the plugin settings")],
        ["pc", t("My PC"), t("The render helper on your PC renders with the PC's FFmpeg and saves the video on the PC")],
      ]}
    />
  );
}

/** 🏷 How far labeling the finished video in Stash is (see labels.ts) – or why it isn't labeled. */
function LabelLine({ file, scanned, pc, wanted }: { file: string | undefined; scanned: boolean; pc: boolean; wanted: boolean }) {
  const host = useHost();
  const [status, setStatus] = useState<LabelStatus | null>(null);
  const queued = wanted && scanned && !!file;
  useEffect(() => (queued && file ? watchLabel(file, setStatus) : undefined), [queued, file]);
  if (!wanted) return null;
  if (!queued) {
    return <div className="pmv-li-meta">🏷 {pc ? t("Not labeled: the video is on the PC outside the folders Stash sees (a mapped folder would be).") : t("Not labeled: Stash doesn't scan the video (plugin setting “Scan after rendering”, output folder inside a library).")}</div>;
  }
  if (!status || status.state === "waiting") return <div className="pmv-li-meta">🏷 {t("Waiting for Stash's scan to label the PMV…")}</div>;
  if (status.state === "error") return <div className="pmv-error">🏷 {status.error}</div>;
  return (
    <div className="pmv-success">
      🏷 {t("Labeled in Stash: title, {p} performers, {t} shared tags.", { p: status.performers, t: status.tags })}{" "}
      <a href={host.sceneHref(status.sceneId)} target="_blank" rel="noreferrer">
        {t("Open in Stash")} ↗
      </a>
    </div>
  );
}

/** 🏷 / 🔔 above the render button – the same two choices for one PMV and for several (BatchDialog). */
export function AfterRender({ label, onLabel, notify, onNotify }: { label: boolean; onLabel: (v: boolean) => void; notify: boolean; onNotify: (v: boolean) => void }) {
  const desktop = desktopNotifications();
  return (
    <>
      <label className="pmv-check" title={t("Once Stash has scanned the video: the project name as title, the performers of its scenes, the tags most of them share and the tag “PMV Creator”")}>
        <input
          type="checkbox"
          checked={label}
          onChange={(e) => {
            setLabelingOn(e.target.checked);
            onLabel(e.target.checked);
          }}
        />{" "}
        🏷 {t("Label it in Stash (title, performers, tags)")}
      </label>
      <label className="pmv-check" title={t("A chime and the tab title when the render is done – also while you are in another tab; a desktop notification where the browser allows it")}>
        <input
          type="checkbox"
          checked={notify}
          onChange={(e) => {
            setNotifyOn(e.target.checked);
            onNotify(e.target.checked);
          }}
        />{" "}
        🔔 {t("Tell me when it is done")}
      </label>
      {notify && desktop === "unavailable" && <div className="pmv-li-meta">{t("Desktop notifications only work over HTTPS (or localhost) – here you get the chime and the tab title.")}</div>}
      {notify && desktop === "denied" && <div className="pmv-li-meta">{t("The browser blocks notifications for this page – the chime and the tab title still work.")}</div>}
    </>
  );
}

function RenderDialog({ onClose }: { onClose: () => void }) {
  const { state, backend, ffmpegAvailable } = useEditor();
  const [{ plan, warnings }] = useState(() => buildRenderPlan(state.present));
  const [label, setLabel] = useState(labelingOn);
  const [notify, setNotify] = useState(notifyOn);
  // where it renders: in Stash (server) or on a PC with the render helper (opt-in, remembered per browser)
  const [target, setTargetState] = useState<RenderTarget>(readTarget);
  const [helper, setHelper] = useState<{ id: string; name: string } | null>(null);
  const setTarget = (v: RenderTarget) => {
    setTargetState(v);
    rememberTarget(v);
  };
  // the render runs on without this dialog (renders.ts); reopened, the dialog shows it again
  const [renderId, setRenderId] = useState<string | null>(() => listRenders().find((r) => r.projectId === state.present.id && isActive(r))?.renderId ?? null);
  const r = useRenders().find((x) => x.renderId === renderId) ?? null;
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const fps = plan.output.fps;

  const start = async () => {
    setError(null);
    primeSignal();
    try {
      const p = state.present;
      const job = await startRender(plan, target === "pc" ? helper?.id : undefined);
      watchRender({ ...job, name: p.name, projectId: p.id, pc: target === "pc" ? (helper?.name ?? null) : null, label: label ? labelFor(p) : null });
      setRenderId(job.renderId);
    } catch (e) {
      setError(String(e));
    }
  };
  const active = !!r && isActive(r);
  const result = r && !active ? (r.result ?? null) : null;
  const pc = target === "pc";
  const counts = plan.pieces.reduce<Record<string, number>>((acc, x) => ((acc[x.kind] = (acc[x.kind] ?? 0) + 1), acc), {});
  const yes = (b: boolean) => (b ? t("yes") : t("no"));

  return (
    <div className="pmv-modal" onClick={() => !recording && onClose()}>
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
          <RenderTargetSeg value={target} disabled={active || recording} onChange={setTarget} />
        </div>
        {pc && backend === "online" && <PcRender disabled={active || recording} onHelper={(id, name) => setHelper(id && name ? { id, name } : null)} />}
        <AfterRender label={label} onLabel={setLabel} notify={notify} onNotify={setNotify} />
        {backend !== "online" && <div className="pmv-error">{t("Backend unreachable. Export the render plan and render with the CLI (see README).")}</div>}
        {!pc && backend === "online" && !ffmpegAvailable && <div className="pmv-error">{t("FFmpeg was not found on the server – set its path in the plugin settings.")}</div>}
        {r && active && (
          <>
            <div className="pmv-progress">
              <div style={{ width: `${Math.round(r.progress * 100)}%` }} />
              <span>{r.state === "queued" ? t("waiting in Stash's task queue") : r.pc && !r.progress ? t("waiting for {pc}…", { pc: r.pc }) : `${Math.round(r.progress * 100)} %`}</span>
            </div>
            <div className="pmv-li-meta">{t("You can close this window – the render goes on; ⏳ in the toolbar shows how far it is.")}</div>
          </>
        )}
        {result?.status === "done" && (
          <div className="pmv-success">
            {result.helper ? t("Done on {pc}:", { pc: r?.pc ?? result.helper }) : t("Done:")} <code>{result.file}</code>
            <br />
            {t("{pieces} segments, {cached} from the cache, {seconds} s", { pieces: result.pieces ?? 0, cached: result.cached ?? 0, seconds: result.seconds?.toFixed(1) ?? "?" })}
          </div>
        )}
        {result?.status === "done" && result.warning && (
          <ul className="pmv-warnings">
            <li>⚠ {result.warning}</li>
          </ul>
        )}
        {result?.status === "done" && r && <LabelLine key={r.renderId} file={r.file} scanned={!!result.scanned} pc={!!result.helper} wanted={!!r.label} />}
        {r?.state === "error" && <div className="pmv-error">{r.error}</div>}
        {r?.state === "cancelled" && <div className="pmv-error">{t("Cancelled.")}</div>}
        {error && <div className="pmv-error">{error}</div>}
        <div className="pmv-row">
          {!active ? (
            <button className="btn btn-sm btn-primary" disabled={backend !== "online" || !plan.pieces.length || (pc && !helper) || recording} onClick={() => void start()}>
              {pc && helper ? t("Render on {pc}", { pc: helper.name }) : r ? t("Render again") : t("Start render")}
            </button>
          ) : (
            <button className="btn btn-sm btn-danger" onClick={() => r && void stopJob(r.jobId)}>
              {t("Cancel")}
            </button>
          )}
          <span className="pmv-li-meta">{t("Runs as a Stash task (also visible under Settings → Tasks).")}</span>
        </div>
        <QuickRecord disabled={active || !plan.pieces.length} onBusy={setRecording} />
      </div>
    </div>
  );
}

type RecordPhase = { kind: "idle" } | { kind: "recording"; p: RecordProgress } | { kind: "uploading"; pct: number } | { kind: "done"; result: RecordingResult | null; name: string; labeled: boolean } | { kind: "error"; error: string };

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
        const result = await saveRecording(up.path, project.name);
        const labeled = labelingOn();
        if (labeled && result.scanned && result.file) queueLabel(labelJob(project, result.file));
        setPhase({ kind: "done", result, name, labeled });
      } else {
        const url = URL.createObjectURL(rec.blob);
        const a = Object.assign(document.createElement("a"), { href: url, download: name });
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        setPhase({ kind: "done", result: null, name, labeled: false });
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
      {phase.kind === "done" && phase.result && <LabelLine key={phase.result.file} file={phase.result.file} scanned={!!phase.result.scanned} pc={false} wanted={phase.labeled} />}
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
