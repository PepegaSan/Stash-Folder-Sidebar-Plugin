import { describe, expect, it } from "vitest";
import { clipEnd } from "../src/model/project";
import { deleteClip, insertClip, moveClip, replaceClip, setAllTransitions, setClipSource, setClipSpeed, slipClip, splitClip, trimClip } from "../src/timeline/ops";
import { transitionLooks } from "../src/ui/preview/engine";
import { assertTrackInvariants, clip, project } from "./helpers";

const trackOf = (p: ReturnType<typeof project>, i = 0) => p.tracks[i].clips;

describe("insertClip", () => {
  it("overwrite splits the clip underneath", () => {
    const p = project([clip("1", 0, 4)]);
    const next = insertClip(p, p.tracks[0].id, clip("2", 1, 1), "overwrite");
    assertTrackInvariants(next);
    const clips = trackOf(next);
    expect(clips.map((c) => [c.sceneId, c.start, c.duration])).toEqual([
      ["1", 0, 1],
      ["2", 1, 1],
      ["1", 2, 2],
    ]);
    // right part continues in the source where it would have been
    expect(clips[2].sourceIn).toBeCloseTo(12);
  });

  it("ripple pushes later clips instead of destroying them", () => {
    const p = project([clip("1", 0, 2), clip("2", 2, 2)]);
    const next = insertClip(p, p.tracks[0].id, clip("3", 2, 1), "ripple");
    assertTrackInvariants(next);
    expect(trackOf(next).map((c) => [c.sceneId, c.start])).toEqual([
      ["1", 0],
      ["3", 2],
      ["2", 3],
    ]);
  });

  it("clamp moves into the nearest gap and never overlaps", () => {
    const p = project([clip("1", 0, 2), clip("2", 5, 2)]);
    const next = insertClip(p, p.tracks[0].id, clip("3", 1.5, 2), "clamp");
    assertTrackInvariants(next);
    expect(trackOf(next)[1].start).toBeCloseTo(2);
  });

  it("clamp skips gaps that are too small", () => {
    const p = project([clip("1", 0, 2), clip("2", 2.5, 2)]);
    // the 0.5 s gap is too small for a 1 s clip -> first fit is after the last clip
    const next = insertClip(p, p.tracks[0].id, clip("3", 1, 1), "clamp");
    expect(trackOf(next).find((c) => c.sceneId === "3")!.start).toBeCloseTo(4.5);
  });

  it("clamp rejects on a locked track and returns the same project", () => {
    const p = project([clip("1", 0, 2)]);
    p.tracks[0].locked = true;
    expect(insertClip(p, p.tracks[0].id, clip("3", 5, 1), "clamp")).toBe(p);
  });
});

describe("moveClip", () => {
  it("clamp stops at the neighbour", () => {
    const a = clip("1", 0, 2);
    const b = clip("2", 4, 2);
    const p = project([a, b]);
    const next = moveClip(p, b.id, p.tracks[0].id, 1, "clamp");
    assertTrackInvariants(next);
    expect(trackOf(next).find((c) => c.id === b.id)!.start).toBeCloseTo(2);
  });

  it("moves between tracks", () => {
    const a = clip("1", 0, 2);
    const p = project([a], []);
    const next = moveClip(p, a.id, p.tracks[1].id, 3, "clamp");
    expect(trackOf(next, 0)).toHaveLength(0);
    expect(trackOf(next, 1)[0].start).toBe(3);
  });

  it("is rejected on a locked track", () => {
    const a = clip("1", 0, 2);
    const p = project([a]);
    p.tracks[0].locked = true;
    expect(moveClip(p, a.id, p.tracks[0].id, 5, "clamp")).toBe(p);
  });
});

