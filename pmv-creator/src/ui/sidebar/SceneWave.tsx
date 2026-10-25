/** The sound of the open scene under the scrub bar, and the button that asks for it. */
import React, { useEffect, useRef } from "react";
import { t } from "../../i18n";
import type { SourceMedia } from "../../model/project";
import { peakLevel, requestPeaks, usePeaks } from "../peaks";

/** “Load waveform” until the peaks are there (then the bar shows them); says so when the scene has no sound. */
export function WaveButton({ sceneId, source, online }: { sceneId: string; source: SourceMedia | null; online: boolean }) {
  const p = usePeaks(sceneId);
  if (p.status === "ready") return null;
  if (p.status === "queued" || p.status === "loading") return <span className="pmv-li-meta">〰 {t("Waveform: loading…")}</span>;
  if (p.status === "none" || (source && !source.hasAudio)) return <span className="pmv-li-meta">〰 {t("Waveform: no sound track")}</span>;
  return (
    <>
      <button
        className="btn btn-sm btn-secondary"
        disabled={!online || !source}
        title={t("Shows the sound of this scene under the bar – worked out once on the server (it reads the whole file), then kept")}
        onClick={() => source && requestPeaks(sceneId, source.path)}
      >
        〰 {t("Load waveform")}
      </button>
      {p.status === "error" && <span className="pmv-error">{t("Waveform: {error}", { error: p.error ?? "?" })}</span>}
    </>
  );
}

/** The whole file's peaks across the scrub bar (behind markers, ranges and the playhead). */
export function ScrubWave({ sceneId, duration }: { sceneId: string; duration: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const p = usePeaks(sceneId);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const draw = () => {
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      const g = canvas.getContext("2d");
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      if (!p.peaks || duration <= 0) return;
      g.fillStyle = getComputedStyle(canvas).getPropertyValue("--pmv-clip-wave").trim() || "rgba(79, 179, 169, 0.8)";
      const mid = h / 2;
      for (let x = 0; x < w; x++) {
        const v = peakLevel(p, (x / w) * duration, ((x + 1) / w) * duration) * (h - 4);
        if (v >= 0.5) g.fillRect(x, mid - v / 2, 1, v);
      }
    };
    draw();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(draw) : null;
    ro?.observe(canvas);
    return () => ro?.disconnect();
  }, [p, duration]);
  if (!p.peaks) return null;
  return <canvas ref={ref} className="pmv-scrub-wave" />;
}
