/**
 * The sound of a track's clips in a band of its own at the bottom of each clip (the lane is taller while the
 * waveforms are on) – one canvas per lane for the visible window only, so a 40-minute scene costs no more than
 * a 2-second clip. Peaks of the scenes in view are asked for as they come into view (the store loads two at a
 * time and keeps them).
 */
import React, { useEffect, useRef } from "react";
import { type Clip, type SourceMedia, clipEnd } from "../../model/project";
import { peakLevel, peaksOf, requestPeaks, usePeaksVersion } from "../peaks";

export function ClipWaves({ clips, sources, zoom, left, width, height, band }: { clips: Clip[]; sources: Record<string, SourceMedia>; zoom: number; left: number; width: number; height: number; band: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const version = usePeaksVersion();
  const t0 = left / zoom;
  const t1 = (left + width) / zoom;

  // what is in view gets asked for (the store ignores scenes that are there or on their way)
  useEffect(() => {
    for (const c of clips) {
      if (clipEnd(c) < t0 || c.start > t1) continue;
      const src = sources[c.sceneId];
      if (src?.path && src.hasAudio) requestPeaks(c.sceneId, src.path);
    }
  }, [clips, sources, t0, t1]);

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
    const style = getComputedStyle(canvas);
    g.fillStyle = style.getPropertyValue("--pmv-clip-wave").trim() || "rgba(79, 179, 169, 0.8)";
    // the clip box ends 4 px above the lane's bottom; the band is its lowest `band` px, the wave mirrored around the middle
    const mid = height - 4 - band / 2;
    const amp = Math.max(1, (band - 6) / 2);
    for (const c of clips) {
      const p = peaksOf(c.sceneId);
      if (!p.peaks) continue;
      const x0 = Math.max(0, Math.floor(c.start * zoom - left) + 1);
      const x1 = Math.min(width, Math.ceil(clipEnd(c) * zoom - left) - 1);
      for (let x = x0; x < x1; x++) {
        // pixel column -> timeline time -> source time (speed stretches the file along the clip)
        const s0 = c.sourceIn + ((left + x) / zoom - c.start) * c.speed;
        const s1 = c.sourceIn + ((left + x + 1) / zoom - c.start) * c.speed;
        const h = Math.max(0.5, peakLevel(p, s0, s1) * amp);
        g.fillRect(x, mid - h, 1, 2 * h);
      }
    }
  }, [clips, zoom, left, width, height, band, version]);

  return <canvas ref={ref} className="pmv-clip-waves" style={{ left, width, height }} />;
}
