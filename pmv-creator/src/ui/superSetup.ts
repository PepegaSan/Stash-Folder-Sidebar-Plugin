import { applyMood, defaultSettings, fieldCapacity, type GeneratorSettings } from "../generator/generate";
import { withLayouts } from "../generator/layouts";
import type { AllAny } from "../generator/material";
import type { PmvProject } from "../model/project";
import type { StashRef } from "../stash/types";
import { t } from "../i18n";

export interface SuperDraft {
  source: "auto" | "library";
  tags: StashRef[];
  tagMode: AllAny;
  performers: StashRef[];
  perfMode: AllAny;
  limit: number | null;
  variance: number;
  layout: "full" | "duo" | "both";
  transition: "none" | "fade" | "fadeblack" | "mix";
}
export const LIBRARY_LIMIT = 40;
export const emptySuperDraft = (): SuperDraft => ({ source: "auto", tags: [], tagMode: "all", performers: [], perfMode: "all", limit: null, variance: 100, layout: "full", transition: "none" });
const refs = (value: unknown): StashRef[] => Array.isArray(value) ? value.filter((r) => r && typeof r.id === "string" && typeof r.name === "string").slice(0, 100) : [];

export function loadSuperDraft(id: string, preset?: { tags: StashRef[]; performers: StashRef[] } | null): SuperDraft {
  let d = emptySuperDraft();
  try {
    const raw = JSON.parse(localStorage.getItem("pmv-creator:super-draft:" + id) ?? "null") as Partial<SuperDraft> | null;
    if (raw) d = { source: raw.source === "library" ? "library" : "auto", tags: refs(raw.tags), performers: refs(raw.performers),
      tagMode: raw.tagMode === "any" ? "any" : "all", perfMode: raw.perfMode === "any" ? "any" : "all",
      limit: typeof raw.limit === "number" && Number.isFinite(raw.limit) ? Math.max(1, Math.min(500, Math.round(raw.limit))) : null,
      variance: typeof raw.variance === "number" && Number.isFinite(raw.variance) ? Math.max(0, Math.min(100, Math.round(raw.variance / 5) * 5)) : d.variance,
      layout: raw.layout === "duo" || raw.layout === "both" ? raw.layout : "full",
      transition: raw.transition === "fade" || raw.transition === "fadeblack" || raw.transition === "mix" ? raw.transition : "none" };
  } catch { /* use the current project's starting point */ }
  return preset ? { ...d, source: "library", tags: refs(preset.tags), performers: refs(preset.performers) } : d;
}

export function saveSuperDraft(id: string, draft: SuperDraft): void {
  try { localStorage.setItem("pmv-creator:super-draft:" + id, JSON.stringify(draft)); } catch { /* current selection stays usable */ }
}

export const usesProjectScenes = (p: PmvProject, d: SuperDraft) => d.source === "auto" && !d.tags.length && !d.performers.length && Object.keys(p.sources).length > 0;
export const guidedLayout = (p: PmvProject, d: SuperDraft) => d.layout !== "full" && fieldCapacity(p) < 2 ? "full" : d.layout;

/** Start with the original guide defaults. Only the answers on the material page override them. */
export function superSettings(project: PmvProject, draft: SuperDraft): GeneratorSettings {
  const track = [...project.tracks].reverse().find((tr) => !tr.locked && !tr.muted);
  if (!track) throw new Error(t("No usable video track"));
  const s = applyMood(defaultSettings(track.id), "clean");
  const fromProject = usesProjectScenes(project, draft);
  const layout = guidedLayout(project, draft);
  const transition = layout === "duo" ? "none" : draft.transition;
  return { ...s,
    clips: { ...s.clips, source: fromProject ? "project" : "filter", tags: draft.tags, tagMode: draft.tagMode,
      performers: draft.performers, perfMode: draft.perfMode, limit: draft.limit ?? LIBRARY_LIMIT,
      ...(fromProject && draft.limit !== null ? { limitProjectScenes: true } : {}) },
    select: { ...s.select, variance: draft.variance },
    style: { ...s.style, layouts: withLayouts(layout === "both" ? ["full", "duo"] : [layout]),
      ...(transition === "none" ? {} : { transitionOn: "cut" as const, transitionType: transition }) },
    target: { ...s.target, range: "song" } };
}
