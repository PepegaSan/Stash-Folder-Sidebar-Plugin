/**
 * Split screens like the PMV Generator's: in a layout range of the timeline the picture is cut into fields, and each
 * field shows the clips of a track – group 0 is the bottom track (V1), group 1 the one above (V2), and so on. Outside
 * the layout ranges nothing changes: the top track wins.
 */
import { uid } from "./ids";
import type { FitMode, Seconds } from "./project";

/** In the order of how full the picture gets. */
export const LAYOUTS = ["duo", "trim", "tri", "quad", "kaleido"] as const;
export type LayoutKind = (typeof LAYOUTS)[number];
/** Fields side by side or one above the other (4-way and kaleidoscope are a grid either way). */
export type SplitDir = "cols" | "rows";

export interface LayoutRange {
  id: string;
  start: Seconds;
  duration: Seconds;
  kind: LayoutKind;
  dir: SplitDir;
}

/** A field: its rectangle as shares of the picture, the group (track) whose clip it shows, mirrored or not. */
export interface Field {
  x: number;
  y: number;
  w: number;
  h: number;
  group: number;
  /** Mirrored left–right / top–bottom. */
  fx: boolean;
  fy: boolean;
}

/** How many different clips a layout shows, and how "full" it is (the generator picks by the music's energy). */
export const LAYOUT_INFO: Record<"full" | LayoutKind, { groups: number; level: number }> = {
  full: { groups: 1, level: 1 },
  kaleido: { groups: 1, level: 2 },
  duo: { groups: 2, level: 2 },
  trim: { groups: 2, level: 3 },
  tri: { groups: 3, level: 3 },
  quad: { groups: 4, level: 4 },
};

/** The fields of a layout (the PMV Generator's slotsFor, as shares of the picture). */
export function layoutFields(kind: LayoutKind, dir: SplitDir): Field[] {
  const split = (groups: number[], mirror: boolean[]): Field[] =>
    groups.map((group, i) => {
      const a = i / groups.length;
      const b = (i + 1) / groups.length;
      return dir === "rows" ? { x: 0, y: a, w: 1, h: b - a, group, fx: false, fy: mirror[i] } : { x: a, y: 0, w: b - a, h: 1, group, fx: mirror[i], fy: false };
    });
  const grid = (group: (i: number) => number, mirror: (i: number) => [boolean, boolean]): Field[] =>
    [0, 1, 2, 3].map((i) => ({ x: (i % 2) / 2, y: Math.floor(i / 2) / 2, w: 0.5, h: 0.5, group: group(i), fx: mirror(i)[0], fy: mirror(i)[1] }));
  switch (kind) {
    case "duo":
      return split([0, 1], [false, false]);
    case "trim":
      // the same clip left and right (mirrored on the right), another one in the middle
      return split([0, 1, 0], [false, false, true]);
    case "tri":
      return split([0, 1, 2], [false, false, false]);
    case "quad":
      return grid((i) => i, () => [false, false]);
    case "kaleido":
      return grid(() => 0, (i) => [i % 2 === 1, i >= 2]);
  }
}

/** Index in `tracks` (top first) of the track a group's clips come from: group 0 = the bottom track. */
export const groupTrackIndex = (tracks: number, group: number): number => tracks - 1 - group;

/**
 * Layout ranges sorted, without overlaps (a later one wins where two overlap) and without empty ones – and without
 * broken ones (an unknown layout, no numbers; a project file can hold anything), none before 0.
 */
export function cleanLayouts(list: LayoutRange[]): LayoutRange[] {
  const out: LayoutRange[] = [];
  const valid = list
    .filter((x) => !!x && (LAYOUTS as readonly string[]).includes(x.kind) && Number.isFinite(x.start) && Number.isFinite(x.duration))
    .map((x) => (x.start < 0 ? { ...x, start: 0, duration: x.duration + x.start } : x))
    .filter((x) => x.duration > 1e-6);
  for (const r of valid.sort((a, b) => a.start - b.start)) {
    const last = out[out.length - 1];
    if (last && last.start + last.duration > r.start + 1e-6) last.duration = Math.max(0, r.start - last.start);
    out.push({ ...r, dir: r.dir === "rows" ? "rows" : "cols" });
  }
  return out.filter((x) => x.duration > 1e-6);
}

/** The layout ranges with [from, to) left free (a range across it is cut there). */
export function carveLayouts(list: LayoutRange[], from: Seconds, to: Seconds): LayoutRange[] {
  return list.flatMap((r) => {
    const end = r.start + r.duration;
    if (end <= from + 1e-6 || r.start >= to - 1e-6) return [r];
    const parts: LayoutRange[] = [];
    if (r.start < from - 1e-6) parts.push({ ...r, duration: from - r.start });
    if (end > to + 1e-6) parts.push({ ...r, id: parts.length ? uid("lay") : r.id, start: to, duration: end - to });
    return parts;
  });
}

/** A field in pixels of a W×H picture: even sizes (the encoder's chroma) that tile the picture. */
export function fieldRect(f: Field, W: number, H: number): [number, number, number, number] {
  const ex = (v: number, size: number) => 2 * Math.round((v * size) / 2);
  const x = ex(f.x, W);
  const y = ex(f.y, H);
  return [x, y, ex(f.x + f.w, W) - x, ex(f.y + f.h, H) - y];
}

/**
 * The PMV Generator's rule for clips in a field: a clip whose shape is close to the field's (within 16 %) fills it –
 * thin bars or blurred edges at the sides would only flicker with the zoom pulse.
 */
export function fitInField(fit: FitMode, clipAspect: number, fieldAspect: number): FitMode {
  if (fit === "cover" || !(clipAspect > 0) || !(fieldAspect > 0)) return fit;
  const r = clipAspect / fieldAspect;
  return Math.max(r, 1 / r) <= 1.16 ? "cover" : fit;
}

/** Width of the dividers between fields: 2 px of a picture 1280 wide (the PMV Generator's), at least 1 px. */
export const dividerWidth = (W: number): number => Math.max(1, Math.round((2 * W) / 1280));

/** The dividers as rectangles [x, y, w, h] in pixels: a line along every inner field edge, centred on it. */
export function dividerRects(fields: Field[], W: number, H: number): Array<[number, number, number, number]> {
  const dw = dividerWidth(W);
  const half = Math.floor(dw / 2);
  const seen = new Set<string>();
  const out: Array<[number, number, number, number]> = [];
  for (const f of fields) {
    const [x, y, w, h] = fieldRect(f, W, H);
    const lines: Array<[number, number, number, number]> = [];
    if (x > 0) lines.push([x - half, y, dw, h]);
    if (y > 0) lines.push([x, y - half, w, dw]);
    for (const r of lines) {
      const key = r.join(",");
      if (!seen.has(key)) {
        seen.add(key);
        out.push(r);
      }
    }
  }
  return out;
}
