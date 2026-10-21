/** Shapes of the GraphQL fragments in queries.ts (only the fields we request). */

export interface StashRef {
  id: string;
  name: string;
}

export interface StashVideoFile {
  id: string;
  path: string;
  basename: string;
  duration: number;
  width: number;
  height: number;
  frame_rate: number;
  video_codec: string;
  audio_codec: string;
}

export interface StashSceneCore {
  id: string;
  title: string | null;
  date: string | null;
  rating100: number | null;
  files: StashVideoFile[];
  paths: {
    screenshot: string | null;
    stream: string | null;
    preview: string | null;
    sprite: string | null;
    vtt: string | null;
  };
  sceneStreams: Array<{ url: string; mime_type: string | null; label: string | null }>;
  studio: StashRef | null;
  performers: StashRef[];
  tags: StashRef[];
}

export interface StashMarker {
  id: string;
  title: string;
  seconds: number;
  /** Stash >= 0.28; undefined/null on older servers or point markers. */
  end_seconds?: number | null;
  primary_tag: StashRef;
  tags: StashRef[];
  screenshot: string | null;
  preview: string | null;
  stream: string | null;
}

export interface StashScene extends StashSceneCore {
  scene_markers: StashMarker[];
}

export interface StashMarkerWithScene extends StashMarker {
  scene: StashSceneCore;
}

export function sceneTitle(s: StashSceneCore): string {
  return s.title || s.files[0]?.basename || `Szene ${s.id}`;
}

export function markerLabel(m: StashMarker): string {
  return m.title || m.primary_tag?.name || "Marker";
}
