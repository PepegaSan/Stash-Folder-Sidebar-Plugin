/**
 * The project's beat and drop effects in the editor: the words' font, the music's loudness and the effect timeline –
 * the same one for the preview, quick record and the render plan.
 */
import { useEffect, useMemo, useState } from "react";
import { type EffectTimeline, FX_FONT, type Measure, effectTimeline } from "../fx/timeline";
import { type EnergyFn, peaksEnergy } from "../generator/rhythm";
import { anyEffect } from "../model/effects";
import type { PmvProject } from "../model/project";
import { stashUrl } from "../stash/graphql";
import { getAudioAnalysis, useAudioAnalysis } from "./hooks";

let fontLoad: Promise<boolean> | null = null;

/** Loads the words' font from the plugin (once); false when that fails – the words then fall back to Impact. */
export function loadFxFont(): Promise<boolean> {
  fontLoad ??= (async () => {
    if (typeof FontFace === "undefined" || !document.fonts) return false;
    try {
      document.fonts.add(await new FontFace(FX_FONT.family, `url("${stashUrl(FX_FONT.url)}")`).load());
      return true;
    } catch {
      return false;
    }
  })();
  return fontLoad;
}

let ctx: CanvasRenderingContext2D | null | undefined;

/** Width of a word in the words' font at size 1 – what decides how big it can be. */
const measure: Measure = (word) => {
  ctx ??= document.createElement("canvas").getContext("2d");
  if (!ctx) return [...word].length * 0.47;
  ctx.font = `100px "${FX_FONT.family}", Impact, "Arial Narrow", sans-serif`;
  return ctx.measureText(word).width / 100;
};

/** The effect timeline with the music's loudness (energy) as given; waits for the font when there are words. */
export async function effectsWith(p: PmvProject, energy: EnergyFn | undefined): Promise<EffectTimeline | null> {
  if (!anyEffect(p.effects)) return null;
  if (p.effects.text) await loadFxFont();
  return effectTimeline(p, energy, p.effects.text ? measure : undefined);
}

/** The effect timeline for a render or a recording – the music is analysed (or taken from the cache) first. */
export async function loadEffects(p: PmvProject): Promise<EffectTimeline | null> {
  if (!anyEffect(p.effects)) return null;
  let energy: EnergyFn | undefined;
  if (p.audio?.url) {
    try {
      const a = await getAudioAnalysis(p.audio.url);
      energy = peaksEnergy(a.peaks, a.peaksPerSecond, p.audio);
    } catch {
      /* the music can't be analysed: the beat effects still fire, drops need its loudness */
    }
  }
  return effectsWith(p, energy);
}

/** The preview's effect timeline: anew when the project changes, the music is analysed or the font has arrived. */
export function useEffects(p: PmvProject): EffectTimeline | null {
  const on = anyEffect(p.effects);
  const { analysis } = useAudioAnalysis(on ? p.audio?.url : null);
  const [font, setFont] = useState(false);
  const words = on && p.effects.text;
  useEffect(() => {
    if (words) void loadFxFont().then(setFont);
  }, [words]);
  const { effects, beatGrid, audio, output, tracks, layouts } = p;
  return useMemo(() => {
    if (!on) return null;
    const energy = analysis && audio ? peaksEnergy(analysis.peaks, analysis.peaksPerSecond, audio) : undefined;
    return effectTimeline(p, energy, words ? measure : undefined);
  }, [on, effects, beatGrid, audio, output, tracks, layouts, analysis, font]);
}
