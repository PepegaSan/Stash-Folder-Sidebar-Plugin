/**
 * 📦 Several PMVs at once: pick songs, and each becomes its own project with the same generator settings (a preset or
 * the last ones) – generated here one after the other, saved, and handed to Stash as renders. Stash runs its tasks one
 * at a time, so the renders queue up and go on without this tab (e.g. overnight on the PC with the render helper).
 */
import React, { useEffect, useRef, useState } from "react";
import { buildRenderPlan } from "../export/renderPlan";
import { type GeneratorSettings, MOODS, applyGeneration } from "../generator/generate";
import { t, tn } from "../i18n";
import { type PmvProject, createAudioTrack, createProject } from "../model/project";
import { type LibrarySong, type MediaResult, type PresetEntry, listPresets, saveProject, startRender, uploadAudio } from "../stash/backend";
import { openProject, useEditor } from "../state/store";
import { cutsToMusic, loadSaved, withPreset } from "./generator/GeneratorDialog";
import { runGenerator } from "./generator/run";
import { forgetAudioAnalysis, getAudioAnalysis } from "./hooks";
import { labelFor, labelingOn } from "./labels";
import { detectSongGrid } from "./music";
import { PcRender } from "./PcRender";
import { isActive, notifyOn, primeSignal, watchRender } from "./renders";
import { useRenders } from "./RenderTray";
import { SongLibraryDialog } from "./SongLibrary";
import { AfterRender, type RenderTarget, RenderTargetSeg, readTarget, rememberTarget } from "./Toolbar";

interface Song {
  key: string;
  name: string;
  /** A song from the library … */
  media?: Pick<MediaResult, "name" | "path" | "url" | "duration">;
  /** … or a file to upload first. */
  file?: File;
}

type Step = { phase: "waiting" | "upload" | "analyse" | "generate" | "render" | "skipped"; text?: string } | { phase: "queued"; renderId: string; projectId: string } | { phase: "error"; error: string };

const stripExt = (name: string) => name.replace(/\.[^.]{1,5}$/, "");
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One line about what the settings pick: the mood and where the clips come from. */
function describe(s: GeneratorSettings, p: PmvProject): string {
  const mood = s.mood === "custom" ? t("Custom") : t(MOODS[s.mood].label);
  const c = s.clips;
  const names = (refs: Array<{ name: string }>) => refs.map((r) => r.name).join(", ");
  let clips: string;
  if (c.source === "saved") clips = t("saved filter “{name}”", { name: c.savedFilter?.name ?? "?" });
  else if (c.source === "watched") clips = t("Most watched");
  else if (c.source === "project") clips = t("Project scenes");
  else if (c.source === "bin") clips = t("My clips ({n})", { n: p.bin.length });
  else clips = [names(c.tags), names(c.performers)].filter(Boolean).join(" · ") || t("the whole library");
  const count = c.source === "filter" || c.source === "saved" || c.source === "watched" ? ` · ${t("up to {n} scenes", { n: c.limit })}` : "";
  return `${mood} · ${clips}${count}`;
}

