/**
 * Generator stage "split screens", after the PMV Generator's: which layout plays where (calm parts full screen, loud
 * parts many fields, drops the fullest), and the cuts of a layout given to its fields in turn – each field keeps its
 * clip while the others cut. Its random choices come from the seed, so a seed gives the same PMV.
 */
import { uid } from "../model/ids";
import { LAYOUT_INFO, LAYOUTS, type LayoutKind, type LayoutRange, type SplitDir, fieldRect, layoutFields } from "../model/layouts";
import { EPS, clamp } from "../timeline/time";
import type { Shape } from "./material";
import { mulberry32 } from "./random";
import type { BeatInfo, Slot } from "./rhythm";

export type LayoutPick = "full" | LayoutKind;
export const LAYOUT_PICKS: LayoutPick[] = ["full", ...LAYOUTS];
/** The layouts the generator may use; "full" = full screen. */
export type LayoutChoice = Record<LayoutPick, boolean>;

export const FULL_ONLY: LayoutChoice = { full: true, duo: false, trim: false, tri: false, quad: false, kaleido: false };

export const withLayouts = (on: LayoutPick[]): LayoutChoice => Object.fromEntries(LAYOUT_PICKS.map((k) => [k, on.includes(k)])) as LayoutChoice;

/** Does the choice ask for split screens at all? */
export const usesSplit = (c: LayoutChoice): boolean => LAYOUTS.some((k) => c[k]);

/** How many fields the fullest chosen layout has – the tracks it needs. */
export const groupsNeeded = (c: LayoutChoice): number => Math.max(1, ...LAYOUTS.filter((k) => c[k]).map((k) => LAYOUT_INFO[k].groups));

/** How full the picture should be: calm 1 (full screen) … drop 4 (many fields) – the PMV Generator's levelFor. */
const levelFor = (e: number, drop: boolean): number => (drop ? 4 : e > 0.6 ? 3 : e > 0.35 ? 2 : 1);

const levelOf = (k: LayoutPick): number => LAYOUT_INFO[k].level;

/** A layout on the timeline, from `t` until the next one. */
export interface LayoutStep {
  t: number;
  kind: LayoutPick;
}

/**
 * Where the layout changes: on drops right away (the fullest), otherwise at the start of a phrase when the music asks
 * for a fuller or calmer picture (in loud parts now and then for variety), at the latest a bar after 6 bars of a
 * changed mood. `minBeats` = the shortest clip, a layout stays at least that long. Starts with full screen if chosen.
 */
export function planLayouts(beats: BeatInfo[], choice: LayoutChoice, seed: number, minBeats = 0): LayoutStep[] {
  const kinds = LAYOUT_PICKS.filter((k) => choice[k]);
  if (!beats.length || !kinds.length) return [];
  const rnd = mulberry32(seed ^ 0x51ab3e5d);
  let current: LayoutPick = kinds.includes("full") ? "full" : kinds[0];
  const steps: LayoutStep[] = [{ t: beats[0].t, kind: current }];
  if (kinds.length < 2) return steps;
  let since = 0;
  let hold = 8;
  const pick = (e: number, drop: boolean): LayoutPick => {
    let want = levelFor(e, drop);
    if (want === 3 && e > 0.8 && rnd() < 0.2) want = 4; // a 4-way now and then
    // never the same layout again – otherwise the next best match (e.g. 4-way ↔ mirrored 3-way)
    const cands = kinds.filter((k) => k !== current);
    const dist = (k: LayoutPick) => Math.abs(levelOf(k) - want);
    const best = Math.min(...cands.map(dist));
    const pool = cands.filter((k) => dist(k) === best);
    return pool[Math.floor(rnd() * pool.length)];
  };
  for (let k = 1; k < beats.length; k++) {
    const B = beats[k];
    since++;
    const want = levelFor(B.e, B.drop);
    const changed = levelOf(current) !== want && kinds.some((x) => levelOf(x) === want || want > 1);
    const due = (B.phrase && since >= hold && (changed || (want >= 3 && rnd() < 0.6))) || (B.downbeat && changed && since >= 24);
    if (!((B.drop && since >= minBeats) || due)) continue;
    current = pick(B.e, B.drop);
    steps.push({ t: B.t, kind: current });
    since = 0;
    // after a drop, move on after one bar (or the shortest clip, if that is longer)
    hold = Math.max(B.drop ? 4 : 8, minBeats);
  }
  return steps;
}

/** Layout changes moved onto fixed cuts (the cuts of another PMV): each to the first cut at or after it. */
export function snapLayouts(steps: LayoutStep[], slots: Slot[]): LayoutStep[] {
  const out: LayoutStep[] = [];
  for (const st of steps) {
    const s = out.length ? slots.find((x) => x.start >= st.t - EPS) : slots[0];
    if (!s) break;
    if (out.length && s.start <= out[out.length - 1].t + EPS) out[out.length - 1] = { t: out[out.length - 1].t, kind: st.kind };
    else out.push({ t: s.start, kind: st.kind });
  }
  // two of the same in a row are one
  return out.filter((st, i) => i === 0 || st.kind !== out[i - 1].kind);
}

