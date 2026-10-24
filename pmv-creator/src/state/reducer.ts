/**
 * Editor state = undoable project history + non-undoable UI state.
 *
 * Every project change is a serialisable EditAction that maps 1:1 onto a pure op. That keeps the
 * reducer trivial, makes edits replayable/loggable, and lets the timeline preview a drag by simply
 * running applyEdit(project, pendingAction) before committing it.
 */
import { type GenerationResult, type GeneratorSettings, applyGeneration } from "../generator/generate";
import type { ClipSource } from "../generator/material";
import type { StashRef } from "../stash/types";
import { type MaterialChange, applyMaterial } from "../generator/reroll";
import { readAdvanced } from "./prefs";
import type { EffectSettings } from "../model/effects";
import type { LayoutRange } from "../model/layouts";
import type { AudioTrack, BeatGrid, Clip, CutTemplate, Exclusion, OutputSettings, PmvProject, Snippet, SourceMedia, TimelineMarker, Track, Transition } from "../model/project";
import {
  type ClipPatch,
  type ClipSourceInput,
  type EditMode,
  type SpeedKeep,
  type TrimEdge,
  addTrack,
  deleteClip,
  findClip,
  insertClip,
  moveClip,
  putLayout,
  removeTrack,
  replaceClip,
  setAllTransitions,
  setClipSource,
  setClipSpeed,
  slipClip,
  splitClip,
  swapScene,
  trimClip,
  updateClip,
  updateTrack,
} from "../timeline/ops";

export type EditAction =
  | { type: "clip/insert"; trackId: string; clip: Clip; mode: EditMode }
  | { type: "clip/move"; clipId: string; trackId: string; start: number; mode: EditMode }
  | { type: "clip/trim"; clipId: string; edge: TrimEdge; time: number; mode: EditMode }
  | { type: "clip/slip"; clipId: string; sourceIn: number }
  | { type: "clip/speed"; clipId: string; speed: number; keep: SpeedKeep; mode: EditMode }
  | { type: "clip/update"; clipId: string; patch: ClipPatch }
  /** The same transition for every clip (the first clip of a track keeps its own). */
  | { type: "clips/transition"; transition: Transition | null }
  /** Every clip of scene `from` gets scene `to` (same relative spot, places and lengths stay). */
  | { type: "scene/swap"; from: string; to: string; label: string; sources: SourceMedia[] }
  | { type: "clip/replace"; clipId: string; snippetId: string }
  /** New material for clips, places and lengths stay ("another clip"); `exclusions` are added in the same step. */
  | { type: "clips/material"; changes: MaterialChange[]; sources: SourceMedia[]; exclusions?: Exclusion[] }
  /** Pinned clips stay when the generator runs again. */
  | { type: "clips/pin"; clipIds: string[]; pinned: boolean }
  /** New material for the same slot (start/duration stay); fit = play exactly the given range. */
  | { type: "clip/source"; clipId: string; source: ClipSourceInput; fit: boolean; sources: SourceMedia[] }
  | { type: "clip/split"; clipId: string; time: number }
  | { type: "clip/delete"; clipId: string; ripple: boolean }
  | { type: "track/add" }
  | { type: "track/remove"; trackId: string }
  | { type: "track/update"; trackId: string; patch: Partial<Pick<Track, "name" | "muted" | "locked">> }
  | { type: "sources/add"; sources: SourceMedia[] }
  | { type: "sources/remove"; sceneId: string }
  | { type: "bin/add"; snippets: Snippet[]; sources: SourceMedia[] }
  | { type: "bin/update"; snippetId: string; patch: Partial<Pick<Snippet, "in" | "out" | "label">> }
  | { type: "bin/remove"; snippetId: string }
  | { type: "bin/reorder"; snippetId: string; toIndex: number }
  | { type: "exclusion/add"; exclusion: Exclusion; sources: SourceMedia[] }
  | { type: "exclusion/remove"; exclusionId: string }
  | { type: "audio/set"; audio: AudioTrack | null }
  | { type: "audio/update"; patch: Partial<AudioTrack> }
  | { type: "grid/update"; patch: Partial<BeatGrid> }
  | { type: "output/update"; patch: Partial<OutputSettings> }
  | { type: "effects/update"; patch: Partial<EffectSettings> }
  /** Add or change a split screen range (the same id = the same range). */
  | { type: "layout/put"; layout: LayoutRange }
  | { type: "layout/remove"; layoutId: string }
  | { type: "project/rename"; name: string }
  | { type: "marker/add"; marker: TimelineMarker }
  | { type: "marker/remove"; markerId: string }
  | { type: "generate/apply"; result: GenerationResult }
  /** Another PMV whose cuts the generator takes over (null = none). */
  | { type: "template/set"; template: CutTemplate | null };

