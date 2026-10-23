import { useEffect, useState } from "react";
import { type AudioAnalysis, analyzeAudio } from "../audio/analysis";
import { stashUrl } from "../stash/graphql";
import { type SpriteSheet, loadSprites } from "../stash/sprites";
import type { Transport } from "../state/transport";

/** Transport time as React state, throttled (for displays, not for the playhead line). */
export function useTransportTime(transport: Transport, intervalMs = 50): number {
  const [t, setT] = useState(transport.time);
  useEffect(() => {
    let last = 0;
    return transport.subscribe(() => {
      const now = performance.now();
      if (!transport.playing || now - last >= intervalMs) {
        last = now;
        setT(transport.time);
      }
    });
  }, [transport, intervalMs]);
  return t;
}

export function useTransportPlaying(transport: Transport): boolean {
  const [p, setP] = useState(transport.playing);
  useEffect(() => transport.subscribe(() => setP(transport.playing)), [transport]);
  return p;
}

const analysisCache = new Map<string, Promise<AudioAnalysis>>();

export function getAudioAnalysis(url: string): Promise<AudioAnalysis> {
  let p = analysisCache.get(url);
  if (!p) {
    p = fetch(stashUrl(url), { credentials: "same-origin" })
      .then((r) => {
        if (!r.ok) throw new Error(`Audio HTTP ${r.status}`);
        return r.arrayBuffer();
      })
      .then(analyzeAudio);
    p.catch(() => analysisCache.delete(url));
    analysisCache.set(url, p);
  }
  return p;
}

/** Drops a decoded song from the cache (several PMVs at once: one song after the other, not all in memory). */
export const forgetAudioAnalysis = (url: string): void => void analysisCache.delete(url);

export function useAudioAnalysis(url: string | null | undefined): { analysis: AudioAnalysis | null; error: string | null } {
  const [state, setState] = useState<{ analysis: AudioAnalysis | null; error: string | null }>({ analysis: null, error: null });
  useEffect(() => {
    if (!url) {
      setState({ analysis: null, error: null });
      return;
    }
    let alive = true;
    setState({ analysis: null, error: null });
    getAudioAnalysis(url).then(
      (analysis) => alive && setState({ analysis, error: null }),
      (e: unknown) => alive && setState({ analysis: null, error: String(e) }),
    );
    return () => {
      alive = false;
    };
  }, [url]);
  return state;
}

export function useSprites(vttPath: string | null | undefined): SpriteSheet | null {
  const [sheet, setSheet] = useState<SpriteSheet | null>(null);
  useEffect(() => {
    if (!vttPath) {
      setSheet(null);
      return;
    }
    let alive = true;
    void loadSprites(vttPath).then((s) => alive && setSheet(s));
    return () => {
      alive = false;
    };
  }, [vttPath]);
  return sheet;
}

/** Closes popovers when clicking elsewhere. */
export function useClickOutside(ref: { current: HTMLElement | null }, open: boolean, onClose: () => void): void {
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [ref, open, onClose]);
}
