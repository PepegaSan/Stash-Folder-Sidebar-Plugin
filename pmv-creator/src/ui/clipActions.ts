/**
 * Clip actions that first ask Stash for candidates: 🎲 another clip (N) and ⊘ scene out, plus the Stash tag behind
 * "never use it again". The candidates are the generator's last run (same filters, stages and seed), fetched once
 * per session; a project that was never generated draws from its own scenes.
 */
import { exclusionFromRange, snippetFromRange } from "../culling/culling";
import type { MaterialItem } from "../generator/material";
import { type RerollOptions, rerollClips } from "../generator/reroll";
import { t, tn } from "../i18n";
import type { PmvProject, SourceMedia } from "../model/project";
import { SKIP_TAG, cachedTagId, ensureTag, setSceneTag } from "../stash/library";
import { invalidateScene } from "../stash/sceneCache";
import type { Action, EditorState } from "../state/reducer";
import { collectPools } from "./generator/run";

type Dispatch = (a: Action) => void;

interface Candidates {
  pools: MaterialItem[][];
  sources: SourceMedia[];
  opts: Omit<RerollOptions, "seed">;
}

/** Library queries of the last run, by clip options + seed (the same library answers the same). */
const poolCache = new Map<string, Promise<{ pools: MaterialItem[][]; sources: SourceMedia[] }>>();

/** The project's own scenes (8 % intro/credits skipped, like the generator's default). */
function projectPool(p: PmvProject): MaterialItem[] {
  return Object.values(p.sources)
    .filter((s) => s.duration > 0)
    .map((s) => ({ snippet: snippetFromRange(s.sceneId, s.duration * 0.08, s.duration * 0.92, s.title), performers: [], fixedStart: false }));
}

async function candidates(p: PmvProject): Promise<Candidates> {
  const memo = p.generator;
  if (memo) {
    const o = memo.settings.clips;
    const key = o.source === "filter" || o.source === "watched" ? JSON.stringify([o, memo.settings.seed]) : null;
    let run = key ? poolCache.get(key) : undefined;
    if (!run) {
      run = collectPools(o, p, memo.settings.seed);
      if (key) {
        poolCache.set(key, run);
        run.catch(() => poolCache.delete(key));
      }
    }
    const { pools, sources } = await run;
    const opts = { variety: memo.settings.select.variety, followTimeline: memo.settings.select.followTimeline, range: { from: memo.from, to: memo.to } };
    if (pools.some((x) => x.length)) return { pools, sources, opts };
  }
  return { pools: [projectPool(p)], sources: [], opts: { variety: true, followTimeline: false, range: null } };
}

const withSources = (p: PmvProject, sources: SourceMedia[]): PmvProject => ({ ...p, sources: { ...p.sources, ...Object.fromEntries(sources.map((s) => [s.sceneId, s])) } });
const randomSeed = () => Math.floor(Math.random() * 0x7fffffff);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

let busy = false;
/** Per clip, the scenes 🎲 rolled it away from this session (the last few) – the next roll prefers others. */
const rolledAway = new Map<string, string[]>();
const AVOID = 6;

/** 🎲 New material for the clips – places and lengths stay. One undo step. */
export async function anotherClip(getState: () => EditorState, dispatch: Dispatch, clipIds: string[]): Promise<void> {
  if (busy || !clipIds.length) return;
  busy = true;
  dispatch({ type: "ui", patch: { clipTask: { text: t("Looking for another clip…"), error: false } } });
  try {
    const p = getState().present;
    const c = await candidates(p);
    const avoid: Record<string, string[]> = {};
    for (const tr of p.tracks) for (const x of tr.clips) if (clipIds.includes(x.id)) avoid[x.id] = [...(rolledAway.get(x.id) ?? []), x.sceneId].slice(-AVOID);
    const changes = rerollClips(withSources(p, c.sources), clipIds, c.pools, { ...c.opts, seed: randomSeed(), avoid });
    for (const id of Object.keys(avoid)) rolledAway.set(id, avoid[id]);
    if (!changes.length) throw new Error(t("No other clip found – every candidate of the last generator run is this scene."));
    const used = new Set(changes.map((x) => x.sceneId));
    dispatch({ type: "clips/material", changes, sources: c.sources.filter((s) => used.has(s.sceneId)) });
    dispatch({ type: "ui", patch: { clipTask: null } });
  } catch (e) {
    dispatch({ type: "ui", patch: { clipTask: { text: message(e), error: true } } });
  } finally {
    busy = false;
  }
}

/**
 * ⊘ The scene leaves this PMV: excluded for the project (the generator skips it, "Include again" in the scene
 * brings it back) and every clip of it gets another clip – one undo step.
 */
export async function sceneOut(getState: () => EditorState, dispatch: Dispatch, sceneId: string): Promise<void> {
  if (busy) return;
  busy = true;
  dispatch({ type: "ui", patch: { clipTask: { text: t("Looking for other clips…"), error: false } } });
  try {
    const p = getState().present;
    const src = p.sources[sceneId];
    const exclusion = exclusionFromRange(sceneId, 0, src?.duration && src.duration > 0 ? src.duration : 24 * 3600);
    const out = { ...p, exclusions: [...p.exclusions, exclusion] };
    const clipIds = p.tracks.filter((tr) => !tr.locked).flatMap((tr) => tr.clips.filter((c) => c.sceneId === sceneId).map((c) => c.id));
    const c = await candidates(out);
    const changes = rerollClips(withSources(out, c.sources), clipIds, c.pools, { ...c.opts, seed: randomSeed() });
    const used = new Set(changes.map((x) => x.sceneId));
    dispatch({ type: "clips/material", changes, sources: c.sources.filter((s) => used.has(s.sceneId)), exclusions: [exclusion] });
    const left = clipIds.length - changes.length;
    dispatch({
      type: "ui",
      patch: {
        sceneOut: { sceneId, title: src?.title ?? sceneId, replaced: changes.length, tagged: false },
        clipTask: left > 0 ? { text: tn(left, "{n} clips found no other scene – they stay, marked ⚠", "1 clip found no other scene – it stays, marked ⚠"), error: true } : null,
      },
    });
  } catch (e) {
    dispatch({ type: "ui", patch: { clipTask: { text: message(e), error: true } } });
  } finally {
    busy = false;
  }
}

/** Tags the scene in Stash so no generator run picks it again (any project). */
export async function skipForever(sceneId: string): Promise<void> {
  await setSceneTag([sceneId], await ensureTag(SKIP_TAG), true);
  poolCache.clear();
  invalidateScene(sceneId);
}

/** Takes the skip tag off again. */
export async function allowAgain(sceneId: string): Promise<void> {
  const id = await cachedTagId(SKIP_TAG);
  if (id) await setSceneTag([sceneId], id, false);
  poolCache.clear();
  invalidateScene(sceneId);
}