const addSources = (p: PmvProject, sources: SourceMedia[]): PmvProject =>
  sources.length ? { ...p, sources: { ...p.sources, ...Object.fromEntries(sources.map((s) => [s.sceneId, s])) } } : p;

export function applyEdit(p: PmvProject, a: EditAction): PmvProject {
  switch (a.type) {
    case "clip/insert":
      return insertClip(p, a.trackId, a.clip, a.mode);
    case "clip/move":
      return moveClip(p, a.clipId, a.trackId, a.start, a.mode);
    case "clip/trim":
      return trimClip(p, a.clipId, a.edge, a.time, a.mode);
    case "clip/slip":
      return slipClip(p, a.clipId, a.sourceIn);
    case "clip/speed":
      return setClipSpeed(p, a.clipId, a.speed, a.keep, a.mode);
    case "clip/update":
      return updateClip(p, a.clipId, a.patch);
    case "clips/transition":
      return setAllTransitions(p, a.transition);
    case "scene/swap": {
      const withSources = addSources(p, a.sources);
      const next = swapScene(withSources, a.from, a.to, a.label);
      return next === withSources ? p : next;
    }
    case "clip/replace": {
      const s = p.bin.find((x) => x.id === a.snippetId);
      return s ? replaceClip(p, a.clipId, s) : p;
    }
    case "clips/material": {
      if (!a.changes.length && !a.exclusions?.length) return p;
      const withSources = addSources(p, a.sources);
      return applyMaterial(a.exclusions?.length ? { ...withSources, exclusions: [...p.exclusions, ...a.exclusions] } : withSources, a.changes);
    }
    case "clips/pin": {
      const ids = new Set(a.clipIds);
      let changed = false;
      const tracks = p.tracks.map((t) =>
        t.clips.some((c) => ids.has(c.id) && !!c.pinned !== a.pinned)
          ? {
              ...t,
              clips: t.clips.map((c) => {
                if (!ids.has(c.id) || !!c.pinned === a.pinned) return c;
                changed = true;
                const { pinned: _old, ...rest } = c;
                return a.pinned ? { ...rest, pinned: true } : rest;
              }),
            }
          : t,
      );
      return changed ? { ...p, tracks } : p;
    }
    case "clip/source": {
      const withSources = addSources(p, a.sources);
      const next = setClipSource(withSources, a.clipId, a.source, a.fit);
      return next === withSources ? p : next;
    }
    case "clip/split":
      return splitClip(p, a.clipId, a.time);
    case "clip/delete":
      return deleteClip(p, a.clipId, a.ripple);
    case "track/add":
      return addTrack(p);
    case "track/remove":
      return removeTrack(p, a.trackId);
    case "track/update":
      return updateTrack(p, a.trackId, a.patch);
    case "sources/add":
      return addSources(p, a.sources);
    case "sources/remove": {
      if (!p.sources[a.sceneId]) return p;
      const { [a.sceneId]: _removed, ...rest } = p.sources;
      return { ...p, sources: rest };
    }
    case "bin/add": {
      const known = new Set(p.bin.filter((s) => s.markerId).map((s) => s.markerId));
      const fresh = a.snippets.filter((s) => !s.markerId || !known.has(s.markerId));
      if (!fresh.length) return p;
      return { ...addSources(p, a.sources), bin: [...p.bin, ...fresh] };
    }
    case "bin/update":
      return { ...p, bin: p.bin.map((s) => (s.id === a.snippetId ? { ...s, ...a.patch } : s)) };
    case "bin/remove":
      return p.bin.some((s) => s.id === a.snippetId) ? { ...p, bin: p.bin.filter((s) => s.id !== a.snippetId) } : p;
    case "bin/reorder": {
      const from = p.bin.findIndex((s) => s.id === a.snippetId);
      const to = Math.max(0, Math.min(p.bin.length - 1, a.toIndex));
      if (from < 0 || from === to) return p;
      const bin = p.bin.slice();
      const [item] = bin.splice(from, 1);
      bin.splice(to, 0, item);
      return { ...p, bin };
    }
    case "exclusion/add":
      return { ...addSources(p, a.sources), exclusions: [...p.exclusions, a.exclusion] };
    case "exclusion/remove":
      return { ...p, exclusions: p.exclusions.filter((x) => x.id !== a.exclusionId) };
    case "audio/set":
      return { ...p, audio: a.audio };
    case "audio/update":
      return p.audio ? { ...p, audio: { ...p.audio, ...a.patch } } : p;
    case "grid/update":
      return { ...p, beatGrid: { ...p.beatGrid, ...a.patch } };
    case "output/update":
      return { ...p, output: { ...p.output, ...a.patch } };
    case "effects/update":
      return { ...p, effects: { ...p.effects, ...a.patch } };
    case "layout/put":
      return putLayout(p, a.layout);
    case "layout/remove":
      return { ...p, layouts: p.layouts.filter((x) => x.id !== a.layoutId) };
    case "project/rename":
      return { ...p, name: a.name };
    case "marker/add":
      return { ...p, markers: [...p.markers, a.marker].sort((x, y) => x.time - y.time) };
    case "marker/remove":
      return { ...p, markers: p.markers.filter((m) => m.id !== a.markerId) };
    case "generate/apply":
      return applyGeneration(p, a.result);
    case "template/set":
      return { ...p, cutTemplate: a.template };
  }
}

