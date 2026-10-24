import type { GeneratorSettings } from "../generator/generate";
import { t } from "../i18n";
import { DEFAULT_EFFECTS, type EffectSettings } from "./effects";
import { uid } from "./ids";
import { type LayoutRange, cleanLayouts } from "./layouts";
import type { LookSettings } from "./look";

/** Mirrors schema/pmv-project.schema.json. Bump together with migrateProject(). */
export const SCHEMA_VERSION = 1;

/** All times are seconds (float). Frame quantisation only happens when exporting/rendering. */
export type Seconds = number;

/** Names match FFmpeg's xfade transitions, so the renderer can pass them through. */
export const TRANSITION_TYPES = [
  "fade",
  "fadeblack",
  "fadewhite",
  "dissolve",
  "wipeleft",
  "wiperight",
  "slideleft",
  "slideright",
  "circleopen",
  "pixelize",
  "zoomin",
  "hblur",
  "radial",
] as const;
export type TransitionType = (typeof TRANSITION_TYPES)[number];

export interface Transition {
  type: TransitionType;
  duration: Seconds;
}

/** cover = crop to the frame, contain = bars, blur = whole picture over a blurred, filled copy of itself. */
export type FitMode = "cover" | "contain" | "blur";

export const VIDEO_CODECS = ["libx264", "libx265", "h264_nvenc", "hevc_nvenc"] as const;
export type VideoCodec = (typeof VIDEO_CODECS)[number];

/** The colour look counts for the whole PMV, like the framing. */
export interface OutputSettings extends LookSettings {
  width: number;
  height: number;
  fps: number;
  fit: FitMode;
  videoCodec: VideoCodec;
  crf: number;
  preset: string;
  audioBitrate: string;
}

export interface AudioTrack {
  name: string;
  /** Path on the Stash server – used by the renderer. */
  path: string | null;
  /** URL (relative to the Stash base URL) for waveform and browser preview. */
  url: string | null;
  /** Length of the audio file. */
  duration: Seconds;
  /** Offset into the file where playback starts. */
  sourceIn: Seconds;
  /** Timeline position of `sourceIn`. */
  start: Seconds;
  gainDb: number;
  fadeIn: Seconds;
  /** Fade-out at the end of the output. */
  fadeOut: Seconds;
}

export interface BeatGrid {
  bpm: number;
  /** Timeline time of any beat – the anchor of the grid. */
  offset: Seconds;
  beatsPerBar: number;
}

/** Snapshot of the Stash file behind a scene: what the renderer needs, no URLs or API keys. */
export interface SourceMedia {
  sceneId: string;
  fileId: string | null;
  path: string;
  title: string;
  duration: Seconds;
  fps: number;
  width: number;
  height: number;
  hasAudio: boolean;
  videoCodec: string | null;
}

/** A culled segment in the bin – raw material for clips. */
export interface Snippet {
  id: string;
  sceneId: string;
  markerId: string | null;
  in: Seconds;
  out: Seconds;
  label: string;
  tags: string[];
}

/** A range of a scene that must never end up in the cut. */
export interface Exclusion {
  id: string;
  sceneId: string;
  markerId: string | null;
  in: Seconds;
  out: Seconds;
}

export interface Clip {
  id: string;
  sceneId: string;
  snippetId: string | null;
  markerId: string | null;
  /** In-point on the timeline. */
  start: Seconds;
  /** Length on the timeline. The source out-point is derived: sourceIn + duration * speed. */
  duration: Seconds;
  sourceIn: Seconds;
  speed: number;
  /** Original clip audio; 0 = music only. */
  volume: number;
  /** Transition into this clip, centred on the cut. */
  transitionIn: Transition | null;
  /** null = output.fit */
  fit: FitMode | null;
  label: string;
  /** Kept by the generator: "generate again" / another variant leave it where it is. */
  pinned?: boolean;
}

/** tracks[0] is the top-most track; where clips overlap, the higher track wins. */
export interface Track {
  id: string;
  name: string;
  muted: boolean;
  locked: boolean;
  clips: Clip[];
}

export interface TimelineMarker {
  id: string;
  time: Seconds;
  label: string;
}

/** Cuts and flashes measured in another PMV ("cuts like another PMV"); times in that video's own time. */
export interface CutTemplate {
  sceneId: string;
  title: string;
  duration: Seconds;
  cuts: Seconds[];
  flashes: Seconds[];
  /** Name of the project music when it is that PMV's own sound (then the cuts follow the music on the timeline). */
  music: string | null;
}

/** How the clips were generated last – lets a single clip be re-rolled later with the same rules. */
export interface GeneratorMemo {
  settings: GeneratorSettings;
  from: Seconds;
  to: Seconds;
}

