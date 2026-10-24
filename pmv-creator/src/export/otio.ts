/**
 * OpenTimelineIO (.otio JSON). Unlike the EDL this keeps the real track layout (V1…Vn + music),
 * so DaVinci Resolve / Premiere (via adapters) get the editable multi-track timeline.
 *
 * Conventions: rate = output fps, values in frames. A clip's source_range.duration is its length in
 * the track; speed is expressed as LinearTimeWarp (OTIO effects do not change the track duration).
 */
import { LAYOUT_INFO, cleanLayouts } from "../model/layouts";
import type { PmvProject, Track } from "../model/project";
import { clipEnd } from "../model/project";
import { toFrame } from "../timeline/time";

type Json = Record<string, unknown>;

const rt = (value: number, rate: number): Json => ({ OTIO_SCHEMA: "RationalTime.1", rate, value });
const tr = (start: number, duration: number, rate: number): Json => ({
  OTIO_SCHEMA: "TimeRange.1",
  start_time: rt(start, rate),
  duration: rt(duration, rate),
});

export function fileUrl(path: string): string {
  const p = path.replace(/\\/g, "/");
  const withRoot = /^[A-Za-z]:\//.test(p) ? `/${p}` : p;
  return `file://${encodeURI(withRoot).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

const gap = (frames: number, rate: number): Json => ({
  OTIO_SCHEMA: "Gap.1",
  name: "",
  source_range: tr(0, frames, rate),
  effects: [],
  markers: [],
  metadata: {},
});

function videoTrack(p: PmvProject, track: Track): Json {
  const rate = p.output.fps;
  const children: Json[] = [];
  let cursor = 0;
  let prevFrames = 0;
  for (const c of track.clips) {
    const s = toFrame(c.start, rate);
    const e = toFrame(clipEnd(c), rate);
    if (e <= s) continue;
    if (s > cursor) {
      children.push(gap(s - cursor, rate));
      prevFrames = s - cursor;
    }
    const frames = e - Math.max(s, cursor);
    if (c.transitionIn && prevFrames > 0) {
      const d = toFrame(c.transitionIn.duration, rate);
      const before = Math.min(Math.floor(d / 2), Math.floor(prevFrames / 2));
      const after = Math.min(d - Math.floor(d / 2), Math.floor(frames / 2));
      if (before + after > 0) {
        children.push({
          OTIO_SCHEMA: "Transition.1",
          name: c.transitionIn.type,
          transition_type: "SMPTE_Dissolve",
          in_offset: rt(before, rate),
          out_offset: rt(after, rate),
          metadata: { pmv: { type: c.transitionIn.type } },
        });
      }
    }
    const src = p.sources[c.sceneId];
    children.push({
      OTIO_SCHEMA: "Clip.1",
      name: c.label || src?.title || `Scene ${c.sceneId}`,
      source_range: tr(c.sourceIn * rate, frames, rate),
      media_reference: src
        ? {
            OTIO_SCHEMA: "ExternalReference.1",
            name: src.title,
            target_url: fileUrl(src.path),
            available_range: src.duration > 0 ? tr(0, Math.round(src.duration * rate), rate) : null,
            metadata: {},
          }
        : { OTIO_SCHEMA: "MissingReference.1", name: "", available_range: null, metadata: {} },
      effects:
        Math.abs(c.speed - 1) > 1e-6 ? [{ OTIO_SCHEMA: "LinearTimeWarp.1", name: "speed", effect_name: "LinearTimeWarp", time_scalar: c.speed, metadata: {} }] : [],
      markers: [],
      metadata: { pmv: { clipId: c.id, sceneId: c.sceneId, markerId: c.markerId, sourceIn: c.sourceIn, speed: c.speed, volume: c.volume } },
    });
    cursor = e;
    prevFrames = frames;
  }
  return { OTIO_SCHEMA: "Track.1", name: track.name, kind: "Video", enabled: !track.muted, source_range: null, children, effects: [], markers: [], metadata: {} };
}

export function buildOtio(p: PmvProject): Json {
  const rate = p.output.fps;
  // OTIO stacks are bottom-to-top; our tracks[0] is the top track.
  const children: Json[] = [...p.tracks].reverse().map((t) => videoTrack(p, t));

  if (p.audio) {
    const a = p.audio;
    const start = toFrame(a.start, rate);
    const frames = toFrame(a.duration - a.sourceIn, rate);
    const items: Json[] = [];
    if (start > 0) items.push(gap(start, rate));
    items.push({
      OTIO_SCHEMA: "Clip.1",
      name: a.name || "Musik",
      source_range: tr(toFrame(a.sourceIn, rate), frames, rate),
      media_reference: a.path
        ? { OTIO_SCHEMA: "ExternalReference.1", name: a.name, target_url: fileUrl(a.path), available_range: tr(0, toFrame(a.duration, rate), rate), metadata: {} }
        : { OTIO_SCHEMA: "MissingReference.1", name: a.name, available_range: null, metadata: {} },
      effects: [],
      markers: [],
      metadata: { pmv: { gainDb: a.gainDb, fadeIn: a.fadeIn, fadeOut: a.fadeOut } },
    });
    children.push({ OTIO_SCHEMA: "Track.1", name: "Musik", kind: "Audio", enabled: true, source_range: null, children: items, effects: [], markers: [], metadata: {} });
  }

  return {
    OTIO_SCHEMA: "Timeline.1",
    name: p.name,
    global_start_time: null,
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      source_range: null,
      children,
      effects: [],
      markers: [
        ...p.markers.map((m) => ({ OTIO_SCHEMA: "Marker.2", name: m.label, color: "RED", marked_range: tr(toFrame(m.time, rate), 0, rate), comment: "", metadata: {} })),
        // split screens have no OTIO equivalent: a marker over each range says where they were and which tracks fill it
        ...cleanLayouts(p.layouts).map((r) => {
          const s = toFrame(r.start, rate);
          return {
            OTIO_SCHEMA: "Marker.2",
            name: `Split screen: ${r.kind} (${r.dir})`,
            color: "PINK",
            marked_range: tr(s, toFrame(r.start + r.duration, rate) - s, rate),
            comment: `Fields from V1…V${LAYOUT_INFO[r.kind].groups} (bottom track first)`,
            metadata: { pmv: { layout: r } },
          };
        }),
      ],
      metadata: {},
    },
    metadata: { pmv: { projectId: p.id, bpm: p.beatGrid.bpm, beatOffset: p.beatGrid.offset } },
  };
}
