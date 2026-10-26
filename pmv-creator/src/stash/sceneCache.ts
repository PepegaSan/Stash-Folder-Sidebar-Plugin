/** Session cache of full Stash scenes (markers, streams, sprites) keyed by scene ID. */
import { useEffect, useMemo, useReducer, useRef } from "react";
import { fetchScenes } from "./queries";
import type { StashScene } from "./types";

const cache = new Map<string, StashScene>();
const pending = new Set<string>();
/** Ids Stash does not know (deleted scenes) – not asked again this session. */
const unknown = new Set<string>();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function primeScenes(scenes: StashScene[]): void {
  for (const s of scenes) {
    cache.set(s.id, s);
    unknown.delete(s.id);
  }
  emit();
}

export function invalidateScene(id: string): void {
  cache.delete(id);
  unknown.delete(id);
  void ensureScenes([id]);
}

/**
 * Fetch these scenes again and swap them in place: the old ones stay in view until the new ones are there
 * (no "Loading…", the scene view keeps its spot), a scene Stash no longer knows becomes unknown.
 */
export async function refreshScenes(ids: string[]): Promise<void> {
  const want = [...new Set(ids)];
  if (!want.length) return;
  const found = await fetchScenes(want);
  const got = new Set(found.map((s) => s.id));
  for (const id of want) {
    if (got.has(id)) continue;
    cache.delete(id);
    unknown.add(id);
  }
  primeScenes(found);
}

export const isUnknownScene = (id: string) => unknown.has(id);

export async function ensureScenes(ids: string[]): Promise<void> {
  const missing = [...new Set(ids)].filter((id) => !cache.has(id) && !pending.has(id) && !unknown.has(id));
  if (!missing.length) return;
  missing.forEach((id) => pending.add(id));
  try {
    const found = await fetchScenes(missing);
    for (const s of found) cache.set(s.id, s);
    const got = new Set(found.map((s) => s.id));
    for (const id of missing) if (!got.has(id)) unknown.add(id);
  } finally {
    missing.forEach((id) => pending.delete(id));
    emit();
  }
}

function useCacheVersion(): number {
  const [version, bump] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);
  return version;
}

/**
 * Re-renders when scenes arrive; dependencies are keyed by the joined IDs, not the array identity. The result keeps
 * its identity while these scenes stay the same – other scenes arriving (the scene list) must not re-cue the preview.
 */
export function useScenes(ids: string[]): Record<string, StashScene> {
  const version = useCacheVersion();
  const key = ids.join(",");
  const last = useRef<Record<string, StashScene>>({});
  useEffect(() => {
    void ensureScenes(key ? key.split(",") : []).catch(() => undefined);
  }, [key]);
  return useMemo(() => {
    const out: Record<string, StashScene> = {};
    for (const id of key ? key.split(",") : []) {
      const s = cache.get(id);
      if (s) out[id] = s;
    }
    const prev = last.current;
    const same = Object.keys(out).length === Object.keys(prev).length && Object.keys(out).every((id) => prev[id] === out[id]);
    if (!same) last.current = out;
    return last.current;
  }, [key, version]);
}

export function useScene(id: string | null): StashScene | null {
  const scenes = useScenes(id ? [id] : []);
  return id ? scenes[id] ?? null : null;
}
