/**
 * Beat and drop effects for the whole PMV, after the PMV Generator's (pmvfx.js): which ones are on. When they fire
 * and what a frame looks like is worked out in fx/timeline.ts.
 */

/** In the order the editor lists them: on the beat, on drops, through the whole song, in split screens. */
export const EFFECTS = ["zoom", "shake", "stutter", "strobe", "rgb", "glitch", "tunnel", "invert", "echo", "text", "hue", "flash", "lines"] as const;
export type EffectId = (typeof EFFECTS)[number];

export type EffectGroup = "beat" | "drops" | "song" | "split";
export const EFFECT_GROUPS: Array<[EffectGroup, EffectId[]]> = [
  ["beat", ["zoom", "shake", "stutter", "strobe"]],
  ["drops", ["rgb", "glitch", "tunnel", "invert", "echo", "text"]],
  ["song", ["hue"]],
  ["split", ["flash", "lines"]],
];

/** The zoom pulse on every beat, on beats 1 and 3, or on the bar's "one" (drops always pulse). */
export type PulseOn = "beat" | "2" | "bar";

export type EffectSettings = Record<EffectId, boolean> & {
  /** Strength of the zoom pulse, 0 … 1.5 (1 = the PMV Generator's). */
  pulseAmount: number;
  pulseOn: PulseOn;
  /** Words for the text effect, separated by commas or new lines. */
  words: string;
};

export const DEFAULT_EFFECTS: EffectSettings = {
  zoom: false,
  shake: false,
  stutter: false,
  strobe: false,
  rgb: false,
  glitch: false,
  tunnel: false,
  invert: false,
  echo: false,
  text: false,
  hue: false,
  flash: false,
  lines: false,
  pulseAmount: 1,
  pulseOn: "beat",
  words: "",
};

export const anyEffect = (s: EffectSettings | null | undefined): boolean => !!s && EFFECTS.some((id) => s[id]);

/** Effects switched on/off as a set (moods), the rest of the settings as they are. */
export const withEffects = (s: EffectSettings, on: readonly EffectId[]): EffectSettings => ({ ...s, ...Object.fromEntries(EFFECTS.map((id) => [id, on.includes(id)])) });

/** The words of the text effect in upper case, with only the characters the renderer draws safely (no quotes, colons, backslashes). */
export function effectWords(words: string): string[] {
  return words
    .split(/[,;\n]+/)
    .map((w) =>
      w
        .normalize("NFC")
        .toUpperCase()
        .replace(/[^\p{L}\p{N} !?.&#+-]/gu, "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40),
    )
    .filter(Boolean)
    .slice(0, 50);
}
