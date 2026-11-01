import React, { useState } from "react";
import { t } from "../i18n";
import { useEditor } from "../state/store";
import { EPS } from "../timeline/time";

/** Apply an absolute clip level; show which clips can change and which the track locks protect. */
export function ClipAudioApply({ value }: { value: number }) {
  const { state, dispatch } = useEditor();
  const p = state.present;
  const editable = p.tracks.filter((tr) => !tr.locked).flatMap((tr) => tr.clips);
  const locked = p.tracks.reduce((n, tr) => n + (tr.locked ? tr.clips.length : 0), 0);
  const changed = editable.filter((clip) => Math.abs(clip.volume - value) >= EPS).length;
  const [applied, setApplied] = useState<{ projectId: string; value: number; changed: number; locked: number } | null>(null);
  const result = applied?.projectId === p.id && applied.value === value && changed === 0 ? applied : null;
  return (
    <div>
      <button
        className="btn btn-sm btn-secondary"
        disabled={!changed}
        title={t("Sets the same level on existing clips of unlocked tracks. Ctrl+Z undoes it in one step.")}
        onClick={() => {
          dispatch({ type: "clips/volume", volume: value });
          setApplied({ projectId: p.id, value, changed, locked });
        }}
      >
        ⇉ {t("Apply to existing clips ({n})", { n: editable.length })}
      </button>
      {locked > 0 && <div className="pmv-li-meta">{t("Skipped: {n} clips on locked tracks.", { n: locked })}</div>}
      <div className="pmv-li-meta" role="status">
        {result
          ? t("Clip audio applied: {changed} changed, {locked} on locked tracks skipped.", result)
          : editable.length > 0 && changed === 0
            ? t("Existing clips on unlocked tracks already use this level.")
            : null}
      </div>
    </div>
  );
}
