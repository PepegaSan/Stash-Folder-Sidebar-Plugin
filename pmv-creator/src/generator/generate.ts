/**
 * PMV generator: clips (Stash filters) -> cuts (beat grid / music energy) -> selection -> timeline.
 * The result is ordinary clips on a track, one undo step – generated like a PMV generator would,
 * but every clip stays editable afterwards. Same settings + same seed + same library = same cut.
 */
import { overlapsExclusion } from "../culling/culling";
import { DEFAULT_EFFECTS, type EffectId, type EffectSettings, withEffects } from "../model/effects";
import { LAYOUT_INFO, type LayoutRange, type SplitDir, carveLayouts, cleanLayouts, groupTrackIndex } from "../model/layouts";
import type { Clip, PmvProject, Snippet, SourceMedia } from "../model/project";
import { audioEnd, clipEnd } from "../model/project";
import { carve, ensureTracks } from "../timeline/ops";
import { EPS, beatLength, nearestGridTime } from "../timeline/time";
import { type FillContext, type FillOptions, type OffsetMode, type PickOrder, type TransitionPick, type TransitionPolicy, type TransitionWhen, fillGroups } from "./assemble";
import { FULL_ONLY, LAYOUT_PICKS, type LayoutChoice, type LayoutPick, layoutRanges, layoutSlots, planLayouts, snapLayouts, usesSplit, withLayouts } from "./layouts";
import type { ClipOptions, MaterialItem, Shape } from "./material";
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
  /** Beat and drop effects – they go into the project with the clips (and stay editable there). */
  fx: EffectSettings;
  /** Split screens: the layouts it may use ("full" = full screen; the louder, the more fields) … */
  layouts: LayoutChoice;
  /** … the fields of 2- and 3-way layouts side by side or stacked … */
  split: SplitDir;
  /** … and the clip shape per layout (e.g. landscape clips only in full screen). */
  layoutShape: Partial<Record<LayoutPick, Shape>>;
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

/**
 * `label` is an i18n key – translate it with t() where it is shown. `fx`: the effects it switches on, `layouts` its split
 * screens – like the PMV Generator's moods.
 */
export const MOODS: Record<Exclude<Mood, "custom">, { label: string; cut: Partial<CutOptions>; style: Partial<StyleOptions> & { layouts: LayoutChoice }; fx: EffectId[] }> = {
  classic: {
    label: "PMV classic",
    cut: { mode: "auto", pace: "normal", onGrid: true },
    style: { transitionOn: "none", flashDrops: true, speedRamps: false, layouts: withLayouts(["full", "trim", "tri"]) },
    fx: ["zoom", "shake", "stutter", "rgb", "glitch", "flash", "lines"],
  },
  maximal: {
    label: "Maximal",
    cut: { mode: "fixed", every: 1, onGrid: true },
    style: { transitionOn: "bar", transitionType: "fadewhite", flashDrops: true, speedRamps: true, layouts: withLayouts(["full", "kaleido", "duo", "trim", "tri", "quad"]) },
    fx: ["zoom", "shake", "stutter", "rgb", "glitch", "tunnel", "invert", "echo", "text", "hue", "flash", "lines"],
  },
  hypno: {
    label: "Hypno",
    cut: { mode: "fixed", every: 2, onGrid: true },
    style: { transitionOn: "cut", transitionType: "fade", flashDrops: false, speedRamps: true, layouts: withLayouts(["full", "kaleido", "trim"]) },
    fx: ["zoom", "tunnel", "echo", "hue"],
  },
  clean: { label: "Clean", cut: { mode: "auto", pace: "normal", onGrid: true }, style: { transitionOn: "none", flashDrops: false, speedRamps: false, layouts: withLayouts(["full", "duo", "trim"]) }, fx: ["zoom"] },
};

/** The effects of a mood; strength, beats and words stay as they are. */
export const moodEffects = (mood: Mood, base: EffectSettings = DEFAULT_EFFECTS): EffectSettings => (mood === "custom" ? { ...DEFAULT_EFFECTS, ...base } : withEffects({ ...DEFAULT_EFFECTS, ...base }, MOODS[mood].fx));

/** The effects of saved settings or a preset; ones saved before the effects existed get their mood's. */
export const savedEffects = (s: Partial<GeneratorSettings>): EffectSettings => (s.style?.fx ? { ...DEFAULT_EFFECTS, ...s.style.fx } : moodEffects(s.mood ?? "classic"));

