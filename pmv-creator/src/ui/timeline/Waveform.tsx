import React, { useEffect, useRef } from "react";
import type { AudioAnalysis } from "../../audio/analysis";
import type { AudioTrack } from "../../model/project";

/** Draws only the visible window (canvas sits at the scroll position), so any zoom level works. */
export function Waveform({ audio, analysis, zoom, left, width, height }: { audio: AudioTrack; analysis: AudioAnalysis | null; zoom: number; left: number; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(width * dpr));
    canvas.height = Math.floor(height * dpr);
    const g = canvas.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    if (!analysis) return;
    const style = getComputedStyle(canvas);
    g.fillStyle = style.getPropertyValue("--pmv-wave").trim() || "#4fb3a9";
    const mid = height / 2;
    const { peaks, peaksPerSecond } = analysis;
    for (let x = 0; x < width; x++) {
      const t0 = (left + x) / zoom;
      const t1 = (left + x + 1) / zoom;
      // timeline -> file time
      const f0 = t0 - audio.start + audio.sourceIn;
      const f1 = t1 - audio.start + audio.sourceIn;
      if (t0 < audio.start || f0 >= audio.duration) continue;
      const i0 = Math.max(0, Math.floor(f0 * peaksPerSecond));
      const i1 = Math.min(peaks.length, Math.max(i0 + 1, Math.ceil(f1 * peaksPerSecond)));
      let m = 0;
      for (let i = i0; i < i1; i++) if (peaks[i] > m) m = peaks[i];
      const h = Math.max(1, m * (height - 4));
      g.fillRect(x, mid - h / 2, 1, h);
    }
  }, [audio, analysis, zoom, left, width, height]);
  return <canvas ref={ref} className="pmv-wave" style={{ left, width, height }} />;
}
