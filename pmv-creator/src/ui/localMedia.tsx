/**
 * Videos from this PC: a render helper (0.7+) serves the files of its mapped folders. The editor finds it in
 * the helper list, checks that it answers from this browser and switches the players over; whatever it can't
 * serve still comes from Stash. Switched off = Stash only (remembered per browser).
 */
import React, { useEffect, useState } from "react";
import { t } from "../i18n";
import { type RenderHelper, listHelpers } from "../stash/backend";
import { setLocalMedia } from "../stash/streams";

const LS_OFF = "pmv-creator:local-media-off";
/** The helper picked in the render dialog is tried first. */
const LS_HELPER = "pmv-creator:render-helper";
const PING_MS = 15000;
const LIST_MS = 60000;

export type LocalMediaState =
  | { kind: "none" }
  /** A helper with mappings, but too old to serve videos. */
  | { kind: "old"; helper: RenderHelper }
  /** It serves, but this browser can't reach it (firewall, other network, https Stash). */
  | { kind: "unreachable"; helper: RenderHelper }
  /** The page still has Stash's security policy from before the update (Stash lets the browser cache /pmv-creator). */
  | { kind: "blocked"; helper: RenderHelper }
  | { kind: "off"; helper: RenderHelper; folders: string[] }
  | { kind: "on"; helper: RenderHelper; folders: string[] };

let state: LocalMediaState = { kind: "none" };
/** Helper origins asked so far, and those the page's Content-Security-Policy refused (cross-origin reports carry only the origin). */
const asked = new Set<string>();
let cspBlocked = false;
const onViolation = (e: SecurityPolicyViolationEvent) => {
  if (e.effectiveDirective === "connect-src" && [...asked].some((o) => e.blockedURI.startsWith(o))) cspBlocked = true;
};
const subs = new Set<() => void>();

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

function apply(next: LocalMediaState): void {
  state = next;
  const serve = next.kind === "on" ? next.helper.serve : undefined;
  setLocalMedia(serve && next.kind === "on" ? { url: serve.url, token: serve.token, prefixes: next.folders } : null);
  subs.forEach((fn) => fn());
}

/** PC ↔ Stash by hand; only possible while the helper answers. */
export function toggleLocalMedia(): void {
  if (state.kind === "on") {
    lsSet(LS_OFF, "1");
    apply({ ...state, kind: "off" });
  } else if (state.kind === "off") {
    lsSet(LS_OFF, null);
    apply({ ...state, kind: "on" });
  }
}

export function useLocalMediaState(): LocalMediaState {
  const [s, setS] = useState(state);
  useEffect(() => {
    const fn = () => setS(state);
    subs.add(fn);
    fn();
    return () => void subs.delete(fn);
  }, []);
  return s;
}

/** The Stash folders the helper serves right now (its own mappings, which follow the editor's within 30 s); null = no answer. */
async function answers(h: RenderHelper): Promise<string[] | null> {
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), 2500);
  asked.add(new URL(h.serve!.url).origin);
  try {
    const r = await fetch(`${h.serve!.url}/v1/ping?k=${encodeURIComponent(h.serve!.token)}`, { cache: "no-store", signal: ctl.signal });
    if (!r.ok) return null;
    const info = (await r.json()) as { folders?: unknown };
    return Array.isArray(info.folders) ? info.folders.filter((x): x is string => typeof x === "string" && x !== "") : [];
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Mount once: finds the helper and keeps checking it (every check of the list is a plugin call on the server). */
export function useLocalMediaPolling(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    document.addEventListener("securitypolicyviolation", onViolation);
    let alive = true;
    let helpers: RenderHelper[] = [];
    let listedAt = 0;
    const tick = async () => {
      if (Date.now() - listedAt > LIST_MS) {
        try {
          const list = await listHelpers();
          helpers = Array.isArray(list) ? list : [];
          listedAt = Date.now();
        } catch {
          /* keep the last list */
        }
      }
      const picked = lsGet(LS_HELPER);
      const mapped = helpers.filter((h) => h.online && h.config?.mappings?.length).sort((a, b) => Number(b.id === picked) - Number(a.id === picked));
      const serving = mapped.filter((h) => h.serve);
      let next: LocalMediaState = { kind: "none" };
      if (mapped.length && !serving.length) next = { kind: "old", helper: mapped[0] };
      else if (serving.length) {
        next = { kind: "unreachable", helper: serving[0] };
        for (const h of serving) {
          const folders = await answers(h);
          if (folders?.length) {
            next = { kind: lsGet(LS_OFF) ? "off" : "on", helper: h, folders };
            break;
          }
          // it answers but hasn't picked up its folders yet (within 30 s of a change) – nothing to say
          if (folders) next = { kind: "none" };
        }
        if (next.kind === "unreachable") await new Promise((r) => window.setTimeout(r, 100)); // the CSP report comes as a task of its own
        if (next.kind === "unreachable" && cspBlocked) next = { kind: "blocked", helper: serving[0] };
        // restarted helpers get a new address/token: ask Stash again next time
        else if (next.kind === "unreachable") listedAt = 0;
      }
      if (alive && JSON.stringify(next) !== JSON.stringify(state)) apply(next);
    };
    void tick();
    const timer = window.setInterval(() => void tick(), PING_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
      document.removeEventListener("securitypolicyviolation", onViolation);
      apply({ kind: "none" });
    };
  }, [enabled]);
}

/** Where the videos come from, as a small switch next to a player. Nothing without a helper. */
export function LocalMediaBadge() {
  const s = useLocalMediaState();
  if (s.kind === "none") return null;
  const name = s.helper.name;
  const folders = s.helper.config.mappings.map((m) => m.to).join(", ");
  if (s.kind === "on")
    return (
      <button className="btn btn-sm pmv-media-badge is-on" onClick={toggleLocalMedia} title={t("Videos come from {name} ({folders}) – click: from Stash instead", { name, folders })}>
        💻 {t("from PC")}
      </button>
    );
  if (s.kind === "off")
    return (
      <button className="btn btn-sm pmv-media-badge" onClick={toggleLocalMedia} title={t("Videos come from Stash – click: from {name} ({folders}), without the NAS converting them", { name, folders })}>
        🗄 {t("from Stash")}
      </button>
    );
  const why =
    s.kind === "old"
      ? t("The render helper on {name} is too old to play videos from the PC – download it again under Render → On my PC.", { name })
      : s.kind === "blocked"
        ? t("This page still has Stash's old security settings – reload it once with Ctrl+F5, then the videos come from {name}.", { name })
        : t("The render helper on {name} doesn't answer from this browser (firewall? Stash over https?) – videos come from Stash.", { name });
  return (
    <span className="pmv-media-badge is-warn" title={why}>
      ⚠ {t("from Stash")}
    </span>
  );
}
