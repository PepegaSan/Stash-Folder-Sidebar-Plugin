/**
 * CMX3600 EDL (single video track = the flattened sequence, plus the music as audio event).
 * Speed changes become M2 lines, transitions become dissolves (other xfade types are noted in comments).
 * A split screen keeps the clip of its first field (V1) and is noted in a comment.
 * Record timecode starts at 01:00:00:00 like DaVinci Resolve's default timeline.
 */
import type { PmvProject } from "../model/project";
import { flattenTimeline, resolveTransitions, sourceTimeAt } from "../timeline/flatten";
import { toFrame } from "../timeline/time";

export function toTimecode(frames: number, fps: number): string {
  const nominal = Math.round(fps);
  const f = Math.max(0, Math.round(frames));
  const ff = f % nominal;
  const totalSec = Math.floor(f / nominal);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(totalSec / 3600))}:${pad(Math.floor(totalSec / 60) % 60)}:${pad(totalSec % 60)}:${pad(ff)}`;
}

const basename = (path: string) => path.split(/[\\/]/).pop() ?? path;

export function buildEdl(p: PmvProject): string {
  const fps = p.output.fps;
  const recOffset = 3600 * Math.round(fps);
  const segs = flattenTimeline(p);
  const trans = resolveTransitions(p, segs);
  const tc = (f: number) => toTimecode(f, fps);
  const lines: string[] = [`TITLE: ${p.name.replace(/[\r\n]/g, " ").slice(0, 70)}`, "FCM: NON-DROP FRAME", ""];
  let n = 0;
  const num = () => String(++n).padStart(3, "0");

  segs.forEach((part, i) => {
    const g0 = part.layout?.groups[0] ?? null;
    const seg = part.layout ? (g0 ? { ...part, clip: g0.clip, clipStartFrame: g0.clipStartFrame } : null) : part;
    const c = seg?.clip;
    if (!seg || !c) return;
    const src = p.sources[c.sceneId];
    const t = trans[i];
    // With a transition the edit point moves to the start of the (centred) dissolve.
    const recIn = seg.startFrame - (t?.before ?? 0);
    const nextT = trans[i + 1];
    const recOut = seg.endFrame - (nextT?.before ?? 0);
    const srcIn = toFrame(sourceTimeAt(seg, recIn, fps), fps);
    const srcOut = srcIn + Math.round((recOut - recIn) * c.speed);
    const id = num();
    const reel = "AX      ";

    if (t) {
      const prev = segs[i - 1];
      const fromReel = prev?.clip ? reel : "BL      ";
      const aOut = prev?.clip ? toFrame(sourceTimeAt(prev, recIn, fps), fps) : 0;
      lines.push(`${id}  ${fromReel} V     C        ${tc(aOut)} ${tc(aOut)} ${tc(recOffset + recIn)} ${tc(recOffset + recIn)}`);
      const dur = String(t.before + t.after).padStart(3, "0");
      lines.push(`${id}  ${reel} V     D    ${dur} ${tc(srcIn)} ${tc(srcOut)} ${tc(recOffset + recIn)} ${tc(recOffset + recOut)}`);
      if (t.type !== "fade" && t.type !== "dissolve") lines.push(`* PMV TRANSITION: ${t.type}`);
    } else {
      lines.push(`${id}  ${reel} V     C        ${tc(srcIn)} ${tc(srcOut)} ${tc(recOffset + recIn)} ${tc(recOffset + recOut)}`);
    }
    if (Math.abs(c.speed - 1) > 1e-6) {
      lines.push(`M2   AX       ${(fps * c.speed).toFixed(1).padStart(5, "0")}                ${tc(srcIn)}`);
    }
    if (src) {
      lines.push(`* FROM CLIP NAME: ${basename(src.path)}`);
      lines.push(`* SOURCE FILE: ${src.path}`);
    }
    lines.push(`* PMV SCENE: ${c.sceneId}${c.markerId ? ` MARKER: ${c.markerId}` : ""}`);
    if (part.layout) lines.push(`* PMV SPLIT SCREEN: ${part.layout.kind} (${part.layout.dir}) – only its first field here`);
    lines.push("");
  });

  if (p.audio) {
    const a = p.audio;
    const total = segs.length ? segs[segs.length - 1].endFrame : 0;
    const recIn = toFrame(a.start, fps);
    const recOut = Math.min(total, toFrame(a.start + a.duration - a.sourceIn, fps));
    if (recOut > recIn) {
      const srcIn = toFrame(a.sourceIn, fps);
      lines.push(`${num()}  AX       AA    C        ${tc(srcIn)} ${tc(srcIn + recOut - recIn)} ${tc(recOffset + recIn)} ${tc(recOffset + recOut)}`);
      lines.push(`* FROM CLIP NAME: ${a.name || (a.path ? basename(a.path) : "music")}`);
      if (a.path) lines.push(`* SOURCE FILE: ${a.path}`);
      lines.push("");
    }
  }
  return lines.join("\r\n");
}
