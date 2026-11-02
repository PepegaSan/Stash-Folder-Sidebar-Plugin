import React from "react";
import { t } from "../i18n";
import { rememberAdvanced, rememberSuperSimple } from "../state/prefs";
import { useEditor } from "../state/store";

export function ViewModeSwitch({ disabled = false }: { disabled?: boolean }) {
  const { state, dispatch, transport } = useEditor();
  const value = state.ui.superSimple ? "super" : state.ui.advanced ? "advanced" : "simple";
  const select = (mode: string) => {
    const crossesGuide = mode === "super" || value === "super";
    if (crossesGuide) transport.pause();
    rememberSuperSimple(mode === "super");
    rememberAdvanced(mode === "advanced");
    dispatch({ type: "ui", patch: { superSimple: mode === "super", advanced: mode === "advanced",
      ...(crossesGuide ? { selectedClipId: null, selectedLayoutId: null, activeSceneId: null, generator: null, batch: null } : {}) } });
  };
  return <label className="pmv-view-mode">{t("View")}
    <select className="form-control form-control-sm" aria-label={t("View")} value={value} disabled={disabled} onChange={(e) => select(e.target.value)}>
      <option value="super">{t("Super simple")}</option>
      <option value="simple">{t("Simple")}</option>
      <option value="advanced">{t("Advanced")}</option>
    </select>
  </label>;
}
