import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useHost } from "../host";
import { t } from "../i18n";
import { type PmvProject, createProject, migrateProject, projectDuration } from "../model/project";
import { loadProject, ping, saveProject } from "../stash/backend";
import { type Action, type EditorState, editorReducer, initialEditorState } from "./reducer";
import { Transport } from "./transport";

export type BackendState = "checking" | "online" | "offline";

interface EditorContextValue {
  state: EditorState;
  dispatch: React.Dispatch<Action>;
  transport: Transport;
  backend: BackendState;
  ffmpegAvailable: boolean;
}

const EditorContext = createContext<EditorContextValue | null>(null);

export function useEditor(): EditorContextValue {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error("useEditor outside EditorProvider");
  return ctx;
}

// localStorage is only a per-browser safety net; the backend file is the source of truth.
const LS_LAST = "pmv-creator:last-project";
const lsKey = (id: string) => `pmv-creator:project:${id}`;

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* quota / private mode */
  }
}

export function rememberProject(p: PmvProject): void {
  lsSet(LS_LAST, p.id);
  lsSet(lsKey(p.id), JSON.stringify(p));
}

export async function openProject(id: string, online: boolean): Promise<PmvProject> {
  if (online) {
    try {
      const raw = await loadProject(id);
      if (raw) return migrateProject(raw);
    } catch {
      /* fall back to the browser copy */
    }
  }
  const local = lsGet(lsKey(id));
  if (!local) throw new Error(t("Project {id} not found", { id }));
  return migrateProject(JSON.parse(local));
}

const reducer = (s: EditorState, a: Action) => editorReducer(s, a);

export function EditorProvider({ children }: { children: React.ReactNode }) {
  const host = useHost();
  const [state, dispatch] = useReducer(reducer, undefined, () => initialEditorState(createProject()));
  const transport = useMemo(() => new Transport(), []);
  const [backend, setBackend] = useState<BackendState>("checking");
  const [ffmpegAvailable, setFfmpeg] = useState(false);
  const [loading, setLoading] = useState(true);
  const savedRef = useRef<PmvProject | null>(null);

  useEffect(() => () => transport.dispose(), [transport]);

  // Initial load: ?project=<id> -> last opened -> new project.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let online = false;
      try {
        const info = await ping();
        online = true;
        setFfmpeg(!!info.ffmpeg);
      } catch {
        /* backend missing (no python?) – editor still works, saving falls back to the browser */
      }
      if (cancelled) return;
      setBackend(online ? "online" : "offline");
      const id = host.query.get("project") ?? lsGet(LS_LAST);
      let project: PmvProject | null = null;
      if (id) {
        try {
          project = await openProject(id, online);
        } catch {
          /* start fresh */
        }
      }
      if (!project) {
        // persist the fresh project right away: its id goes into the URL, so a reload must find it
        project = createProject();
        const stamped = { ...project, updatedAt: new Date().toISOString() };
        rememberProject(stamped);
        if (online) await saveProject(stamped).catch(() => undefined);
      }
      if (cancelled) return;
      savedRef.current = project;
      dispatch({ type: "project/load", project });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const project = state.present;
  useEffect(() => {
    transport.duration = projectDuration(project);
    transport.setAudio(project.audio);
  }, [transport, project]);

  // Debounced autosave whenever the project object changes (edits, undo, redo).
  useEffect(() => {
    if (loading) return;
    if (savedRef.current === null) savedRef.current = project;
    if (savedRef.current === project) return;
    dispatch({ type: "ui", patch: { saveState: "dirty" } });
    const handle = window.setTimeout(async () => {
      const stamped = { ...project, updatedAt: new Date().toISOString() };
      rememberProject(stamped);
      if (backend !== "online") {
        savedRef.current = project;
        dispatch({ type: "ui", patch: { saveState: "saved" } });
        return;
      }
      dispatch({ type: "ui", patch: { saveState: "saving" } });
      try {
        await saveProject(stamped);
        savedRef.current = project;
        dispatch({ type: "ui", patch: { saveState: "saved" } });
      } catch {
        dispatch({ type: "ui", patch: { saveState: "error" } });
      }
    }, 1200);
    return () => window.clearTimeout(handle);
  }, [project, loading, backend]);

  // Keep ?project= in the address bar so reloads/bookmarks reopen the same project (classic only).
  useEffect(() => {
    if (!loading) host.setProjectParam?.(project.id);
  }, [project.id, loading, host]);

  const value = useMemo(() => ({ state, dispatch, transport, backend, ffmpegAvailable }), [state, transport, backend, ffmpegAvailable]);
  if (loading) return <div className="pmv-loading">{t("PMV Creator is loading…")}</div>;
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}
