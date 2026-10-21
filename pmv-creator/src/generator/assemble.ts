/** Generator stage "selection": which clip and which spot of it goes into each slot. */
import { uid } from "../model/ids";
import type { Clip, PmvProject, Transition } from "../model/project";
import { EPS, beatLength, clamp } from "../timeline/time";
import type { MaterialItem } from "./material";
import type { SpeedSpot } from "./motion";
import { mulberry32 } from "./random";
import type { Slot } from "./rhythm";

/** shuffle = seeded mix, interleave = round-robin over scenes, source = order as delivered. */
export type PickOrder = "shuffle" | "interleave" | "source";
/** Non-marker clips start at a seeded random spot, at the beginning, or where their last use stopped. */
export type OffsetMode = "random" | "start" | "continue";
export type TransitionPolicy = "none" | "flashBar" | "fadePhrase" | "fadeAll";

export interface FillOptions {
  seed: number;
  order: PickOrder;
  offset: OffsetMode;
  /** The same scene not within the last 24 clips, the same performer preferably not within the last 4. */
  variety: boolean;
  /** Take a clip from the part of its scene that matches the song's progress (±12 %). */
  followTimeline: boolean;
  /** Experimental: spots whose motion speed fits the music's energy (needs speed maps). */
  paceMatch: boolean;
  speed: number;
  /** Slow motion in calm parts, faster in loud ones, a burst on drops. */
  speedRamps: boolean;
  transitions: TransitionPolicy;
  flashDrops: boolean;
}

export interface FillContext {
  speedMaps: Record<string, SpeedSpot[]>;
  /** Library-relative speed percentile (0 calm … 1 fast). */
  speedPct: (v: number) => number | null;
}

const RECENT_SCENES = 24;
const RECENT_PERFORMERS = 4;
const LOOKAHEAD = 24;
const TIMELINE_WINDOW = 0.12;

