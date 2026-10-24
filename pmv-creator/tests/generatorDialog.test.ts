// @vitest-environment jsdom
/** The generator dialog's simple choices: when to cut (like the PMV Generator) and settings saved by older versions. */
import { describe, expect, it } from "vitest";
import { MOODS, applyMood, defaultSettings, moodEffects } from "../src/generator/generate";
import { chooseCut, cutChoiceOf, loadSaved, withPreset } from "../src/ui/generator/GeneratorDialog";
import { HELPER_FOR_LOOKS, HELPER_FOR_SPLIT, helperFor, olderVersion } from "../src/ui/PcRender";

describe("render helper versions", () => {
  it("a helper from before the colour looks is told to update", () => {
    expect(olderVersion("0.9.4", HELPER_FOR_LOOKS)).toBe(true);
    expect(olderVersion(undefined, HELPER_FOR_LOOKS)).toBe(true);
    expect(olderVersion("0.9.5", HELPER_FOR_LOOKS)).toBe(false);
    expect(olderVersion("0.10.0", HELPER_FOR_LOOKS)).toBe(false);
    expect(olderVersion("1.0", "0.9.5")).toBe(false);
  });

  it("split screens need the helper 0.9.6 – it stops at them before", () => {
    expect(helperFor({ split: true, looks: false })).toBe(HELPER_FOR_SPLIT);
    expect(helperFor({ split: false, looks: true })).toBe(HELPER_FOR_LOOKS);
    expect(helperFor({ split: false, looks: false })).toBeUndefined();
    expect(olderVersion("0.9.5", HELPER_FOR_SPLIT)).toBe(true);
  });
});

describe("when to cut", () => {
  it("every 1/2/4 beats on the bar grid, automatic, like another PMV", () => {
    const s = defaultSettings("t1");
    expect(cutChoiceOf(s.cut)).toBe("auto");
    const two = chooseCut(s, "2");
    expect(two.cut).toMatchObject({ mode: "fixed", every: 2, onGrid: true });
    expect(cutChoiceOf(two.cut)).toBe("2");
    expect(cutChoiceOf(chooseCut(s, "4").cut)).toBe("4");
    expect(cutChoiceOf({ ...s.cut, mode: "fixed", every: 8 })).toBeNull();
    expect(cutChoiceOf({ ...s.cut, mode: "pattern" })).toBeNull();
    const tpl = chooseCut(two, "template");
    expect(tpl.cut.mode).toBe("template");
    expect(chooseCut(tpl, "2").cut).toMatchObject({ mode: "fixed", every: 2 });
  });

  it("the mood keeps its name only while its own cutting stays", () => {
    const hypno = applyMood(defaultSettings("t1"), "hypno"); // every 2 beats
    expect(chooseCut(hypno, "2").mood).toBe("hypno");
    expect(chooseCut(hypno, "1").mood).toBe("custom");
    expect(chooseCut(hypno, "1").style).toEqual(hypno.style);
    expect(chooseCut(applyMood(hypno, "classic"), "auto").mood).toBe("classic");
    expect(chooseCut(hypno, "template").mood).toBe("hypno");
  });
});

describe("settings saved by older versions", () => {
  it("turn their transitions into place and kind, and get their mood's effects", () => {
    localStorage.setItem("pmv-creator:generator", JSON.stringify({ mood: "maximal", style: { speed: 1, speedRamps: true, transitions: "flashBar", flashDrops: true } }));
    // … and their mood's split screens
    expect(loadSaved("t1", ["t1"]).style).toEqual({ speed: 1, speedRamps: true, transitionOn: "bar", transitionType: "fadewhite", flashDrops: true, fx: moodEffects("maximal"), layouts: MOODS.maximal.style.layouts, split: "cols", layoutShape: {} });
    expect(moodEffects("maximal")).toMatchObject({ zoom: true, tunnel: true, hue: true, strobe: false });
    const fromPreset = withPreset(defaultSettings("t1"), { style: { transitions: "fadePhrase" } } as never);
    expect(fromPreset.style).toMatchObject({ transitionOn: "phrase", transitionType: "fade" });
    expect(fromPreset.style).not.toHaveProperty("transitions");
    expect(fromPreset.style.fx).toEqual(moodEffects("classic"));
  });

  it("keep their own effects; a mood switches its set, strength and words stay", () => {
    const own = { ...moodEffects("clean"), echo: true, pulseAmount: 0.5, words: "WOW" };
    localStorage.setItem("pmv-creator:generator", JSON.stringify({ mood: "custom", style: { fx: own } }));
    expect(loadSaved("t1", ["t1"]).style.fx).toEqual(own);
    const hypno = applyMood({ ...defaultSettings("t1"), style: { ...defaultSettings("t1").style, fx: own } }, "hypno").style.fx;
    expect(hypno).toMatchObject({ zoom: true, echo: true, tunnel: true, hue: true, shake: false, pulseAmount: 0.5, words: "WOW" });
  });
});
