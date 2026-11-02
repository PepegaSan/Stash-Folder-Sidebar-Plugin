import React from "react";
import { fieldCapacity } from "../generator/generate";
import type { AllAny } from "../generator/material";
import { t } from "../i18n";
import type { PmvProject } from "../model/project";
import { findPerformers, findTags } from "../stash/queries";
import { RefPicker } from "./common";
import { guidedLayout, LIBRARY_LIMIT, usesProjectScenes, type SuperDraft } from "./superSetup";

function MatchRule({ label, value, change }: { label: string; value: AllAny; change: (v: AllAny) => void }) {
  return <div className="pmv-row pmv-wrap" role="group" aria-label={label}>
    <span>{label}</span>
    <div className="pmv-seg">
      {(["all", "any"] as const).map((mode) =>
        <button key={mode} type="button" aria-pressed={value === mode} className={value === mode ? "is-on" : ""}
          onClick={() => change(mode)}>{mode === "all" ? t("All") : t("Any")}</button>)}
    </div>
  </div>;
}

export function SuperQuestions({ project, draft, change }: { project: PmvProject; draft: SuperDraft; change: (d: SuperDraft) => void }) {
  const patch = (values: Partial<SuperDraft>) => change({ ...draft, ...values });
  const scenes = Object.keys(project.sources).length;
  const projectPool = usesProjectScenes(project, draft);
  const limit = projectPool ? Math.min(scenes, draft.limit ?? scenes) : draft.limit ?? LIBRARY_LIMIT;
  const splitOK = fieldCapacity(project) >= 2;
  const layout = guidedLayout(project, draft);
  const layouts = { full: t("Full screen"), duo: t("Two videos side by side"), both: t("Alternate full screen and two videos") };
  const transitions = { none: t("Hard cuts"), fade: t("Crossfade"), fadeblack: t("Fade through black"), mix: t("Mixed transitions") };
  return <div className="pmv-super-questions">
    <details>
      <summary>{t("Which videos should be considered?")}<small>{t("Up to {n} videos · {v}% clip variance", { n: limit, v: draft.variance })}</small></summary>
      <div className="pmv-super-fields">
        {scenes > 0 && <label>{t("Material")}<select className="form-control form-control-sm" value={projectPool ? "auto" : "library"}
          onChange={(e) => patch({ source: e.target.value as SuperDraft["source"], tags: [], performers: [] })}>
          <option value="auto">{t("Project scenes")}</option><option value="library">{t("Videos from your library")}</option>
        </select></label>}
        <div><p>{t("Which tags or performers should match?")}</p>
          <MatchRule label={t("Tags")} value={draft.tagMode} change={(tagMode) => patch({ tagMode })} />
          <RefPicker placeholder={t("Tags (optional)")} value={draft.tags} search={findTags} onChange={(tags) => patch({ source: "library", tags })} />
          <MatchRule label={t("Performers")} value={draft.perfMode} change={(perfMode) => patch({ perfMode })} />
          <RefPicker placeholder={t("Performers (optional)")} value={draft.performers} search={findPerformers} onChange={(performers) => patch({ source: "library", performers })} />
          <small>{t("Any: one match in that group is enough. If you choose tags and performers, both groups must match.")}</small>
        </div>
        <label>{t("How many source videos at most?")}
          <input className="form-control form-control-sm" type="number" min="1" max="500" step="1" value={draft.limit ?? ""}
            placeholder={projectPool ? t("All project scenes ({n})", { n: scenes }) : t("{n} (default)", { n: LIBRARY_LIMIT })}
            onChange={(e) => { const n = e.target.valueAsNumber; patch({ limit: Number.isFinite(n) ? Math.max(1, Math.min(500, Math.round(n))) : null }); }} />
          <small>{t("This limits the videos to choose from. The song still determines how many cuts you get.")}</small>
        </label>
        <label>{t("Clip variance")} · {draft.variance}%
          <input aria-label={t("Clip variance")} type="range" min="0" max="100" step="5" value={draft.variance}
            onChange={(e) => patch({ variance: Number(e.target.value) })} />
          <small>{t("Low: allow repeats. High: prefer unused parts of each video.")}</small>
        </label>
      </div>
    </details>
    <details>
      <summary>{t("How should the cut look?")}<small>{layouts[layout]} · {transitions[layout === "duo" ? "none" : draft.transition]}</small></summary>
      <div className="pmv-super-fields">
        <label>{t("How many pictures at once?")}
          <select className="form-control form-control-sm" value={layout} onChange={(e) => patch({ layout: e.target.value as SuperDraft["layout"] })}>
            <option value="full">{layouts.full}</option><option value="duo" disabled={!splitOK}>{layouts.duo}</option><option value="both" disabled={!splitOK}>{layouts.both}</option>
          </select>
          {!splitOK && <small>{t("For two pictures, the bottom two video tracks must be unlocked and visible.")}</small>}
        </label>
        <label>{t("Which transitions do you want?")}
          <select className="form-control form-control-sm" disabled={layout === "duo"} value={layout === "duo" ? "none" : draft.transition} onChange={(e) => patch({ transition: e.target.value as SuperDraft["transition"] })}>
            <option value="none">{transitions.none}</option><option value="fade">{transitions.fade}</option><option value="fadeblack">{transitions.fadeblack}</option><option value="mix">{transitions.mix}</option>
          </select>
          {layout !== "full" && <small>{t("Transitions work between full-screen clips. Split screens use hard cuts.")}</small>}
        </label>
      </div>
    </details>
  </div>;
}
