/** Adding music: upload or server path, analysis, and the beat grid straight away. Shared by the start panel and the inspector. */
import { useState } from "react";
import { type AudioAnalysis, detectTempo } from "../audio/analysis";
import { t } from "../i18n";
import { createAudioTrack } from "../model/project";
import { type LibrarySong, type MediaResult, importAudio, uploadAudio } from "../stash/backend";
import { useEditor } from "../state/store";
import { getAudioAnalysis } from "./hooks";

/** BPM and the grid offset of a song (from its first two minutes) placed at `start`; null when no tempo is found. */
export function detectSongGrid(a: AudioAnalysis, start: number): { bpm: number; offset: number; confidence: number } | null {
  const sr = a.sampleRate;
  const est = detectTempo(a.mono.subarray(0, Math.min(a.mono.length, 120 * sr)), sr);
  if (!est) return null;
  const b = 60 / est.bpm;
  return { bpm: est.bpm, offset: (((start + est.offset) % b) + b) % b, confidence: est.confidence };
}

export function useMusic() {
  const { state, dispatch, backend } = useEditor();
  const audio = state.present.audio;
  const [status, setStatus] = useState<string | null>(null);

  const adopt = async (name: string, path: string, url: string, probed?: number | null) => {
    setStatus(t("Analysing…"));
    const a = await getAudioAnalysis(url);
    // the render uses the file on the server, so its length (ffprobe) wins when the browser decoded less
    const duration = Math.max(a.duration, probed ?? 0);
    const start = audio?.start ?? 0;
    dispatch({ type: "audio/set", audio: { ...createAudioTrack(name, path, url, duration), ...(audio ? { start: audio.start, gainDb: audio.gainDb, fadeIn: audio.fadeIn, fadeOut: audio.fadeOut } : {}) } });
    const notes: string[] = [];
    // the beat grid is what everything is cut to – detect it right away, the inspector can still correct it
    const est = detectSongGrid(a, start);
    if (est) {
      dispatch({ type: "grid/update", patch: { bpm: est.bpm, offset: est.offset } });
      notes.push(t("{bpm} BPM detected", { bpm: est.bpm }) + (est.confidence < 1.5 ? ` ${t("(uncertain – try ×2/÷2)")}` : ""));
    }
    if (probed && Math.abs(probed - a.duration) > 1) notes.push(t("The browser decoded {a} s of a {b} s file – the timeline uses {b} s; waveform and BPM come from the decoded part.", { a: a.duration.toFixed(1), b: probed.toFixed(1) }));
    setStatus(notes.length ? notes.join(" · ") : null);
  };

  const upload = async (f: File) => {
    try {
      setStatus(t("Upload {pct} %", { pct: 0 }));
      const r = await uploadAudio(f, (p) => setStatus(t("Upload {pct} %", { pct: Math.round(p * 100) })));
      await adopt(r.name, r.path, r.url, r.duration);
    } catch (e) {
      setStatus(t("Error: {error}", { error: String(e) }));
    }
  };
  const usePath = async (serverPath: string) => {
    try {
      setStatus(t("Importing…"));
      const r = await importAudio(serverPath.trim());
      await adopt(r.name, r.path, r.url, r.duration);
    } catch (e) {
      setStatus(t("Error: {error}", { error: String(e) }));
    }
  };
  /** A song from the library (uploaded before) or one the backend made (a PMV's sound) – no upload. */
  const adoptMedia = async (r: Pick<MediaResult, "name" | "path" | "url" | "duration">) => {
    try {
      await adopt(r.name, r.path, r.url, r.duration);
    } catch (e) {
      setStatus(t("Error: {error}", { error: String(e) }));
    }
  };
  const adoptSong = (s: LibrarySong) => adoptMedia({ name: s.name, path: s.path, url: s.url, duration: null });
  const remove = () => dispatch({ type: "audio/set", audio: null });

  return { audio, status, online: backend === "online", upload, usePath, adoptMedia, adoptSong, remove };
}