/** Consecutive edits with the same key (typing into a field) collapse into one undo step. */
function coalesceKey(a: EditAction): string | null {
  switch (a.type) {
    case "clip/update":
    case "clip/slip":
      return `${a.type}:${a.clipId}`;
    case "bin/update":
      return `${a.type}:${a.snippetId}`;
    case "audio/update":
    case "grid/update":
    case "output/update":
    case "effects/update":
    case "project/rename":
      return a.type;
    case "layout/put":
      return `${a.type}:${a.layout.id}`;
    default:
      return null;
  }
}

export type SidebarTab = "scenes" | "markers" | "bin";
export type SaveState = "saved" | "dirty" | "saving" | "error";

export interface UiState {
  selectedClipId: string | null;
  /** The split screen range selected on the timeline (the inspector shows it). */
  selectedLayoutId: string | null;
  selectedSnippetId: string | null;
  activeSceneId: string | null;
  /** Source time the scene drill-down jumps to when it opens. */
  activeSceneSeek: number;
  /** The open scene is shown in the main player (off = PMV preview while the scene stays open). */
  sceneInPlayer: boolean;
  /** Bumped by every request to open a scene, so opening the scene that is open already seeks again. */
  sceneRequest: number;
  /** Picking the scene that replaces every clip of this scene (scene list on the left), null = not picking. */
  swapFrom: string | null;
  /** Status of "another clip" / "scene out" (they ask Stash for candidates first), null = idle. */
  clipTask: { text: string; error: boolean } | null;
  /** A scene was just taken out of the PMV – the bar above the timeline offers to skip it for good. */
  sceneOut: { sceneId: string; title: string; replaced: number; tagged: boolean } | null;
  /** "PMV with this performer/tag" from Stash: the generator opens with these filters (once). */
  clipPreset: { performers: StashRef[]; tags: StashRef[]; label: string } | null;
  sidebarTab: SidebarTab;
  /** Pixels per second. */
  zoom: number;
  editMode: EditMode;
  snap: boolean;
  /** Snap step in beats. */
  snapDivision: number;
  /** Drops from the bin get a length that is a multiple of the snap step. */
  quantizeDrops: boolean;
  /** Length for point markers without end_seconds. */
  markerDefaultLength: number;
  saveState: SaveState;
  /** Open generator dialog (optionally preset to a clip source), null = closed. */
  generator: { source?: ClipSource } | null;
  /** All settings and tools visible (off = simple mode). */
  advanced: boolean;
  /** Open "several PMVs at once" dialog with the generator settings it starts from (null = the last used ones). */
  batch: { settings: GeneratorSettings | null } | null;
}

