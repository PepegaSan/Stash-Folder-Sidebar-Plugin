/**
 * Seamless sequence preview with a small pool of <video> elements. The current clip plays in one of them; the
 * clips coming up are loaded in the others and wait paused on their first frame, so a cut is just a visibility
 * swap – and a file that is slow to open (long files keep their index at the end, a NAS over Wi-Fi) has a few
 * clips' time for it. Picture follows the transport clock: small drift is evened out with the playback rate, a
 * seek aims where the clock will be once it is through (measured per player), and a seek on its way is never
 * interrupted by the next one – on slow seeks that left the picture frozen. A clip whose player has no picture
 * yet keeps the last picture on screen instead of going black.
 * In a split screen the clips of all its fields play at once (each field clip goes on while the others cut), and the
 * field cuts coming up are loaded ahead like any cut.
 * The engine only says what is on screen (`view`: players with their transition looks, framing and fields, a colour
 * wash); the compositor draws it on a canvas – for the preview and the quick record alike.
 */
import { type Field, type LayoutKind, type SplitDir, layoutFields } from "../../model/layouts";
import type { FitMode, TransitionType } from "../../model/project";
import { type ResolvedTransition, type Segment, segmentIndexAt, segmentUnits, sourceTimeAt } from "../../timeline/flatten";
import { VideoSlot, pickStream } from "../../stash/streams";
import type { StashScene } from "../../stash/types";
import { clamp } from "../../timeline/time";

export interface PreviewTimeline {
  segs: Segment[];
  trans: Array<ResolvedTransition | null>;
  fps: number;
  scenes: Record<string, StashScene>;
  /** The project's framing; a clip's own `fit` overrides it. */
  fit: FitMode;
}

/**
 * <video> elements per preview: the current clip, a transition partner or the last picture, the clips coming up – in a
 * 4-way split screen its four clips plus the four of the next layout.
 */
export const PREVIEW_SLOTS = 8;
/** Clips are loaded at most this far ahead (timeline seconds). */
const LOOKAHEAD = 12;
/** At most this many clips ahead from Stash's live transcode or the PC helper – each one is an FFmpeg process. */
const AHEAD_LIVE = { param: 1, mse: 2 } as const;
/** Files opened at the same time: they share the network, so the nearest clip comes first. */
const OPENING = 2;
/** A waiting clip starts playing (unseen, muted) this long before it shows, so it is in motion at its cut. */
const KICK = 0.1;
/** Further behind/ahead of the clock than this while playing: seek (less is evened out with the rate). */
const DRIFT_SEEK = 0.25;
/** Drift below this leaves the rate alone. */
const DRIFT_RATE = 0.04;
/** The clock moved further than this between two frames: the user jumped – seeks on their way get the new target. */
const JUMP = 0.5;

/** How one slot is drawn. Fractions refer to the picture. */
export interface SlotLook {
  opacity: number;
  /** Visible horizontal band [from, to] as fractions of the width (wipes). */
  band?: [number, number];
  /** Visible circle around the centre; radius as a fraction of half the diagonal. */
  circle?: number;
  /** Visible clock sweep from 12 o'clock, as a fraction of a turn. */
  sweep?: number;
  /** Horizontal shift as a fraction of the width (slides). */
  shift?: number;
  scale?: number;
  /** Blur radius as a fraction of the picture height. */
  blur?: number;
}

/**
 * Incoming/outgoing looks of an xfade-style transition at progress p (0 → 1), after FFmpeg's xfade
 * so the preview resembles the render. fade/dissolve fall back to a crossfade; the colour fades use
 * the overlay instead.
 */
export function transitionLooks(type: TransitionType, p: number): { incoming: SlotLook; outgoing: SlotLook } {
  const peak = 1 - Math.abs(2 * p - 1);
  switch (type) {
    case "wipeleft":
      return { incoming: { opacity: 1, band: [1 - p, 1] }, outgoing: { opacity: 1 } };
    case "wiperight":
      return { incoming: { opacity: 1, band: [0, p] }, outgoing: { opacity: 1 } };
    case "slideleft":
      return { incoming: { opacity: 1, shift: 1 - p }, outgoing: { opacity: 1, shift: -p } };
    case "slideright":
      return { incoming: { opacity: 1, shift: p - 1 }, outgoing: { opacity: 1, shift: p } };
    case "circleopen":
      return { incoming: { opacity: 1, circle: p }, outgoing: { opacity: 1 } };
    case "radial":
      return { incoming: { opacity: 1, sweep: p }, outgoing: { opacity: 1 } };
    case "zoomin":
      return { incoming: { opacity: p }, outgoing: { opacity: 1, scale: 1 + p } };
    case "pixelize":
    case "hblur":
      return { incoming: { opacity: p, blur: 0.03 * peak }, outgoing: { opacity: 1, blur: 0.03 * peak } };
    default:
      return { incoming: { opacity: p }, outgoing: { opacity: 1 } };
  }
}

