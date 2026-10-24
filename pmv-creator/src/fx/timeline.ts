/**
 * When the beat and drop effects fire and what each frame looks like. The events come from the beat grid and the
 * music's energy (analyzeBeats – the generator's measure: loudness per beat, drops) with the PMV Generator's rules
 * (its onBeat); what is random there (which bars get a word, the shaking, the glitch stripes) comes from hashes of
 * beat and frame numbers here, so a project always looks the same. effectFrame() is the one source for the preview's
 * compositor and for the numbers the render plan hands to FFmpeg.
 */
import { type EnergyFn, analyzeBeats } from "../generator/rhythm";
import { anyEffect, effectWords } from "../model/effects";
import { cleanLayouts } from "../model/layouts";
import { type PmvProject, clipEnd, projectDuration } from "../model/project";
import { type Segment, flattenTimeline } from "../timeline/flatten";
import { beatIndexAt, beatLength } from "../timeline/time";

/** The PMV Generator's sizes are pixels of a picture 1280 wide. */
export const REF_W = 1280;
/** The zoom pulse eases in this long before its beat and dies away at this rate (per second). */
const EASE_IN = 0.11;
const DECAY = 5.5;
/** A word stays this long; it fades out from TEXT_FADE_AT on. */
export const TEXT_SECONDS = 0.42;
export const TEXT_FADE_AT = 0.3;
const STROBE_SECONDS = 0.045;
/** Glitch stripes: their heights as shares of the picture, shifted by up to GLITCH_SHIFT of the width either way. */
export const GLITCH_STRIPES = [0.02, 0.05, 0.035, 0.08, 0.012, 0.06];
export const GLITCH_SHIFT = 0.14;
/** Echo: the ghost of the frame before is this much larger, the one before that twice as much. */
export const ECHO_ZOOM = 1.04;
/** Tunnel: the copies' sizes and their pink frame (share of the width). */
export const TUNNEL_SIZES = [0.74, 0.52, 0.34];
export const TUNNEL_BORDER = 3 / REF_W;

/** The text effect's font (Anton, SIL Open Font License), shipped with the plugin: the editor and FFmpeg's drawtext draw with it. */
export const FX_FONT = { family: "PMV Creator Anton", file: "Anton-Regular.ttf", url: "/plugin/pmv-creator/assets/fonts/Anton-Regular.ttf" } as const;

/** Width of a word at a font size of 1 (the editor measures it with the text font). */
export type Measure = (word: string) => number;

interface Span {
  t0: number;
  t1: number;
}

export interface EffectTimeline {
  fps: number;
  /** Width / height of the picture. */
  aspect: number;
  /** Zoom pulses, already scaled by the strength: a beat eases in, a stutter jumps. */
  pulses: Array<{ t: number; a: number; ease: boolean }>;
  /** Shaking, amplitude as a share of the width. */
  shakes: Array<Span & { amp: number }>;
  /** The clip on screen jumps back at these times. */
  stutters: number[];
  strobes: Span[];
  /** RGB split: start, strength (share of the width), duration. */
  rgb: Array<{ t: number; amt: number; dur: number }>;
  glitches: Span[];
  inverts: Span[];
  tunnels: Array<{ t: number; dur: number }>;
  echoes: Array<Span & { alpha: number }>;
  /** Words: start, text, size as a share of the picture height. */
  texts: Array<{ t: number; word: string; size: number }>;
  /** Colour rush per beat: its start, the hue there (degrees) and how fast it turns (degrees per second). */
  hue: Array<{ t: number; angle: number; rate: number }> | null;
  /** Flashes where the split screen changes: start, strength, colour (pink on a drop). */
  flashes: Array<{ t: number; a: number; color: [number, number, number] }>;
  /** Beats the dividers of a split screen glow on (null = they don't). */
  glow: number[] | null;
}

/** The dividers glow up on every beat and fade quickly: strength at `since` seconds after the beat (0 when too faint). */
export function glowAt(since: number): number {
  const g = 0.9 * Math.exp(-7 * since);
  return since >= 0 && g > 0.05 ? g : 0;
}

/** Pseudo-random 0…1 of a frame or beat number – the backend builds the same formula into FFmpeg expressions. */
export const hashSalt = (i: number, k: number): number => i * 78.233 + k * 37.719;
export function fxHash(n: number, i: number, k: number): number {
  const x = Math.sin(n * 12.9898 + hashSalt(i, k)) * 43758.5453;
  return x - Math.floor(x);
}

