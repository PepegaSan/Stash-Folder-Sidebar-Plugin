/**
 * PMV generator: clips (Stash filters) -> cuts (beat grid / music energy) -> selection -> timeline.
 * The result is ordinary clips on a track, one undo step – generated like a PMV generator would,
 * but every clip stays editable afterwards. Same settings + same seed + same library = same cut.
 */
import { overlapsExclusion } from "../culling/culling";
import type { Clip, PmvProject, Snippet, SourceMedia } from "../model/project";
import { audioEnd, clipEnd } from "../model/project";
import { carve } from "../timeline/ops";
import { EPS, beatLength, nearestGridTime } from "../timeline/time";
import { type FillContext, type FillOptions, type OffsetMode, type PickOrder, type TransitionPick, type TransitionPolicy, type TransitionWhen, fillSlots } from "./assemble";
import type { ClipOptions, MaterialItem } from "./material";
import { type Rhythm, beatFit } from "./motion";
import { type CutOptions, type EnergyFn, analyzeBeats, assignStages, planCuts } from "./rhythm";
import { templateShift, templateSlots } from "./template";

export type Mood = "classic" | "maximal" | "hypno" | "clean" | "custom";
export type RangeMode = "song" | "playhead" | "bars";

export interface SelectOptions {
  order: PickOrder;
  offset: OffsetMode;
  variety: boolean;
  followTimeline: boolean;
  /** Experimental: clip speed follows the music (speed maps from Stash scene previews). */
  paceMatch: boolean;
  /** Experimental: motion on the beat (rhythm of each clip lined up with the beat, ±12 %). */
  beatSync: boolean;
}

export interface StyleOptions {
  speed: number;
  speedRamps: boolean;
  /** On which cuts a transition goes … */
  transitionOn: TransitionWhen;
  /** … and which one. */
  transitionType: TransitionPick;
  flashDrops: boolean;
}

const LEGACY_TRANSITIONS: Record<TransitionPolicy, Pick<StyleOptions, "transitionOn" | "transitionType">> = {
  none: { transitionOn: "none", transitionType: "fade" },
  flashBar: { transitionOn: "bar", transitionType: "fadewhite" },
  fadePhrase: { transitionOn: "phrase", transitionType: "fade" },
  fadeAll: { transitionOn: "cut", transitionType: "fade" },
};

/** Style of saved settings and presets: before 0.9.4 one `transitions` value said where and which. */
export function upgradeStyle(style: Partial<StyleOptions> & { transitions?: TransitionPolicy } = {}): Partial<StyleOptions> {
  const { transitions, ...rest } = style;
  return transitions && LEGACY_TRANSITIONS[transitions] && !rest.transitionOn ? { ...LEGACY_TRANSITIONS[transitions], ...rest } : rest;
}

export interface TargetOptions {
  range: RangeMode;
  bars: number;
  trackId: string;
  /** Empty the whole track first; otherwise only the generated range is overwritten. */
  replaceTrack: boolean;
  /** Put the used segments into the bin (makes ⇄ replace easy afterwards). */
  addToBin: boolean;
}

export interface GeneratorSettings {
  mood: Mood;
  seed: number;
  clips: ClipOptions;
  select: SelectOptions;
  cut: CutOptions;
  style: StyleOptions;
  target: TargetOptions;
}

/** `label` is an i18n key – translate it with t() where it is shown. */
export const MOODS: Record<Exclude<Mood, "custom">, { label: string; cut: Partial<CutOptions>; style: Partial<StyleOptions> }> = {
  classic: { label: "PMV classic", cut: { mode: "auto", pace: "normal", onGrid: true }, style: { transitionOn: "none", flashDrops: true, speedRamps: false } },
  maximal: { label: "Maximal", cut: { mode: "fixed", every: 1, onGrid: true }, style: { transitionOn: "bar", transitionType: "fadewhite", flashDrops: true, speedRamps: true } },
  hypno: { label: "Hypno", cut: { mode: "fixed", every: 2, onGrid: true }, style: { transitionOn: "cut", transitionType: "fade", flashDrops: false, speedRamps: true } },
  clean: { label: "Clean", cut: { mode: "auto", pace: "normal", onGrid: true }, style: { transitionOn: "none", flashDrops: false, speedRamps: false } },
};

export function defaultSettings(trackId: string): GeneratorSettings {
  return {
    mood: "classic",
    seed: 1,
    clips: {
      source: "filter",
      kind: "scenes",
      tags: [],
      xtags: [],
      tagMode: "all",
      mainTags: [],
      performers: [],
      perfMode: "all",
      favoritesOnly: false,
      minRating: 0,
      minMinutes: 0,
      maxRes: 0,
      shape: "all",
      pathContains: "",
      markerSubTags: true,
      limit: 40,
      preferMarkers: false,
      skipPercent: 8,
      markerLength: 8,
      stagesOn: false,
      stages: [
        { tags: [], xtags: [] },
        { tags: [], xtags: [] },
      ],
      savedFilter: null,
    },
    select: { order: "shuffle", offset: "random", variety: true, followTimeline: false, paceMatch: false, beatSync: false },
    cut: { mode: "auto", pace: "normal", every: 2, pattern: [4, 2, 2], onGrid: true, minBeats: 0, maxBeats: 0 },
    style: { speed: 1, speedRamps: false, transitionOn: "none", transitionType: "fade", flashDrops: true },
    target: { range: "song", bars: 16, trackId, replaceTrack: false, addToBin: true },
  };
}

