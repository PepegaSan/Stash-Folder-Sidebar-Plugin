/**
 * Seamless sequence preview with two <video> elements (A/B). The one not on screen is pre-cued on
 * the next segment, so a cut is just a visibility swap. Picture follows the transport clock; drift
 * above a threshold triggers a seek. Transitions are approximated per slot (opacity, visible part,
 * shift, zoom, blur) and colour overlays; the quick recorder replays the same looks on its canvas.
 */
import type { FitMode, TransitionType } from "../../model/project";
import { type ResolvedTransition, type Segment, segmentIndexAt, sourceTimeAt } from "../../timeline/flatten";
import { VideoSlot } from "../../stash/streams";
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

const DRIFT_PLAYING = 0.15;
/** Low-res copy of the picture behind a "blur" clip; the CSS blur does the rest. */
const BLUR_W = 160;

/** How one slot is drawn. Fractions refer to the picture, so CSS and the recorder's canvas agree. */
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

/** CSS for a look; empty strings reset what a previous transition set. */
function lookCss(look: SlotLook, height: number): { clipPath: string; mask: string; transform: string; filter: string } {
  const clipPath = look.band
    ? `inset(0 ${(1 - look.band[1]) * 100}% 0 ${look.band[0] * 100}%)`
    : look.circle !== undefined
      ? `circle(${look.circle * 70.72}% at 50% 50%)` // % of a circle() radius = diagonal / √2
      : "";
  const mask = look.sweep !== undefined ? `conic-gradient(#000 ${look.sweep * 360}deg, transparent 0)` : "";
  const transform = [look.shift ? `translateX(${look.shift * 100}%)` : "", look.scale && look.scale !== 1 ? `scale(${look.scale})` : ""].filter(Boolean).join(" ");
  const filter = look.blur ? `blur(${(look.blur * height).toFixed(1)}px)` : "";
  return { clipPath, mask, transform, filter };
}

export class PreviewEngine {
  private slots: VideoSlot[];
  /** Segment index each slot is bound to. */
  private bound: Array<number | null> = [null, null];
  private tl: PreviewTimeline | null = null;

  constructor(
    els: [HTMLVideoElement, HTMLVideoElement],
    private overlay: HTMLElement,
    private blur: HTMLCanvasElement | null = null,
    /** Listening volume of the on-screen preview; a recording keeps the clips' own level. */
    private listen: () => number = () => 1,
  ) {
    this.slots = els.map((el) => new VideoSlot(el));
    // paused: nothing re-renders when the picture arrives later – redraw the backdrop then
    for (const el of els) for (const ev of ["loadeddata", "seeked"]) el.addEventListener(ev, this.onPicture);
  }

  private blurTarget: HTMLVideoElement | null = null;
  private onPicture = (e: Event) => {
    if (e.currentTarget === this.blurTarget) this.drawBlur(this.blurTarget);
  };

  /** Framing of a segment's clip, as classes on the slot (the recorder reads them too). */
  private applyFit(el: HTMLVideoElement, seg: Segment): FitMode {
    const fit = seg.clip?.fit ?? this.tl!.fit;
    el.classList.toggle("is-contain", fit !== "cover");
    el.classList.toggle("is-blur", fit === "blur");
    return fit;
  }

  /** Blurred backdrop: a small cover-cropped copy of the active frame (CSS blurs and scales it). */
  private drawBlur(el: HTMLVideoElement | null): void {
    const c = this.blur;
    if (!c) return;
    if (!el || el.readyState < 2 || !el.videoWidth) {
      c.style.opacity = "0";
      return;
    }
    const ar = c.clientWidth && c.clientHeight ? c.clientWidth / c.clientHeight : 16 / 9;
    const w = BLUR_W;
    const h = Math.max(2, Math.round(BLUR_W / ar));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext("2d");
    if (!g) return;
    const s = Math.max(w / el.videoWidth, h / el.videoHeight);
    const dw = el.videoWidth * s;
    const dh = el.videoHeight * s;
    g.drawImage(el, (w - dw) / 2, (h - dh) / 2, dw, dh);
    c.style.opacity = "1";
  }

