/**
 * Where the editor runs: classic Stash (our route + navbar) or Stash UI (an overlay page of its
 * extension API). The host owns the address bar, the deep-link query and where a scene opens.
 */
import { createContext, useContext } from "react";
import { stashUrl } from "./stash/graphql";

export type HostKind = "classic" | "stashui";

export interface Host {
  kind: HostKind;
  /** Query of the page/route at mount: ?project=, ?scenes=, ?t= */
  query: URLSearchParams;
  /** Keep ?project=<id> in the address bar – null when the host owns the URL (Stash UI). */
  setProjectParam: ((id: string) => void) | null;
  /** Drop consumed deep-link params from the address bar. */
  clearQueryParams: ((keys: string[]) => void) | null;
  /** Link that opens a scene in the host's own UI (new tab); `at` = seconds into the scene where its player should start (classic Stash's ?t=). */
  sceneHref: (sceneId: string, at?: number) => string;
  /** Top edge of the editor (classic: below Stash's fixed navbar). */
  topOffset: () => number;
}

export function classicHost(): Host {
  return {
    kind: "classic",
    query: new URLSearchParams(window.location.search),
    setProjectParam: (id) => {
      const url = new URL(window.location.href);
      if (url.searchParams.get("project") === id) return;
      url.searchParams.set("project", id);
      window.history.replaceState(window.history.state, "", url.toString());
    },
    clearQueryParams: (keys) => {
      const url = new URL(window.location.href);
      keys.forEach((k) => url.searchParams.delete(k));
      window.history.replaceState(window.history.state, "", url.toString());
    },
    sceneHref: (id, at) => {
      const sec = Math.floor(at ?? 0);
      return stashUrl(`scenes/${id}${sec > 0 ? `?t=${sec}` : ""}`);
    },
    topOffset: () => Math.round(document.querySelector(".navbar.fixed-top")?.getBoundingClientRect().bottom ?? 50),
  };
}

export const STASHUI_APP = "/plugin/stashui/assets/index.html";

export function stashuiHost(query: URLSearchParams): Host {
  return {
    kind: "stashui",
    query,
    setProjectParam: null,
    clearQueryParams: null,
    sceneHref: (id) => stashUrl(`${STASHUI_APP.replace(/^\//, "")}#/scene/${id}`),
    topOffset: () => 0,
  };
}

const HostContext = createContext<Host | null>(null);
export const HostProvider = HostContext.Provider;

let fallback: Host | null = null;
export function useHost(): Host {
  const ctx = useContext(HostContext);
  if (ctx) return ctx;
  fallback ??= classicHost();
  return fallback;
}
