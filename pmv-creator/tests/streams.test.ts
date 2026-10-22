// @vitest-environment jsdom
/** Where a scene's video comes from: the render helper on this PC (mapped folders) or Stash, and the fallbacks. */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VideoSlot, pickStream, setLocalMedia, streamGeneration } from "../src/stash/streams";
import type { StashSceneCore } from "../src/stash/types";

let n = 0;
function scene(path: string, audio = "aac"): StashSceneCore {
  const id = String(++n);
  return {
    id,
    title: null,
    date: null,
    rating100: null,
    files: [{ id: `f${id}`, path, basename: path.split("/").pop()!, duration: 60, width: 1920, height: 1080, frame_rate: 30, video_codec: "h264", audio_codec: audio }],
    paths: { screenshot: null, stream: `/scene/${id}/stream`, preview: null, sprite: null, vtt: null },
    sceneStreams: [{ url: `http://stash/scene/${id}/stream.mp4`, mime_type: "video/mp4", label: "MP4" }],
    studio: null,
    performers: [],
    tags: [],
  };
}

const helper = { url: "http://10.0.0.5:9978", token: "t k", prefixes: ["/data/"] };
let mse = true;

beforeAll(() => {
  // jsdom has no Media Source Extensions; this one never opens, which is all the slot logic needs here
  (globalThis as any).MediaSource = class extends EventTarget {
    static isTypeSupported = () => mse;
  };
  URL.createObjectURL = () => "blob:helper-stream";
  URL.revokeObjectURL = () => undefined;
  HTMLMediaElement.prototype.load = () => undefined;
  HTMLMediaElement.prototype.pause = () => undefined;
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
});

afterEach(() => {
  setLocalMedia(null);
  mse = true;
});

describe("pickStream", () => {
  it("streams mapped files from the PC through Media Source Extensions", () => {
    setLocalMedia(helper);
    expect(pickStream(scene("/data/a b.mp4"))).toEqual({
      url: "http://10.0.0.5:9978/v1/stream?k=t%20k&path=%2Fdata%2Fa%20b.mp4&a=1",
      seek: "mse",
      local: true,
      mime: 'video/mp4; codecs="avc1.640029, mp4a.40.2"',
      duration: 60,
    });
    // no audio track: the helper leaves it out, the SourceBuffer must not expect one
    expect(pickStream(scene("/data/silent.mp4", ""))).toMatchObject({ url: expect.stringMatching(/&a=0$/), mime: 'video/mp4; codecs="avc1.640029"' });
  });

  it("keeps Stash for other folders, without a helper and without Media Source Extensions", () => {
    setLocalMedia(helper);
    expect(pickStream(scene("/elsewhere/a.mp4"))!.local).toBeUndefined();
    mse = false;
    expect(pickStream(scene("/data/a.mp4"))!.local).toBeUndefined();
    mse = true;
    setLocalMedia(null);
    expect(pickStream(scene("/data/a.mp4"))!.url).toMatch(/\/scene\/\d+\/stream$/);
  });

  it("bumps the generation only when the source really changes", () => {
    const g = streamGeneration();
    setLocalMedia(helper);
    setLocalMedia({ ...helper });
    expect(streamGeneration()).toBe(g + 1);
  });
});

describe("VideoSlot with the helper", () => {
  it("reports the requested time while loading, falls back to Stash on an error and reloads when the source changes", async () => {
    setLocalMedia(helper);
    const el = document.createElement("video");
    // jsdom tries to load the blob: URL itself and fails – keep that from the slot until the test errors on purpose
    let swallow = true;
    el.addEventListener("error", (e) => swallow && e.stopImmediatePropagation());
    const slot = new VideoSlot(el);
    const sc = scene("/data/x.mp4");
    slot.assign(sc, 5);
    await new Promise((r) => setTimeout(r, 200)); // a stream starts at once or 150 ms after the last one
    expect(el.src).toBe("blob:helper-stream");
    // drift checks see the target, not the empty element – no new stream per frame while loading
    expect(slot.time).toBe(5);
    slot.seek(6.5);
    expect(slot.time).toBe(6.5);
    swallow = false;
    el.dispatchEvent(new Event("error")); // the helper could not deliver it
    swallow = true;
    expect(el.src).toMatch(/\/scene\/\d+\/stream$/);

    const other = scene("/data/y.mp4");
    slot.assign(other, 0);
    await new Promise((r) => setTimeout(r, 200));
    expect(el.src).toBe("blob:helper-stream");
    setLocalMedia(null);
    expect(slot.stale).toBe(true);
    slot.assign(other, 0);
    expect(el.src).toMatch(/\/scene\/\d+\/stream$/);
    expect(slot.stale).toBe(false);
  });
});
