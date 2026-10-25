/** Per-browser preferences that are not part of a project. */
const KEY_ADVANCED = "pmv-creator:advanced";

/** Simple mode is the default: the editor shows what a PMV needs, the rest sits behind "Advanced". */
export function readAdvanced(): boolean {
  try {
    return localStorage.getItem(KEY_ADVANCED) === "1";
  } catch {
    return false;
  }
}

export function rememberAdvanced(on: boolean): void {
  try {
    localStorage.setItem(KEY_ADVANCED, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}

const KEY_WAVEFORMS = "pmv-creator:waveforms";

/** 〰 above the timeline: the clips' sound drawn over the clips (each scene's peaks are asked from the server once). */
export function readWaveforms(): boolean {
  try {
    return localStorage.getItem(KEY_WAVEFORMS) === "1";
  } catch {
    return false;
  }
}

export function rememberWaveforms(on: boolean): void {
  try {
    localStorage.setItem(KEY_WAVEFORMS, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}

const KEY_LISTEN = "pmv-creator:listen";

/** How loud the preview plays in this browser (🔊 above the timeline) – never part of the render or a recording. */
export interface Listen {
  /** 0..1 */
  volume: number;
  muted: boolean;
}

export function readListen(): Listen {
  try {
    const v = JSON.parse(localStorage.getItem(KEY_LISTEN) ?? "null") as Partial<Listen> | null;
    if (v && typeof v.volume === "number" && Number.isFinite(v.volume)) return { volume: Math.min(1, Math.max(0, v.volume)), muted: !!v.muted };
  } catch {
    /* private mode / garbage */
  }
  return { volume: 1, muted: false };
}

export function rememberListen(l: Listen): void {
  try {
    localStorage.setItem(KEY_LISTEN, JSON.stringify(l));
  } catch {
    /* private mode */
  }
}
