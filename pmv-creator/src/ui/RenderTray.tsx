/** ⏳ / ✓ in the toolbar: every render on its way or done lately – progress, "Open in Stash", cancel. */
import React, { useEffect, useRef, useState } from "react";
import { useHost } from "../host";
import { t } from "../i18n";
import { stopJob } from "../stash/backend";
import { openProject, useEditor } from "../state/store";
import { useClickOutside } from "./hooks";
import { type WatchedRender, configureRenders, forgetFinished, isActive, listRenders, markSeen, subscribeRenders } from "./renders";

export function useRenders(): WatchedRender[] {
  const [list, setList] = useState(listRenders);
  useEffect(() => {
    setList(listRenders());
    return subscribeRenders(() => setList(listRenders()));
  }, []);
  return list;
}

const pct = (r: WatchedRender) => `${Math.round(r.progress * 100)} %`;
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

function stateText(r: WatchedRender): string {
  switch (r.state) {
    case "queued":
      return t("waiting in Stash's task queue");
    case "running":
      return r.pc && !r.progress ? t("waiting for {pc}…", { pc: r.pc }) : r.pc ? t("{pct} on {pc}", { pct: pct(r), pc: r.pc }) : pct(r);
    case "done": {
      const file = r.file ? baseName(r.file) : "";
      if (!r.result?.scanned) return file;
      if (r.sceneId) return `${file} · ${r.label ? t("labeled in Stash") : t("in Stash")}`;
      return `${file} · ${t("waiting for Stash's scan…")}`;
    }
    case "error":
      return r.error ?? t("failed");
    case "cancelled":
      return t("Cancelled.");
  }
}

const ICON: Record<WatchedRender["state"], string> = { queued: "⏸", running: "⏳", done: "✓", error: "⚠", cancelled: "✕" };

export function RenderTray() {
  const list = useRenders();
  const host = useHost();
  const { state, dispatch, backend } = useEditor();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));
  // a click on a desktop notification opens this list
  useEffect(() => configureRenders({ sceneHref: host.sceneHref, openList: () => setOpen(true) }), [host]);
  useEffect(() => {
    if (open) markSeen();
  }, [open, list]);
  if (!list.length) return null;

  const active = list.filter(isActive);
  const fresh = list.filter((r) => !isActive(r) && !r.seen && r.state !== "cancelled");
  const running = active.find((r) => r.state === "running");
  const failed = fresh.filter((r) => r.state === "error").length;
  const label = active.length
    ? `⏳ ${running ? pct(running) : "…"}${active.length > 1 ? ` · ${active.length}` : ""}`
    : failed
      ? `⚠ ${failed}`
      : fresh.length
        ? `✓ ${fresh.length}`
        : "🎬";
  const title = active.length
    ? t("{n} renders on their way – click for the list", { n: active.length })
    : fresh.length
      ? t("Renders finished – click for the list")
      : t("Recent renders");

  return (
    <div className="pmv-menu is-right" ref={ref}>
      <button className={`btn btn-sm ${fresh.length && !active.length ? (failed ? "btn-danger" : "btn-success") : "btn-secondary"}`} title={title} onClick={() => setOpen(!open)}>
        {label}
      </button>
      {open && (
        <div className="pmv-menu-pop pmv-renders">
          {list.map((r) => (
            <div key={r.renderId} className={`pmv-render-item is-${r.state}`}>
              <div className="pmv-li-main">
                <div className="pmv-li-title" title={r.name}>
                  {ICON[r.state]} {r.name}
                </div>
                <div className={r.state === "error" ? "pmv-error" : "pmv-li-meta"} title={r.file}>
                  {stateText(r)} · {new Date(r.finished ?? r.started).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </div>
                {r.state === "running" && (
                  <div className="pmv-progress is-thin">
                    <div style={{ width: pct(r) }} />
                  </div>
                )}
              </div>
              <div className="pmv-li-actions">
                {r.state === "done" && r.sceneId && (
                  <a className="btn btn-sm btn-link" href={host.sceneHref(r.sceneId)} target="_blank" rel="noreferrer" title={t("Open in Stash")}>
                    ↗
                  </a>
                )}
                {r.projectId !== state.present.id && (
                  <button
                    className="btn btn-sm btn-link"
                    title={t("Open its project in the editor")}
                    onClick={() =>
                      void openProject(r.projectId, backend === "online").then(
                        (project) => (dispatch({ type: "project/load", project }), setOpen(false)),
                        (e) => window.alert(String(e)),
                      )
                    }
                  >
                    ✎
                  </button>
                )}
                {isActive(r) ? (
                  <button className="btn btn-sm btn-link" title={t("Cancel")} onClick={() => void stopJob(r.jobId)}>
                    ■
                  </button>
                ) : (
                  <button className="btn btn-sm btn-link" title={t("Remove from the list")} onClick={() => forgetFinished(r.renderId)}>
                    ✕
                  </button>
                )}
              </div>
            </div>
          ))}
          {list.some((r) => !isActive(r)) && (
            <button className="pmv-menu-item" onClick={() => forgetFinished()}>
              {t("Clear the finished ones")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
