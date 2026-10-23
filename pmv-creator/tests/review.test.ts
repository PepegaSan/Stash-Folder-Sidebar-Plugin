import { describe, expect, it, vi } from "vitest";
import { initialEditorState } from "../src/state/reducer";
import { REVIEW_LEAD, neighbourCut, reviewCut } from "../src/ui/review";
import { clip, project } from "./helpers";

describe("review the cuts ([ / ])", () => {
  const a = clip("1", 0, 2);
  const b = clip("2", 2, 3);
  const c = clip("1", 5, 2);
  const over = clip("3", 2, 1); // upper track cuts at the same moment as b
  const p = project([over], [a, b, c]);

  it("finds the next and previous cut over all tracks, the upper track first", () => {
    expect(neighbourCut(p, 0, 1)?.id).toBe(over.id);
    expect(neighbourCut(p, 2, 1)?.id).toBe(c.id);
    expect(neighbourCut(p, 5, -1)?.id).toBe(over.id);
    expect(neighbourCut(p, 2, -1)?.id).toBe(a.id);
    expect(neighbourCut(p, 5, 1)).toBeNull();
    expect(neighbourCut(p, 0, -1)).toBeNull();
  });

  it("skips muted tracks", () => {
    const muted = { ...p, tracks: [{ ...p.tracks[0], muted: true }, p.tracks[1]] };
    expect(neighbourCut(muted, 0, 1)?.id).toBe(b.id);
  });

  it("selects the clip and plays from a second before its cut", () => {
    const dispatch = vi.fn();
    const transport = { time: 0, seek: vi.fn(), play: vi.fn() };
    const state = initialEditorState(p, { selectedClipId: a.id, activeSceneId: "2", sceneInPlayer: true });
    expect(reviewCut(state, dispatch, transport as never, 1)).toBe(true);
    expect(dispatch).toHaveBeenCalledWith({ type: "ui", patch: { selectedClipId: over.id, sceneInPlayer: false } });
    expect(transport.seek).toHaveBeenCalledWith(2 - REVIEW_LEAD);
    expect(transport.play).toHaveBeenCalled();
    // without a selection the playhead is the reference; the first clip starts at 0 – no negative seek
    const fresh = initialEditorState(p);
    const t2 = { time: 1, seek: vi.fn(), play: vi.fn() };
    expect(reviewCut(fresh, dispatch, t2 as never, -1)).toBe(true);
    expect(t2.seek).toHaveBeenCalledWith(0);
    expect(reviewCut(initialEditorState(p, { selectedClipId: c.id }), dispatch, t2 as never, 1)).toBe(false);
  });
});