/** The split screens of saved settings or a preset; ones saved before split screens existed get their mood's. */
export const savedLayouts = (s: Partial<GeneratorSettings>): LayoutChoice =>
  s.style?.layouts ? { ...FULL_ONLY, ...s.style.layouts } : s.mood && s.mood !== "custom" ? MOODS[s.mood].style.layouts : s.mood === "custom" ? FULL_ONLY : MOODS.classic.style.layouts;

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
    style: { speed: 1, speedRamps: false, transitionOn: "none", transitionType: "fade", flashDrops: true, fx: moodEffects("classic"), layouts: MOODS.classic.style.layouts, split: "cols", layoutShape: {} },
    target: { range: "song", bars: 16, trackId, replaceTrack: false, addToBin: true },
  };
}

export function applyMood(s: GeneratorSettings, mood: Mood): GeneratorSettings {
  if (mood === "custom") return { ...s, mood };
  const m = MOODS[mood];
  // cuts taken over from another PMV stay – the mood then only sets the style
  return { ...s, mood, cut: s.cut.mode === "template" ? s.cut : { ...s.cut, ...m.cut }, style: { ...s.style, ...m.style, fx: moodEffects(mood, s.style.fx) } };
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
  /** The track of the clips – with split screens the bottom one (V1: full screen and the first field). */
  trackId: string;
  from: number;
  to: number;
  replaceTrack: boolean;
  clips: Clip[];
  /** Split screens of the range (none: full screen only). */
  layouts: LayoutRange[];
  /** The clips of their other fields: fields[g - 1] for group g, on the g-th track above the bottom one. */
  fields: Clip[][];
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

/** How many field groups the tracks can take: from V1 up to the first locked or hidden one (missing tracks are added). */
export function fieldCapacity(p: PmvProject): number {
  let n = 0;
  while (n < 4) {
    const track = p.tracks[groupTrackIndex(p.tracks.length, n)];
    if (track && (track.locked || track.muted)) break;
    n++;
  }
  return n;
}

/** The chosen layouts that fit into that many fields (full screen always does). */
export const withinFields = (c: LayoutChoice, fields: number): LayoutChoice => {
  const fit = Object.fromEntries(LAYOUT_PICKS.map((k) => [k, c[k] && (k === "full" || LAYOUT_INFO[k].groups <= fields)])) as LayoutChoice;
  return LAYOUT_PICKS.some((k) => fit[k]) ? fit : FULL_ONLY;
};

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
  const beatLen = beatLength(p.beatGrid);
  // split screens (and clip shapes per layout): where which layout plays; its changes are cuts. Only layouts whose
  // fields have usable tracks: a locked or hidden track above V1 ends them there
  const st = s.style;
  const layouts = withinFields(st.layouts ?? FULL_ONLY, fieldCapacity(p));
  const split = usesSplit(layouts);
  const shaped = Object.entries(st.layoutShape ?? {}).some(([k, v]) => layouts[k as LayoutPick] && v && v !== "all");
  const planned = split || shaped ? planLayouts(beats, layouts, s.seed, s.cut.minBeats) : [];
  let slots = !all.length
    ? []
    : tpl
      ? templateSlots(beats, p.beatGrid, range.from, range.to, tpl.cuts.map((c) => c + shift), tpl.flashes.map((f) => f + shift))
      : planCuts(beats, p.beatGrid, range.from, range.to, s.cut.mode === "template" ? { ...s.cut, mode: "auto" } : s.cut, planned.slice(1).map((x) => x.t));
  const steps = tpl ? snapLayouts(planned, slots) : planned;
  if (steps.length && slots.length) {
    const { width, height } = p.output;
    slots = layoutSlots(slots, steps, { from: range.from, to: range.to, dir: st.split ?? "cols", width, height, beats, beatLen, minBeats: s.cut.minBeats, maxBeats: s.cut.maxBeats, shapes: st.layoutShape });
  }
  const stages = assignStages(slots, pools.length, beatLen);
  const fill: FillOptions = { seed: s.seed, ...s.select, ...s.style };
  // with split screens the fields fill the bottom tracks: V1 = group 0 (and full screen), V2 = group 1 …
  const groups = Math.max(1, ...steps.map((x) => LAYOUT_INFO[x.kind].groups));
  const trackId = split ? p.tracks[p.tracks.length - 1].id : s.target.trackId;
  const pins = Array.from({ length: groups }, (_, g) => (g === 0 ? pinnedClips(p, trackId) : pinnedClips(p, p.tracks[groupTrackIndex(p.tracks.length, g)]?.id ?? "")));
  let filled = fillGroups(withSources, slots, stages, pools, fill, input.context, pins);
  filled = Array.from({ length: groups }, (_, g) => filled[g] ?? []);

  const used = new Set(filled.flat().map((c) => c.snippetId));
  const snippets = s.target.addToBin ? all.map((it) => it.snippet).filter((sn) => used.has(sn.id)) : [];
  if (!s.target.addToBin) filled = filled.map((list) => list.map((c) => ({ ...c, snippetId: null })));
  const clips = filled[0];
  const scenes = new Set(filled.flat().map((c) => c.sceneId));
  return {
    result: {
      trackId,
      from: range.from,
      to: range.to,
      replaceTrack: s.target.replaceTrack,
      clips,
      layouts: split && slots.length ? layoutRanges(steps, range.to, st.split ?? "cols") : [],
      fields: split ? filled.slice(1) : [],
      snippets,
      sources: input.sources.filter((x) => scenes.has(x.sceneId)),
      seed: s.seed,
      settings: s,
    },
    stats: { clips: filled.flat().length, scenes: scenes.size, candidates: all.length, drops: beats.filter((b) => b.drop).length, stages: pools.length },
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

/**
 * Reducer side: one atomic edit – sources, bin (de-duplicated), track content, split screens, the run's settings.
 * Generated on the bottom track, the run also owns the split screens of its range: old ones there go (with the clips of
 * their other fields), the new ones come with theirs on the tracks above – added when there are too few.
 */
export function applyGeneration(p: PmvProject, r: GenerationResult): PmvProject {
  const layouts = r.layouts ?? [];
  const need = Math.max(1, ...layouts.map((x) => LAYOUT_INFO[x.kind].groups));
  const q = layouts.length ? ensureTracks(p, need) : p;
  const idx = q.tracks.findIndex((t) => t.id === r.trackId);
  if (idx < 0 || q.tracks[idx].locked || !r.clips.length) return p;
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
  const end = Math.max(r.to, ...r.clips.map((c) => c.start + c.duration));
  const tracks = q.tracks.slice();
  /** New clips on track i: pinned clips stay (also with "clear the track first"), the new ones give way to them. */
  const place = (i: number, list: Clip[], keep: (others: Clip[]) => Clip[]) => {
    const pins = tracks[i].clips.filter((c) => c.pinned);
    let clips = list.map((c) => (c.snippetId && remap.has(c.snippetId) ? { ...c, snippetId: remap.get(c.snippetId)! } : c));
    for (const pin of pins) clips = carve(clips, pin.start, clipEnd(pin), minDur);
    tracks[i] = { ...tracks[i], clips: [...keep(tracks[i].clips.filter((c) => !c.pinned)), ...pins, ...clips].sort((a, b) => a.start - b.start) };
  };
  place(idx, r.clips, (others) => (r.replaceTrack ? [] : carve(others, r.from, end, minDur)));

  let ranges = q.layouts ?? [];
  if (idx === tracks.length - 1) {
    // a split screen with a locked field track stays as it is (its clips there can't go – full screen they'd cover V1)
    const lockedField = (x: LayoutRange) => Array.from({ length: LAYOUT_INFO[x.kind].groups - 1 }, (_, k) => tracks[groupTrackIndex(tracks.length, k + 1)]).some((t) => t?.locked);
    const kept = ranges.filter(lockedField);
    const own = ranges.filter((x) => !lockedField(x));
    // the split screens that go: all with "clear the track first", else the parts in the range
    const gone = r.replaceTrack ? own : cleanLayouts(own).flatMap((x) => {
      const a = Math.max(x.start, r.from);
      const b = Math.min(x.start + x.duration, end);
      return b > a + EPS ? [{ ...x, start: a, duration: b - a }] : [];
    });
    ranges = [...kept, ...(r.replaceTrack ? [] : carveLayouts(own, r.from, end))];
    // the other fields: their clips only where the split screens were or come (the rest of those tracks stays)
    const zones = [...gone, ...layouts];
    const fields = Math.max(need, ...gone.map((x) => LAYOUT_INFO[x.kind].groups));
    for (let g = 1; g < fields; g++) {
      const i = groupTrackIndex(tracks.length, g);
      if (i < 0 || tracks[i].locked) continue;
      place(i, r.fields?.[g - 1] ?? [], (others) => zones.reduce((list, z) => carve(list, z.start, z.start + z.duration, minDur), others));
    }
    ranges = cleanLayouts([...ranges, ...layouts]);
  }
  const effects = r.settings.style.fx ? { ...DEFAULT_EFFECTS, ...r.settings.style.fx } : p.effects;
  return { ...q, sources, bin, tracks, layouts: ranges, effects, generator: { settings: r.settings, from: r.from, to: r.to } };
}
