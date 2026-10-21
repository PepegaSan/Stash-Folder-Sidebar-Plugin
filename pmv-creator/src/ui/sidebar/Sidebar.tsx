import React from "react";
import { t } from "../../i18n";
import { useEditor } from "../../state/store";
import type { SidebarTab } from "../../state/reducer";
import { BinPanel } from "./BinPanel";
import { MarkerBrowser } from "./MarkerBrowser";
import { SceneBrowser } from "./SceneBrowser";
import { SceneDetail } from "./SceneDetail";

/** The library-wide marker search is an advanced tool; markers of a scene are always in its drill-down. */
const tabs = (advanced: boolean): Array<[SidebarTab, string, string]> => [
  ["scenes", t("Scenes"), t("Search the library and add scenes to the project")],
  ...(advanced ? [["markers", t("Markers"), t("Search markers across the whole library")] as [SidebarTab, string, string]] : []),
  ["bin", t("My clips"), t("The clips you picked – drag them onto the timeline")],
];

export function Sidebar() {
  const { state, dispatch } = useEditor();
  const { sidebarTab, activeSceneId, advanced } = state.ui;
  const binCount = state.present.bin.length;
  const tab = !advanced && sidebarTab === "markers" ? "scenes" : sidebarTab;
  return (
    <div className="pmv-sidebar-inner">
      <div className="pmv-tabs">
        {tabs(advanced).map(([id, label, title]) => (
          <button key={id} className={`pmv-tab ${tab === id ? "is-active" : ""}`} title={title} onClick={() => dispatch({ type: "ui", patch: { sidebarTab: id, activeSceneId: null } })}>
            {label}
            {id === "bin" && binCount > 0 && <span className="pmv-count">{binCount}</span>}
          </button>
        ))}
      </div>
      <div className="pmv-sidebar-body">
        {activeSceneId ? (
          <SceneDetail sceneId={activeSceneId} onBack={() => dispatch({ type: "ui", patch: { activeSceneId: null } })} />
        ) : tab === "scenes" ? (
          <SceneBrowser />
        ) : tab === "markers" ? (
          <MarkerBrowser />
        ) : (
          <BinPanel />
        )}
      </div>
    </div>
  );
}
