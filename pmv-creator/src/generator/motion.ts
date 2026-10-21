/**
 * Motion analysis for the two experimental generator modes, ported from the Pepega PMV Generator
 * (pmvgen.js / pmvsmart.js). Input are small grayscale frames (long side 64 px) that the backend
 * decodes with FFmpeg – so the same file always gives the same numbers.
 */

export interface GrayFrames {
  w: number;
  h: number;
  fps: number;
  /** Media time of the first frame. */
  t0: number;
  frames: Uint8Array[];
}

export interface Frame {
  t: number;
  gray: Uint8Array;
}

export const toFrames = (g: GrayFrames): Frame[] => g.frames.map((gray, i) => ({ t: g.t0 + i / g.fps, gray }));

export function decodeGrayFrames(b64: string, w: number, h: number, fps: number, t0: number): GrayFrames {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const size = w * h;
  const frames: Uint8Array[] = [];
  for (let o = 0; o + size <= bytes.length; o += size) frames.push(bytes.subarray(o, o + size));
  return { w, h, fps, t0, frames };
}

/** pmvsmart motion(): mean absolute difference, 40 grey levels = 1. */
export function frameDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || !a.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return Math.min(1, s / a.length / 40);
}

function hist16(a: Uint8Array): Float32Array {
  const h = new Float32Array(16);
  for (let i = 0; i < a.length; i++) h[a[i] >> 4]++;
  for (let i = 0; i < 16; i++) h[i] /= a.length;
  return h;
}

/** Hard cut between two frames: very different AND the brightness distribution changed (fast motion fails the 2nd test). */
export function isCut(a: Uint8Array, b: Uint8Array): boolean {
  if (frameDiff(a, b) <= 0.5) return false;
  const ha = hist16(a);
  const hb = hist16(b);
  let d = 0;
  for (let i = 0; i < 16; i++) d += Math.abs(ha[i] - hb[i]);
  return d / 2 > 0.35;
}

const shifts = (rx: number, ry: number): Array<[number, number]> => {
  const l: Array<[number, number]> = [];
  for (let dy = -ry; dy <= ry; dy++) for (let dx = -rx; dx <= rx; dx++) l.push([dx, dy]);
  return l.sort((p, q) => Math.abs(p[0]) + Math.abs(p[1]) - Math.abs(q[0]) - Math.abs(q[1]));
};
const CAM_SHIFTS = shifts(6, 4);
const BLOCK_SHIFTS = shifts(12, 12);

/**
 * How fast what is in the picture moves – not the camera. Camera shift first (best whole-frame fit), then
 * 4×4 block matching on top of it; the fastest 6 % of textured blocks count. -> px (of 64) per frame step.
 */
export function actionMotion(a: Uint8Array, b: Uint8Array, w: number): number {
  const h = Math.floor(a.length / w);
  const B = 4;
  if (w < 4 * B || h < 4 * B) return 0;
  let cb = Infinity;
  let cx = 0;
  let cy = 0;
  for (const [dx, dy] of CAM_SHIFTS) {
    let s = 0;
    for (let y = 4; y < h - 4 && s < cb; y += 2) for (let x = 6; x < w - 6; x += 2) s += Math.abs(a[y * w + x] - b[(y + dy) * w + x + dx]);
    if (s < cb) [cb, cx, cy] = [s, dx, dy];
  }
  const diff = (x0: number, y0: number, dx: number, dy: number, max: number) => {
    if (x0 + dx < 0 || y0 + dy < 0 || x0 + dx + B > w || y0 + dy + B > h) return Infinity;
    let s = 0;
    for (let y = y0; y < y0 + B && s < max; y++) {
      const r = y * w;
      const k = (y + dy) * w + dx;
      for (let x = x0; x < x0 + B; x++) s += Math.abs(a[r + x] - b[k + x]);
    }
    return s;
  };
  const mags: number[] = [];
  for (let y0 = 0; y0 + B <= h; y0 += B) {
    for (let x0 = 0; x0 + B <= w; x0 += B) {
      let tex = 0;
      for (let y = y0; y < y0 + B; y++) {
        for (let x = x0; x < x0 + B; x++) tex += Math.abs(a[y * w + Math.min(w - 1, x + 1)] - a[y * w + x]) + Math.abs(a[Math.min(h - 1, y + 1) * w + x] - a[y * w + x]);
      }
      if (tex < B * B * 6) continue;
      const still = diff(x0, y0, cx, cy, Infinity);
      if (still === Infinity) continue;
      let bc = Math.min(0.7 * still, still - B * B * 5);
      let mx = 0;
      let my = 0;
      let moved = false;
      for (const [dx, dy] of BLOCK_SHIFTS) {
        const pen = 2 * (Math.abs(dx) + Math.abs(dy));
        if (pen >= bc) break;
        const s = diff(x0, y0, cx + dx, cy + dy, bc - pen);
        if (s + pen < bc) [bc, mx, my, moved] = [s + pen, dx, dy, true];
      }
      mags.push(moved ? Math.hypot(mx, my) : 0);
    }
  }
  if (!mags.length) return 0;
  mags.sort((p, q) => q - p);
  const top = mags.slice(0, Math.max(2, Math.round(mags.length * 0.06)));
  return top.reduce((s, v) => s + v, 0) / top.length;
}

