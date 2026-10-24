/**
 * "Another clip": new material for clips that are already on the timeline – their place, length, speed and
 * transition stay. The candidates are the ones the generator used (same filters and stages); the pick follows
 * its rules: not the scene the clip had, no scene that plays nearby, few clips per scene, a spot of the scene
 * that is not used yet.
 */
import type { Clip, PmvProject } from "../model/project";
import { MIN_SPEED, findClip } from "../timeline/ops";
import { EPS } from "../timeline/time";
import { timelineWindow } from "./assemble";
import { allowedParts } from "./generate";
import type { MaterialItem } from "./material";
import { mulberry32 } from "./random";

/** What a clip gets: the material, never its place on the timeline. */
export interface MaterialChange {
  clipId: string;
  sceneId: string;
  snippetId: string | null;
  markerId: string | null;
  sourceIn: number;
  speed: number;
  label: string;
}

export interface RerollOptions {
  seed: number;
  variety: boolean;
  followTimeline: boolean;
  /** Generated range – the song's progress for "follow the scenes' timeline". */
  range: { from: number; to: number } | null;
  /** Per clip: scenes it was just rolled away from – pressing again goes on to others instead of back. */
  avoid?: Record<string, string[]>;
}

/** Clips on each side whose scenes a re-rolled clip should not repeat. */
const NEIGHBOURS = 6;

const applyChange = (p: PmvProject, ch: MaterialChange): PmvProject => ({
  ...p,
  tracks: p.tracks.map((t) => (t.clips.some((c) => c.id === ch.clipId) ? { ...t, clips: t.clips.map((c) => (c.id === ch.clipId ? { ...c, ...ch, id: c.id } : c)) } : t)),
});

/**
 * New material for each clip (in timeline order; every pick sees the ones before it). Clips for which no other
 * candidate exists are left out of the result.
 */
export function rerollClips(p: PmvProject, clipIds: string[], pools: MaterialItem[][], o: RerollOptions): MaterialChange[] {
  const rnd = mulberry32(o.seed ^ 0x5bd1e995);
  const usable = pools.map((pool) => pool.flatMap((it) => allowedParts(it, p.exclusions)));
  const all = usable.flat();
  const performersOf = new Map<string, string[]>();
  for (const it of all) if (it.performers.length) performersOf.set(it.snippet.sceneId, it.performers);

  const targets = clipIds
    .map((id) => findClip(p, id)?.clip)
    .filter((c): c is Clip => !!c)
    .sort((a, b) => a.start - b.start);
  const changes: MaterialChange[] = [];
  let cur = p;
  for (const target of targets) {
    const loc = findClip(cur, target.id);
    if (!loc || loc.track.locked) continue;
    const c = loc.clip;
    // a generated clip comes from one tag stage – its replacement from the same one
    const stagePool = usable.find((pool) => pool.some((it) => it.snippet.sceneId === c.sceneId));
    let cands = (stagePool ?? all).filter((it) => it.snippet.sceneId !== c.sceneId);
    if (!cands.length) cands = all.filter((it) => it.snippet.sceneId !== c.sceneId);
    if (!cands.length) continue;

    const lane = loc.track.clips;
    const i = lane.findIndex((x) => x.id === c.id);
    const near = lane.slice(Math.max(0, i - NEIGHBOURS), i + NEIGHBOURS + 1).filter((x) => x.id !== c.id);
    const nearScenes = new Set(near.map((x) => x.sceneId));
    // what plays at the same time on the other tracks – in a split screen the other fields
    for (const t of cur.tracks) if (t.id !== loc.track.id) for (const x of t.clips) if (x.start < c.start + c.duration - EPS && x.start + x.duration > c.start + EPS) nearScenes.add(x.sceneId);
    const nearPerformers = lane
      .slice(Math.max(0, i - 2), i + 3)
      .filter((x) => x.id !== c.id)
      .flatMap((x) => performersOf.get(x.sceneId) ?? []);
    const uses = new Map<string, number>();
    for (const t of cur.tracks) for (const x of t.clips) if (x.id !== c.id) uses.set(x.sceneId, (uses.get(x.sceneId) ?? 0) + 1);

    let best: MaterialItem | null = null;
    let low = Infinity;
    for (const it of cands) {
      const sid = it.snippet.sceneId;
      let cost = 0.3 * (uses.get(sid) ?? 0) + rnd();
      if (o.avoid?.[c.id]?.includes(sid)) cost += 50;
      if (o.variety) {
        if (nearScenes.has(sid)) cost += 100;
        for (const id of it.performers) if (nearPerformers.includes(id)) cost += 0.6;
      }
      if (cost < low) [low, best] = [cost, it];
    }
    const it = best!;
    const s = it.snippet;
    const fileDur = cur.sources[s.sceneId]?.duration ?? 0;
    // material shorter than the slot: slow down rather than run past the end of the file
    const speed = fileDur > 0 && c.duration * c.speed > fileDur ? Math.max(MIN_SPEED, fileDur / c.duration) : c.speed;
    const need = c.duration * speed;
    let start = s.in;
    if (!it.fixedStart) {
      const progress = o.range && o.range.to > o.range.from ? (c.start - o.range.from) / (o.range.to - o.range.from) : 0.5;
      const [lo, hi] = o.followTimeline && o.range ? timelineWindow(s.in, s.out, progress) : [s.in, s.out];
      const room = Math.max(0, Math.min(hi, s.out) - need - lo);
      const used: number[] = [];
      for (const t of cur.tracks) for (const x of t.clips) if (x.sceneId === s.sceneId && x.id !== c.id) used.push(x.sourceIn);
      // a few tries, the one farthest from the spots this scene already plays
      let bestGap = -1;
      for (let tries = 0; tries < 4; tries++) {
        const t = lo + rnd() * room;
        const gap = Math.min(99, ...used.map((u) => Math.abs(u - t)));
        if (gap > bestGap) [start, bestGap] = [t, gap];
        if (gap >= 3) break;
      }
    }
    if (fileDur > 0 && start + need > fileDur + EPS) start = Math.max(0, fileDur - need);
    const change: MaterialChange = {
      clipId: c.id,
      sceneId: s.sceneId,
      snippetId: cur.bin.some((b) => b.id === s.id) ? s.id : null,
      markerId: s.markerId,
      sourceIn: Math.round(start * 1e6) / 1e6,
      speed,
      label: s.label,
    };
    changes.push(change);
    cur = applyChange(cur, change);
  }
  return changes;
}

/** Reducer side: the material of each clip, one undo step. */
export function applyMaterial(p: PmvProject, changes: MaterialChange[]): PmvProject {
  return changes.reduce((acc, ch) => (findClip(acc, ch.clipId) ? applyChange(acc, ch) : acc), p);
}
