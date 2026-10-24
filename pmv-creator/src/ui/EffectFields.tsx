/** The beat and drop effects as switches – the project's in the inspector, the generator's (applied with the clips) in its dialog. */
import React from "react";
import { t } from "../i18n";
import { EFFECTS, EFFECT_GROUPS, type EffectGroup, type EffectId, type EffectSettings, type PulseOn, effectWords } from "../model/effects";
import { Seg } from "./common";

export function effectLabel(id: EffectId): string {
  switch (id) {
    case "zoom":
      return t("Zoom pulse");
    case "shake":
      return t("Shake");
    case "stutter":
      return t("Stutter");
    case "strobe":
      return t("Strobe");
    case "rgb":
      return t("RGB split");
    case "glitch":
      return t("Glitch");
    case "tunnel":
      return t("Tunnel");
    case "invert":
      return t("Negative");
    case "echo":
      return t("Echo");
    case "text":
      return t("Text");
    case "hue":
      return t("Colour rush");
  }
}

function effectHint(id: EffectId): string {
  switch (id) {
    case "zoom":
      return t("The picture pumps on the beat – it swells just before and dies away after");
    case "shake":
      return t("The picture shakes on loud beats");
    case "stutter":
      return t("In loud parts the clip jumps back on every other half beat – a classic PMV effect");
    case "strobe":
      return t("White flashes on half beats in loud parts – careful if you are sensitive to light");
    case "rgb":
      return t("Red and cyan tear apart – hard on drops, lighter on loud bars and cuts");
    case "glitch":
      return t("Stripes of the picture slip sideways on drops and very loud bars");
    case "tunnel":
      return t("On drops the picture sits inside itself three times");
    case "invert":
      return t("A short negative on drops and every other very loud bar");
    case "echo":
      return t("In loud parts the last frames linger as ghosts");
    case "text":
      return t("Your words slam into the picture on drops and now and then on loud bars");
    case "hue":
      return t("The colours turn through the whole song – faster when it is loud");
  }
}

function groupLabel(g: EffectGroup): string {
  return g === "beat" ? t("On the beat") : g === "drops" ? t("On drops") : t("Through the song");
}

/** "Zoom pulse, RGB split, …" or "none". */
export function effectSummary(fx: EffectSettings): string {
  const on = EFFECTS.filter((id) => fx[id]).map(effectLabel);
  return on.length ? on.join(", ") : t("none");
}

/** `music`: drops need the song's loudness – without it only the beat effects fire. */
export function EffectFields({ fx, onChange, music }: { fx: EffectSettings; onChange: (patch: Partial<EffectSettings>) => void; music: boolean }) {
  return (
    <div className="pmv-fx">
      {EFFECT_GROUPS.map(([group, ids]) => (
        <div key={group} className="pmv-fx-group">
          <span className="pmv-fx-head">{groupLabel(group)}</span>
          <span className="pmv-fx-items">
            {ids.map((id) => (
              <label key={id} className="pmv-check" title={effectHint(id)}>
                <input type="checkbox" checked={fx[id]} onChange={(e) => onChange({ [id]: e.target.checked } as Partial<EffectSettings>)} /> {effectLabel(id)}
              </label>
            ))}
          </span>
        </div>
      ))}
      {fx.zoom && (
        <div className="pmv-fx-group">
          <span className="pmv-fx-head">{t("Zoom pulse")}</span>
          <span className="pmv-fx-items">
            <Seg<PulseOn> value={fx.pulseOn} onChange={(v) => onChange({ pulseOn: v })} options={[["beat", t("every beat")], ["2", t("beats 1 and 3")], ["bar", t("every bar")]]} />
            <span className="pmv-row" title={t("How strongly the picture pumps")}>
              <input type="range" min={0} max={1.5} step={0.05} value={fx.pulseAmount} onChange={(e) => onChange({ pulseAmount: +e.target.value })} />
              <span className="pmv-mono">{Math.round(fx.pulseAmount * 100)}%</span>
            </span>
          </span>
        </div>
      )}
      {fx.text && (
        <div className="pmv-fx-group">
          <span className="pmv-fx-head">{t("Words")}</span>
          <input className="form-control form-control-sm pmv-fx-words" value={fx.words} placeholder={t("e.g. GOOD GIRL, DROP, WOW")} onChange={(e) => onChange({ words: e.target.value })} onKeyDown={(e) => e.stopPropagation()} />
        </div>
      )}
      {fx.text && !effectWords(fx.words).length && <div className="pmv-li-meta">{t("Text needs words – separate them with commas.")}</div>}
      {fx.strobe && <div className="pmv-li-meta">⚠ {t("Strobe: fast white flashes – careful if you are sensitive to light.")}</div>}
      {!music && <div className="pmv-li-meta">{t("Without music there are no drops – only the effects on the beat fire.")}</div>}
    </div>
  );
}
