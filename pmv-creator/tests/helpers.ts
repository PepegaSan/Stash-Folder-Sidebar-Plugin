import { type Clip, type PmvProject, createProject } from "../src/model/project";

let n = 0;

export function clip(sceneId: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip {
  return {
    id: `c${++n}`,
    sceneId,
    snippetId: null,
    markerId: null,
    start,
    duration,
    sourceIn: 10,
    speed: 1,
    volume: 0,
    transitionIn: null,
    fit: null,
    label: "",
    ...extra,
  };
}

/** Two tracks (top, bottom), 30 fps, two 100 s sources. */
export function project(top: Clip[] = [], bottom: Clip[] = []): PmvProject {
  const p = createProject("test");
  p.tracks[0].clips = top;
  p.tracks[1].clips = bottom;
  for (const id of ["1", "2", "3"]) {
    p.sources[id] = { sceneId: id, fileId: null, path: `/media/${id}.mp4`, title: `S${id}`, duration: 100, fps: 30, width: 1920, height: 1080, hasAudio: true, videoCodec: "h264" };
  }
  return p;
}

export function assertTrackInvariants(p: PmvProject): void {
  for (const t of p.tracks) {
    for (let i = 1; i < t.clips.length; i++) {
      const a = t.clips[i - 1];
      const b = t.clips[i];
      if (b.start < a.start) throw new Error(`unsorted track ${t.name}`);
      if (a.start + a.duration > b.start + 1e-6) throw new Error(`overlap on ${t.name}: ${a.id} / ${b.id}`);
    }
    for (const c of t.clips) if (c.duration <= 0 || c.sourceIn < -1e-9) throw new Error(`invalid clip ${c.id}`);
  }
}
