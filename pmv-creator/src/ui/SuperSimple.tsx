import React, { useEffect, useRef, useState } from "react";
import { t, tn } from "../i18n";
import { createProject, type PmvProject } from "../model/project";
import { checkpointProject, useEditor } from "../state/store";
import { More } from "./common";
import { SuperQuestions } from "./SuperQuestions";
import { downloadText, safeName } from "./download";
import { runGenerator } from "./generator/run";
import { useMusic } from "./music";
import { PreviewPlayer } from "./preview/PreviewPlayer";
import { RenderTray } from "./RenderTray";
import { SongLibraryButton } from "./SongLibrary";
import { loadSuperDraft, saveSuperDraft, superSettings, type SuperDraft } from "./superSetup";
import { RenderDialog } from "./Toolbar";
import { ViewModeSwitch } from "./ViewModeSwitch";
import { ClearTimelineButton } from "./timeline/ClearTimelineButton";

type Step = "music" | "material" | "review";
const hasClips = (p: PmvProject) => p.tracks.some((tr) => tr.clips.length > 0);
const nextStep = (p: PmvProject): Step => hasClips(p) ? "review" : p.audio ? "material" : "music";

/** One current task, with the existing generator, project, preview and render pipeline underneath. */
export function SuperSimple() {
  const { state, getState, dispatch, transport, backend } = useEditor();
  const p = state.present;
  const music = useMusic();
  const [step, setStep] = useState<Step | "start">(() => hasClips(p) || p.audio ? "start" : "music");
  const [beforeClear, setBeforeClear] = useState<PmvProject | null>(null);
  const [draft, setDraft] = useState(() => loadSuperDraft(p.id, state.ui.clipPreset));
  const [busy, setBusy] = useState<string | null>(null);
  const [musicBusy, setMusicBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedWhere, setSavedWhere] = useState<"server" | "browser" | null>(null);
  const [renderOpen, setRenderOpen] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const running = useRef<{ cancelled: boolean } | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; if (running.current) running.current.cancelled = true; transport.pause(); };
  }, [transport]);
  useEffect(() => {
    if (state.ui.clipPreset) setDraft(loadSuperDraft(p.id, state.ui.clipPreset));
  }, [p.id, state.ui.clipPreset]);
  useEffect(() => saveSuperDraft(p.id, draft), [p.id, draft]);
  useEffect(() => {
    if (p.audio && p.name === t("New PMV")) dispatch({ type: "project/rename", name: p.audio.name.replace(/\.[^.]+$/, "") });
  }, [p.audio?.path, p.name, dispatch]);

  const editMaterial = (next: SuperDraft) => {
    if (state.ui.clipPreset) dispatch({ type: "ui", patch: { clipPreset: null } });
    setDraft(next);
  };

  const prepareMusic = async (action: () => Promise<void>) => {
    if (musicBusy) return;
    setMusicBusy(true);
    try { await action(); } finally { if (alive.current) setMusicBusy(false); }
  };

  const generate = async () => {
    if (running.current) return;
    const original = getState().present;
    if (!original.audio || hasClips(original)) return;
    const token = { cancelled: false };
    running.current = token;
    setError(null);
    setBusy(t("Starting…"));
    transport.pause();
    try {
      const result = await runGenerator(original, superSettings(original, draft), 0, (message) => {
        if (token.cancelled || !alive.current) throw new Error("cancelled");
        setBusy(message);
      });
      if (token.cancelled || !alive.current || getState().present !== original) return;
      if (!result.result.clips.length) throw new Error(t("No suitable clips found. Adjust the material and try again."));
      dispatch({ type: "generate/apply", result: result.result });
      dispatch({ type: "ui", patch: { clipPreset: null } });
      transport.seek(0);
      setStep("review");
    } catch (e) {
      if (!token.cancelled && alive.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (running.current === token) running.current = null;
      if (alive.current) setBusy(null);
    }
  };

  const pause = async () => {
    if (saving || musicBusy) return;
    if (running.current) { running.current.cancelled = true; setBusy(t("Stopping…")); }
    transport.pause();
    setSaving(true);
    setError(null);
    const current = getState().present;
    const where = await checkpointProject(current, backend === "online");
    if (!alive.current) return;
    setSaving(false);
    if (!where) { setError(t("Saving failed. Keep this page open or download the project.")); return; }
    setSavedWhere(where);
    setPaused(true);
  };

  const startNew = async () => {
    if (saving) return;
    const current = getState().present;
    transport.pause();
    setError(null);
    setSaving(true);
    // The project picker lists server projects. Keep the current project open
    // if only its browser copy is available instead of stranding that copy.
    const where = await checkpointProject(current, backend === "online");
    if (!alive.current) return;
    setSaving(false);
    if (where !== "server") { setError(t("Could not save this project to Stash. It is still open.")); return; }
    if (getState().present !== current) return;
    transport.seek(0);
    dispatch({ type: "project/load", project: createProject() });
  };

  const scenes = Object.keys(p.sources).length;
  const selectedSource = draft.tags.length || draft.performers.length ? t("Matching videos from your library") : draft.source === "auto" && scenes ? tn(scenes, "{n} project scenes", "1 project scene") : t("Videos from your library");
  const index = step === "review" ? 3 : step === "material" ? 2 : 1;

  return <div className="pmv-super">
    <header className="pmv-toolbar pmv-super-toolbar">
      <strong className="pmv-brand">PMV Creator</strong>
      <ViewModeSwitch disabled={!!busy || musicBusy || saving} />
      <span className="pmv-super-name">{p.name}</span>
      <span className="pmv-spacer" />
      {!musicBusy && !saving && <RenderTray />}
      <button className="btn btn-sm btn-secondary" disabled={saving || musicBusy} onClick={() => void pause()}>{saving ? t("saving…") : t("Save & pause")}</button>
    </header>
    <main className="pmv-super-main">
      {saving ? <section className="pmv-super-card" role="status">{t("saving…")}</section> : paused ? <section className="pmv-super-card">
        <h2>{t("Saved. That is enough for now.")}</h2>
        <p>{savedWhere === "browser" ? t("Saved in this browser. Reopen PMV Creator here to continue.") : t("Your project is saved. Reopen PMV Creator to continue here.")}</p>
        <button className="btn btn-primary pmv-super-primary" disabled={!!busy} onClick={() => setPaused(false)}>{busy ? t("Stopping…") : t("Continue here")}</button>
      </section> : <section className="pmv-super-card" aria-busy={!!busy || musicBusy}>
        <div className="pmv-super-step">{t("Step {n} of 3", { n: index })} · {t("Super simple")}</div>
        <h2>{step === "start" || step === "music" ? t("Choose one song") : step === "material" ? t("Let the music guide the cut") : t("Watch your suggestion")}</h2>
        {step === "start" && <>
          <p>{t("Start with a new song, or continue “{name}”.", { name: p.name })}</p>
          <button className="btn btn-primary pmv-super-primary" onClick={() => void startNew()}>{t("Start a new PMV")}</button>
          <button className="btn btn-secondary" onClick={() => { setError(null); setStep(nextStep(p)); }}>{t("Continue existing project")}</button>
        </>}
        {step === "music" && <>
          <p>{p.audio ? p.audio.name : t("Choose a song. Its length and beat are prepared automatically.")}</p>
          <input ref={file} type="file" accept="audio/*" className="pmv-hidden" aria-label={t("Choose song file")} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void prepareMusic(() => music.upload(f)); }} />
          {p.audio && !musicBusy ? <button className="btn btn-primary pmv-super-primary" onClick={() => setStep(hasClips(p) ? "review" : "material")}>{t("Continue with this song")}</button>
            : <button className="btn btn-primary pmv-super-primary" disabled={!music.online || musicBusy} onClick={() => file.current?.click()}>{musicBusy ? t("Preparing your music…") : t("Choose song…")}</button>}
          {!musicBusy && <More label={p.audio ? t("Choose another song") : t("Use a previously uploaded song")}>
            {p.audio && <button className="btn btn-sm btn-secondary" disabled={!music.online} onClick={() => file.current?.click()}>{t("Choose song…")}</button>}
            {music.online && <SongLibraryButton current={p.audio?.name} onPick={(song) => void prepareMusic(() => music.adoptSong(song))} />}
          </More>}
          {music.status && <p className="pmv-li-meta" role="status">{music.status}</p>}
          {!music.online && <p className="pmv-error">{t("Backend unreachable – Stash needs Python for this plugin (Settings → System → Python path).")}</p>}
        </>}
        {step === "material" && <>
          <p>{t("A full-song suggestion, with automatic cuts and a light zoom. No editing setup needed.")}</p>
          <div className="pmv-super-summary"><strong>{p.audio?.name}</strong><span>{selectedSource}</span>
            {(draft.tags.length > 0 || draft.performers.length > 0) && <span>{[...draft.tags, ...draft.performers].map((r) => r.name).join(" · ")}</span>}
          </div>
          {!busy && <SuperQuestions project={p} draft={draft} change={editMaterial} />}
          <button className="btn btn-primary pmv-super-primary" disabled={!!busy || backend !== "online" || !p.audio} onClick={() => void generate()}>{busy ? t("Preparing your suggestion…") : t("Create my PMV suggestion")}</button>
          {busy && <p className="pmv-li-meta" role="status">{busy}</p>}
          {!busy && <button className="btn btn-sm btn-link" onClick={() => setStep("music")}>{t("Back to the song")}</button>}
          {backend !== "online" && <p className="pmv-error">{t("Backend unreachable – Stash needs Python for this plugin (Settings → System → Python path).")}</p>}
        </>}
        {step === "review" && <>
          <p>{t("Play a little of it. If it fits, finish the video. You can also pause here.")}</p>
          <div className="pmv-super-preview"><PreviewPlayer simple /></div>
          <button className="btn btn-primary pmv-super-primary" disabled={!hasClips(p)} onClick={() => { transport.pause(); setRenderOpen(true); }}>{t("Finish this video")}</button>
          <More label={t("I want to adjust something")}>
            <p>{t("Switch to Simple or Advanced above. Your song and clips stay in the same project.")}</p>
            <ClearTimelineButton onClear={() => { setBeforeClear(p); setStep(p.audio ? "material" : "music"); }} />
          </More>
          <button className="btn btn-sm btn-link" onClick={() => void startNew()}>{t("Start a new PMV")}</button>
        </>}
        {beforeClear && !busy && !musicBusy && state.past[state.past.length - 1] === beforeClear &&
          <button className="btn btn-sm btn-link" onClick={() => { dispatch({ type: "undo" }); setStep("review"); setBeforeClear(null); }}>{t("Restore previous cut")}</button>}
        <p className="pmv-super-save" role="status">{state.ui.saveState === "saving" || state.ui.saveState === "dirty" ? t("saving…") : state.ui.saveState === "error" ? t("Saving failed. Use Save & pause or download the project.") : backend === "online" ? t("Your project is saved automatically.") : t("Saved in this browser only.")}</p>
      </section>}
      {error && <div className="pmv-super-error" role="alert"><p>{error}</p><button className="btn btn-sm btn-secondary" onClick={() => downloadText(safeName(p.name) + ".pmv.json", JSON.stringify(getState().present, null, 2), "application/json")}>{t("Download project")}</button></div>}
    </main>
    {renderOpen && <RenderDialog guided onClose={() => setRenderOpen(false)} />}
  </div>;
}