export function BatchDialog() {
  const { state, getState, dispatch, backend, ffmpegAvailable } = useEditor();
  const base = state.present;
  const defaultTrack = base.tracks[base.tracks.length - 1].id;
  const [initial] = useState<GeneratorSettings>(() => state.ui.batch?.settings ?? loadSaved(defaultTrack, base.tracks.map((x) => x.id)));
  const [presets, setPresets] = useState<PresetEntry[]>([]);
  const [presetName, setPresetName] = useState("");
  const [songs, setSongs] = useState<Song[]>([]);
  const [library, setLibrary] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [target, setTargetState] = useState<RenderTarget>(readTarget);
  const [helper, setHelper] = useState<{ id: string; name: string } | null>(null);
  const [label, setLabel] = useState(labelingOn);
  const [notify, setNotify] = useState(notifyOn);
  const [steps, setSteps] = useState<Record<string, Step>>({});
  const [busy, setBusy] = useState(false);
  const stopRef = useRef(false);
  const renders = useRenders();

  useEffect(() => {
    listPresets().then((x) => setPresets(Array.isArray(x) ? x : []), () => setPresets([]));
  }, []);

  const chosen = presetName ? presets.find((p) => p.name === presetName) : null;
  const picked = chosen ? withPreset(initial, chosen.settings as Partial<GeneratorSettings>) : initial;
  // "cuts like another PMV" belongs to that PMV's song – every other song is cut to its own music
  const fromPmv = picked.cut.mode === "template";
  const settings = fromPmv ? cutsToMusic(picked) : picked;
  const pc = target === "pc";
  const started = Object.keys(steps).length > 0;
  const close = () => {
    if (busy && !window.confirm(t("Stop after the song that is being made right now?"))) return;
    stopRef.current = true;
    dispatch({ type: "ui", patch: { batch: null } });
  };

  const addSongs = (list: Song[]) => setSongs((x) => [...x, ...list.filter((s) => !x.some((y) => y.key === s.key))]);
  const fromLibrary = (list: LibrarySong[]) => {
    setLibrary(false);
    addSongs(list.map((s) => ({ key: s.path, name: s.name, media: { name: s.name, path: s.path, url: s.url, duration: null } })));
  };
  const set = (key: string, step: Step) => setSteps((x) => ({ ...x, [key]: step }));

  /** One song -> a generated, saved project -> a render in Stash's queue. */
  const makeOne = async (song: Song, i: number, batch: string): Promise<void> => {
    let media = song.media;
    if (!media) {
      set(song.key, { phase: "upload", text: "0 %" });
      media = await uploadAudio(song.file!, (p) => set(song.key, { phase: "upload", text: `${Math.round(p * 100)} %` }));
    }
    set(song.key, { phase: "analyse" });
    let p = createProject(t("PMV – {name}", { name: stripExt(media.name) }));
    let out;
    try {
      const a = await getAudioAnalysis(media.url);
      const grid = detectSongGrid(a, 0);
      p = {
        ...p,
        output: { ...base.output },
        audio: createAudioTrack(media.name, media.path, media.url, Math.max(a.duration, media.duration ?? 0)),
        beatGrid: grid ? { ...p.beatGrid, bpm: grid.bpm, offset: grid.offset } : p.beatGrid,
        // clips from this project's scenes or "My clips": those come along
        ...(settings.clips.source === "project" || settings.clips.source === "bin" ? { sources: base.sources, bin: base.bin, exclusions: base.exclusions } : {}),
      };
      set(song.key, { phase: "generate" });
      const trackId = p.tracks[p.tracks.length - 1].id;
      // another seed per song, so the PMVs don't all start with the same scenes
      const run = { ...settings, seed: settings.seed + i, target: { ...settings.target, range: "song" as const, trackId, replaceTrack: true } };
      out = await runGenerator(p, run, 0, (text) => set(song.key, { phase: "generate", text }));
    } finally {
      // one decoded song at a time, not the whole batch in memory – unless it is the editor's own song
      if (getState().present.audio?.url !== media.url) forgetAudioAnalysis(media.url);
    }
    if (!out.result.clips.length) throw new Error(t("No clips came out of this."));
    p = { ...applyGeneration(p, out.result), updatedAt: new Date().toISOString() };
    set(song.key, { phase: "render" });
    await saveProject(p);
    const job = await startRender(buildRenderPlan(p).plan, pc ? helper?.id : undefined);
    watchRender({ ...job, name: p.name, projectId: p.id, pc: pc ? (helper?.name ?? null) : null, label: label ? labelFor(p) : null, batch });
    set(song.key, { phase: "queued", renderId: job.renderId, projectId: p.id });
  };

  const startAll = async () => {
    primeSignal();
    stopRef.current = false;
    setBusy(true);
    setSteps(Object.fromEntries(songs.map((s) => [s.key, { phase: "waiting" } as Step])));
    const batch = `batch_${Date.now().toString(36)}`;
    for (const [i, song] of songs.entries()) {
      if (stopRef.current) {
        set(song.key, { phase: "skipped" });
        continue;
      }
      try {
        await makeOne(song, i, batch);
      } catch (e) {
        set(song.key, { phase: "error", error: message(e) });
      }
    }
    setBusy(false);
  };

  const open = (projectId: string) =>
    void openProject(projectId, true).then(
      (project) => {
        dispatch({ type: "project/load", project });
        dispatch({ type: "ui", patch: { batch: null } });
      },
      (e) => window.alert(String(e)),
    );

  const stepText = (song: Song): React.ReactNode => {
    const st = steps[song.key];
    if (!st) return song.file ? t("will be uploaded") : t("from the library");
    switch (st.phase) {
      case "waiting":
        return t("waiting");
      case "skipped":
        return t("stopped – not made");
      case "upload":
        return t("Upload {pct} %", { pct: (st.text ?? "0").replace(/ %$/, "") });
      case "analyse":
        return t("Analysing…");
      case "generate":
        return st.text ? `⚡ ${st.text}` : `⚡ ${t("Generating…")}`;
      case "render":
        return t("Saving and handing it to Stash…");
      case "error":
        return <span className="pmv-error">⚠ {st.error}</span>;
      case "queued": {
        const r = renders.find((x) => x.renderId === st.renderId);
        if (!r) return t("handed to Stash");
        if (r.state === "queued") return t("waiting in Stash's task queue");
        if (r.state === "running") return r.pc && !r.progress ? t("waiting for {pc}…", { pc: r.pc }) : `⏳ ${Math.round(r.progress * 100)} %`;
        if (r.state === "done") return <span className="pmv-success">✓ {t("rendered")}</span>;
        if (r.state === "cancelled") return t("Cancelled.");
        return <span className="pmv-error">⚠ {r.error}</span>;
      }
    }
  };

  const queued = Object.values(steps).filter((x) => x.phase === "queued");
  const allDone = started && !busy && queued.length > 0;
  const stillRendering = queued.some((x) => x.phase === "queued" && renders.some((r) => r.renderId === x.renderId && isActive(r)));

  return (
    <div className="pmv-modal" onClick={() => !busy && close()}>
      <div className="pmv-modal-body pmv-batch" onClick={(e) => e.stopPropagation()}>
        <div className="pmv-section-head is-static">
          📦 {t("Several PMVs at once")} <span className="pmv-spacer" />
          <button className="btn btn-sm btn-link" onClick={close}>
            ✕
          </button>
        </div>
        <div className="pmv-li-meta">{t("Every song becomes its own PMV with the same settings. Each is saved as a project (fine-tune it later) and rendered – one after another, in Stash's task queue.")}</div>

        <div className="pmv-grid2">
          <label>{t("Settings")}</label>
          <select className="form-control form-control-sm" value={presetName} disabled={busy} onChange={(e) => setPresetName(e.target.value)}>
            <option value="">{state.ui.batch?.settings ? t("As set in the generator") : t("As last used in the generator")}</option>
            {presets.map((p) => (
              <option key={p.name} value={p.name}>
                {t("Preset: {name}", { name: p.name })}
              </option>
            ))}
          </select>
          <span />
          <span className="pmv-li-meta">
            {describe(settings, base)}
            {fromPmv && ` · ${t("cut to each song's music (cuts like another PMV only fit that PMV's song)")}`}
          </span>
        </div>

        <div className="pmv-gen-h">{t("Songs")}</div>
        <ul className="pmv-list pmv-batch-songs">
          {!songs.length && <li className="pmv-empty">{t("No songs yet – add some from the library or upload them.")}</li>}
          {songs.map((s) => {
            const st = steps[s.key];
            return (
              <li key={s.key} className="pmv-list-item">
                <div className="pmv-li-main">
                  <div className="pmv-li-title" title={s.name}>
                    ♪ {stripExt(s.name)}
                  </div>
                  <div className="pmv-li-meta">{stepText(s)}</div>
                </div>
                {st?.phase === "queued" && (
                  // not while the rest of the batch is still being made – opening it closes this dialog
                  <button className="btn btn-sm btn-link" disabled={busy} title={busy ? t("When all songs are made") : t("Open its project in the editor")} onClick={() => open(st.projectId)}>
                    ✎
                  </button>
                )}
                {!started && (
                  <button className="btn btn-sm btn-link" title={t("Remove")} onClick={() => setSongs((x) => x.filter((y) => y.key !== s.key))}>
                    ✕
                  </button>
                )}
              </li>
            );
          })}
        </ul>
        {!started && (
          <div className="pmv-row">
            <button className="btn btn-sm btn-secondary" onClick={() => setLibrary(true)}>
              🎵 {t("From the library…")}
            </button>
            <button className="btn btn-sm btn-secondary" onClick={() => fileRef.current?.click()}>
              ⬆ {t("Upload…")}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="audio/*,.mp3,.m4a,.wav,.flac,.ogg,.opus"
              className="pmv-hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                addSongs(files.map((f) => ({ key: `file:${f.name}:${f.size}`, name: f.name, file: f })));
              }}
            />
          </div>
        )}

        {!started && (
          <>
            <div className="pmv-row pmv-wrap">
              <span className="pmv-gen-label">{t("Render on")}</span>
              <RenderTargetSeg
                value={target}
                disabled={busy}
                onChange={(v) => {
                  setTargetState(v);
                  rememberTarget(v);
                }}
              />
            </div>
            {pc && <PcRender disabled={busy} onHelper={(id, name) => setHelper(id && name ? { id, name } : null)} />}
            <AfterRender label={label} onLabel={setLabel} notify={notify} onNotify={setNotify} />
            {!pc && !ffmpegAvailable && <div className="pmv-error">{t("FFmpeg was not found on the server – set its path in the plugin settings.")}</div>}
            {settings.clips.source === "saved" && !settings.clips.savedFilter && <div className="pmv-error">{t("Pick one of your saved filters first.")}</div>}
          </>
        )}

        {allDone && <div className="pmv-success">✓ {tn(queued.length, "{n} PMVs are in Stash's queue.", "1 PMV is in Stash's queue.")}</div>}
        {allDone && stillRendering && <div className="pmv-li-meta">{t("Stash renders them one after another, also when this tab is closed. With the editor open you hear when each is done and they get labeled right away; otherwise the labels follow the next time it opens. ⏳ in the toolbar shows them.")}</div>}

        <div className="pmv-row">
          {!started ? (
            <button
              className="btn btn-primary"
              disabled={backend !== "online" || !songs.length || (pc && !helper) || (!pc && !ffmpegAvailable) || (settings.clips.source === "saved" && !settings.clips.savedFilter)}
              onClick={() => void startAll()}
            >
              ⚡ {songs.length ? tn(songs.length, "Make {n} PMVs and render them", "Make 1 PMV and render it") : t("Make PMVs")}
            </button>
          ) : busy ? (
            <button className="btn btn-secondary" onClick={() => (stopRef.current = true)} title={t("The song being made now is finished, the rest is left out")}>
              ■ {t("Stop after this song")}
            </button>
          ) : null}
          <span className="pmv-spacer" />
          <button className="btn btn-secondary" disabled={busy} onClick={close}>
            {t("Close")}
          </button>
        </div>
        {library && <SongLibraryDialog current={null} onClose={() => setLibrary(false)} onPickMany={fromLibrary} />}
      </div>
    </div>
  );
}
