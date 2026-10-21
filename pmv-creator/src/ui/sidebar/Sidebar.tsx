import React from "react";
import { t } from "../../i18n";
import { useEditor } from "../../state/store";
import type { SidebarTab } from "../../state/reducer";
import { BinPanel } from "./BinPanel";
import { MarkerBrowser } from "./MarkerBrowser";
import { SceneBrowser } from "./SceneBrowser";
import { SceneDetail } from "./SceneDetail";

const tabs = (): Array<[SidebarTab, string]> => [
  ["scenes", t("Scenes")],
  ["markers", t("Markers")],
  ["bin", t("Selection")],
];

export function Sidebar() {
  const { state, dispatch } = useEditor();
  const { sidebarTab, activeSceneId } = state.ui;
  const binCount = state.present.bin.length;
  return (
    <div className="pmv-sidebar-inner">
      <div className="pmv-tabs">
        {tabs().map(([id, label]) => (
          <button key={id} className={`pmv-tab ${sidebarTab === id ? "is-active" : ""}`} onClick={() => dispatch({ type: "ui", patch: { sidebarTab: id, activeSceneId: null } })}>
            {label}
            {id === "bin" && binCount > 0 && <span className="pmv-count">{binCount}</span>}
          </button>
        ))}
      </div>
      <div className="pmv-sidebar-body">
        {activeSceneId ? (
          <SceneDetail sceneId={activeSceneId} onBack={() => dispatch({ type: "ui", patch: { activeSceneId: null } })} />
        ) : sidebarTab === "scenes" ? (
          <SceneBrowser />
        ) : sidebarTab === "markers" ? (
          <MarkerBrowser />
        ) : (
          <BinPanel />
        )}
      </div>
    </div>
  );
}
