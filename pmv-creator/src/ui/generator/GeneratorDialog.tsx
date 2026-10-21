/**
 * "Generate PMV": pick clips by criteria and a cutting style like a PMV generator – the result lands on a
 * track as ordinary, editable clips (one undo step). Simple mode: mood, where the clips come from, tags,
 * performers, count. Advanced mode shows every option (following the Pepega PMV Generator where it applies
 * to an offline cut; split screens and live effects are left out).
 */
import React, { useCallback, useMemo, useState } from "react";
import type { PickOrder, TransitionPolicy } from "../../generator/assemble";
import { type GeneratorSettings, MOODS, type Mood, applyMood, defaultSettings, generationRange } from "../../generator/generate";
import type { ClipOptions, ClipSource, TagStage } from "../../generator/material";
import type { CutOptions, Pace } from "../../generator/rhythm";
import { t, tn } from "../../i18n";
import { formatTime } from "../../timeline/time";
import { findPerformers, findTags } from "../../stash/queries";
import { rememberAdvanced } from "../../state/prefs";
import { useEditor } from "../../state/store";
import { NumField, RefPicker, Seg } from "../common";
import { type RunOutcome, runGenerator } from "./run";

const LS_KEY = "pmv-creator:generator";

/** Last used settings (per browser); the track only if it exists in this project. */
function loadSaved(fallbackTrack: string, trackIds: string[]): GeneratorSettings {
  const base = defaultSettings(fallbackTrack);
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return base;
    const s = JSON.parse(raw) as Partial<GeneratorSettings>;
    const trackId = s.target?.trackId && trackIds.includes(s.target.trackId) ? s.target.trackId : fallbackTrack;
    return {
      ...base,
      ...s,
      clips: { ...base.clips, ...s.clips },
      select: { ...base.select, ...s.select },
      cut: { ...base.cut, ...s.cut },
      style: { ...base.style, ...s.style },
      target: { ...base.target, ...s.target, trackId },
    };
  } catch {
    return base;
  }
}

function save(s: GeneratorSettings): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s));
  } catch {
    /* private mode */
  }
}

const Check = ({ label, checked, onChange, title, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string; disabled?: boolean }) => (
  <label className="pmv-check pmv-gen-check" title={title}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} /> {label}
  </label>
);

