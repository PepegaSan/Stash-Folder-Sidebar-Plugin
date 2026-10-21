/**
 * Playback clock. While the music plays it is the master (no drift between picture and beat);
 * outside the music range a performance.now() clock takes over. Lives outside React state so the
 * playhead can move at 60 fps without re-rendering the editor.
 */
import type { AudioTrack } from "../model/project";
import { stashUrl } from "../stash/graphql";
import { clamp } from "../timeline/time";

export class Transport {
  readonly audio: HTMLAudioElement;
  duration = 0;
  private _time = 0;
  private _playing = false;
  private clockBase = 0;
  private clockTime = 0;
  private cfg: AudioTrack | null = null;
  private listeners = new Set<() => void>();
  private raf = 0;

  constructor() {
    this.audio = new Audio();
    this.audio.preload = "auto";
  }

  get time(): number {
    return this._time;
  }

  get playing(): boolean {
    return this._playing;
  }

  /** Called on every project change; only re-seeks when the music placement really changed. */
  setAudio(cfg: AudioTrack | null): void {
    const prev = this.cfg;
    const url = cfg?.url ? stashUrl(cfg.url) : null;
    const urlChanged = url !== (prev?.url ? stashUrl(prev.url) : null);
    if (urlChanged) {
      if (url) this.audio.src = url;
      else this.audio.removeAttribute("src");
    }
    this.cfg = cfg;
    this.syncAudio(urlChanged || prev?.start !== cfg?.start || prev?.sourceIn !== cfg?.sourceIn);
  }

  play(): void {
    if (this._playing) return;
    if (this._time >= this.duration - 0.01) this._time = 0;
    this._playing = true;
    this.clockBase = performance.now();
    this.clockTime = this._time;
    this.syncAudio(true);
    this.raf = requestAnimationFrame(this.loop);
    this.emit();
  }

  pause(): void {
    if (!this._playing) return;
    this._playing = false;
    cancelAnimationFrame(this.raf);
    this.audio.pause();
    this.emit();
  }

  toggle(): void {
    if (this._playing) this.pause();
    else this.play();
  }

  seek(t: number): void {
    this._time = clamp(t, 0, Math.max(0, this.duration));
    this.clockBase = performance.now();
    this.clockTime = this._time;
    this.syncAudio(true);
    this.emit();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  dispose(): void {
    this.pause();
    this.audio.removeAttribute("src");
    this.listeners.clear();
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }

  private loop = () => {
    if (!this._playing) return;
    const a = this.cfg;
    const audioDriving = !!a?.url && !this.audio.paused && !this.audio.seeking && this.audio.readyState >= 3;
    if (audioDriving) {
      this._time = a!.start + (this.audio.currentTime - a!.sourceIn);
      this.clockTime = this._time;
      this.clockBase = performance.now();
    } else {
      this._time = this.clockTime + (performance.now() - this.clockBase) / 1000;
    }
    if (this._time >= this.duration) {
      this._time = this.duration;
      this.pause();
      return;
    }
    this.syncAudio(false);
    this.emit();
    this.raf = requestAnimationFrame(this.loop);
  };

  private syncAudio(force: boolean): void {
    const a = this.cfg;
    if (!a?.url) return;
    const local = a.sourceIn + (this._time - a.start);
    const inRange = this._time >= a.start && local < a.duration;
    // music gain incl. fades, preview approximation of the render
    const fadeIn = a.fadeIn > 0 ? clamp((this._time - a.start) / a.fadeIn, 0, 1) : 1;
    const fadeOut = a.fadeOut > 0 ? clamp((this.duration - this._time) / a.fadeOut, 0, 1) : 1;
    this.audio.volume = clamp(10 ** (a.gainDb / 20), 0, 1) * fadeIn * fadeOut;
    if (!this._playing || !inRange) {
      if (!this.audio.paused) this.audio.pause();
      if (force && inRange && this.audio.readyState > 0) this.audio.currentTime = local;
      return;
    }
    if (force || Math.abs(this.audio.currentTime - local) > 0.25) this.audio.currentTime = local;
    if (this.audio.paused) void this.audio.play().catch(() => undefined);
  }
}