describe("trimClip", () => {
  it("clamp trims up to the neighbour only", () => {
    const a = clip("1", 0, 2);
    const b = clip("2", 3, 2);
    const p = project([a, b]);
    const next = trimClip(p, a.id, "end", 4, "clamp");
    assertTrackInvariants(next);
    expect(clipEnd(trackOf(next)[0])).toBeCloseTo(3);
  });

  it("head trim keeps the source in sync", () => {
    const a = clip("1", 2, 4, { sourceIn: 20, speed: 2 });
    const p = project([a]);
    const next = trimClip(p, a.id, "start", 3, "clamp");
    const c = trackOf(next)[0];
    expect(c.start).toBe(3);
    expect(c.duration).toBe(3);
    expect(c.sourceIn).toBe(22);
  });

  it("head trim cannot go before the start of the source", () => {
    const a = clip("1", 5, 2, { sourceIn: 1 });
    const p = project([a]);
    const c = trackOf(trimClip(p, a.id, "start", 0, "clamp"))[0];
    expect(c.start).toBeCloseTo(4);
    expect(c.sourceIn).toBeCloseTo(0);
  });

  it("ripple shifts followers by the trimmed amount", () => {
    const a = clip("1", 0, 2);
    const b = clip("2", 2, 2);
    const p = project([a, b]);
    const next = trimClip(p, a.id, "end", 1, "ripple");
    assertTrackInvariants(next);
    expect(trackOf(next)[1].start).toBeCloseTo(1);
  });

  it("overwrite eats into the neighbour", () => {
    const a = clip("1", 0, 2);
    const b = clip("2", 2, 2);
    const p = project([a, b]);
    const next = trimClip(p, a.id, "end", 3, "overwrite");
    assertTrackInvariants(next);
    expect(trackOf(next)[1].start).toBeCloseTo(3);
    expect(trackOf(next)[1].duration).toBeCloseTo(1);
  });
});

describe("slip / speed / replace / split / delete", () => {
  it("slip keeps the timeline slot and respects source bounds", () => {
    const a = clip("1", 0, 2);
    const p = project([a]);
    const c = trackOf(slipClip(p, a.id, 99))[0];
    expect(c.start).toBe(0);
    expect(c.duration).toBe(2);
    expect(c.sourceIn).toBeCloseTo(98);
  });

  it("speed with keep=duration keeps the slot (beat sync)", () => {
    const a = clip("1", 0, 2);
    const p = project([a]);
    const c = trackOf(setClipSpeed(p, a.id, 2, "duration", "clamp"))[0];
    expect(c.duration).toBe(2);
    expect(c.speed).toBe(2);
  });

  it("speed with keep=range changes the length", () => {
    const a = clip("1", 0, 2);
    const p = project([a]);
    const c = trackOf(setClipSpeed(p, a.id, 2, "range", "clamp"))[0];
    expect(c.duration).toBeCloseTo(1);
  });

  it("replace swaps material but keeps position, length and transition", () => {
    const a = clip("1", 4, 2, { transitionIn: { type: "fade", duration: 0.5 } });
    const p = project([a]);
    p.bin.push({ id: "s1", sceneId: "2", markerId: "m9", in: 50, out: 51, label: "x", tags: [] });
    const c = trackOf(replaceClip(p, a.id, p.bin[0]))[0];
    expect([c.sceneId, c.start, c.duration, c.sourceIn, c.markerId]).toEqual(["2", 4, 2, 50, "m9"]);
    expect(c.transitionIn?.type).toBe("fade");
  });

  describe("setClipSource: other material, same slot (A → B stays)", () => {
    const slot = (c: { start: number; duration: number }) => [c.start, c.duration];

    it("moves the range inside the same scene, speed and slot unchanged", () => {
      const a = clip("1", 4, 2, { sourceIn: 10, speed: 1.5, label: "L", snippetId: "s" });
      const c = trackOf(setClipSource(project([a]), a.id, { sceneId: "1", sourceIn: 40, markerId: null }, false))[0];
      expect(slot(c)).toEqual([4, 2]);
      expect([c.sourceIn, c.speed, c.label, c.snippetId]).toEqual([40, 1.5, "L", "s"]);
    });

    it("takes material from another scene or marker", () => {
      const a = clip("1", 4, 2, { sourceIn: 10, label: "old", snippetId: "s" });
      const c = trackOf(setClipSource(project([a]), a.id, { sceneId: "2", sourceIn: 30, markerId: "m7", label: "Dance" }, false))[0];
      expect(slot(c)).toEqual([4, 2]);
      expect([c.sceneId, c.sourceIn, c.markerId, c.label, c.snippetId]).toEqual(["2", 30, "m7", "Dance", null]);
    });

    it("fit plays exactly the given range by adjusting the speed", () => {
      const a = clip("1", 4, 2, { sourceIn: 10 });
      const c = trackOf(setClipSource(project([a]), a.id, { sceneId: "1", sourceIn: 20, sourceOut: 23, markerId: null }, true))[0];
      expect(slot(c)).toEqual([4, 2]);
      expect([c.sourceIn, c.speed]).toEqual([20, 1.5]);
    });

    it("stays inside the file", () => {
      const a = clip("1", 4, 2, { sourceIn: 10 });
      const c = trackOf(setClipSource(project([a]), a.id, { sceneId: "1", sourceIn: 99.5, markerId: null }, false))[0];
      expect(c.sourceIn).toBeCloseTo(98);
      expect(slot(c)).toEqual([4, 2]);
    });

    it("does nothing on a locked track", () => {
      const a = clip("1", 4, 2);
      const p = project([a]);
      p.tracks[0].locked = true;
      expect(setClipSource(p, a.id, { sceneId: "2", sourceIn: 1, markerId: null }, false)).toBe(p);
    });
  });

  it("split produces two continuous halves", () => {
    const a = clip("1", 0, 4);
    const p = project([a]);
    const clips = trackOf(splitClip(p, a.id, 1.5));
    expect(clips).toHaveLength(2);
    expect(clips[1].sourceIn).toBeCloseTo(11.5);
  });

  it("ripple delete closes the gap", () => {
    const a = clip("1", 0, 2);
    const b = clip("2", 2, 2);
    const p = project([a, b]);
    const clips = trackOf(deleteClip(p, a.id, true));
    expect(clips[0].start).toBe(0);
  });
});

