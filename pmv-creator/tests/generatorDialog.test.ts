// @vitest-environment jsdom
/** The generator dialog's simple choices: when to cut (like the PMV Generator) and settings saved by older versions. */
import { describe, expect, it } from "vitest";
import { applyMood, defaultSettings } from "../src/generator/generate";
import { chooseCut, cutChoiceOf, loadSaved, withPreset } from "../src/ui/generator/GeneratorDialog";

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
  it("turn their transitions into place and kind", () => {
    localStorage.setItem("pmv-creator:generator", JSON.stringify({ mood: "maximal", style: { speed: 1, speedRamps: true, transitions: "flashBar", flashDrops: true } }));
    expect(loadSaved("t1", ["t1"]).style).toEqual({ speed: 1, speedRamps: true, transitionOn: "bar", transitionType: "fadewhite", flashDrops: true });
    const fromPreset = withPreset(defaultSettings("t1"), { style: { transitions: "fadePhrase" } } as never);
    expect(fromPreset.style).toMatchObject({ transitionOn: "phrase", transitionType: "fade" });
    expect(fromPreset.style).not.toHaveProperty("transitions");
  });
});
