/**
 * "Like another PMV" in the generator: pick a PMV from the library, take over its music (optional), measure its cuts
 * and flashes (cutTemplate.ts) – the generator then cuts at the same moments with your clips.
 */
import React, { useEffect, useState } from "react";
import { t, tn } from "../../i18n";
import { extractAudio } from "../../stash/backend";
import { stashUrl } from "../../stash/graphql";
import { PMV_TAG, cachedTagId } from "../../stash/library";
import { queryScenes } from "../../stash/queries";
import { type StashScene, sceneTitle } from "../../stash/types";
import { useEditor } from "../../state/store";
import { formatTime } from "../../timeline/time";
import { useMusic } from "../music";
import { MAX_TEMPLATE_SECONDS, scanCutTemplate } from "./cutTemplate";

export function CutTemplateBox({ disabled }: { disabled: boolean }) {
  const { state, dispatch } = useEditor();
  const tpl = state.present.cutTemplate ?? null;
  const audio = state.present.audio;
  const music = useMusic();
  const [picking, setPicking] = useState(!tpl);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [withMusic, setWithMusic] = useState(true);

  const pick = async (scene: StashScene) => {
    const f = scene.files[0];
    if (!f) return;
    const title = sceneTitle(scene);
    setError(null);
    try {
      let song: string | null = null;
      if (withMusic) {
        setBusy(t("Taking over its music…"));
        const r = await extractAudio(f.path, title.replace(/\.(mp4|m4v|mkv|webm|mov|avi|wmv|ts)$/i, ""));
        await music.adoptMedia(r);
        song = r.name;
      }
      const scan = await scanCutTemplate({ id: scene.id, path: f.path, duration: f.duration }, setBusy);
      if (!scan.cuts.length && !scan.flashes.length) throw new Error(t("No cuts found in “{title}”.", { title }));
      dispatch({ type: "template/set", template: { sceneId: scene.id, title, duration: scan.duration, cuts: scan.cuts, flashes: scan.flashes, music: song } });
      setPicking(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const synced = !!tpl?.music && audio?.name === tpl.music;
  return (
    <div className="pmv-gen-template">
      {tpl && !picking && (
        <div className="pmv-row pmv-wrap">
          <span>
            📼 <b>{tpl.title}</b> · {tn(tpl.cuts.length, "{n} cuts", "1 cut")} · {tn(tpl.flashes.length, "{n} flashes", "1 flash")} · {formatTime(tpl.duration)}
          </span>
          <span className="pmv-li-meta">{synced ? t("its music is the project's song – the cuts sit where they sit in the original") : t("with your own song – its cuts start with the song")}</span>
          <button className="btn btn-sm btn-secondary" disabled={disabled || !!busy} onClick={() => setPicking(true)}>
            {t("Other PMV…")}
          </button>
        </div>
      )}
      {(picking || !tpl) && (
        <>
          <div className="pmv-row pmv-wrap">
            <label className="pmv-check" title={t("Its sound becomes the project's song – then its cuts land exactly on the music")}>
              <input type="checkbox" checked={withMusic} disabled={!!busy} onChange={(e) => setWithMusic(e.target.checked)} /> {t("Take over its music too")}
            </label>
            {tpl && (
              <button className="btn btn-sm btn-link" disabled={!!busy} onClick={() => setPicking(false)}>
                {t("Cancel")}
              </button>
            )}
          </div>
          <PmvList disabled={disabled || !!busy} onPick={(s) => void pick(s)} />
        </>
      )}
      {busy && <div className="pmv-li-meta">⏳ {busy}</div>}
      {music.status && !busy && <div className="pmv-li-meta">{music.status}</div>}
      {error && <div className="pmv-error">{error}</div>}
    </div>
  );
}

/** PMVs of the library (tag "PMV" or "PMV Creator") newest first, or what the search finds. */
function PmvList({ onPick, disabled }: { onPick: (s: StashScene) => void; disabled: boolean }) {
  const [q, setQ] = useState("");
  const [scenes, setScenes] = useState<StashScene[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const run = async () => {
      const filter: Record<string, unknown> = { duration: { value: MAX_TEMPLATE_SECONDS, modifier: "LESS_THAN" } };
      if (!q.trim()) {
        const ids = (await Promise.all(["PMV", PMV_TAG].map((n) => cachedTagId(n).catch(() => null)))).filter((x): x is string => !!x);
        if (ids.length) filter.tags = { value: ids, modifier: "INCLUDES", depth: 0 };
      }
      const r = await queryScenes(filter, { q: q.trim() || undefined, per_page: 12, sort: "created_at", direction: "DESC" });
      if (alive) setScenes(r.scenes);
    };
    const h = window.setTimeout(() => void run().catch((e) => alive && setError(String(e))), q ? 300 : 0);
    return () => {
      alive = false;
      window.clearTimeout(h);
    };
  }, [q]);
  return (
    <>
      <input className="form-control form-control-sm" placeholder={t("Search a PMV (title, path …)")} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <div className="pmv-li-meta">{t("Scenes tagged “PMV” or “PMV Creator” first – or search for one.")}</div>
      {error && <div className="pmv-error">{error}</div>}
      <div className="pmv-gen-pmvs">
        {(scenes ?? []).map((s) => (
          <button key={s.id} className="pmv-gen-pmv" disabled={disabled} onClick={() => onPick(s)} title={s.files[0]?.path}>
            {s.paths.screenshot && <img src={stashUrl(s.paths.screenshot)} alt="" loading="lazy" />}
            <span>
              <b>{sceneTitle(s)}</b>
              <small>{formatTime(s.files[0]?.duration ?? 0)}</small>
            </span>
          </button>
        ))}
        {scenes && !scenes.length && <div className="pmv-li-meta">{t("Nothing found.")}</div>}
      </div>
    </>
  );
}