describe("transitions", () => {
  it("one transition for all clips: the first clip of each track and locked tracks keep theirs", () => {
    const own = { type: "fadewhite" as const, duration: 0.1 };
    const p = project([clip("1", 0, 2, { transitionIn: own }), clip("2", 2, 2)], [clip("3", 0, 2), clip("1", 2, 2), clip("2", 4, 2, { transitionIn: own })]);
    const fade = { type: "fade" as const, duration: 0.5 };
    const next = setAllTransitions(p, fade);
    expect(trackOf(next, 0).map((c) => c.transitionIn)).toEqual([own, fade]);
    expect(trackOf(next, 1).map((c) => c.transitionIn)).toEqual([null, fade, fade]);
    // nothing to change → same project (no undo step)
    expect(setAllTransitions(next, fade)).toBe(next);
    // hard cuts everywhere, locked tracks untouched
    const locked = { ...next, tracks: next.tracks.map((t, i) => (i === 1 ? { ...t, locked: true } : t)) };
    const cut = setAllTransitions(locked, null);
    expect(trackOf(cut, 0).map((c) => c.transitionIn)).toEqual([own, null]);
    expect(trackOf(cut, 1)).toBe(trackOf(locked, 1));
  });

  it("preview looks follow FFmpeg's xfade directions", () => {
    // wipeleft: the new clip appears on the right and grows to the left
    expect(transitionLooks("wipeleft", 0.25).incoming.band).toEqual([0.75, 1]);
    expect(transitionLooks("wiperight", 0.25).incoming.band).toEqual([0, 0.25]);
    // slideleft: both move left, the new clip comes in from the right
    const s = transitionLooks("slideleft", 0.25);
    expect([s.incoming.shift, s.outgoing.shift]).toEqual([0.75, -0.25]);
    expect(transitionLooks("circleopen", 1).incoming.circle).toBe(1);
    // everything without its own look is a crossfade
    expect(transitionLooks("dissolve", 0.4)).toEqual({ incoming: { opacity: 0.4 }, outgoing: { opacity: 1 } });
  });
});