/** Pepega's word size: a third of the picture's short side, smaller if the word would be wider than 86 % of the picture. A share of the picture height. */
export function textSize(word: string, aspect: number, measure?: Measure): number {
  // without a measure: Anton's capitals are about 0.47 em wide, a space 0.23
  const em = measure?.(word) ?? [...word].reduce((w, c) => w + (c === " " ? 0.23 : 0.47), 0);
  return Math.round(Math.min(0.34 * Math.min(aspect, 1), (0.86 * aspect) / Math.max(0.1, em)) * 1e4) / 1e4;
}

/** The effects of a project on its timeline; null when none is on. `energy` = the music's loudness (drops need it). */
export function effectTimeline(p: PmvProject, energy?: EnergyFn, measure?: Measure): EffectTimeline | null {
  const fx = p.effects;
  const duration = projectDuration(p);
  if (!anyEffect(fx) || !(duration > 0)) return null;
  const { fps, width, height } = p.output;
  const grid = p.beatGrid;
  const snap = (t: number) => Math.round(t * fps) / fps;
  const span = (t: number, end: number): Span => {
    const t0 = snap(t);
    return { t0, t1: Math.max(t0 + 1 / fps, snap(end)) };
  };
  const tl: EffectTimeline = { fps, aspect: width / height, pulses: [], shakes: [], stutters: [], strobes: [], rgb: [], glitches: [], inverts: [], tunnels: [], echoes: [], texts: [], hue: fx.hue ? [] : null, flashes: [], glow: null };
  const beats = analyzeBeats(grid, 0, duration, energy);
  if (fx.lines) tl.glow = beats.map((B) => B.t);
  if (fx.flash) {
    // where a split screen begins or ends (back to full screen): white, pink on a drop
    const ranges = cleanLayouts(p.layouts ?? []);
    const changes = new Set<number>();
    ranges.forEach((r, k) => {
      changes.add(snap(r.start));
      const end = r.start + r.duration;
      if (!(ranges[k + 1] && Math.abs(ranges[k + 1].start - end) < 1e-6)) changes.add(snap(end));
    });
    for (const t of [...changes].sort((a, b) => a - b)) {
      if (t <= 0 || t >= duration) continue;
      const drop = beats.some((B) => B.drop && Math.abs(B.t - t) < 1.5 / fps);
      tl.flashes.push({ t, a: drop ? 0.9 : 0.35, color: drop ? [255, 62, 138] : [255, 255, 255] });
    }
  }
  const words = fx.text ? effectWords(fx.words) : [];
  const amount = Math.max(0, Math.min(1.5, fx.pulseAmount));
  // where a clip starts: the RGB split also tears on cuts in loud parts
  const segs = flattenTimeline(p);
  const cuts = new Set(segs.flatMap((s) => (s.layout ? s.layout.groups.flatMap((g) => (g ? [g.startFrame] : [])) : s.clip && s.startFrame === s.clipStartFrame ? [s.startFrame] : [])));
  // where a field of a split screen gets a new clip while the others go on (not where the split screen begins)
  const rangeStarts = new Set(segs.filter((s, i) => s.layout && segs[i - 1]?.layout?.rangeId !== s.layout.rangeId).map((s) => s.startFrame));
  const fieldCuts = new Set(segs.flatMap((s) => (s.layout ? s.layout.groups.flatMap((g) => (g && g.startFrame === g.clipStartFrame && !rangeStarts.has(g.startFrame) ? [g.startFrame] : [])) : [])));
  let angle = 0;

  beats.forEach((B, k) => {
    const next = beats[k + 1]?.t ?? B.t + beatLength(grid);
    const len = next - B.t;
    const { e, drop, downbeat: bar } = B;
    // the beat's number in the song (Pepega's k: every other beat, every 8th)
    const n = Math.round(beatIndexAt(B.t, grid));
    const f = Math.round(B.t * fps);
    const cut = cuts.has(f) || cuts.has(f - 1) || cuts.has(f + 1);
    const t = snap(B.t);
    // a field cut in a loud part flashes a little – pink on the bar's "one"
    if (fx.flash && e > 0.5 && (fieldCuts.has(f) || fieldCuts.has(f - 1) || fieldCuts.has(f + 1)) && !tl.flashes.some((x) => Math.abs(x.t - t) < 1.5 / fps)) {
      tl.flashes.push({ t, a: 0.15 + 0.3 * e, color: bar ? [255, 62, 138] : [255, 255, 255] });
    }

    if (fx.zoom && amount > 0 && (drop || fx.pulseOn === "beat" || (fx.pulseOn === "2" && Math.round(B.pos) % 2 === 0) || (fx.pulseOn === "bar" && bar))) {
      tl.pulses.push({ t: B.t, a: (0.03 + 0.07 * e + (drop ? 0.1 : 0)) * amount, ease: true });
    }
    if (fx.shake && e > 0.7) tl.shakes.push({ ...span(B.t, B.t + 0.1 + 0.1 * e), amp: (6 + 16 * e) / REF_W });
    if (fx.glitch && (drop || (e > 0.85 && bar))) tl.glitches.push(span(B.t, B.t + (drop ? 0.3 : 0.14)));
    if (fx.rgb && drop) tl.rgb.push({ t, amt: 26 / REF_W, dur: 0.45 });
    else if (fx.rgb && e > 0.62 && (bar || cut)) tl.rgb.push({ t, amt: (6 + 12 * e) / REF_W, dur: 0.14 });
    if (fx.tunnel && drop) tl.tunnels.push({ t, dur: Math.min(1.2, len * 2) });
    if (fx.invert && (drop || (e > 0.85 && ((n % 8) + 8) % 8 === 0))) tl.inverts.push(span(B.t, B.t + len / 4));
    if (words.length && (drop || (bar && e > 0.6 && fxHash(n, 7, 1) < 0.45))) {
      const word = words[Math.floor(fxHash(n, 7, 2) * words.length)];
      tl.texts.push({ t, word, size: textSize(word, tl.aspect, measure) });
    }
    // half beats in loud parts: the clips stutter (every other beat), the strobe flashes
    if (e > 0.8 && !drop && k + 1 < beats.length) {
      const mid = snap((B.t + next) / 2);
      if (fx.stutter && Math.abs(n % 2) === 1) {
        tl.stutters.push(mid);
        if (fx.zoom && amount > 0) tl.pulses.push({ t: mid, a: 0.05 * amount, ease: false });
      }
      if (fx.strobe) tl.strobes.push(span(mid, mid + STROBE_SECONDS));
    }
    if (fx.strobe && e > 0.85) tl.strobes.push(span(B.t, B.t + STROBE_SECONDS));
    if (fx.echo && e > 0.45) tl.echoes.push({ ...span(B.t, next), alpha: 0.16 + 0.2 * e });
    if (tl.hue) {
      // turning faster when it is loud – integrated, so the colours never jump
      const rate = 30 + 110 * e;
      if (k === 0) angle = rate * B.t;
      tl.hue.push({ t: B.t, angle, rate });
      angle += rate * len;
    }
  });
  const byStart = (a: Span, b: Span) => a.t0 - b.t0;
  tl.pulses.sort((a, b) => a.t - b.t);
  tl.strobes.sort(byStart);
  tl.flashes.sort((a, b) => a.t - b.t);
  return tl;
}