/** One player on screen: its look in the transition, the framing of the clip it shows, stacking order. */
export interface PreviewLayer {
  el: HTMLVideoElement;
  look: SlotLook;
  fit: FitMode;
  z: number;
  /** In a split screen: the field it fills (a player can fill several – the kaleidoscope). */
  field?: Field;
}

/** What the preview shows right now; `wash` is the colour of a fade through black or white. */
export interface PreviewView {
  layers: PreviewLayer[];
  wash: { color: string; alpha: number };
  /** The split screen on screen (its dividers are drawn), null = full screen. */
  layout: { kind: LayoutKind; dir: SplitDir } | null;
}

/** A clip as the engine plays it, with the first frame it is seen (a transition brings it in earlier). */
interface Unit {
  seg: Segment;
  from: number;
}

/** A segment's identity across timeline edits (indices shift, clips keep their id). */
const segKey = (seg: Segment) => `${seg.clip?.id}@${seg.startFrame}`;

export class PreviewEngine {
  private slots: VideoSlot[];
  /** Segment each slot is bound to (segKey), kept when the timeline changes. */
  private bound: Array<string | null>;
  /** Timeline frame of the bound segment – which slot to give up first. */
  private boundFrame: number[];
  private tl: PreviewTimeline | null = null;
  /** Every clip of the timeline in the order it comes in – what the players load ahead. */
  private units: Unit[] = [];
  /** Slot whose picture was on screen last – shown on while the current clip has none yet. */
  private shown = -1;
  private lastT = 0;

  constructor(
    els: HTMLVideoElement[],
    private opts: {
      /** Listening volume of the on-screen preview; a recording keeps the clips' own level. */
      listen?: () => number;
      /** A player got a picture (a stream opened, a seek arrived) – nothing else redraws a paused preview. */
      onPicture?: () => void;
    } = {},
  ) {
    this.slots = els.map((el) => new VideoSlot(el));
    this.bound = els.map(() => null);
    this.boundFrame = els.map(() => 0);
    this.fits = els.map(() => "cover");
    this.view = { layers: [], wash: { color: "transparent", alpha: 0 }, layout: null };
    for (const el of els) for (const ev of ["loadeddata", "seeked"]) el.addEventListener(ev, this.onPicture);
  }

  /** What is on screen after the last render (the compositor draws it). */
  view: PreviewView;
  /** Framing of the clip each player shows. */
  private fits: FitMode[];
  private onPicture = () => this.opts.onPicture?.();

  private applyFit(slotIdx: number, seg: Segment): void {
    this.fits[slotIdx] = seg.clip?.fit ?? this.tl!.fit;
  }

  /** Slots keep their scenes and bindings: an edit costs at most a seek, not a reload (that went black). */
  setTimeline(tl: PreviewTimeline): void {
    this.tl = tl;
    const seen = new Set<Segment>();
    this.units = [];
    tl.segs.forEach((seg, i) => {
      for (const u of segmentUnits(seg)) {
        if (seen.has(u)) continue;
        seen.add(u);
        this.units.push({ seg: u, from: (u === seg ? seg.startFrame - (tl.trans[i]?.before ?? 0) : u.startFrame) });
      }
    });
    this.units.sort((a, b) => a.from - b.from);
  }

  dispose(): void {
    this.slots.forEach((s) => {
      for (const ev of ["loadeddata", "seeked"]) s.el.removeEventListener(ev, this.onPicture);
      s.dispose();
    });
  }

