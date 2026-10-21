/** Stash scrubber sprites (WebVTT + sprite sheet) – used as thumbnails / filmstrip ("keyframes"). */
import { stashUrl } from "./graphql";

export interface SpriteCue {
  start: number;
  end: number;
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpriteSheet {
  cues: SpriteCue[];
  /** Sheet size per image URL (needed to scale background-size). */
  sheets: Record<string, { w: number; h: number }>;
}

const parseTs = (s: string): number => {
  const parts = s.trim().split(":").map(Number);
  return parts.reduce((acc, v) => acc * 60 + v, 0);
};

export function parseVtt(text: string, vttUrl: string): SpriteSheet {
  const cues: SpriteCue[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*([\d:.]+)\s*-->\s*([\d:.]+)/);
    if (!m) continue;
    const ref = (lines[i + 1] ?? "").trim();
    const hash = ref.match(/^(.*)#xywh=(\d+),(\d+),(\d+),(\d+)$/);
    if (!hash) continue;
    cues.push({
      start: parseTs(m[1]),
      end: parseTs(m[2]),
      url: new URL(hash[1], vttUrl).toString(),
      x: +hash[2],
      y: +hash[3],
      w: +hash[4],
      h: +hash[5],
    });
  }
  const sheets: SpriteSheet["sheets"] = {};
  for (const c of cues) {
    const s = (sheets[c.url] ??= { w: 0, h: 0 });
    s.w = Math.max(s.w, c.x + c.w);
    s.h = Math.max(s.h, c.y + c.h);
  }
  return { cues, sheets };
}

const cache = new Map<string, Promise<SpriteSheet>>();

export function loadSprites(vttPath: string): Promise<SpriteSheet> {
  let p = cache.get(vttPath);
  if (!p) {
    const url = stashUrl(vttPath);
    p = fetch(url, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : ""))
      .then((t) => parseVtt(t, url))
      .catch(() => ({ cues: [], sheets: {} }));
    cache.set(vttPath, p);
  }
  return p;
}

export function cueAt(sheet: SpriteSheet, t: number): SpriteCue | null {
  const { cues } = sheet;
  if (!cues.length) return null;
  let lo = 0;
  let hi = cues.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cues[mid].start <= t) lo = mid;
    else hi = mid - 1;
  }
  return cues[lo];
}
