import React from "react";
import { t } from "../../i18n";
import { canClearTimeline } from "../../state/reducer";
import { useEditor } from "../../state/store";

export function ClearTimelineButton({ onClear }: { onClear?: () => void }) {
  const { state, dispatch, transport } = useEditor();
  const p = state.present;
  const locked = p.tracks.some((tr) => tr.locked && tr.clips.length);
  return <button className="btn btn-sm btn-secondary" disabled={!canClearTimeline(p)}
    title={locked ? t("Unlock tracks with clips first.") : undefined}
    onClick={() => {
      if (!window.confirm(t("Remove all video clips, split screens and timeline markers? Your song and My clips stay in the project."))) return;
      transport.pause();
      transport.seek(0);
      dispatch({ type: "timeline/clear" });
      onClear?.();
    }}>{t("Clear timeline")}</button>;
}