  render(t: number, playing: boolean): void {
    const tl = this.tl;
    if (!tl) return;
    const fps = tl.fps;
    const frame = t * fps;
    const jumped = Math.abs(t - this.lastT) > JUMP;
    this.lastT = t;
    const i = segmentIndexAt(tl.segs, Math.floor(frame));
    const seg = i >= 0 ? tl.segs[i] : null;
    const split = seg?.layout ?? null;

    // inside a transition window? (centred on the cut into segment j; split screens cut hard)
    let j = -1;
    let progress = 0;
    for (const k of split ? [] : [i, i + 1]) {
      const tr = tl.trans[k];
      if (k < 0 || !tr) continue;
      const cut = tl.segs[k].startFrame;
      if (frame >= cut - tr.before && frame < cut + tr.after) {
        j = k;
        progress = clamp((frame - (cut - tr.before)) / (tr.before + tr.after), 0, 1);
      }
    }
    const partner = j < 0 ? -1 : j === i ? i - 1 : j;

    // slots, most important first: the clip on screen, its transition partner, the last picture, the clips coming up
    const taken = new Set<number>();
    const want: Array<Segment | null> = this.slots.map(() => null);
    const bind = (k: number, unit: Segment): number => {
      taken.add(k);
      want[k] = unit;
      this.bound[k] = segKey(unit);
      this.boundFrame[k] = unit.startFrame;
      return k;
    };
    const take = (unit: Segment, protect: number): number => {
      const k = this.pick(unit, frame, taken, protect);
      return k >= 0 ? bind(k, unit) : -1;
    };
    const driven = new Set<number>();
    const drive = (k: number, unit: Segment) => {
      driven.add(k);
      this.drive(k, unit, frame, playing, jumped);
    };
    // a split screen: every field clip plays – the ones that have their player keep it first, so a field clip coming in
    // never takes the player of one that goes on
    const fieldSlots = new Map<Segment, number>();
    if (split) {
      const units = segmentUnits(seg!).filter((u) => this.scene(u));
      const own = units.map((u) => this.slots.findIndex((_, k) => this.bound[k] === segKey(u)));
      units.forEach((u, i) => own[i] >= 0 && bind(own[i], u));
      units.forEach((u, i) => {
        const k = own[i] >= 0 ? own[i] : take(u, -1);
        if (k < 0) return;
        fieldSlots.set(u, k);
        drive(k, u);
      });
    }
    const active = !split && seg?.clip && this.scene(seg) ? take(seg, this.shown) : -1;
    const other = partner >= 0 && tl.segs[partner]?.clip && this.scene(tl.segs[partner]) ? take(tl.segs[partner], this.shown) : -1;
    if (active >= 0) drive(active, seg!);
    if (other >= 0) drive(other, tl.segs[partner]);
    // no picture yet (a new file still opening, the scene not known yet): the last one stays instead of black
    const blank = !split && !!seg?.clip && (active < 0 || !this.slots[active].hasPicture);
    const hold = blank && j < 0 && this.shown >= 0 && !taken.has(this.shown) && this.slots[this.shown].hasPicture ? this.shown : -1;
    if (hold >= 0) taken.add(hold);
    const rolling = new Set<number>();
    if (i >= 0) {
      const live = { param: 0, mse: 0 };
      let opening = [...driven].filter((k) => !this.slots[k].hasPicture).length;
      let looked = 0;
      const now = new Set(want.filter((u): u is Segment => !!u));
      // the clips coming up, cuts and field cuts alike, in the order they come in
      for (let u = this.firstUnitAt(Math.floor(frame)); u < this.units.length && taken.size < this.slots.length && looked < 3 * this.slots.length; u++) {
        const { seg: next, from } = this.units[u];
        if ((from - frame) / fps > LOOKAHEAD) break;
        const scene = this.scene(next);
        if (now.has(next) || !scene || next.endFrame <= frame) continue;
        looked++;
        const kind = pickStream(scene)?.seek;
        const ffmpeg = kind === "param" || kind === "mse" ? kind : null;
        if (ffmpeg && live[ffmpeg] >= AHEAD_LIVE[ffmpeg]) continue;
        const k = this.pick(next, frame, taken, -1);
        if (k < 0) break;
        const slot = this.slots[k];
        const loading = slot.sceneId !== scene.id || slot.stale || !slot.hasPicture;
        if (loading && opening >= OPENING) continue;
        if (loading) opening++;
        if (ffmpeg) live[ffmpeg]++;
        bind(k, next);
        // waiting on its first frame and about to show: get it moving (starting up takes a few frames)
        const at = Math.max(0, sourceTimeAt(next, from, fps));
        const cued = !loading && !slot.busy && slot.time > at - 0.05 && slot.time < at + 0.5;
        if (playing && cued && (from - frame) / fps <= KICK) {
          this.kick(k, next);
          rolling.add(k);
        } else {
          this.cue(k, next, from);
        }
      }
    }

    // visibility
    const looks: SlotLook[] = this.slots.map(() => ({ opacity: 0 }));
    const layers: PreviewLayer[] = [];
    let overlayColor = "transparent";
    let overlayAlpha = 0;
    const tr = j >= 0 ? tl.trans[j] : null;
    if (split) {
      // every field: the player of its group's clip (the same player may fill several – mirrored)
      for (const field of layoutFields(split.kind, split.dir)) {
        const u = split.groups[field.group];
        const k = u ? fieldSlots.get(u) : undefined;
        if (k === undefined) continue;
        looks[k] = { opacity: 1 };
        layers.push({ el: this.slots[k].el, look: looks[k], fit: this.fits[k], z: 1, field });
      }
      const first = split.groups[0] ? fieldSlots.get(split.groups[0]) : undefined;
      this.shown = first !== undefined && this.slots[first].hasPicture ? first : -1;
    } else {
      const onScreen = hold >= 0 ? hold : active;
      if (onScreen >= 0) looks[onScreen] = { opacity: 1 };
      if (tr) {
        const incomingSlot = want.indexOf(tl.segs[j]);
        const outgoingSlot = j === i ? other : active;
        if (tr.type === "fadeblack" || tr.type === "fadewhite") {
          overlayColor = tr.type === "fadeblack" ? "#000" : "#fff";
          overlayAlpha = 1 - Math.abs(2 * progress - 1);
        } else if (incomingSlot >= 0) {
          const { incoming, outgoing } = transitionLooks(tr.type, progress);
          looks[incomingSlot] = incoming;
          if (outgoingSlot >= 0) looks[outgoingSlot] = outgoing;
        }
      }
      if (active >= 0 && this.slots[active].hasPicture) this.shown = active;
      else if (onScreen < 0) this.shown = -1;
      this.slots.forEach((s, k) => {
        if (looks[k].opacity > 0) layers.push({ el: s.el, look: looks[k], fit: this.fits[k], z: tr && want[k] === tl.segs[j] ? 2 : 1 });
      });
    }
    this.slots.forEach((s, k) => {
      // for tests and diagnostics: which player is drawn how strongly
      const op = String(looks[k].opacity);
      if (s.el.dataset.op !== op) s.el.dataset.op = op;
      // Chrome renders a video that is not drawn on the page on a slow timer of its own (a quarter second, the
      // canvas then stalls): what the canvas shows, and a clip starting up, stays barely visible above it
      const css = looks[k].opacity > 0 || rolling.has(k) ? "0.001" : "0";
      if (s.el.style.opacity !== css) s.el.style.opacity = css;
      if (!driven.has(k) && !rolling.has(k) && !s.el.paused) s.el.pause();
    });
    this.view = { layers: layers.sort((a, b) => a.z - b.z), wash: { color: overlayColor, alpha: overlayAlpha }, layout: split ? { kind: split.kind, dir: split.dir } : null };
  }

