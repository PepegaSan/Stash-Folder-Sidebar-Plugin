/** Adding music: upload or server path, analysis, and the beat grid straight away. Shared by the start panel and the inspector. */
import { useState } from "react";
import { detectTempo } from "../audio/analysis";
import { t } from "../i18n";
import { createAudioTrack } from "../model/project";
import { importAudio, uploadAudio } from "../stash/backend";
import { useEditor } from "../state/store";
import { getAudioAnalysis } from "./hooks";

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
    const sr = a.sampleRate;
    const est = detectTempo(a.mono.subarray(0, Math.min(a.mono.length, 120 * sr)), sr);
    if (est) {
      const b = 60 / est.bpm;
      dispatch({ type: "grid/update", patch: { bpm: est.bpm, offset: (((start + est.offset) % b) + b) % b } });
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
  const remove = () => dispatch({ type: "audio/set", audio: null });

  return { audio, status, online: backend === "online", upload, usePath, remove };
}
