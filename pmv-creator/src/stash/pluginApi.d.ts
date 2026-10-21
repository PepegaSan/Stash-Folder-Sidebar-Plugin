// Minimal typing of the parts of Stash's window.PluginApi this plugin uses.
import type * as ReactNS from "react";

declare global {
  interface StashPluginApi {
    React: typeof ReactNS;
    libraries: {
      ReactRouterDOM: { Link: ReactNS.ComponentType<{ to: string; className?: string; title?: string; children?: ReactNS.ReactNode }> };
      [name: string]: unknown;
    };
    register: { route(path: string, component: ReactNS.ComponentType): void };
    patch: {
      before(component: string, fn: (props: { children?: ReactNS.ReactNode }) => unknown[]): void;
    };
    [key: string]: unknown;
  }

  interface Window {
    PluginApi: StashPluginApi;
  }
}

export {};