/** What one frame shows of the effects. Shares refer to the picture's width unless said otherwise. */
export interface EffectFrame {
  /** The video frame at this time – the seed of the random parts. */
  frame: number;
  /** Zoom (≥ 1) and shift of the picture. */
  zoom: number;
  dx: number;
  dy: number;
  /** Shaking amplitude (0 = still). */
  shake: number;
  /** Colour rush: hue rotation in degrees. */
  hue: number | null;
  /** Echo strength α (0 = off). */
  echo: number;
  /** Opacity of the tunnel's copies (0 = off). */
  tunnel: number;
  glitch: boolean;
  /** RGB split: how far red and cyan move apart (0 = off). */
  rgb: number;
  invert: boolean;
  strobe: boolean;
  /** A word: size as a share of the height, seconds since it came in. */
  text: { word: string; size: number; tt: number } | null;
  /** A flash fading out: strength and colour. */
  flash: { a: number; color: [number, number, number] } | null;
  /** How strongly the dividers of a split screen glow (0 = dark). */
  lines: number;
}

const EPS = 1e-9;

/** Index of the last entry starting at or before t (entries sorted by start), -1 if none. */
function lastAt<T>(list: T[], t: number, start: (x: T) => number): number {
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (start(list[mid]) <= t + EPS) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The span that covers t (spans sorted by start; one may still run while the next has begun). */
function active<T extends Span>(spans: T[], t: number): T | null {
  const j = lastAt(spans, t, (s) => s.t0);
  for (let i = j; i >= 0 && i >= j - 2; i--) if (t < spans[i].t1 - EPS) return spans[i];
  return null;
}

export function effectFrame(tl: EffectTimeline, t: number): EffectFrame {
  const frame = Math.floor(t * tl.fps + 1e-6);
  // zoom pulse: the last pulse dies away, the next beat eases in shortly before it lands
  const j = lastAt(tl.pulses, t, (x) => x.t);
  let pulse = j >= 0 ? tl.pulses[j].a * Math.exp(-DECAY * Math.max(0, t - tl.pulses[j].t)) : 0;
  for (let k = j + 1; k < tl.pulses.length && tl.pulses[k].t - t < EASE_IN; k++) {
    if (!tl.pulses[k].ease) continue;
    const x = 1 - (tl.pulses[k].t - t) / EASE_IN;
    pulse = Math.max(pulse, tl.pulses[k].a * x * x * (3 - 2 * x));
    break;
  }
  let zoom = 1 + pulse;
  // shaking: another spot every frame, zoomed in just enough that no edge shows
  const s = active(tl.shakes, t);
  const shake = s?.amp ?? 0;
  if (s) zoom *= 1 + s.amp * Math.max(1, tl.aspect);
  const h = tl.hue?.length ? tl.hue[Math.max(0, lastAt(tl.hue, t, (x) => x.t))] : null;
  const tu = tl.tunnels[lastAt(tl.tunnels, t, (x) => x.t)];
  const tunnelSince = tu ? t - tu.t : Infinity;
  const r = tl.rgb[lastAt(tl.rgb, t, (x) => x.t)];
  const rp = r ? (t - r.t) / r.dur : Infinity;
  const w = tl.texts[lastAt(tl.texts, t, (x) => x.t)];
  const tt = w ? t - w.t : Infinity;
  const fl = tl.flashes[lastAt(tl.flashes, t, (x) => x.t)];
  const flash = fl ? fl.a * Math.exp(-9 * (t - fl.t)) : 0;
  const beat = tl.glow ? tl.glow[lastAt(tl.glow, t, (x) => x)] : undefined;
  return {
    frame,
    zoom,
    dx: s ? (fxHash(frame, 0, 1) - 0.5) * s.amp : 0,
    dy: s ? (fxHash(frame, 0, 2) - 0.5) * s.amp : 0,
    shake,
    hue: h ? h.angle + h.rate * (t - h.t) : null,
    echo: active(tl.echoes, t)?.alpha ?? 0,
    tunnel: tu && tunnelSince < tu.dur - EPS ? 1 - (0.9 * tunnelSince) / tu.dur : 0,
    glitch: !!active(tl.glitches, t),
    rgb: r && rp < 1 - EPS ? r.amt * (1 - rp) ** 2 + 1 / REF_W : 0,
    invert: !!active(tl.inverts, t),
    strobe: !!active(tl.strobes, t),
    text: w && tt < TEXT_SECONDS - EPS ? { word: w.word, size: w.size, tt } : null,
    flash: fl && flash > 0.01 ? { a: flash, color: fl.color } : null,
    lines: beat === undefined ? 0 : glowAt(t - beat),
  };
}

/**
 * Stutter: at a stutter the clip on screen jumps back – to its start plus a quarter of the time it has been on
 * (Pepega's). Here that is a cut inside the clip: its segment is split and the second part starts earlier in the
 * source, so the preview cues it in a second player and the renderer simply gets one more piece.
 */
export function withStutters(segs: Segment[], tl: EffectTimeline | null, fps: number): Segment[] {
  if (!tl?.stutters.length) return segs;
  const frames = tl.stutters.map((t) => Math.round(t * fps));
  const out: Segment[] = [];
  let s = 0;
  for (const seg of segs) {
    let cur = seg;
    const clip = seg.clip;
    for (; s < frames.length && frames[s] < seg.endFrame; s++) {
      const f = frames[s];
      // not in a gap, and not right at a cut (a frame or two of a clip looks like a glitch)
      if (!clip || f < cur.startFrame + 2 || f > seg.endFrame - 2) continue;
      const since = (f - seg.clipStartFrame) / fps;
      out.push({ ...cur, endFrame: f });
      const jumped = { ...clip, sourceIn: clip.sourceIn + 0.25 * since * clip.speed, start: f / fps, duration: clipEnd(clip) - f / fps, transitionIn: null };
      cur = { startFrame: f, endFrame: seg.endFrame, clip: jumped, trackId: seg.trackId, clipStartFrame: f };
    }
    out.push(cur);
  }
  return out;
}
