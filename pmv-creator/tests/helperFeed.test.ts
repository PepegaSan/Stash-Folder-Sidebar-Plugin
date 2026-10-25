// @vitest-environment jsdom
/**
 * Helper streams (Media Source Extensions) in a VideoSlot, against a fake MediaSource and fetch: the stream URL says how
 * far the clip needs it, a "busy" helper is asked again instead of the scene falling back to Stash, and an idle player
 * gives up its connection but keeps its buffer – a seek inside it costs nothing, one beyond it opens a new stream.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoSlot, pickStream, setLocalMedia } from "../src/stash/streams";
import type { StashScene } from "../src/stash/types";

type Ranges = Array<[number, number]>;
const timeRanges = (r: Ranges) => ({ length: r.length, start: (i: number) => r[i][0], end: (i: number) => r[i][1] });

class FakeSourceBuffer extends EventTarget {
  updating = false;
  timestampOffset = 0;
  appended = 0;
  ranges: Ranges = [];
  get buffered() {
    return timeRanges(this.ranges);
  }
  private update(): void {
    this.updating = true;
    queueMicrotask(() => {
      this.updating = false;
      this.dispatchEvent(new Event("updateend"));
    });
  }
  appendBuffer(): void {
    this.appended++;
    this.update();
  }
  remove(): void {
    this.update();
  }
}

class FakeMediaSource extends EventTarget {
  static last: FakeMediaSource | null = null;
  static isTypeSupported(): boolean {
    return true;
  }
  readyState = "open";
  duration = NaN;
  sb = new FakeSourceBuffer();
  constructor() {
    super();
    FakeMediaSource.last = this;
  }
  addSourceBuffer(): FakeSourceBuffer {
    return this.sb;
  }
  endOfStream(): void {
    this.readyState = "ended";
  }
}

interface Media {
  readyState: number;
  seeking: boolean;
  currentTime: number;
  ranges: Ranges;
  paused: boolean;
  src: string;
}
type FakeVideo = HTMLVideoElement & { m: Media };

function fakeVideo(): FakeVideo {
  const el = document.createElement("video") as FakeVideo;
  const m: Media = { readyState: 0, seeking: false, currentTime: 0, ranges: [], paused: true, src: "" };
  const prop = (name: string, get: () => unknown, set?: (v: never) => void) => Object.defineProperty(el, name, { configurable: true, get, set });
  prop("readyState", () => m.readyState);
  prop("seeking", () => m.seeking);
  prop("paused", () => m.paused);
  prop("buffered", () => timeRanges(m.ranges));
  prop("currentTime", () => m.currentTime, (v: number) => void (m.currentTime = v));
  // a blob: source opens its MediaSource at once
  prop("src", () => m.src, (v: string) => {
    m.src = v;
    if (v.startsWith("blob:")) FakeMediaSource.last?.dispatchEvent(new Event("sourceopen"));
  });
  el.play = () => {
    m.paused = false;
    return Promise.resolve();
  };
  el.pause = () => void (m.paused = true);
  const removeAttribute = el.removeAttribute.bind(el);
  el.removeAttribute = (name: string) => {
    if (name === "src") m.src = "";
    removeAttribute(name);
  };
  el.load = () => undefined;
  el.m = m;
  return el;
}

function scene(id: string): StashScene {
  return {
    id,
    title: null,
    date: null,
    rating100: null,
    files: [{ id: `f${id}`, path: `/media/${id}.mp4`, basename: `${id}.mp4`, duration: 100, width: 1920, height: 1080, frame_rate: 30, video_codec: "h264", audio_codec: "aac" }],
    paths: { screenshot: null, stream: `/scene/${id}/stream`, preview: null, sprite: null, vtt: null },
    sceneStreams: [],
    studio: null,
    performers: [],
    tags: [],
    scene_markers: [],
  };
}

/** A fetch answering `statuses` in turn (the last one from then on); a 200 body yields one chunk, then ends or stays open. */
function fakeFetch(statuses: number[], ends: boolean) {
  const urls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    urls.push(url);
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
    if (status !== 200) return { ok: false, status } as Response;
    let n = 0;
    const read = () => {
      if (n++ === 0) return Promise.resolve({ done: false, value: new Uint8Array(8) });
      return ends ? Promise.resolve({ done: true, value: undefined }) : new Promise<never>(() => undefined);
    };
    return { ok: true, status: 200, body: { getReader: () => ({ read }) } } as unknown as Response;
  });
  return { fetch, urls };
}