export function GeneratorDialog() {
  const { state, dispatch, transport, backend } = useEditor();
  const project = state.present;
  const preset = state.ui.generator;
  const adv = state.ui.advanced;
  const defaultTrack = project.tracks[project.tracks.length - 1].id;
  const [s, setS] = useState<GeneratorSettings>(() => {
    const loaded = loadSaved(defaultTrack, project.tracks.map((x) => x.id));
    return preset?.source ? { ...loaded, clips: { ...loaded.clips, source: preset.source } } : loaded;
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const searchTags = useCallback(findTags, []);
  const searchPerformers = useCallback(findPerformers, []);

  const close = () => dispatch({ type: "ui", patch: { generator: null } });
  const setAdvanced = (on: boolean) => {
    rememberAdvanced(on);
    dispatch({ type: "ui", patch: { advanced: on } });
  };
  const setClips = (patch: Partial<ClipOptions>) => setS((x) => ({ ...x, clips: { ...x.clips, ...patch } }));
  const setCut = (patch: Partial<CutOptions>) => setS((x) => ({ ...x, mood: "custom", cut: { ...x.cut, ...patch } }));
  const setStyle = (patch: Partial<GeneratorSettings["style"]>) => setS((x) => ({ ...x, mood: "custom", style: { ...x.style, ...patch } }));
  const setSelect = (patch: Partial<GeneratorSettings["select"]>) => setS((x) => ({ ...x, select: { ...x.select, ...patch } }));
  const setTarget = (patch: Partial<GeneratorSettings["target"]>) => setS((x) => ({ ...x, target: { ...x.target, ...patch } }));
  const setStage = (i: number, patch: Partial<TagStage>) => setClips({ stages: s.clips.stages.map((st, k) => (k === i ? { ...st, ...patch } : st)) });

  const c = s.clips;
  const hasAudio = !!project.audio;
  const offline = backend !== "online";
  // without music there is no song range: N bars from the playhead; simple mode always fills the whole song
  const target = !hasAudio ? { ...s.target, range: "bars" as const } : adv ? s.target : { ...s.target, range: "song" as const };
  const range = useMemo(() => generationRange(project, target, transport.time), [project, target.range, target.bars, transport.time]);

  const run = async (seed: number) => {
    const next = { ...s, seed };
    setS(next);
    save(next);
    setError(null);
    setBusy(t("Starting…"));
    try {
      const r = await runGenerator(state.present, { ...next, target }, transport.time, setBusy);
      if (!r.result.clips.length) throw new Error(t("No clips came out of this."));
      dispatch({ type: "generate/apply", result: r.result });
      setOutcome(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const moodHints: Record<Exclude<Mood, "custom">, string> = {
    classic: t("Cuts follow the music's energy, flash on drops"),
    maximal: t("A cut on every beat, flashes, speed ramps"),
    hypno: t("Slow, dissolving cuts every two beats"),
    clean: t("Energy-based cuts without effects"),
  };

  const sourceSeg = (
    <Seg<ClipSource>
      value={c.source}
      onChange={(v) => setClips({ source: v })}
      options={[
        ["filter", t("By criteria"), t("Scenes or markers from the whole library, by tags, performers and more")],
        ["watched", t("Most watched"), t("The most played scenes of the last 30 days")],
        ["project", t("Project scenes"), t("The scenes of this project (left sidebar)")],
        ["bin", t("My clips ({n})", { n: project.bin.length }), t("The clips you picked under “My clips”")],
      ]}
    />
  );

  return (
    <div className="pmv-modal" onClick={() => !busy && close()}>
      <div className={`pmv-modal-body pmv-gen ${adv ? "" : "is-simple"}`} onClick={(e) => e.stopPropagation()}>
        <div className="pmv-section-head is-static">
          {t("Generate PMV")}
          {adv && <span className="pmv-li-meta">– {t("lands on the track as ordinary clips, everything stays editable (Ctrl+Z undoes it)")}</span>}
          <span className="pmv-spacer" />
          <label className="pmv-check" title={t("Show all settings and tools")}>
            <input type="checkbox" checked={adv} onChange={(e) => setAdvanced(e.target.checked)} /> {t("Advanced")}
          </label>
          <button className="btn btn-sm btn-link" onClick={close} disabled={!!busy}>
            ✕
          </button>
        </div>

        <div className="pmv-row pmv-wrap">
          <span className="pmv-gen-label">{t("Mood")}</span>
          <Seg<Mood>
            value={s.mood}
            options={[...(Object.keys(MOODS) as Array<Exclude<Mood, "custom">>).map((m) => [m, t(MOODS[m].label), moodHints[m]] as [Mood, string, string]), ...(adv || s.mood === "custom" ? [["custom", t("Custom")] as [Mood, string]] : [])]}
            onChange={(m) => setS((x) => applyMood(x, m))}
          />
          {!adv && s.mood !== "custom" && <span className="pmv-li-meta">{moodHints[s.mood]}</span>}
        </div>

        {!adv ? (
          // ---------------------------------------------------------------- simple: what is needed, nothing else
          <div className="pmv-gen-col">
            <div className="pmv-gen-h">{t("Clips")}</div>
            {sourceSeg}
            {c.source === "filter" && (
              <div className="pmv-grid2">
                <label>{t("Tags")}</label>
                <span className="pmv-row">
                  <RefPicker placeholder={t("Tags (optional)")} value={c.tags} onChange={(v) => setClips({ tags: v })} search={searchTags} />
                  {c.tags.length > 1 && <Seg<ClipOptions["tagMode"]> value={c.tagMode} onChange={(v) => setClips({ tagMode: v })} options={[["all", t("all")], ["any", t("any")]]} />}
                </span>
                <label>{t("Performers")}</label>
                <span className="pmv-row">
                  <RefPicker placeholder={t("Performers (optional)")} value={c.performers} onChange={(v) => setClips({ performers: v })} search={searchPerformers} />
                  {c.performers.length > 1 && <Seg<ClipOptions["perfMode"]> value={c.perfMode} onChange={(v) => setClips({ perfMode: v })} options={[["all", t("all")], ["any", t("any")]]} />}
                </span>
                <label>{t("Count")}</label>
                <NumField value={c.limit} onCommit={(v) => setClips({ limit: Math.round(v) })} min={1} max={500} step={5} digits={0} suffix={c.kind === "markers" ? t("markers (random, seed)") : t("scenes (random, seed)")} />
              </div>
            )}
            {c.source === "bin" && !project.bin.length && <div className="pmv-li-meta">{t("“My clips” is empty – pick markers or ranges in a scene first.")}</div>}
            {c.source === "project" && !Object.keys(project.sources).length && <div className="pmv-li-meta">{t("The project has no scenes yet – add some on the left.")}</div>}
            {!hasAudio && (
              <div className="pmv-row">
                <span className="pmv-gen-label">{t("Length")}</span>
                <NumField value={s.target.bars} onCommit={(v) => setTarget({ bars: Math.round(v) })} min={1} max={512} step={1} digits={0} suffix={t("bars")} />
                <span className="pmv-li-meta">{t("No music yet – the PMV is cut from the playhead; with a song it fills the whole song.")}</span>
              </div>
            )}
          </div>
        ) : (
          // ---------------------------------------------------------------- advanced: everything
          <div className="pmv-gen-cols">
            <div className="pmv-gen-col">
              <div className="pmv-gen-h">1 · {t("Clips")}</div>
              {sourceSeg}
              {c.source === "filter" && (
                <>
                  <div className="pmv-grid2">
                    <label>{t("What")}</label>
                    <Seg<ClipOptions["kind"]> value={c.kind} onChange={(v) => setClips({ kind: v })} options={[["scenes", t("Scenes")], ["markers", t("Markers"), t("Every clip starts at a marker; the tag filter looks at the marker's tags")]]} />
                    <label>{t("Tags")}</label>
                    <span className="pmv-row">
                      <RefPicker placeholder={t("Tags (optional)")} value={c.tags} onChange={(v) => setClips({ tags: v })} search={searchTags} />
                      <Seg<ClipOptions["tagMode"]> value={c.tagMode} onChange={(v) => setClips({ tagMode: v })} options={[["all", t("all")], ["any", t("any")]]} />
                    </span>
                    <label>{t("Without tags")}</label>
                    <RefPicker placeholder={t("exclude")} value={c.xtags} onChange={(v) => setClips({ xtags: v })} search={searchTags} />
                    <label title={t("Tags every clip must have (e.g. a model) – the normal tags only count together with them")}>{t("Main tags")}</label>
                    <RefPicker placeholder={t("always required")} value={c.mainTags} onChange={(v) => setClips({ mainTags: v })} search={searchTags} />
                    <label>{t("Performers")}</label>
                    <span className="pmv-row">
                      <RefPicker placeholder={t("Performers (optional)")} value={c.performers} onChange={(v) => setClips({ performers: v })} search={searchPerformers} />
                      <Seg<ClipOptions["perfMode"]> value={c.perfMode} onChange={(v) => setClips({ perfMode: v })} options={[["all", t("all")], ["any", t("any")]]} />
                    </span>
                    <label>{t("Rating at least")}</label>
                    <Seg<number> value={c.minRating} onChange={(v) => setClips({ minRating: v })} options={[[0, t("any")], [20, "★"], [40, "★2"], [60, "★3"], [80, "★4"], [100, "★5"]]} />
                    <label>{t("Length at least")}</label>
                    <Seg<number> value={c.minMinutes} onChange={(v) => setClips({ minMinutes: v })} options={[[0, t("any")], [1, "1 min"], [5, "5 min"], [20, "20 min"]]} />
                    <label>{t("Resolution up to")}</label>
                    <Seg<number> value={c.maxRes} onChange={(v) => setClips({ maxRes: v })} options={[[0, t("any")], [720, "720p"], [1080, "1080p"], [1440, "1440p"]]} />
                    <label>{t("Shape")}</label>
                    <Seg<ClipOptions["shape"]> value={c.shape} onChange={(v) => setClips({ shape: v })} options={[["all", t("all")], ["portrait", t("portrait only")], ["landscape", t("landscape only")]]} />
                    <label>{t("Path contains")}</label>
                    <input className="form-control form-control-sm" value={c.pathContains} placeholder={t("e.g. /library/clips")} onChange={(e) => setClips({ pathContains: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
                    <label>{t("Count")}</label>
                    <NumField value={c.limit} onCommit={(v) => setClips({ limit: Math.round(v) })} min={1} max={500} step={5} digits={0} suffix={c.kind === "markers" ? t("markers (random, seed)") : t("scenes (random, seed)")} />
                  </div>
                  <div className="pmv-row pmv-wrap">
                    <Check label={t("Favorites only")} title={t("Scenes with the tag “Favorite” (like Stash UI)")} checked={c.favoritesOnly} onChange={(v) => setClips({ favoritesOnly: v })} />
                    {c.kind === "markers" && <Check label={t("Include sub-tags")} checked={c.markerSubTags} onChange={(v) => setClips({ markerSubTags: v })} />}
                    <Check label={t("Tag stages that follow the song")} title={t("A → B → C: the clips change with the song; the last stage plays on drops and in the finale")} checked={c.stagesOn} onChange={(v) => setClips({ stagesOn: v })} />
                  </div>
                  {c.stagesOn && (
                    <div className="pmv-gen-stages">
                      {c.stages.map((st, i) => (
                        <div key={i} className="pmv-gen-stage">
                          <span className="pmv-gen-label">{i === c.stages.length - 1 ? t("Drops & finale") : t("Stage {n}", { n: i + 1 })}</span>
                          <RefPicker placeholder={t("Tags")} value={st.tags} onChange={(v) => setStage(i, { tags: v })} search={searchTags} />
                          <RefPicker placeholder={t("without")} value={st.xtags} onChange={(v) => setStage(i, { xtags: v })} search={searchTags} />
                          {c.stages.length > 2 && (
                            <button className="btn btn-sm btn-link" onClick={() => setClips({ stages: c.stages.filter((_, k) => k !== i) })}>
                              ×
                            </button>
                          )}
                        </div>
                      ))}
                      {c.stages.length < 5 && (
                        <button className="btn btn-sm btn-secondary" onClick={() => setClips({ stages: [...c.stages.slice(0, -1), { tags: [], xtags: [] }, c.stages[c.stages.length - 1]] })}>
                          + {t("Stage")}
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
              {c.source !== "bin" && !(c.source === "filter" && c.kind === "markers") && (
                <div className="pmv-row pmv-wrap">
                  <Check label={t("Prefer markers")} title={t("Scenes with markers contribute their markers as clips")} checked={c.preferMarkers} onChange={(v) => setClips({ preferMarkers: v })} />
                  <span className="pmv-li-meta">{t("Skip intro/credits")}</span>
                  <NumField value={c.skipPercent} onCommit={(v) => setClips({ skipPercent: v })} min={0} max={40} step={1} digits={0} suffix="%" />
                </div>
              )}
            </div>

            <div className="pmv-gen-col">
              <div className="pmv-gen-h">2 · {t("Selection")}</div>
              <div className="pmv-row pmv-wrap">
                <Check label={t("Variety")} title={t("The same scene not within the last 24 clips, the same performer preferably not within the last 4")} checked={s.select.variety} onChange={(v) => setSelect({ variety: v })} />
                <Check label={t("Follow the scenes' timeline")} title={t("The start of the song uses the beginnings of the scenes, the end their endings (±12 %)")} checked={s.select.followTimeline} onChange={(v) => setSelect({ followTimeline: v })} />
              </div>
              <div className="pmv-grid2">
                <label>{t("Order")}</label>
                <Seg<PickOrder> value={s.select.order} onChange={(v) => setSelect({ order: v })} options={[["shuffle", t("shuffled")], ["interleave", t("alternate scenes")], ["source", t("as delivered")]]} />
                <label>{t("Start point")}</label>
                <Seg<GeneratorSettings["select"]["offset"]> value={s.select.offset} onChange={(v) => setSelect({ offset: v })} options={[["random", t("random")], ["start", t("beginning")], ["continue", t("continue")]]} />
              </div>
              <div className="pmv-gen-exp">
                <div className="pmv-li-meta">{t("Experimental (measures motion with FFmpeg in the backend)")}</div>
                <Check
                  label={t("Clip speed follows the music")}
                  title={t("Loud, fast parts of the music get spots with fast motion, calm music calm ones – measured in Stash's scene previews (Tasks → Generate → Previews)")}
                  checked={s.select.paceMatch}
                  disabled={offline || !hasAudio}
                  onChange={(v) => setSelect({ paceMatch: v })}
                />
                <Check
                  label={t("Motion on the beat")}
                  title={t("Measures the motion rhythm at the start of each clip; if it fits the tempo (±12 %), the clip plays a little faster/slower and starts on a turn of the motion – which lands on the beat")}
                  checked={s.select.beatSync}
                  disabled={offline}
                  onChange={(v) => setSelect({ beatSync: v })}
                />
              </div>

              <div className="pmv-gen-h">3 · {t("Cutting & style")}</div>
              <div className="pmv-grid2">
                <label>{t("Cutting")}</label>
                <Seg<CutOptions["mode"]> value={s.cut.mode} onChange={(v) => setCut({ mode: v })} options={[["auto", t("Automatic"), t("By the music's energy: calm long, loud short")], ["fixed", t("Fixed")], ["pattern", t("Pattern")]]} />
                {s.cut.mode === "auto" && (
                  <>
                    <label>{t("Pace")}</label>
                    <Seg<Pace> value={s.cut.pace} onChange={(v) => setCut({ pace: v })} options={[["slow", t("Slow"), t("calm 8 · medium 4 · loud 2 beats")], ["normal", t("Normal"), t("calm 4 · medium 2 · loud 1 beat")], ["fast", t("Fast"), t("calm 2 · medium 1 · loud 1 beat")]]} />
                  </>
                )}
                {s.cut.mode === "fixed" && (
                  <>
                    <label>{t("Every")}</label>
                    <Seg<number> value={s.cut.every} onChange={(v) => setCut({ every: v })} options={[[1, t("1 beat")], [2, t("2 beats")], [4, t("bar")], [8, t("2 bars")]]} />
                  </>
                )}
                {s.cut.mode === "pattern" && (
                  <>
                    <label>{t("Pattern (beats)")}</label>
                    <input
                      className="form-control form-control-sm"
                      defaultValue={s.cut.pattern.join(",")}
                      onBlur={(e) => setCut({ pattern: e.target.value.split(/[,; ]+/).map((x) => parseFloat(x.replace(",", "."))).filter((x) => x > 0) })}
                      onKeyDown={(e) => e.stopPropagation()}
                      placeholder="4,2,2"
                    />
                  </>
                )}
                <label>{t("Clip length")}</label>
                <span className="pmv-row">
                  <NumField value={s.cut.minBeats} onCommit={(v) => setCut({ minBeats: Math.round(v) })} min={0} max={16} step={1} digits={0} suffix={t("min")} title={t("Shortest clip in beats (0 = off)")} />
                  <NumField value={s.cut.maxBeats} onCommit={(v) => setCut({ maxBeats: Math.round(v) })} min={0} max={32} step={1} digits={0} suffix={t("max beats")} title={t("Longest clip in beats (0 = off)")} />
                </span>
                <label>{t("Transitions")}</label>
                <select className="form-control form-control-sm" value={s.style.transitions} onChange={(e) => setStyle({ transitions: e.target.value as TransitionPolicy })}>
                  <option value="none">{t("Hard cuts")}</option>
                  <option value="flashBar">{t("Flash on every bar")}</option>
                  <option value="fadePhrase">{t("Dissolve per phrase (4 bars)")}</option>
                  <option value="fadeAll">{t("Short dissolve on every cut")}</option>
                </select>
                <label>{t("Speed")}</label>
                <NumField value={s.style.speed} onCommit={(v) => setStyle({ speed: v })} min={0.25} max={4} step={0.05} suffix="×" />
              </div>
              <div className="pmv-row pmv-wrap">
                <Check label={t("Cuts on the bar grid")} checked={s.cut.onGrid} onChange={(v) => setCut({ onGrid: v })} />
                <Check label={t("Flash on drops")} checked={s.style.flashDrops} onChange={(v) => setStyle({ flashDrops: v })} disabled={!hasAudio} />
                <Check label={t("Speed ramps")} title={t("Slow motion in calm parts, faster in loud ones, a burst on drops")} checked={s.style.speedRamps} onChange={(v) => setStyle({ speedRamps: v })} />
              </div>

              <div className="pmv-gen-h">4 · {t("Target")}</div>
              <div className="pmv-grid2">
                <label>{t("Range")}</label>
                <span className="pmv-row">
                  <Seg<GeneratorSettings["target"]["range"]>
                    value={hasAudio ? s.target.range : "bars"}
                    onChange={(v) => setTarget({ range: v })}
                    options={[["song", t("Whole song")], ["playhead", t("From the playhead")], ["bars", t("Bars")]]}
                    disabled={!hasAudio}
                  />
                  {(s.target.range === "bars" || !hasAudio) && <NumField value={s.target.bars} onCommit={(v) => setTarget({ bars: Math.round(v) })} min={1} max={512} step={1} digits={0} suffix={t("bars")} />}
                </span>
                <label>{t("Track")}</label>
                <select className="form-control form-control-sm" value={s.target.trackId} onChange={(e) => setTarget({ trackId: e.target.value })}>
                  {project.tracks.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                      {x.clips.length ? ` (${tn(x.clips.length, "{n} clips", "1 clip")})` : ""}
                    </option>
                  ))}
                </select>
                <label>{t("Seed")}</label>
                <span className="pmv-row">
                  <NumField value={s.seed} onCommit={(v) => setS((x) => ({ ...x, seed: Math.round(v) }))} min={0} step={1} digits={0} />
                  <span className="pmv-li-meta">{t("same seed = same PMV")}</span>
                </span>
              </div>
              <div className="pmv-row pmv-wrap">
                <Check label={t("Clear the track first")} checked={s.target.replaceTrack} onChange={(v) => setTarget({ replaceTrack: v })} />
                <Check label={t("Used segments into “My clips”")} title={t("So every clip can later be swapped for another segment with ⇄")} checked={s.target.addToBin} onChange={(v) => setTarget({ addToBin: v })} />
              </div>
            </div>
          </div>
        )}

        <div className="pmv-gen-foot">
          <div className="pmv-li-meta">
            {formatTime(range.from)} – {formatTime(range.to)} ({Math.max(0, range.to - range.from).toFixed(1)} s){!hasAudio && ` · ${t("without music: no energy/drop signal")}`}
          </div>
          {busy && <div className="pmv-li-meta">⏳ {busy}</div>}
          {error && <div className="pmv-error">{error}</div>}
          {outcome && !busy && (
            <div className="pmv-success">
              ✓ {t("{clips} clips from {scenes} scenes", { clips: outcome.stats.clips, scenes: outcome.stats.scenes })}
              {adv && (
                <>
                  {" "}
                  ({tn(outcome.stats.candidates, "{n} candidates", "1 candidate")}
                  {outcome.stats.stages > 1 && `, ${t("{n} stages", { n: outcome.stats.stages })}`}) · {tn(outcome.stats.drops, "{n} drops", "1 drop")} · {t("Seed")} {outcome.result.seed}
                  {s.select.paceMatch && ` · ${t("speed maps for {n} scenes", { n: outcome.mapped })}`}
                  {s.select.beatSync && ` · ${t("{n} clips put on the beat", { n: outcome.synced })}`}
                </>
              )}
            </div>
          )}
          <div className="pmv-row">
            <button className="btn btn-primary" disabled={!!busy || range.to <= range.from} onClick={() => void run(s.seed)}>
              ⚡ {outcome ? t("Generate again") : t("Generate")}
            </button>
            {outcome && (
              <button className="btn btn-secondary" disabled={!!busy} onClick={() => void run(s.seed + 1)} title={t("Same settings, a different random pick")}>
                🎲 {t("Another variant")}
              </button>
            )}
            <span className="pmv-spacer" />
            <button className="btn btn-secondary" disabled={!!busy} onClick={close}>
              {outcome ? t("Done – fine-tune") : t("Close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
