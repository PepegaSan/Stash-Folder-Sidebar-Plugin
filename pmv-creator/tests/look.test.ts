/** Colour looks: one definition, two forms – CSS filters for the canvas, one colour matrix for FFmpeg – that agree. */
import { describe, expect, it } from "vitest";
import { buildRenderPlan } from "../src/export/renderPlan";
import { type LookSettings, colorGrade } from "../src/model/look";
import { clip, project } from "./helpers";

const look = (patch: Partial<LookSettings>): LookSettings => ({ look: "none", lookAmount: 1, lookColor: "#ff4d94", brightness: 0, ...patch });

/** The CSS filter functions one after another on an RGB value (0…1), as the Filter Effects spec defines them. */
function cssApply(css: string, rgb: number[]): number[] {
  let [r, g, b] = rgb;
  for (const m of css.matchAll(/(\w+)\(([\d.]+)\)/g)) {
    const v = +m[2];
    const mat = (k: number[]) => [k[0] * r + k[1] * g + k[2] * b, k[3] * r + k[4] * g + k[5] * b, k[6] * r + k[7] * g + k[8] * b];
    const k = 1 - Math.min(1, v);
    switch (m[1]) {
      case "grayscale":
        [r, g, b] = mat([0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k, 0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k, 0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k]);
        break;
      case "sepia":
        [r, g, b] = mat([0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k, 0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k, 0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k]);
        break;
      case "saturate":
        [r, g, b] = mat([0.213 + 0.787 * v, 0.715 - 0.715 * v, 0.072 - 0.072 * v, 0.213 - 0.213 * v, 0.715 + 0.285 * v, 0.072 - 0.072 * v, 0.213 - 0.213 * v, 0.715 - 0.715 * v, 0.072 + 0.928 * v]);
        break;
      case "contrast":
        [r, g, b] = [r, g, b].map((x) => (x - 0.5) * v + 0.5);
        break;
      case "brightness":
        [r, g, b] = [r, g, b].map((x) => x * v);
        break;
    }
  }
  return [r, g, b];
}

describe("colour looks", () => {
  it("leave the picture alone when there is nothing to do", () => {
    expect(colorGrade(look({}))).toBeNull();
    expect(colorGrade(look({ look: "warm", lookAmount: 0 }))).toBeNull();
  });

  it("fold the CSS chain into one matrix in the same order", () => {
    const samples = [[0.2, 0.5, 0.8], [0.9, 0.1, 0.3], [0.5, 0.5, 0.5]];
    for (const l of ["warm", "pink", "cold", "vivid", "bw", "noir"] as const) {
      const g = colorGrade(look({ look: l, lookAmount: 0.8, brightness: 0.3 }))!;
      for (const rgb of samples) {
        const viaMatrix = [0, 1, 2].map((r) => g.matrix[r * 3] * rgb[0] + g.matrix[r * 3 + 1] * rgb[1] + g.matrix[r * 3 + 2] * rgb[2] + g.offset[r]);
        cssApply(g.css, rgb).forEach((x, i) => expect(viaMatrix[i]).toBeCloseTo(x, 3));
      }
    }
  });

  it("black & white takes the colour out; tint, own colour, brightness and dark corners scale with the strength", () => {
    const bw = colorGrade(look({ look: "bw" }))!;
    expect(bw.css).toBe("grayscale(1) contrast(1.15)");
    expect(bw.matrix.slice(0, 3)).toEqual(bw.matrix.slice(3, 6));
    expect(colorGrade(look({ look: "warm", lookAmount: 0.5 }))!.layers).toEqual([[255, 140, 60, 0.11]]);
    expect(colorGrade(look({ look: "custom", lookColor: "#00ff80" }))!.layers).toEqual([[0, 255, 128, 0.34]]);
    expect(colorGrade(look({ brightness: 0.5 }))).toMatchObject({ css: "brightness(1.05)", layers: [[255, 255, 255, 0.2]], vignette: 0 });
    expect(colorGrade(look({ look: "noir", lookAmount: 0.5 }))!.vignette).toBe(0.3);
  });

  it("travel in the render plan as numbers, only when there is a look", () => {
    const p = project([], [clip("1", 0, 2)]);
    expect(buildRenderPlan(p).plan.grade).toBeUndefined();
    p.output = { ...p.output, look: "pink", lookAmount: 1 };
    const g = buildRenderPlan(p).plan.grade!;
    expect(g.layers).toEqual([[255, 62, 138, 0.3]]);
    expect(g.matrix).toHaveLength(9);
    expect(g).not.toHaveProperty("css");
  });
});