export interface FieldOptions {
  /** The generated range. */
  from: number;
  to: number;
  dir: SplitDir;
  /** The picture, for the shapes of the fields. */
  width: number;
  height: number;
  beats: BeatInfo[];
  beatLen: number;
  /** A field's clip stays at least / at most this many beats (0 = off). */
  minBeats: number;
  maxBeats: number;
  /** Clip shape per layout (like landscape clips only in full screen). */
  shapes?: Partial<Record<LayoutPick, Shape>>;
}

/**
 * The slots laid out over the layouts (every step begins on a slot): full screen keeps them; a split screen starts
 * every field with a new clip and then gives its cuts to the fields in turn – a field whose clip has not been on for
 * the shortest clip yet is passed over, one whose clip has been on for the longest is cut on the next beat.
 */
export function layoutSlots(slots: Slot[], steps: LayoutStep[], o: FieldOptions): Slot[] {
  const out: Slot[] = [];
  const span = Math.max(EPS, o.to - o.from);
  const fromBeat = (B: BeatInfo): Slot => ({ start: B.t, duration: 0, energy: B.e, downbeat: B.downbeat, phrase: B.phrase, drop: B.drop, progress: clamp((B.t - o.from) / span, 0, 1) });
  steps.forEach((step, k) => {
    const from = step.t;
    const end = Math.min(o.to, steps[k + 1]?.t ?? o.to);
    if (end <= from + EPS) return;
    const inside = slots.filter((s) => s.start >= from - EPS && s.start < end - EPS);
    if (!inside.length) return;
    const rule = o.shapes?.[step.kind];
    const shape = rule && rule !== "all" ? { shape: rule } : {};
    if (step.kind === "full") {
      inside.forEach((s, i) => out.push({ ...s, ...shape, duration: Math.min(s.start + s.duration, end) - s.start, group: 0, hard: i === 0 && k > 0 }));
      return;
    }
    const n = LAYOUT_INFO[step.kind].groups;
    const fields = layoutFields(step.kind, o.dir);
    const aspect = Array.from({ length: n }, (_, g) => {
      const [, , w, h] = fieldRect(fields.find((f) => f.group === g) ?? fields[0], o.width, o.height);
      return w / Math.max(1, h);
    });
    // every field starts with the layout
    const lists: Slot[][] = Array.from({ length: n }, () => [{ ...inside[0], start: from }]);
    const since = Array<number>(n).fill(from);
    const put = (g: number, s: Slot) => {
      lists[g].push(s);
      since[g] = s.start;
    };
    const minLen = o.minBeats * o.beatLen - EPS;
    const maxLen = o.maxBeats * o.beatLen - EPS;
    const beats = o.maxBeats > 0 ? o.beats.filter((B) => B.t > from + EPS && B.t < end - EPS) : [];
    const times = [...new Set([...inside.slice(1).map((s) => s.start), ...beats.map((B) => B.t)])].sort((a, b) => a - b);
    let next = 0;
    for (const t of times) {
      let cut = -1;
      const slot = inside.find((s) => Math.abs(s.start - t) < EPS && s !== inside[0]);
      if (slot) {
        // the next field in turn – with a shortest clip the next one that has been on long enough
        for (let j = 0; j < n; j++) {
          const g = (next + j) % n;
          if (o.minBeats > 0 && t - since[g] < minLen) continue;
          cut = g;
          break;
        }
        if (cut >= 0) {
          put(cut, slot);
          next = cut + 1;
        }
      }
      const B = o.maxBeats > 0 ? beats.find((x) => Math.abs(x.t - t) < EPS) : undefined;
      if (B) {
        // one per beat: the field whose clip has been on the longest
        let g = -1;
        since.forEach((x, i) => i !== cut && t - x >= maxLen && (g < 0 || x < since[g]) && (g = i));
        if (g >= 0) put(g, slot ?? fromBeat(B));
      }
    }
    lists.forEach((list, g) => list.forEach((s, i) => out.push({ ...s, ...shape, duration: (list[i + 1]?.start ?? end) - s.start, group: g, aspect: aspect[g], hard: true })));
  });
  return out.filter((s) => s.duration > EPS).sort((a, b) => a.start - b.start || (a.group ?? 0) - (b.group ?? 0));
}

/** The split screen ranges of the steps (full screen has none); `dir` for their fields. */
export function layoutRanges(steps: LayoutStep[], to: number, dir: SplitDir): LayoutRange[] {
  return steps.flatMap((st, k): LayoutRange[] => {
    const end = Math.min(to, steps[k + 1]?.t ?? to);
    return st.kind === "full" || end <= st.t + EPS ? [] : [{ id: uid("lay"), start: st.t, duration: end - st.t, kind: st.kind, dir }];
  });
}

/** Whether a clip's shape is what a layout asks for ("all" = any). */
export function shapeFits(rule: Shape | undefined, width: number, height: number): boolean {
  if (!rule || rule === "all" || !(width > 0 && height > 0)) return true;
  return rule === "portrait" ? height > width : width >= height;
}