  /** Index of the first clip that comes in at or after `frame`. */
  private firstUnitAt(frame: number): number {
    let lo = 0;
    let hi = this.units.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.units[mid].from < frame) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * The slot for a segment: the one bound to it already, else one that has its scene open (a seek instead of
   * opening the file again), else the one needed least – free, then bound to a clip that is over, then to the
   * clip furthest ahead. `protect` (the last picture) is given up last.
   */
  private pick(seg: Segment, frame: number, taken: Set<number>, protect: number): number {
    const key = segKey(seg);
    const free = this.slots.map((_, k) => k).filter((k) => !taken.has(k));
    const bound = free.find((k) => this.bound[k] === key);
    if (bound !== undefined) return bound;
    const sceneId = seg.clip!.sceneId;
    const src = sourceTimeAt(seg, Math.max(frame, seg.startFrame), this.tl!.fps);
    // the last picture too: seeking in it shows the same scene meanwhile
    const open = free
      .filter((k) => this.slots[k].sceneId === sceneId && !this.slots[k].stale)
      .sort((a, b) => Math.abs(this.slots[a].time - src) - Math.abs(this.slots[b].time - src))[0];
    if (open !== undefined) return open;
    const worth = (k: number) => (k === protect ? 3e9 : this.bound[k] === null ? -3e9 : this.boundFrame[k] <= frame ? this.boundFrame[k] - 2e9 : -this.boundFrame[k]);
    return free.sort((a, b) => worth(a) - worth(b))[0] ?? -1;
  }