export interface PmvProject {
  schemaVersion: number;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  output: OutputSettings;
  /** Beat and drop effects of the whole PMV (zoom pulse, RGB split …). */
  effects: EffectSettings;
  audio: AudioTrack | null;
  beatGrid: BeatGrid;
  sources: Record<string, SourceMedia>;
  bin: Snippet[];
  exclusions: Exclusion[];
  tracks: Track[];
  /** Split screens: ranges of the timeline whose fields show the clips of several tracks at once. */
  layouts: LayoutRange[];
  markers: TimelineMarker[];
  /** Last generator run; absent for projects that were never generated. */
  generator?: GeneratorMemo | null;
  /** Another PMV whose cuts the generator can take over. */
  cutTemplate?: CutTemplate | null;
}

export const clipEnd = (c: Clip): Seconds => c.start + c.duration;
export const clipSourceOut = (c: Clip): Seconds => c.sourceIn + c.duration * c.speed;
export const audioEnd = (a: AudioTrack): Seconds => a.start + Math.max(0, a.duration - a.sourceIn);

/** Sequence length: whatever ends last, music or video. */
export function projectDuration(p: PmvProject): Seconds {
  let end = p.audio ? audioEnd(p.audio) : 0;
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, clipEnd(c));
  return end;
}

export const DEFAULT_OUTPUT: OutputSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  fit: "blur",
  videoCodec: "libx264",
  crf: 18,
  preset: "medium",
  audioBitrate: "320k",
  look: "none",
  lookAmount: 1,
  lookColor: "#ff4d94",
  brightness: 0,
};

export function createTrack(name: string): Track {
  return { id: uid("trk"), name, muted: false, locked: false, clips: [] };
}

export function createProject(name = t("New PMV")): PmvProject {
  const now = new Date().toISOString();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: uid("pmv"),
    name,
    createdAt: now,
    updatedAt: now,
    output: { ...DEFAULT_OUTPUT },
    effects: { ...DEFAULT_EFFECTS },
    audio: null,
    beatGrid: { bpm: 120, offset: 0, beatsPerBar: 4 },
    sources: {},
    bin: [],
    exclusions: [],
    tracks: [createTrack("V2"), createTrack("V1")],
    layouts: [],
    markers: [],
  };
}

export function createAudioTrack(name: string, path: string | null, url: string | null, duration: Seconds): AudioTrack {
  return { name, path, url, duration, sourceIn: 0, start: 0, gainDb: 0, fadeIn: 0, fadeOut: 2 };
}

const CLIP_DEFAULTS: Pick<Clip, "snippetId" | "markerId" | "speed" | "volume" | "transitionIn" | "fit" | "label"> = {
  snippetId: null,
  markerId: null,
  speed: 1,
  volume: 0,
  transitionIn: null,
  fit: null,
  label: "",
};

/** Accepts a parsed .pmv.json, fills defaults and rejects files from a newer schema. */
export function migrateProject(raw: unknown): PmvProject {
  if (!raw || typeof raw !== "object") throw new Error(t("Not a valid project file"));
  const r = raw as Partial<PmvProject>;
  const version = typeof r.schemaVersion === "number" ? r.schemaVersion : 0;
  if (version > SCHEMA_VERSION) throw new Error(t("Project schema v{version} is newer than this plugin (v{max})", { version, max: SCHEMA_VERSION }));
  if (!Array.isArray(r.tracks)) throw new Error(t("Project file without tracks"));
  const base = createProject(r.name ?? t("Imported PMV"));
  return {
    ...base,
    ...r,
    schemaVersion: SCHEMA_VERSION,
    id: typeof r.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(r.id) ? r.id : base.id,
    output: { ...DEFAULT_OUTPUT, ...r.output },
    effects: { ...DEFAULT_EFFECTS, ...r.effects },
    audio: r.audio ? { ...createAudioTrack("", null, null, 0), ...r.audio } : null,
    beatGrid: { ...base.beatGrid, ...r.beatGrid },
    sources: r.sources ?? {},
    bin: r.bin ?? [],
    exclusions: r.exclusions ?? [],
    markers: r.markers ?? [],
    layouts: cleanLayouts((Array.isArray(r.layouts) ? r.layouts : []).filter((x) => x && typeof x === "object").map((x) => ({ ...x, id: typeof x.id === "string" && x.id ? x.id : uid("lay") }))),
    tracks: r.tracks.map((t) => ({
      ...createTrack(t.name ?? "V"),
      ...t,
      clips: ((t.clips ?? []) as Array<Partial<Clip>>)
        .map((c) => ({ ...CLIP_DEFAULTS, ...c }) as Clip)
        .sort((a, b) => a.start - b.start),
    })),
  };
}