export function applyMood(s: GeneratorSettings, mood: Mood): GeneratorSettings {
  if (mood === "custom") return { ...s, mood };
  const m = MOODS[mood];
  // cuts taken over from another PMV stay – the mood then only sets the style
  return { ...s, mood, cut: s.cut.mode === "template" ? s.cut : { ...s.cut, ...m.cut }, style: { ...s.style, ...m.style } };
}

/** Generated range: the song, from the (bar-snapped) playhead to its end, or N bars from the playhead. */
export function generationRange(p: PmvProject, target: TargetOptions, playhead: number): { from: number; to: number } {
  const g = p.beatGrid;
  const bar = beatLength(g) * g.beatsPerBar;
  const songEnd = p.audio ? audioEnd(p.audio) : 0;
  if (target.range === "song") return { from: p.audio ? p.audio.start : 0, to: songEnd };
  let from = nearestGridTime(playhead, g, g.beatsPerBar);
  if (from < playhead - EPS) from += bar;
  from = Math.max(0, from);
  if (target.range === "playhead") return { from, to: songEnd };
  return { from, to: from + Math.max(1, target.bars) * bar };
}

export interface GenerationResult {
  trackId: string;
  from: number;
  to: number;
  replaceTrack: boolean;
  clips: Clip[];
  /** Segments for the bin (empty when addToBin is off). */
  snippets: Snippet[];
  sources: SourceMedia[];
  seed: number;
  /** The settings of this run – remembered in the project for re-rolling single clips. */
  settings: GeneratorSettings;
}

export interface GenerationStats {
  clips: number;
  scenes: number;
  candidates: number;
  drops: number;
  stages: number;
}

export interface BuildInput {
  pools: MaterialItem[][];
  sources: SourceMedia[];
  energy?: EnergyFn;
  context: FillContext;
}

const MIN_PART = 1;

/**
 * Excluded ranges are cut out of a candidate (what is left of a scene stays usable); a marker clip that
 * touches an exclusion is dropped as a whole.
 */
export function allowedParts(it: MaterialItem, exclusions: PmvProject["exclusions"]): MaterialItem[] {
  const sn = it.snippet;
  if (sn.out - sn.in < MIN_PART / 10) return [];
  if (!overlapsExclusion(exclusions, sn.sceneId, sn.in, sn.out)) return [it];
  if (it.fixedStart) return [];
  const ex = exclusions.filter((x) => x.sceneId === sn.sceneId && x.in < sn.out && x.out > sn.in).sort((a, b) => a.in - b.in);
  const parts: Array<[number, number]> = [];
  let cursor = sn.in;
  for (const x of ex) {
    if (x.in - cursor >= MIN_PART) parts.push([cursor, x.in]);
    cursor = Math.max(cursor, x.out);
  }
  if (sn.out - cursor >= MIN_PART) parts.push([cursor, sn.out]);
  return parts.map(([a, b], k) => ({ ...it, snippet: { ...sn, id: `${sn.id}-${k}`, in: a, out: b } }));
}

export function buildGeneration(p: PmvProject, s: GeneratorSettings, range: { from: number; to: number }, input: BuildInput): { result: GenerationResult; stats: GenerationStats } {
  const sourceMap = { ...p.sources, ...Object.fromEntries(input.sources.map((x) => [x.sceneId, x])) };
  const withSources = { ...p, sources: sourceMap };
  // candidates without their excluded parts; a stage without clips borrows from the others
  const usable = input.pools.map((pool) => pool.flatMap((it) => allowedParts(it, p.exclusions)));
  const all = usable.flat();
  const pools = usable.map((pool) => (pool.length ? pool : all));

  const tpl = s.cut.mode === "template" ? p.cutTemplate : null;
  const shift = tpl ? templateShift(tpl, p.audio, range.from) : 0;
  if (tpl) range = { ...range, to: Math.min(range.to, shift + tpl.duration) };
  const beats = analyzeBeats(p.beatGrid, range.from, range.to, input.energy);
  const slots = !all.length
    ? []
    : tpl
      ? templateSlots(beats, p.beatGrid, range.from, range.to, tpl.cuts.map((c) => c + shift), tpl.flashes.map((f) => f + shift))
      : planCuts(beats, p.beatGrid, range.from, range.to, s.cut.mode === "template" ? { ...s.cut, mode: "auto" } : s.cut);
  const stages = assignStages(slots, pools.length, beatLength(p.beatGrid));
  const fill: FillOptions = { seed: s.seed, ...s.select, ...s.style };
  let clips = fillSlots(withSources, slots, stages, pools, fill, input.context, pinnedClips(p, s.target.trackId));

  const used = new Set(clips.map((c) => c.snippetId));
  const snippets = s.target.addToBin ? all.map((it) => it.snippet).filter((sn) => used.has(sn.id)) : [];
  if (!s.target.addToBin) clips = clips.map((c) => ({ ...c, snippetId: null }));
  const scenes = new Set(clips.map((c) => c.sceneId));
  return {
    result: {
      trackId: s.target.trackId,
      from: range.from,
      to: range.to,
      replaceTrack: s.target.replaceTrack,
      clips,
      snippets,
      sources: input.sources.filter((x) => scenes.has(x.sceneId)),
      seed: s.seed,
      settings: s,
    },
    stats: { clips: clips.length, scenes: scenes.size, candidates: all.length, drops: beats.filter((b) => b.drop).length, stages: pools.length },
  };
}

