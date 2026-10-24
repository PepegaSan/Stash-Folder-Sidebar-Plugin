/**
 * Draws what the preview engine shows onto a canvas: the players with their transition looks (opacity, visible part,
 * shift, zoom, blur) and framing (cover, contain, whole picture over a blurred copy), the colour wash of a fade through
 * black/white, the project's colour look and its beat and drop effects. The on-screen preview and the quick record
 * share it, so what is recorded is what was seen; the FFmpeg render builds the same steps in the same order
 * (pmv_backend.py: fx_pre_graph, grade_graph, fx_post_graph).
 */
import { type EffectFrame, type EffectTimeline, ECHO_ZOOM, FX_FONT, GLITCH_SHIFT, GLITCH_STRIPES, REF_W, TEXT_FADE_AT, TEXT_SECONDS, TUNNEL_SIZES, effectFrame, fxHash } from "../../fx/timeline";
import type { ColorGrade } from "../../model/look";
import type { PreviewView, SlotLook } from "./engine";

/** Width of the small copy behind a "blur" clip – blurred there and scaled up, cheap at any canvas size. */
const BACKDROP_W = 160;
const PINK = "#ff3e8a";

/** The visible part of a transition look as a clip path. */
function clipToLook(g: CanvasRenderingContext2D, look: SlotLook, w: number, h: number): void {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.hypot(w, h) / 2;
  g.beginPath();
  if (look.band) g.rect(look.band[0] * w, 0, (look.band[1] - look.band[0]) * w, h);
  else if (look.circle !== undefined) g.arc(cx, cy, look.circle * r, 0, 2 * Math.PI);
  else if (look.sweep !== undefined) {
    g.moveTo(cx, cy);
    g.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + look.sweep * 2 * Math.PI);
    g.closePath();
  } else return;
  g.clip();
}

/** The project's effects at a moment of the timeline. */
export interface EffectsAt {
  tl: EffectTimeline;
  t: number;
}

