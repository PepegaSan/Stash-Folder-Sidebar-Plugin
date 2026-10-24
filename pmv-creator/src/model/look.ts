/**
 * Colour looks for the whole PMV, after the PMV Generator's: a chain of CSS colour filters on every clip, soft-light
 * layers over the picture (the look's tint, white for extra brightness) and dark corners. The preview and the quick
 * record draw the CSS form on their canvas; the FFmpeg render gets the same chain folded into one colour matrix,
 * so all three agree.
 */

export const LOOKS = ["none", "warm", "pink", "cold", "vivid", "bw", "noir", "custom"] as const;
export type Look = (typeof LOOKS)[number];

/** What a project says about its look (part of the output settings). */
export interface LookSettings {
  look: Look;
  /** Strength of the look, 0…1. */
  lookAmount: number;
  /** The tint of the "custom" look, #rrggbb. */
  lookColor: string;
  /** Extra brightness, 0…1. */
  brightness: number;
}

type Op = ["sepia" | "saturate" | "grayscale" | "contrast" | "brightness", number];
type Rgba = [number, number, number, number];

/** Each look at strength a: filters on every clip, a tint over everything, dark corners. */
const DEFS: Record<Look, { ops: (a: number) => Op[]; tint: Rgba | null; vignette?: number }> = {
  none: { ops: () => [], tint: null },
  warm: { ops: (a) => [["sepia", 0.22 * a], ["saturate", 1 + 0.2 * a], ["contrast", 1 + 0.04 * a]], tint: [255, 140, 60, 0.22] },
  pink: { ops: (a) => [["saturate", 1 + 0.15 * a], ["contrast", 1 + 0.05 * a]], tint: [255, 62, 138, 0.3] },
  cold: { ops: (a) => [["saturate", 1 - 0.15 * a], ["contrast", 1 + 0.06 * a]], tint: [60, 140, 255, 0.26] },
  vivid: { ops: (a) => [["saturate", 1 + 0.7 * a], ["contrast", 1 + 0.12 * a]], tint: null },
  bw: { ops: (a) => [["grayscale", a], ["contrast", 1 + 0.15 * a]], tint: null },
  noir: { ops: (a) => [["grayscale", a], ["contrast", 1 + 0.5 * a], ["brightness", 1 - 0.12 * a]], tint: null, vignette: 0.6 },
  custom: { ops: () => [], tint: null },
};

export interface ColorGrade {
  /** CSS filter for drawing a clip on a canvas. */
  css: string;
  /** The same chain as a 3×3 RGB matrix (row-major) plus an offset per channel, on 0…1 values. */
  matrix: number[];
  offset: number[];
  /** Soft-light layers over the picture: r, g, b (0…255) and alpha. */
  layers: Rgba[];
  /** Dark corners, 0 = none … 1 = strong. */
  vignette: number;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0xff4d94;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** The filter functions' matrices from the CSS Filter Effects spec (sepia/grayscale amount 0…1). */
function opMatrix([f, v]: Op): { m: number[]; o: number } {
  const k = 1 - clamp01(v);
  switch (f) {
    case "sepia":
      return { m: [0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k, 0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k, 0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k], o: 0 };
    case "grayscale":
      return { m: [0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k, 0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k, 0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k], o: 0 };
    case "saturate":
      return { m: [0.213 + 0.787 * v, 0.715 - 0.715 * v, 0.072 - 0.072 * v, 0.213 - 0.213 * v, 0.715 + 0.285 * v, 0.072 - 0.072 * v, 0.213 - 0.213 * v, 0.715 - 0.715 * v, 0.072 + 0.928 * v], o: 0 };
    case "contrast":
      return { m: [v, 0, 0, 0, v, 0, 0, 0, v], o: 0.5 - 0.5 * v };
    case "brightness":
      return { m: [v, 0, 0, 0, v, 0, 0, 0, v], o: 0 };
  }
}

/** One affine colour transform for a chain applied in order: v → M·v + o. */
function compose(ops: Op[]): { matrix: number[]; offset: number[] } {
  let M = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  let o = [0, 0, 0];
  for (const op of ops) {
    const { m, o: c } = opMatrix(op);
    const mul = (r: number, col: number) => m[r * 3] * M[col] + m[r * 3 + 1] * M[3 + col] + m[r * 3 + 2] * M[6 + col];
    const next = [0, 1, 2].flatMap((r) => [0, 1, 2].map((col) => mul(r, col)));
    o = [0, 1, 2].map((r) => m[r * 3] * o[0] + m[r * 3 + 1] * o[1] + m[r * 3 + 2] * o[2] + c);
    M = next;
  }
  return { matrix: M, offset: o };
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** The look of a project; null when it leaves the picture as it is. */
export function colorGrade(s: LookSettings): ColorGrade | null {
  const a = clamp01(s.lookAmount);
  const b = clamp01(s.brightness);
  const def = DEFS[s.look] ?? DEFS.none;
  // steps that change nothing (a look at strength 0) are left out
  const ops = def.ops(a).filter(([f, v]) => (f === "sepia" || f === "grayscale" ? v > 1e-6 : Math.abs(v - 1) > 1e-6));
  if (b > 0) ops.push(["brightness", 1 + 0.1 * b]);
  const tint: Rgba | null = s.look === "custom" ? [...hexRgb(s.lookColor), 0.34] : def.tint;
  const layers: Rgba[] = [];
  if (tint && a > 0) layers.push([tint[0], tint[1], tint[2], r3(tint[3] * a)]);
  // brighter, smoothly: white in soft-light lifts the mid-tones without burning out the highlights
  if (b > 0) layers.push([255, 255, 255, r3(0.4 * b)]);
  const vignette = r3((def.vignette ?? 0) * a);
  if (!ops.length && !layers.length && !vignette) return null;
  const { matrix, offset } = compose(ops);
  return {
    css: ops.map(([f, v]) => `${f}(${r3(v)})`).join(" "),
    matrix: matrix.map((x) => Math.round(x * 1e4) / 1e4),
    offset: offset.map((x) => Math.round(x * 1e4) / 1e4),
    layers,
    vignette,
  };
}
