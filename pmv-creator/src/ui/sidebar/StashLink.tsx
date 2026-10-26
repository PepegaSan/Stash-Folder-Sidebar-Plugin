/**
 * "↗ Stash": a scene's page in Stash in a new tab – to add a marker found while editing, say. When the
 * editor is in front again (tab switch or window focus) the scene is fetched anew, so the new marker
 * shows up without a reload.
 */
import React from "react";
import { useHost } from "../../host";
import { t } from "../../i18n";
import { refreshScenes } from "../../stash/sceneCache";

const opened = new Set<string>();
let listening = false;

function onReturn(): void {
  if (!opened.size) return;
  const ids = [...opened];
  opened.clear();
  void refreshScenes(ids).catch(() => undefined);
}

/** Remember the scene until the editor is in front again: a tab switch fires visibilitychange, another window focus. */
export function noteOpenedInStash(sceneId: string): void {
  opened.add(sceneId);
  if (listening) return;
  listening = true;
  window.addEventListener("focus", onReturn);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") onReturn();
  });
}

/** `at` = seconds into the scene where Stash's player should start (the scene view passes its spot). */
export function StashLink({ sceneId, at, className = "btn btn-sm btn-secondary" }: { sceneId: string; at?: number; className?: string }) {
  const host = useHost();
  const title =
    at != null
      ? t("The scene's page in Stash in a new tab, at this spot – add a marker there, say; the editor picks the change up when you come back")
      : t("The scene's page in Stash in a new tab – add a marker there, say; the editor picks the change up when you come back");
  return (
    <a
      className={className}
      href={host.sceneHref(sceneId, at)}
      target="_blank"
      rel="noreferrer"
      draggable={false}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        noteOpenedInStash(sceneId);
      }}
    >
      ↗ Stash
    </a>
  );
}