export class Compositor {
  private g: CanvasRenderingContext2D | null;
  private backdrop: HTMLCanvasElement | null = null;
  /** Work canvases of the effects (snapshots, colour channels, a tunnel copy). */
  private bufs = new Map<string, HTMLCanvasElement>();
  /** Echo: the frame drawn last and the two before it, each as it looked before its own echo (null = none yet). */
  private echoNow: HTMLCanvasElement | null = null;
  private echo1: HTMLCanvasElement | null = null;
  private echo2: HTMLCanvasElement | null = null;
  private lastFrame = Number.NaN;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.g = canvas.getContext("2d", { alpha: false });
  }

  draw(view: PreviewView, grade: ColorGrade | null, effects: EffectsAt | null = null): void {
    const g = this.g;
    if (!g) return;
    const W = this.canvas.width;
    const H = this.canvas.height;
    const fx = effects ? effectFrame(effects.tl, effects.t) : null;
    g.save();
    g.fillStyle = "#000";
    g.fillRect(0, 0, W, H);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    // the colour rush turns the clips' colours, before the look (like FFmpeg's hue before the colour matrix)
    const colour = [fx?.hue != null ? `hue-rotate(${Math.round((fx.hue % 360) * 100) / 100}deg) saturate(1.3)` : "", grade?.css ?? ""].join(" ").trim();
    g.save();
    // zoom pulse and shaking move the whole picture (FFmpeg: zoompan after the transition)
    if (fx && (fx.zoom !== 1 || fx.dx || fx.dy)) {
      g.translate(W / 2 + fx.dx * W, H / 2 + fx.dy * W);
      g.scale(fx.zoom, fx.zoom);
      g.translate(-W / 2, -H / 2);
    }
    for (const { el: v, look, fit } of view.layers) {
      // during a seek the browser keeps drawing the last frame; only a player without any picture is skipped
      if (look.opacity <= 0 || !v.videoWidth || v.readyState < 1) continue;
      g.save();
      g.globalAlpha = look.opacity;
      clipToLook(g, look, W, H);
      if (look.shift) g.translate(look.shift * W, 0);
      if (look.scale && look.scale !== 1) {
        g.translate(W / 2, H / 2);
        g.scale(look.scale, look.scale);
        g.translate(-W / 2, -H / 2);
      }
      const cover = Math.max(W / v.videoWidth, H / v.videoHeight);
      const contain = Math.min(W / v.videoWidth, H / v.videoHeight);
      if (fit === "blur") this.drawBackdrop(g, v, W, H, colour);
      g.filter = [look.blur ? `blur(${Math.round(look.blur * H)}px)` : "", colour].join(" ").trim() || "none";
      const s = fit === "cover" ? cover : contain;
      g.drawImage(v, (W - v.videoWidth * s) / 2, (H - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s);
      g.restore();
    }
    g.restore();
    if (view.wash.alpha > 0) {
      g.globalAlpha = view.wash.alpha;
      g.fillStyle = view.wash.color;
      g.fillRect(0, 0, W, H);
      g.globalAlpha = 1;
    }
    if (grade) this.drawGrade(g, grade, W, H);
    if (fx && effects) this.drawEffects(g, fx, effects.tl, W, H);
    g.restore();
  }

  /** The whole picture's surroundings: a blurred, slightly darker copy that fills the frame. */
  private drawBackdrop(g: CanvasRenderingContext2D, v: HTMLVideoElement, W: number, H: number, colour: string): void {
    const w = BACKDROP_W;
    const h = Math.max(2, Math.round((BACKDROP_W * H) / W));
    const c = (this.backdrop ??= document.createElement("canvas"));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const b = c.getContext("2d");
    if (!b) return;
    const s = Math.max(w / v.videoWidth, h / v.videoHeight);
    b.filter = "blur(2.5px)";
    b.drawImage(v, (w - v.videoWidth * s) / 2, (h - v.videoHeight * s) / 2, v.videoWidth * s, v.videoHeight * s);
    g.filter = `brightness(0.85) ${colour}`.trim();
    // a little larger than the frame: the blur fades out at the copy's edges
    g.drawImage(c, -W * 0.04, -H * 0.04, W * 1.08, H * 1.08);
  }

  /** The look over the whole picture: soft-light layers (tint, brightness) and dark corners. */
  private drawGrade(g: CanvasRenderingContext2D, grade: ColorGrade, W: number, H: number): void {
    g.filter = "none";
    if (grade.layers.length) {
      g.globalCompositeOperation = "soft-light";
      for (const [r, gr, b, a] of grade.layers) {
        g.fillStyle = `rgba(${r}, ${gr}, ${b}, ${a})`;
        g.fillRect(0, 0, W, H);
      }
      g.globalCompositeOperation = "source-over";
    }
    if (grade.vignette > 0) {
      const v = g.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
      v.addColorStop(0, "rgba(0, 0, 0, 0)");
      v.addColorStop(1, `rgba(0, 0, 0, ${grade.vignette})`);
      g.fillStyle = v;
      g.fillRect(0, 0, W, H);
    }
  }

  /** A work canvas of this size (kept between frames). */
  private buf(name: string, w: number, h: number): HTMLCanvasElement {
    let c = this.bufs.get(name);
    if (!c) this.bufs.set(name, (c = document.createElement("canvas")));
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    return c;
  }

  /** A copy of what the canvas shows now. */
  private snapshot(name: string, W: number, H: number): HTMLCanvasElement {
    const c = this.buf(name, W, H);
    const x = c.getContext("2d")!;
    x.globalCompositeOperation = "copy";
    x.drawImage(this.canvas, 0, 0);
    x.globalCompositeOperation = "source-over";
    return c;
  }

  /** After the look, in FFmpeg's order: echo, tunnel, glitch, RGB split, negative, strobe, word. */
  private drawEffects(g: CanvasRenderingContext2D, fx: EffectFrame, tl: EffectTimeline, W: number, H: number): void {
    g.filter = "none";
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    if (tl.echoes.length) this.drawEcho(g, fx, W, H);
    if (fx.tunnel > 0) {
      // three copies of the picture inside it, each with a pink frame, all fading together
      const snap = this.snapshot("tunnel", W, H);
      const b = Math.max(1, (3 * W) / REF_W);
      for (const f of TUNNEL_SIZES) {
        const w = W * f;
        const h = H * f;
        const c = this.buf("copy", Math.ceil(w + 2 * b), Math.ceil(h + 2 * b));
        const x = c.getContext("2d")!;
        x.fillStyle = PINK;
        x.fillRect(0, 0, c.width, c.height);
        x.drawImage(snap, b, b, w, h);
        g.globalAlpha = fx.tunnel;
        g.drawImage(c, (W - c.width) / 2, (H - c.height) / 2);
      }
      g.globalAlpha = 1;
    }
    if (fx.glitch) {
      // stripes slip sideways, another pattern every frame; then a pink shimmer
      const snap = this.snapshot("glitch", W, H);
      GLITCH_STRIPES.forEach((share, i) => {
        const sh = Math.max(2, Math.round(share * H));
        const y = Math.floor((H - sh) * fxHash(fx.frame, i + 1, 1));
        const x = (fxHash(fx.frame, i + 1, 2) - 0.5) * GLITCH_SHIFT * W;
        g.drawImage(snap, 0, y, W, sh, x, y, W, sh);
      });
      g.globalCompositeOperation = "screen";
      g.fillStyle = "rgba(255, 62, 138, 0.16)";
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = "source-over";
    }
    if (fx.rgb > 0) {
      // red one way, cyan the other
      const a = fx.rgb * W;
      const snap = this.snapshot("rgb", W, H);
      const parts = ["#f00", "#0ff"].map((colour) => {
        const c = this.buf(colour, W, H);
        const x = c.getContext("2d")!;
        x.globalCompositeOperation = "copy";
        x.drawImage(snap, 0, 0);
        x.globalCompositeOperation = "multiply";
        x.fillStyle = colour;
        x.fillRect(0, 0, W, H);
        x.globalCompositeOperation = "source-over";
        return c;
      });
      g.fillStyle = "#000";
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = "lighter";
      g.drawImage(parts[0], -a, 0);
      g.drawImage(parts[1], a, 0);
      g.globalCompositeOperation = "source-over";
    }
    if (fx.invert) {
      g.globalCompositeOperation = "difference";
      g.fillStyle = "#fff";
      g.fillRect(0, 0, W, H);
      g.globalCompositeOperation = "source-over";
    }
    if (fx.strobe) {
      g.fillStyle = "rgba(255, 255, 255, 0.92)";
      g.fillRect(0, 0, W, H);
    }
    if (fx.text) this.drawWord(g, fx.text.word, fx.text.size * H, fx.text.tt, W, H);
  }

  /**
   * Echo: the two frames before linger as enlarged ghosts – weights (1-α), α(1-α), α² like FFmpeg's mix. The history
   * holds the frames as they were before their own echo; after a jump (seek) the frame on screen stands in for them,
   * like FFmpeg's cloned first frame at the start of a piece.
   */
  private drawEcho(g: CanvasRenderingContext2D, fx: EffectFrame, W: number, H: number): void {
    const step = fx.frame - this.lastFrame;
    const sized = this.echoNow && this.echoNow.width === W && this.echoNow.height === H;
    if (step >= 1 && step <= 4 && sized) {
      // on to the next frame: the one drawn last joins the history
      const reuse = this.echo2;
      this.echo2 = this.echo1;
      this.echo1 = this.echoNow;
      this.echoNow = reuse && reuse !== this.echo1 && reuse !== this.echo2 ? reuse : document.createElement("canvas");
    } else if (step !== 0 || !sized) {
      this.echoNow ??= document.createElement("canvas");
      this.echo1 = this.echo2 = null;
    }
    this.lastFrame = fx.frame;
    const now = this.echoNow!;
    if (now.width !== W || now.height !== H) {
      now.width = W;
      now.height = H;
    }
    const x = now.getContext("2d")!;
    x.globalCompositeOperation = "copy";
    x.drawImage(this.canvas, 0, 0);
    const a = fx.echo;
    if (a <= 0) return;
    const ghost = (c: HTMLCanvasElement, z: number, alpha: number) => {
      g.globalAlpha = alpha;
      g.drawImage(c, (W - W * z) / 2, (H - H * z) / 2, W * z, H * z);
    };
    const g1 = this.echo1 ?? now;
    ghost(g1, ECHO_ZOOM, a / (1 + a));
    ghost(this.echo2 ?? g1, ECHO_ZOOM * ECHO_ZOOM, a * a);
    g.globalAlpha = 1;
  }

  /** A word slams in: big at first, slanted, tilted, a pink shadow and a dark edge; it fades out at the end. */
  private drawWord(g: CanvasRenderingContext2D, word: string, size: number, tt: number, W: number, H: number): void {
    const punch = 1 + 0.35 * Math.exp(-tt * 18);
    const fade = tt > TEXT_FADE_AT ? 1 - (tt - TEXT_FADE_AT) / (TEXT_SECONDS - TEXT_FADE_AT) : 1;
    g.save();
    g.globalAlpha = Math.max(0, fade);
    g.translate(W / 2, H / 2);
    g.rotate(-0.1);
    g.transform(1, 0, -0.18, 1, 0, 0);
    g.scale(punch, punch);
    g.font = `${size}px "${FX_FONT.family}", Impact, "Arial Narrow", sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "alphabetic";
    g.lineJoin = "round";
    // centred on the letters themselves, like FFmpeg's drawtext (y = (h - text_h) / 2)
    const m = g.measureText(word);
    const y = (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
    g.fillStyle = PINK;
    g.fillText(word, size * 0.05, y + size * 0.05);
    g.lineWidth = size * 0.1;
    g.strokeStyle = "#230f1f";
    g.strokeText(word, 0, y);
    g.fillStyle = "#fbeff4";
    g.fillText(word, 0, y);
    g.restore();
  }
}