/**
 * Experimental "motion on the beat": each clip whose motion rhythm fits the tempo (±12 %) gets that speed
 * factor, and non-marker clips start on a turn of the motion – the turn lands on the cut, i.e. on a beat.
 * The rate is taken relative to the clip's current speed (the motion period *on the timeline* is matched),
 * so applying it again to a clip that is already on the beat changes nothing.
 */
export function applyBeatSync(clips: Clip[], rhythms: Record<string, Rhythm | null>, bpm: number, fileDuration: (sceneId: string) => number, fixedStart: (c: Clip) => boolean): { clips: Clip[]; synced: number } {
  let synced = 0;
  const out = clips.map((c) => {
    const r = rhythms[c.id];
    if (!r) return c;
    const rate = beatFit(r.period / c.speed, bpm) ?? (r.half ? beatFit(r.half / c.speed, bpm) : null);
    const speed = rate != null && Math.abs(rate - 1) > 0.002 ? Math.round(c.speed * rate * 1e4) / 1e4 : c.speed;
    const step = r.half || r.period;
    let sourceIn = c.sourceIn;
    if (!fixedStart(c)) {
      // first turn at/after the start (the epsilon keeps a clip that already starts on a turn where it is)
      const turn = r.turn - Math.floor((r.turn - c.sourceIn) / step + 1e-6) * step;
      const dur = fileDuration(c.sceneId);
      if (Math.abs(turn - c.sourceIn) > 1e-3 && (!(dur > 0) || turn + c.duration * speed < dur - 0.05)) sourceIn = Math.round(turn * 1e6) / 1e6;
    }
    if (rate == null && sourceIn === c.sourceIn) return c;
    synced++;
    return speed === c.speed && sourceIn === c.sourceIn ? c : { ...c, sourceIn, speed };
  });
  return { clips: out, synced };
}

/** Pinned clips of a track – the generator keeps them and fills around them. */
export const pinnedClips = (p: PmvProject, trackId: string): Clip[] => p.tracks.find((t) => t.id === trackId)?.clips.filter((c) => c.pinned) ?? [];

/** Reducer side: one atomic edit – sources, bin (de-duplicated), track content, the run's settings. */
export function applyGeneration(p: PmvProject, r: GenerationResult): PmvProject {
  const idx = p.tracks.findIndex((t) => t.id === r.trackId);
  if (idx < 0 || p.tracks[idx].locked || !r.clips.length) return p;
  const sources = { ...p.sources, ...Object.fromEntries(r.sources.map((x) => [x.sceneId, x])) };

  // snippets that already exist (same marker, or same scene range) are reused instead of duplicated
  const bin = p.bin.slice();
  const remap = new Map<string, string>();
  for (const sn of r.snippets) {
    const existing = bin.find((b) => (sn.markerId && b.markerId === sn.markerId) || (b.sceneId === sn.sceneId && Math.abs(b.in - sn.in) < EPS && Math.abs(b.out - sn.out) < EPS));
    if (existing) remap.set(sn.id, existing.id);
    else bin.push(sn);
  }
  const minDur = 1 / p.output.fps;
  const pins = p.tracks[idx].clips.filter((c) => c.pinned);
  // pinned clips stay (also with "clear the track first"); new clips give way to them
  let clips = r.clips.map((c) => (c.snippetId && remap.has(c.snippetId) ? { ...c, snippetId: remap.get(c.snippetId)! } : c));
  for (const pin of pins) clips = carve(clips, pin.start, clipEnd(pin), minDur);
  const end = Math.max(...r.clips.map((c) => c.start + c.duration));
  const others = p.tracks[idx].clips.filter((c) => !c.pinned);
  const kept = r.replaceTrack ? [] : carve(others, r.from, Math.max(r.to, end), minDur);
  const tracks = p.tracks.slice();
  tracks[idx] = { ...tracks[idx], clips: [...kept, ...pins, ...clips].sort((a, b) => a.start - b.start) };
  return { ...p, sources, bin, tracks, generator: { settings: r.settings, from: r.from, to: r.to } };
}