  setTimeline(tl: PreviewTimeline): void {
    this.tl = tl;
    // indices may have shifted; slots keep their loaded scene, so re-binding is only a seek
    this.bound = [null, null];
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
    const frame = t * tl.fps;
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

    const next = this.nextClip(i);
    const want: Array<number | null> = [null, null];
    let active = -1;
    if (seg?.clip) {
      active = this.slotFor(i, next);
      want[active] = i;
    }
    const other = active === 0 ? 1 : 0;
    if (j >= 0) {
      // keep both sides of the transition bound
      const partner = j === i ? i - 1 : j;
      if (tl.segs[partner]?.clip && partner !== i) want[active < 0 ? 0 : other] = partner;
    } else if (next >= 0) {
      want[active < 0 ? this.slotFor(next, -1) : other] = next;
    }

    want.forEach((segIdx, s) => {
      if (segIdx === null) return;
      if (segIdx === i) this.drive(s, tl.segs[segIdx], frame, playing);
      else this.cue(s, tl.segs[segIdx], j >= 0 ? frame : tl.segs[segIdx].startFrame);
    });

    // visibility
    const looks: SlotLook[] = [{ opacity: 0 }, { opacity: 0 }];
    if (active >= 0) looks[active] = { opacity: 1 };
    let overlayColor = "transparent";
    let overlayAlpha = 0;
    const tr = j >= 0 ? tl.trans[j] : null;
    if (tr) {
      const incomingSlot = want.indexOf(j);
      const outgoingSlot = incomingSlot === 0 ? 1 : 0;
      if (tr.type === "fadeblack" || tr.type === "fadewhite") {
        overlayColor = tr.type === "fadeblack" ? "#000" : "#fff";
        overlayAlpha = 1 - Math.abs(2 * progress - 1);
      } else if (incomingSlot >= 0) {
        const { incoming, outgoing } = transitionLooks(tr.type, progress);
        looks[incomingSlot] = incoming;
        looks[outgoingSlot] = want[outgoingSlot] !== null ? outgoing : { opacity: 0 };
      }
    }
    this.looks = looks;
    this.slots.forEach((s, k) => {
      this.paint(k, looks[k]);
      s.el.style.zIndex = tr && want[k] === j ? "2" : "1";
      if (want[k] !== i && !s.el.paused) s.el.pause();
    });
    this.overlay.style.background = overlayColor;
    this.overlay.style.opacity = String(overlayAlpha);
    this.bound = want;
    // backdrop for "blur" framing: the topmost visible slot
    const top = [...this.slots].filter((s) => Number(s.el.style.opacity) > 0 && s.el.classList.contains("is-blur")).sort((a, b) => Number(b.el.style.zIndex) - Number(a.el.style.zIndex))[0];
    this.blurTarget = top?.el ?? null;
    this.drawBlur(this.blurTarget);
  }

  /** Looks of the two slots after the last render (the recorder draws them on its canvas). */
  looks: SlotLook[] = [{ opacity: 0 }, { opacity: 0 }];
  /** CSS last written per slot – render runs every frame, so only changes are applied. */
  private painted = ["", ""];

  private paint(k: number, look: SlotLook): void {
    const el = this.slots[k].el;
    el.style.opacity = String(look.opacity);
    const css = lookCss(look, el.clientHeight);
    const key = `${css.clipPath}|${css.mask}|${css.transform}|${css.filter}`;
    if (key === this.painted[k]) return;
    this.painted[k] = key;
    el.style.clipPath = css.clipPath;
    el.style.transform = css.transform;
    el.style.filter = css.filter;
    el.style.setProperty("mask-image", css.mask);
    el.style.setProperty("-webkit-mask-image", css.mask);
  }

  private nextClip(i: number): number {
    const segs = this.tl!.segs;
    for (let k = i + 1; k < segs.length; k++) if (segs[k].clip) return k;
    return -1;
  }

  private slotFor(segIdx: number, avoid: number): number {
    const found = this.bound.indexOf(segIdx);
    if (found >= 0) return found;
    const holdsAvoid = this.bound.indexOf(avoid);
    return holdsAvoid === 0 ? 1 : 0;
  }

  private scene(seg: Segment): StashScene | null {
    return seg.clip ? this.tl!.scenes[seg.clip.sceneId] ?? null : null;
  }

  private drive(slotIdx: number, seg: Segment, frame: number, playing: boolean): void {
    const scene = this.scene(seg);
    if (!scene || !seg.clip) return;
    const slot = this.slots[slotIdx];
    const src = sourceTimeAt(seg, frame, this.tl!.fps);
    this.applyFit(slot.el, seg);
    if (slot.sceneId !== scene.id || slot.stale) slot.assign(scene, src);
    const rate = clamp(seg.clip.speed, 0.0625, 16);
    if (slot.el.playbackRate !== rate) slot.el.playbackRate = rate;
    const level = clamp(seg.clip.volume, 0, 1) * this.listen();
    slot.el.muted = level <= 0;
    slot.el.volume = level;
    const drift = Math.abs(slot.time - src);
    if (playing) {
      if (drift > DRIFT_PLAYING) slot.seek(src);
      if (slot.el.paused) void slot.el.play().catch(() => undefined);
    } else {
      if (!slot.el.paused) slot.el.pause();
      if (drift > 0.5 / this.tl!.fps) slot.seek(src);
    }
  }

  private cue(slotIdx: number, seg: Segment, frame: number): void {
    const scene = this.scene(seg);
    if (!scene) return;
    const slot = this.slots[slotIdx];
    const src = sourceTimeAt(seg, frame, this.tl!.fps);
    this.applyFit(slot.el, seg);
    if (slot.sceneId !== scene.id || slot.stale) slot.assign(scene, src);
    else if (Math.abs(slot.time - src) > 0.05) slot.seek(src);
    if (!slot.el.paused) slot.el.pause();
  }
}