/** Speed of the action over a run of frames (px of 64 per second), null on a cut or too few frames. */
export function actionSpeed(fr: Frame[], w: number): number | null {
  const pts: number[] = [];
  for (let i = 1; i < fr.length; i++) {
    const dt = fr[i].t - fr[i - 1].t;
    if (dt <= 0) continue;
    if (isCut(fr[i - 1].gray, fr[i].gray)) return null;
    pts.push(actionMotion(fr[i - 1].gray, fr[i].gray, w) / dt);
  }
  return pts.length >= 5 ? pts.reduce((s, v) => s + v, 0) / pts.length : null;
}

export interface MotionPoint {
  t: number;
  m: number;
}

/** Motion per second between neighbouring frames; null on a cut (a scene change mixes two motions). */
export function motionCurve(fr: Frame[]): MotionPoint[] | null {
  const pts: MotionPoint[] = [];
  for (let i = 1; i < fr.length; i++) {
    const dt = fr[i].t - fr[i - 1].t;
    if (dt <= 0) continue;
    if (isCut(fr[i - 1].gray, fr[i].gray)) return null;
    pts.push({ t: (fr[i].t + fr[i - 1].t) / 2, m: frameDiff(fr[i - 1].gray, fr[i].gray) / dt });
  }
  return pts;
}

export interface Rhythm {
  /** Seconds per motion pulse. */
  period: number;
  /** Half period if the back-and-forth halves are a rhythm of their own. */
  half: number | null;
  /** A media time where the motion turns (least motion) – the "hit". */
  turn: number;
  q: number;
}

const RHYTHM_DT = 1 / 30;

/** The rhythm in a motion curve: autocorrelation over 0.2–0.9 s, phase from the fundamental. Null without a clear one. */
export function rhythmOf(pts: MotionPoint[]): Rhythm | null {
  if (pts.length < 30) return null;
  const t0 = pts[0].t;
  const n = Math.floor((pts[pts.length - 1].t - t0) / RHYTHM_DT) + 1;
  const x = new Float64Array(n);
  for (let i = 0, j = 0; i < n; i++) {
    const t = t0 + i * RHYTHM_DT;
    while (j < pts.length - 2 && pts[j + 1].t < t) j++;
    const a = pts[j];
    const b = pts[j + 1];
    const f = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    x[i] = a.m + (b.m - a.m) * f;
  }
  const mean = x.reduce((s, v) => s + v, 0) / n;
  for (let i = 0; i < n; i++) x[i] -= mean;
  const sd = Math.sqrt(x.reduce((s, v) => s + v * v, 0) / n);
  if (mean < 0.3 || sd / mean < 0.15) return null;
  const lo = Math.round(0.2 / RHYTHM_DT);
  const hi = Math.min(Math.round(0.9 / RHYTHM_DT), Math.floor(n * 0.6));
  if (hi <= lo + 2) return null;
  const corr = (L: number) => {
    let s = 0;
    let ea = 0;
    let eb = 0;
    for (let i = 0; i + L < n; i++) {
      s += x[i] * x[i + L];
      ea += x[i] * x[i];
      eb += x[i + L] * x[i + L];
    }
    return ea && eb ? s / Math.sqrt(ea * eb) : 0;
  };
  const r: number[] = [];
  for (let L = lo - 1; L <= hi + 1; L++) r[L] = corr(L);
  const peakAt = (L: number) => {
    const den = r[L - 1] - 2 * r[L] + r[L + 1];
    return L + (den ? Math.max(-0.5, Math.min(0.5, (0.5 * (r[L - 1] - r[L + 1])) / den)) : 0);
  };
  const peakNear = (L: number) => {
    let k = L;
    for (const j of [L - 1, L + 1]) if (r[j] != null && r[j] > r[k]) k = j;
    return r[k - 1] != null && r[k + 1] != null && r[k] >= r[k - 1] && r[k] >= r[k + 1] ? k : -1;
  };
  let top = 0;
  for (let L = lo; L <= hi; L++) top = Math.max(top, r[L]);
  if (top < 0.35) return null;
  let lag = -1;
  for (let L = lo; L <= hi; L++) {
    if (r[L] >= 0.8 * top && r[L] >= r[L - 1] && r[L] >= r[L + 1]) {
      lag = L;
      break;
    }
  }
  if (lag < 0) return null;
  let period = peakAt(lag) * RHYTHM_DT;
  if (2 * lag + 4 < n * 0.75) {
    for (let L = 2 * lag - 4; L <= 2 * lag + 4; L++) r[L] = r[L] ?? corr(L);
    let k = 2 * lag - 3;
    for (let L = k + 1; L <= 2 * lag + 3; L++) if (r[L] > r[k]) k = L;
    if (r[k] >= 0.25 && r[k] >= r[k - 1] && r[k] >= r[k + 1]) {
      const p2 = (peakAt(k) * RHYTHM_DT) / 2;
      if (Math.abs(p2 - period) < 1.6 * RHYTHM_DT) period = p2;
    }
  }
  const hk = Math.round(lag / 2) - 1 >= lo - 1 ? peakNear(Math.round(lag / 2)) : -1;
  const half = hk >= lo && r[hk] >= 0.3 ? period / 2 : null;
  const pulse = half || period;
  const mid = (n - 1) / 2;
  let c = 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const w = (2 * Math.PI * (i - mid) * RHYTHM_DT) / pulse;
    c += x[i] * Math.cos(w);
    s += x[i] * Math.sin(w);
  }
  const most = (Math.atan2(s, c) / (2 * Math.PI)) * pulse;
  return { period, half, turn: t0 + mid * RHYTHM_DT + most + pulse / 2, q: top };
}

