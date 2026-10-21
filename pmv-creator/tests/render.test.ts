import { describe, expect, it } from "vitest";
import { buildEdl, toTimecode } from "../src/export/edl";
import { buildOtio, fileUrl } from "../src/export/otio";
import { buildRenderPlan } from "../src/export/renderPlan";
import { flattenTimeline, resolveTransitions } from "../src/timeline/flatten";
import { clip, project } from "./helpers";

describe("flattenTimeline", () => {
  it("top track wins, gaps become black, the lower clip resumes with the right source time", () => {
    const p = project([clip("2", 1, 1)], [clip("1", 0, 3, { sourceIn: 10 }), clip("3", 4, 1)]);
    const segs = flattenTimeline(p);
    expect(segs.map((s) => [s.clip?.sceneId ?? null, s.startFrame, s.endFrame])).toEqual([
      ["1", 0, 30],
      ["2", 30, 60],
      ["1", 60, 90],
      [null, 90, 120],
      ["3", 120, 150],
    ]);
    // resumed segment is anchored at the clip's own start
    expect(segs[2].clipStartFrame).toBe(0);
  });

  it("muted tracks are ignored", () => {
    const p = project([clip("2", 0, 1)], [clip("1", 0, 1)]);
    p.tracks[0].muted = true;
    expect(flattenTimeline(p)[0].clip?.sceneId).toBe("1");
  });
});

describe("transitions", () => {
  it("are centred on the cut and limited to half the neighbours", () => {
    const p = project([], [clip("1", 0, 2), clip("2", 2, 0.2, { transitionIn: { type: "fade", duration: 1 } })]);
    const t = resolveTransitions(p, flattenTimeline(p))[1]!;
    expect(t.before).toBe(15);
    expect(t.after).toBe(3); // half of the 6-frame incoming clip
  });

  it("are shortened when the incoming clip has no material before its in-point", () => {
    const p = project([], [clip("1", 0, 2), clip("2", 2, 2, { sourceIn: 0.1, transitionIn: { type: "fade", duration: 1 } })]);
    const t = resolveTransitions(p, flattenTimeline(p))[1]!;
    expect(t.before).toBe(3);
  });
});

describe("buildRenderPlan", () => {
  it("pieces add up to the exact frame count", () => {
    const p = project(
      [clip("3", 1.5, 0.75, { transitionIn: { type: "fadewhite", duration: 0.2 } })],
      [
        clip("1", 0, 2, { transitionIn: { type: "fadeblack", duration: 0.5 } }),
        clip("2", 2, 1.4, { speed: 1.5, transitionIn: { type: "fade", duration: 0.4 } }),
        clip("1", 4, 1),
      ],
    );
    const { plan } = buildRenderPlan(p);
    const sum = plan.pieces.reduce((n, x) => n + x.frames, 0);
    expect(sum).toBe(plan.totalFrames);
    expect(plan.totalFrames).toBe(150);
    expect(plan.pieces[0]).toMatchObject({ kind: "xfade", transition: "fadeblack", a: null });
    expect(plan.pieces.some((x) => x.kind === "black")).toBe(true);
  });

  it("xfade sources continue linearly into handles", () => {
    const p = project([], [clip("1", 0, 2, { sourceIn: 10 }), clip("2", 2, 2, { sourceIn: 30, transitionIn: { type: "fade", duration: 0.4 } })]);
    const { plan } = buildRenderPlan(p);
    const x = plan.pieces.find((q) => q.kind === "xfade");
    expect(x).toMatchObject({ kind: "xfade", frames: 12 });
    if (x?.kind !== "xfade") throw new Error();
    expect(x.a!.in).toBeCloseTo(11.8); // A at 1.8 s
    expect(x.b!.in).toBeCloseTo(29.8); // B 0.2 s before its in-point
  });

  it("flags clip audio only when a clip is audible", () => {
    const silent = project([], [clip("1", 0, 1)]);
    expect(buildRenderPlan(silent).plan.clipAudio).toBe(false);
    const loud = project([], [clip("1", 0, 1, { volume: 0.8 })]);
    expect(buildRenderPlan(loud).plan.clipAudio).toBe(true);
  });
});

describe("EDL / OTIO", () => {
  it("formats non-drop timecode", () => {
    expect(toTimecode(3600 * 30 + 61 * 30 + 5, 30)).toBe("01:01:01:05");
  });

  it("writes cut, dissolve and speed events", () => {
    const p = project([], [clip("1", 0, 2), clip("2", 2, 2, { speed: 2, transitionIn: { type: "fade", duration: 0.5 } })]);
    const edl = buildEdl(p);
    expect(edl).toContain("001  AX       V     C        00:00:10:00 00:00:11:23 01:00:00:00 01:00:01:23");
    expect(edl).toMatch(/002 {2}AX {7}V {5}D {4}015 /);
    expect(edl).toContain("M2   AX       060.0");
    expect(edl).toContain("* SOURCE FILE: /media/2.mp4");
  });

  it("OTIO keeps tracks bottom-to-top with gaps and time warps", () => {
    const p = project([clip("2", 1, 1, { speed: 2 })], [clip("1", 0, 3)]);
    const otio = buildOtio(p) as { tracks: { children: Array<{ name: string; children: Array<{ OTIO_SCHEMA: string; effects?: unknown[] }> }> } };
    const [bottom, top] = otio.tracks.children;
    expect(bottom.name).toBe("V1");
    expect(top.children.map((c) => c.OTIO_SCHEMA)).toEqual(["Gap.1", "Clip.1"]);
    expect(top.children[1].effects).toHaveLength(1);
    expect(fileUrl("C:\\Media\\a b.mp4")).toBe("file:///C:/Media/a%20b.mp4");
  });
});
