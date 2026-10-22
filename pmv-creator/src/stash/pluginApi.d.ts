// Minimal typing of the parts of Stash's window.PluginApi this plugin uses.
import type * as ReactNS from "react";
import type * as ReactDOMNS from "react-dom";

declare global {
  interface StashPluginApi {
    React: typeof ReactNS;
    ReactDOM: typeof ReactDOMNS;
    libraries: {
      ReactRouterDOM: { Link: ReactNS.ComponentType<{ to: string; className?: string; title?: string; children?: ReactNS.ReactNode }> };
      [name: string]: unknown;
    };
    register: { route(path: string, component: ReactNS.ComponentType): void };
    patch: {
      before<P = { children?: ReactNS.ReactNode }>(component: string, fn: (props: P) => unknown[]): void;
    };
    [key: string]: unknown;
  }

  interface Window {
    PluginApi: StashPluginApi;
  }
}

export {};