beforeAll(() => {
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("probably");
  Object.assign(URL, { createObjectURL: () => "blob:test", revokeObjectURL: () => undefined });
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("MediaSource", FakeMediaSource);
  setLocalMedia({ url: "http://pc:9979", token: "t0k", prefixes: ["/media/"] });
});

afterEach(() => {
  setLocalMedia(null);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("helper streams", () => {
  it("asks for the stream up to where the clip needs it, and again while the helper is busy", async () => {
    const { fetch, urls } = fakeFetch([503, 503, 200], true);
    vi.stubGlobal("fetch", fetch);
    const el = fakeVideo();
    const slot = new VideoSlot(el);
    const s = scene("1");
    expect(pickStream(s)?.seek).toBe("mse");
    slot.assign(s, 10, 14);
    expect(slot.streaming).toBe(true);
    expect(slot.busy).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(urls[0]).toContain("start=10.000");
    expect(urls[0]).toContain("end=14.000");
    // 503 "busy": asked again after a moment, twice – no fallback to Stash
    await vi.advanceTimersByTimeAsync(400);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(400);
    expect(fetch).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10);
    const ms = FakeMediaSource.last!;
    expect(ms.sb.appended).toBe(1);
    expect(ms.sb.timestampOffset).toBe(10);
    expect(el.m.currentTime).toBe(10);
    expect(ms.readyState).toBe("ended");
    expect(slot.busy).toBe(false);
    expect(slot.streaming).toBe(false);
    expect(pickStream(s)?.seek).toBe("mse");
  });

  it("an idle player gives up its connection but keeps its buffer", async () => {
    const { fetch, urls } = fakeFetch([200], false);
    vi.stubGlobal("fetch", fetch);
    const el = fakeVideo();
    const slot = new VideoSlot(el);
    slot.assign(scene("2"), 20);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(slot.streaming).toBe(true);
    // 20 s buffered and the stream still coming: a seek just past the end waits for it
    el.m.ranges = [[20, 40]];
    slot.seek(40.5);
    expect(el.m.currentTime).toBe(40.5);
    expect(fetch).toHaveBeenCalledTimes(1);
    // idle: the connection goes, the buffer stays usable
    slot.suspend();
    expect(slot.streaming).toBe(false);
    expect(slot.stale).toBe(false);
    slot.seek(30);
    expect(el.m.currentTime).toBe(30);
    expect(fetch).toHaveBeenCalledTimes(1);
    // beyond what is buffered nothing more comes: a new stream
    slot.seek(40.5, false, 45);
    await vi.advanceTimersByTimeAsync(200);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(urls[1]).toContain("start=40.500");
    expect(urls[1]).toContain("end=45.000");
    expect(slot.streaming).toBe(true);
  });

  it("a file from Stash is let go when idle – only a new source makes the browser close its connection", () => {
    setLocalMedia(null);
    const el = fakeVideo();
    const slot = new VideoSlot(el);
    const s = scene("3");
    expect(pickStream(s)?.seek).toBe("native");
    slot.assign(s, 5);
    expect(el.m.src).toContain("/scene/3/stream");
    slot.suspend();
    expect(slot.sceneId).toBeNull();
    expect(slot.hasPicture).toBe(false);
    expect(el.m.src).toBe("");
    // asked for again: the file is opened once more at the new spot
    slot.assign(s, 6);
    expect(el.m.src).toContain("/scene/3/stream");
    expect(el.m.currentTime).toBe(6);
  });
});