  private scene(seg: Segment): StashScene | null {
    return seg.clip ? this.tl!.scenes[seg.clip.sceneId] ?? null : null;
  }

  private drive(slotIdx: number, seg: Segment, frame: number, playing: boolean, jumped: boolean): void {
    const scene = this.scene(seg);
    if (!scene || !seg.clip) return;
    const slot = this.slots[slotIdx];
    const fps = this.tl!.fps;
    const speed = clamp(seg.clip.speed, 0.0625, 16);
    const src = sourceTimeAt(seg, frame, fps);
    this.applyFit(slotIdx, seg);
    const level = clamp(seg.clip.volume, 0, 1) * (this.opts.listen?.() ?? 1);
    slot.el.muted = level <= 0;
    slot.el.volume = level;
    const opened = slot.sceneId === scene.id && !slot.stale;
    if (!playing) {
      if (!slot.el.paused) slot.el.pause();
      if (!opened) slot.assign(scene, src);
      else if (Math.abs(slot.time - src) > 0.5 / fps) slot.seek(src);
      return;
    }
    // where the clock will be once the picture is there
    const lead = Math.min(2, slot.eta(scene.id, src) * speed);
    const length = opened ? slot.duration : scene.files[0]?.duration ?? 0;
    const end = length > 0 ? length - 0.5 / fps : Infinity;
    if (!opened) {
      slot.assign(scene, Math.min(src + lead, end));
    } else if (src >= end) {
      // the clip runs past the end of its file: its last picture stays, as in the render
      if (!slot.el.paused) slot.el.pause();
      if (Math.abs(slot.time - end) > 0.5 / fps) slot.seek(end);
      return;
    } else {
      const lag = slot.time - src; // > 0: ahead of the clock
      if (slot.busy) {
        // a seek or a new stream is on its way – let it arrive unless it can't be of use any more
        if (jumped || lag < -(2 + 2 * lead) || lag > 2 + lead) slot.seek(Math.min(src + lead, end), true);
      } else if (lag < -DRIFT_SEEK || lag > DRIFT_SEEK + lead) {
        slot.seek(Math.min(src + lead, end));
      }
    }
    // small drift: a few per cent faster or slower until picture and clock agree
    const lag = slot.time - src;
    const nudge = slot.busy || Math.abs(lag) < DRIFT_RATE ? 1 : Math.round(clamp(1 - lag, 0.92, 1.08) * 50) / 50;
    const rate = clamp(speed * nudge, 0.0625, 16);
    if (Math.abs(slot.el.playbackRate - rate) > 1e-3) slot.el.playbackRate = rate;
    if (slot.el.paused && !slot.el.ended) void slot.el.play().catch(() => undefined);
  }

  /** Starts a cued clip from where it waits, unseen and silent until drive() takes over at its cut. */
  private kick(slotIdx: number, seg: Segment): void {
    const el = this.slots[slotIdx].el;
    const rate = clamp(seg.clip!.speed, 0.0625, 16);
    el.muted = true;
    if (el.playbackRate !== rate) el.playbackRate = rate;
    if (el.paused) void el.play().catch(() => undefined);
  }

  private cue(slotIdx: number, seg: Segment, frame: number): void {
    const scene = this.scene(seg);
    if (!scene) return;
    const slot = this.slots[slotIdx];
    const src = Math.max(0, sourceTimeAt(seg, frame, this.tl!.fps));
    this.applyFit(slotIdx, seg);
    if (slot.sceneId !== scene.id || slot.stale) slot.assign(scene, src);
    else if (Math.abs(slot.time - src) > 0.05) slot.seek(src);
    if (!slot.el.paused) slot.el.pause();
  }
}
