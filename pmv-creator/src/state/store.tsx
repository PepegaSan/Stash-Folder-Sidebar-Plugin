import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useHost } from "../host";
import { t } from "../i18n";
import { type PmvProject, createProject, migrateProject, projectDuration } from "../model/project";
import { loadProject, ping, saveProject } from "../stash/backend";
import { type Action, type EditorState, editorReducer, initialEditorState } from "./reducer";
import { Transport } from "./transport";

export type BackendState = "checking" | "online" | "offline";

interface EditorContextValue {
  state: EditorState;
  /** The current state also after an await (async actions must not work on a stale render's state). */
  getState: () => EditorState;
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

// A failed server save can leave the browser with the most recent checkpoint.
const LS_LAST = "pmv-creator:last-project";
const lsKey = (id: string) => `pmv-creator:project:${id}`;

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function rememberProject(p: PmvProject): boolean {
  const saved = lsSet(lsKey(p.id), JSON.stringify(p));
  const linked = saved && lsSet(LS_LAST, p.id);
  return saved && linked;
}

type SavedWhere = "server" | "browser" | null;
const pendingSaves = new Map<string, Promise<SavedWhere>>();
const lastStamp = new Map<string, number>();

export async function checkpointProject(p: PmvProject, online: boolean): Promise<SavedWhere> {
  const previousStamp = Math.max(Date.parse(p.updatedAt) || 0, lastStamp.get(p.id) ?? 0);
  const now = Math.max(Date.now(), previousStamp + 1);
  lastStamp.set(p.id, now);
  const stamped = { ...p, updatedAt: new Date(now).toISOString() };
  const fallback = rememberProject(stamped) ? "browser" : null;
  if (!online) return fallback;
  // A slow autosave must finish before a later explicit pause writes the same file.
  const previous = pendingSaves.get(p.id) ?? Promise.resolve();
  const write = previous.then(() => saveProject(stamped)).then((result) => result?.path ? "server" as const : fallback, () => fallback);
  pendingSaves.set(p.id, write);
  try { return await write; } finally {
    if (pendingSaves.get(p.id) === write) pendingSaves.delete(p.id);
  }
}

export async function openProject(id: string, online: boolean): Promise<PmvProject> {
  let server: PmvProject | null = null;
  if (online) {
    try {
      const raw = await loadProject(id);
      if (raw) server = migrateProject(raw);
    } catch {
      /* fall back to the browser copy */
    }
  }
  const local = lsGet(lsKey(id));
  if (local) {
    try {
      const raw = JSON.parse(local);
      if (!server || (raw?.id === id && Date.parse(raw.updatedAt) > Date.parse(server.updatedAt))) return migrateProject(raw);
    } catch (error) { if (!server) throw error; }
  }
  if (server) return server;
  throw new Error(t("Project {id} not found", { id }));
}

const reducer = (s: EditorState, a: Action) => editorReducer(s, a);

export function EditorProvider({ children }: { children: React.ReactNode }) {
  const host = useHost();
  const [state, dispatch] = useReducer(reducer, undefined, () => initialEditorState(createProject()));
  const stateRef = useRef(state);
  stateRef.current = state;
  const getState = useCallback(() => stateRef.current, []);
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
        await checkpointProject(project, online);
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
      dispatch({ type: "ui", patch: { saveState: "saving" } });
      const where = await checkpointProject(project, backend === "online");
      if (stateRef.current.present !== project) return;
      const saved = where === "server" || (backend !== "online" && where === "browser");
      if (saved) savedRef.current = project;
      dispatch({ type: "ui", patch: { saveState: saved ? "saved" : "error" } });
    }, 1200);
    return () => window.clearTimeout(handle);
  }, [project, loading, backend]);

  // Keep ?project= in the address bar so reloads/bookmarks reopen the same project (classic only).
  useEffect(() => {
    if (!loading) host.setProjectParam?.(project.id);
  }, [project.id, loading, host]);

  const value = useMemo(() => ({ state, getState, dispatch, transport, backend, ffmpegAvailable }), [state, getState, transport, backend, ffmpegAvailable]);
  if (loading) return <div className="pmv-loading">{t("PMV Creator is loading…")}</div>;
  return <EditorContext.Provider value={value}>{children}</EditorContext.Provider>;
}
