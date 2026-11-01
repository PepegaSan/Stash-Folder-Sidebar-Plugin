/** Shared Web Audio sources: a media element can be captured only once, including across recordings. */
let context: AudioContext | null = null;
let unavailable = false;
const sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>();

export function mediaAudioContext(): AudioContext | null {
  if (context) return context;
  if (unavailable || typeof AudioContext === "undefined") return null;
  let candidate: AudioContext;
  try {
    candidate = new AudioContext();
  } catch {
    unavailable = true;
    return null;
  }
  // Some embedded browsers do not expose media-element routing.
  if (!candidate.createMediaElementSource || !candidate.createGain) {
    unavailable = true;
    void candidate.close?.().catch(() => undefined);
    return null;
  }
  return (context = candidate);
}

export function captureElement(el: HTMLMediaElement): MediaElementAudioSourceNode {
  let source = sources.get(el);
  if (!source) {
    const ctx = mediaAudioContext();
    if (!ctx) throw new Error("Web Audio is unavailable");
    source = ctx.createMediaElementSource(el);
    sources.set(el, source);
  }
  return source;
}

/** Clip gain belongs after the element (whose volume cannot exceed 1). Recordings route to their own mix. */
export class ClipAudioOutput {
  private routes = new Map<HTMLMediaElement, { source: MediaElementAudioSourceNode; gain: GainNode }>();
  limited = false;

  constructor(private destination?: AudioNode) {}

  setLevel(el: HTMLMediaElement, level: number, playing: boolean): void {
    let route = this.routes.get(el);
    // Ordinary playback stays native until amplification or recording needs a graph. Once captured,
    // an element must keep a graph, even if React remounts the preview with the same elements.
    if (!route && (this.destination || level > 1 || sources.has(el))) {
      const ctx = mediaAudioContext();
      if (ctx) {
        const gain = ctx.createGain();
        const source = captureElement(el);
        gain.gain.value = 0;
        source.connect(gain).connect(this.destination ?? ctx.destination);
        route = { source, gain };
        this.routes.set(el, route);
      }
    }
    if (route) {
      route.gain.gain.value = level;
      el.volume = 1;
      el.muted = level <= 0;
      const ctx = route.gain.context as AudioContext;
      if (playing && ctx.state === "suspended") void ctx.resume().catch(() => undefined);
    } else {
      el.volume = Math.min(1, level);
      el.muted = level <= 0;
      if (level > 1) this.limited = true;
    }
  }

  dispose(): void {
    for (const { source, gain } of this.routes.values()) {
      source.disconnect(gain);
      gain.disconnect();
    }
    this.routes.clear();
  }
}
