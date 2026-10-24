/**
 * Seamless sequence preview with a small pool of <video> elements. The current clip plays in one of them; the
 * clips coming up are loaded in the others and wait paused on their first frame, so a cut is just a visibility
 * swap – and a file that is slow to open (long files keep their index at the end, a NAS over Wi-Fi) has a few
 * clips' time for it. Picture follows the transport clock: small drift is evened out with the playback rate, a
 * seek aims where the clock will be once it is through (measured per player), and a seek on its way is never
 * interrupted by the next one – on slow seeks that left the picture frozen. A clip whose player has no picture
 * yet keeps the last picture on screen instead of going black.
 * The engine only says what is on screen (`view`: players with their transition looks and framing, a colour wash);
 * the compositor draws it on a canvas – for the preview and the quick record alike.
 */
import type { FitMode, TransitionType } from "../../model/project";
import { type ResolvedTransition, type Segment, segmentIndexAt, sourceTimeAt } from "../../timeline/flatten";
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

/** <video> elements per preview: the current clip, a transition partner or the last picture, the clips coming up. */
export const PREVIEW_SLOTS = 4;
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
}

/** What the preview shows right now; `wash` is the colour of a fade through black or white. */
export interface PreviewView {
  layers: PreviewLayer[];
  wash: { color: string; alpha: number };
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
    this.view = { layers: [], wash: { color: "transparent", alpha: 0 } };
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

    // inside a transition window? (centred on the cut into segment j)
    let j = -1;
    let progress = 0;
    for (const k of [i, i + 1]) {
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
    const want: Array<number | null> = this.slots.map(() => null);
    const bind = (k: number, segIdx: number): number => {
      taken.add(k);
      want[k] = segIdx;
      this.bound[k] = segKey(tl.segs[segIdx]);
      this.boundFrame[k] = tl.segs[segIdx].startFrame;
      return k;
    };
    const take = (segIdx: number, protect: number): number => {
      const k = this.pick(tl.segs[segIdx], frame, taken, protect);
      return k >= 0 ? bind(k, segIdx) : -1;
    };
    const active = seg?.clip && this.scene(seg) ? take(i, this.shown) : -1;
    const other = partner >= 0 && tl.segs[partner]?.clip && this.scene(tl.segs[partner]) ? take(partner, this.shown) : -1;
    if (active >= 0) this.drive(active, tl.segs[i], frame, playing, jumped);
    if (other >= 0) this.drive(other, tl.segs[partner], frame, playing, jumped);
    // no picture yet (a new file still opening, the scene not known yet): the last one stays instead of black
    const blank = !!seg?.clip && (active < 0 || !this.slots[active].hasPicture);
    const hold = blank && j < 0 && this.shown >= 0 && !taken.has(this.shown) && this.slots[this.shown].hasPicture ? this.shown : -1;
    if (hold >= 0) taken.add(hold);
    const rolling = new Set<number>();
    if (i >= 0) {
      const live = { param: 0, mse: 0 };
      let opening = [active, other].filter((k) => k >= 0 && !this.slots[k].hasPicture).length;
      let looked = 0;
      for (let s = i + 1; s < tl.segs.length && taken.size < this.slots.length && looked < 3 * this.slots.length; s++) {
        const next = tl.segs[s];
        if ((next.startFrame - frame) / fps > LOOKAHEAD) break;
        const scene = this.scene(next);
        if (s === partner || !next.clip || !scene) continue;
        looked++;
        // a cue for a clip that a transition brings in earlier starts there
        const from = next.startFrame - (tl.trans[s]?.before ?? 0);
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
        bind(k, s);
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
    const onScreen = hold >= 0 ? hold : active;
    if (onScreen >= 0) looks[onScreen] = { opacity: 1 };
    let overlayColor = "transparent";
    let overlayAlpha = 0;
    const tr = j >= 0 ? tl.trans[j] : null;
    if (tr) {
      const incomingSlot = want.indexOf(j);
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
    const layers: PreviewLayer[] = [];
    this.slots.forEach((s, k) => {
      const z = tr && want[k] === j ? 2 : 1;
      if (looks[k].opacity > 0) layers.push({ el: s.el, look: looks[k], fit: this.fits[k], z });
      // for tests and diagnostics: which player is drawn how strongly
      const op = String(looks[k].opacity);
      if (s.el.dataset.op !== op) s.el.dataset.op = op;
      // Chrome renders a video that is not drawn on the page on a slow timer of its own (a quarter second, the
      // canvas then stalls): what the canvas shows, and a clip starting up, stays barely visible above it
      const css = looks[k].opacity > 0 || rolling.has(k) ? "0.001" : "0";
      if (s.el.style.opacity !== css) s.el.style.opacity = css;
      if (k !== active && k !== other && !rolling.has(k) && !s.el.paused) s.el.pause();
    });
    this.view = { layers: layers.sort((a, b) => a.z - b.z), wash: { color: overlayColor, alpha: overlayAlpha } };
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