export interface EditorState {
  past: PmvProject[];
  present: PmvProject;
  future: PmvProject[];
  ui: UiState;
  lastEdit: { key: string; at: number } | null;
}

export type Action =
  | EditAction
  | { type: "undo" }
  | { type: "redo" }
  | { type: "project/load"; project: PmvProject }
  | { type: "ui"; patch: Partial<UiState> };

export const HISTORY_LIMIT = 200;
const COALESCE_MS = 1000;

export const DEFAULT_UI: UiState = {
  selectedClipId: null,
  selectedLayoutId: null,
  selectedSnippetId: null,
  activeSceneId: null,
  activeSceneSeek: 0,
  sceneInPlayer: true,
  sceneRequest: 0,
  swapFrom: null,
  clipTask: null,
  sceneOut: null,
  clipPreset: null,
  sidebarTab: "scenes",
  zoom: 60,
  editMode: "clamp",
  snap: true,
  snapDivision: 1,
  quantizeDrops: true,
  markerDefaultLength: 8,
  saveState: "saved",
  generator: null,
  advanced: readAdvanced(),
  batch: null,
};

export function initialEditorState(project: PmvProject, ui: Partial<UiState> = {}): EditorState {
  return { past: [], present: project, future: [], ui: { ...DEFAULT_UI, ...ui }, lastEdit: null };
}

function fixSelection(ui: UiState, p: PmvProject): UiState {
  const clipOk = !ui.selectedClipId || !!findClip(p, ui.selectedClipId);
  const snipOk = !ui.selectedSnippetId || p.bin.some((s) => s.id === ui.selectedSnippetId);
  const layoutOk = !ui.selectedLayoutId || p.layouts.some((x) => x.id === ui.selectedLayoutId);
  return clipOk && snipOk && layoutOk
    ? ui
    : { ...ui, selectedClipId: clipOk ? ui.selectedClipId : null, selectedSnippetId: snipOk ? ui.selectedSnippetId : null, selectedLayoutId: layoutOk ? ui.selectedLayoutId : null };
}

export function editorReducer(state: EditorState, action: Action, now: number = Date.now()): EditorState {
  switch (action.type) {
    case "undo": {
      if (!state.past.length) return state;
      const present = state.past[state.past.length - 1];
      return { ...state, past: state.past.slice(0, -1), present, future: [state.present, ...state.future], lastEdit: null, ui: fixSelection(state.ui, present) };
    }
    case "redo": {
      if (!state.future.length) return state;
      const [present, ...future] = state.future;
      return { ...state, past: [...state.past, state.present], present, future, lastEdit: null, ui: fixSelection(state.ui, present) };
    }
    case "project/load":
      return initialEditorState(action.project, { ...state.ui, selectedClipId: null, selectedLayoutId: null, selectedSnippetId: null, activeSceneId: null, swapFrom: null, clipTask: null, sceneOut: null, saveState: "saved" });
    case "ui": {
      const ui = { ...state.ui, ...action.patch };
      // a clip or a split screen is selected, never both (Del takes away what is selected)
      if (action.patch.selectedClipId && !("selectedLayoutId" in action.patch)) ui.selectedLayoutId = null;
      if (action.patch.selectedLayoutId && !("selectedClipId" in action.patch)) ui.selectedClipId = null;
      // opening a scene (from anywhere) shows it in the main player
      if (action.patch.activeSceneId) {
        ui.sceneInPlayer = action.patch.sceneInPlayer ?? true;
        ui.sceneRequest = state.ui.sceneRequest + 1;
      }
      return { ...state, ui };
    }
    default: {
      const next = applyEdit(state.present, action);
      if (next === state.present) return state;
      const key = coalesceKey(action);
      const merge = key !== null && state.lastEdit?.key === key && now - state.lastEdit.at < COALESCE_MS;
      return {
        ...state,
        past: merge ? state.past : [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: next,
        future: [],
        lastEdit: key ? { key, at: now } : null,
        ui: fixSelection(state.ui, next),
      };
    }
  }
}