/** Speed factor that puts motion pulses on the beat (1, 2 or ½ per beat), at most ±12 %; null if none fits. */
export function beatFit(period: number, bpm: number): number | null {
  const beat = 60 / bpm;
  let rate: number | null = null;
  for (const k of [1, 2, 0.5]) {
    const f = (period * k) / beat;
    if (f >= 0.88 && f <= 1.12 && (rate == null || Math.abs(f - 1) < Math.abs(rate - 1))) rate = f;
  }
  return rate;
}

// ------------------------------------------------------------------ speed maps from Stash scene previews

export interface PreviewConfig {
  previewSegments: number;
  previewSegmentDuration: number;
  previewExcludeStart: string;
  previewExcludeEnd: string;
}

export const DEFAULT_PREVIEW_CONFIG: PreviewConfig = { previewSegments: 12, previewSegmentDuration: 0.75, previewExcludeStart: "0", previewExcludeEnd: "0" };

/** Stash's rule: "5%" = share of the video, otherwise seconds. */
const excludeOf = (dur: number, v: string) => {
  const s = String(v ?? "0").trim();
  return s.endsWith("%") && s.length > 1 ? (parseFloat(s) / 100) * dur : parseFloat(s) || 0;
};

/** Where each piece of a preview (pieces spread over the scene) comes from in the scene. */
export function previewPieces(previewDur: number, sceneDur: number, cfg: PreviewConfig): Array<{ p0: number; p1: number; t: number }> {
  if (previewDur >= sceneDur * 0.9) {
    return Array.from({ length: Math.floor(previewDur) }, (_, i) => ({ p0: i, p1: i + 1, t: i * (sceneDur / previewDur) }));
  }
  const segLen = Math.max(0.75, +cfg.previewSegmentDuration || 0.75);
  let n = Math.max(1, +cfg.previewSegments || 12);
  if (Math.abs(previewDur / n - segLen) > 0.25 * segLen) n = Math.max(1, Math.round(previewDur / segLen));
  const len = previewDur / n;
  const ex0 = excludeOf(sceneDur, cfg.previewExcludeStart);
  const ex1 = excludeOf(sceneDur, cfg.previewExcludeEnd);
  const [offset, span] = sceneDur > ex0 + ex1 ? [ex0, sceneDur - ex0 - ex1] : [0, sceneDur];
  return Array.from({ length: n }, (_, i) => ({ p0: i * len, p1: (i + 1) * len, t: offset + (i * span) / n }));
}

export interface SpeedSpot {
  /** Scene time. */
  t: number;
  len: number;
  /** Action speed, px of 64 per second. */
  speed: number;
}

export function speedMapFromPreview(g: GrayFrames, sceneDur: number, cfg: PreviewConfig): SpeedSpot[] | null {
  const fr = toFrames(g);
  const previewDur = g.frames.length / g.fps;
  if (fr.length < 20 || !(sceneDur > 0)) return null;
  const pieces = previewPieces(previewDur, sceneDur, cfg);
  const out: SpeedSpot[] = [];
  for (const pc of pieces) {
    // frames well inside the piece (its edges are cuts to the next piece)
    const inner = fr.filter((f) => f.t - g.t0 > pc.p0 + 0.06 && f.t - g.t0 < pc.p1 - 0.06);
    const speed = actionSpeed(inner, g.w);
    if (speed != null) out.push({ t: pc.t, len: pc.p1 - pc.p0, speed });
  }
  return out.length >= Math.min(3, pieces.length) ? out : null;
}

/** Where a speed stands among the speeds seen (0 = calmest, 1 = fastest). */
export function makePercentile(speeds: number[]): (v: number) => number | null {
  const S = Float64Array.from(speeds).sort();
  const at = (f: (x: number) => boolean) => {
    let lo = 0;
    let hi = S.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (f(S[mid])) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return (v) => {
    if (S.length < 8) return null;
    const below = at((x) => x < v);
    return (below + (at((x) => x <= v) - below) / 2) / S.length;
  };
}