function shuffle<T>(list: T[], rnd: () => number): T[] {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function interleave(items: MaterialItem[]): MaterialItem[] {
  const groups = new Map<string, MaterialItem[]>();
  for (const it of items) {
    const k = it.snippet.sceneId;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(it);
  }
  const lists = [...groups.values()];
  const out: MaterialItem[] = [];
  for (let round = 0; out.length < items.length; round++) for (const l of lists) if (round < l.length) out.push(l[round]);
  return out;
}

/** Cost above which (pace match) already used clips are considered again – Pepega's "low > 0.12" × 2.5. */
const REUSE_THRESHOLD = 0.3;
const REUSE_PENALTY = 0.6;

/** A queue that refills (re-shuffled) when it runs dry; picks the best of the next few in line. */
class Pool {
  private queue: MaterialItem[] = [];
  private uses = new Map<MaterialItem, number>();
  constructor(
    readonly items: MaterialItem[],
    private order: PickOrder,
    private rnd: () => number,
  ) {}

  get scenes(): number {
    return new Set(this.items.map((i) => i.snippet.sceneId)).size;
  }

  /**
   * `reuse`: if nothing in line fits well, clips used before count too (less with every use) –
   * a fast scene has more than one fast spot, and on a long loud part the fast ones in line run out.
   */
  take(cost: (it: MaterialItem) => number, reuse = false): MaterialItem {
    if (!this.queue.length) this.queue = this.order === "shuffle" ? shuffle(this.items, this.rnd) : this.order === "interleave" ? interleave(this.items) : this.items.slice();
    let best = 0;
    let low = Infinity;
    for (let i = 0; i < Math.min(LOOKAHEAD, this.queue.length); i++) {
      const c = cost(this.queue[i]) + i * 1e-3; // (earlier in line wins ties)
      if (c < low) [low, best] = [c, i];
    }
    let pick: MaterialItem | null = null;
    if (reuse && low > REUSE_THRESHOLD) {
      for (const [it, n] of this.uses) {
        if (this.queue.includes(it)) continue;
        const c = cost(it) + REUSE_PENALTY * n;
        if (c < low) [low, pick] = [c, it];
      }
    }
    pick ??= this.queue.splice(best, 1)[0];
    this.uses.set(pick, (this.uses.get(pick) ?? 0) + 1);
    return pick;
  }
}

function transitionFor(o: FillOptions, slot: Slot, beat: number): Transition | null {
  if (slot.drop && o.flashDrops) return { type: "fadewhite", duration: Math.min(0.15, beat / 3) };
  switch (o.transitions) {
    case "flashBar":
      return slot.downbeat ? { type: "fadewhite", duration: Math.min(0.12, beat / 4) } : null;
    case "fadePhrase":
      return slot.phrase ? { type: "fade", duration: beat } : null;
    case "fadeAll":
      return { type: "fade", duration: Math.min(0.15, slot.duration / 3) };
    case "none":
      return null;
  }
}

function rampedSpeed(o: FillOptions, slot: Slot): number {
  if (!o.speedRamps) return o.speed;
  if (slot.drop) return o.speed * 1.4;
  if (slot.energy > 0.72) return o.speed * 1.15;
  if (slot.energy < 0.4) return o.speed * 0.75;
  return o.speed;
}

/**
 * One clip per slot. `pools[stage]` holds the candidates of each tag stage, `stages[i]` the stage of slot i.
 * Deterministic: all randomness comes from `o.seed`.
 */
export function fillSlots(p: PmvProject, slots: Slot[], stages: number[], pools: MaterialItem[][], o: FillOptions, ctx: FillContext): Clip[] {
  const rnd = mulberry32(o.seed ^ 0x9e3779b9);
  const queues = pools.map((items) => new Pool(items, o.order, rnd));
  const beat = beatLength(p.beatGrid);
  const recentScenes: string[] = [];
  const recentPerformers: string[][] = [];
  const usedSpots = new Map<string, number[]>();
  const continued = new Map<string, number>();

  const fresh = (sceneId: string, t: number) => !(usedSpots.get(sceneId) ?? []).some((u) => Math.abs(u - t) < 3);
  const mapSpots = (it: MaterialItem, need: number, slot: Slot) => {
    const s = it.snippet;
    const win = o.followTimeline ? timelineWindow(s.in, s.out, slot.progress) : [s.in, s.out];
    return (ctx.speedMaps[s.sceneId] ?? []).filter((x) => x.t >= win[0] && x.t + need <= Math.min(win[1], s.out) + EPS);
  };
  // how far the best spot of an item is from the wanted pace (null = unknown)
  const paceFit = (it: MaterialItem, need: number, slot: Slot): number | null => {
    let d: number | null = null;
    for (const x of mapSpots(it, need, slot)) {
      const pct = ctx.speedPct(x.speed);
      if (pct == null) continue;
      const v = Math.abs(pct - slot.energy) + (fresh(it.snippet.sceneId, x.t) ? 0 : 0.5);
      if (d == null || v < d) d = v;
    }
    return d;
  };

  return slots.map((slot, k) => {
    const pool = queues[stages[k]] ?? queues[0];
    const speed = rampedSpeed(o, slot);
    const need = slot.duration * speed;
    const varietyWindow = Math.min(RECENT_SCENES, Math.max(0, pool.scenes - 1));
    const it = pool.take((cand) => {
      let c = 0;
      if (o.variety) {
        if (recentScenes.slice(-varietyWindow).includes(cand.snippet.sceneId) && varietyWindow > 0) c += 100;
        for (const perfs of recentPerformers.slice(-RECENT_PERFORMERS)) for (const id of cand.performers) if (perfs.includes(id)) c += 0.6;
      }
      if (o.paceMatch && !cand.fixedStart) c += 2.5 * (paceFit(cand, need, slot) ?? 0.3);
      return c;
    }, o.paceMatch);
    const s = it.snippet;
    const len = s.out - s.in;
    let start = s.in;

    if (it.fixedStart) {
      // markers: from their start; re-used ones play on inside the marker
      const off = continued.get(s.id) ?? 0;
      start = s.in + (off + need <= len + EPS ? off : 0);
      continued.set(s.id, start - s.in + need);
    } else {
      const spots = o.paceMatch ? mapSpots(it, need, slot) : [];
      const scored = spots
        .map((x) => ({ x, pct: ctx.speedPct(x.speed) }))
        .filter((c) => c.pct != null)
        .map((c) => ({ t: c.x.t, d: Math.abs(c.pct! - slot.energy) + (fresh(s.sceneId, c.x.t) ? 0 : 0.5) + rnd() * 0.12 }))
        .sort((a, b) => a.d - b.d);
      if (scored.length) start = scored[0].t;
      else if (o.offset === "continue") {
        const off = continued.get(s.id) ?? 0;
        start = s.in + (off + need <= len + EPS ? off : 0);
        continued.set(s.id, start - s.in + need);
      } else if (o.offset === "random" || o.followTimeline) {
        const [lo, hi] = o.followTimeline ? timelineWindow(s.in, s.out, slot.progress) : [s.in, s.out];
        const room = Math.max(0, Math.min(hi, s.out) - need - lo);
        // a few seeded tries, the one farthest from spots used before in this scene
        let bestT = lo;
        let bestGap = -1;
        for (let tries = 0; tries < 3; tries++) {
          const t = lo + rnd() * room;
          const gap = Math.min(99, ...(usedSpots.get(s.sceneId) ?? [99]).map((u) => Math.abs(u - t)));
          if (gap > bestGap) [bestT, bestGap] = [t, gap];
          if (gap >= 3) break;
        }
        start = bestT;
      }
    }
    const fileDur = p.sources[s.sceneId]?.duration ?? 0;
    if (fileDur > 0 && start + need > fileDur) start = Math.max(0, fileDur - need);

    recentScenes.push(s.sceneId);
    recentPerformers.push(it.performers);
    usedSpots.set(s.sceneId, [...(usedSpots.get(s.sceneId) ?? []), start].slice(-8));

    return {
      id: uid("clip"),
      sceneId: s.sceneId,
      snippetId: s.id,
      markerId: s.markerId,
      start: slot.start,
      duration: slot.duration,
      sourceIn: start,
      speed,
      volume: 0,
      transitionIn: k === 0 ? null : transitionFor(o, slot, beat),
      fit: null,
      label: s.label,
    };
  });
}

/** The part of [a, b] that matches song progress p (±12 % of the length). */
export function timelineWindow(a: number, b: number, p: number): [number, number] {
  const len = b - a;
  const c = a + clamp(p, 0, 1) * len;
  return [Math.max(a, c - TIMELINE_WINDOW * len), Math.min(b, c + TIMELINE_WINDOW * len)];
}
