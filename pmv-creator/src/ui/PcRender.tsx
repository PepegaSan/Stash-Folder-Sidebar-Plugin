/**
 * "Render on my PC" (opt-in): pick a connected render helper, its output folder and optional path mappings;
 * without a helper, offer it for download (one .py file with the Stash address filled in).
 */
import React, { useEffect, useState } from "react";
import { t } from "../i18n";
import { type HelperConfig, type HelperMapping, type RenderHelper, helperScript, listHelpers, quitHelper, setHelperConfig } from "../stash/backend";
import { More } from "./common";
import { downloadText } from "./download";

const LS_HELPER = "pmv-creator:render-helper";

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
    /* private mode */
  }
}

/** The helper renders the colour look and the beat/drop effects from this version on – an older one leaves them out. */
export const HELPER_FOR_LOOKS = "0.9.5";
/** … and split screens from this one – an older one stops at the first. */
export const HELPER_FOR_SPLIT = "0.9.6";
/** … and from this one it renders with FFmpeg 8, whose builds no longer know -filter_complex_script. */
export const HELPER_FOR_FFMPEG8 = "0.9.7";

/** What a render needs from the helper: the version, and which features – so the notice names what the connected one misses. */
export interface HelperNeed {
  version: string;
  split: boolean;
  looks: boolean;
}

/** Every render needs the FFmpeg 8 fix, so the newest requirement is always the version; the flags pick the message. */
export function helperFor(o: { split: boolean; looks: boolean }): HelperNeed {
  return { version: HELPER_FOR_FFMPEG8, split: o.split, looks: o.looks };
}

/** a < b for dotted version numbers; an unknown version counts as old. */
export function olderVersion(a: string | undefined, b: string): boolean {
  if (!a) return true;
  const x = a.split(".").map((n) => parseInt(n, 10) || 0);
  const y = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
}

/** The URL scheme the helper registers on its PC at every start (Windows): opening it starts the helper without a window. */
export const HELPER_SCHEME = "pmvhelper";

/** Opens pmvhelper://start without leaving the page (a hidden frame); the browser asks once whether it may. */
export function launchHelper(): void {
  const f = document.createElement("iframe");
  f.style.display = "none";
  f.src = `${HELPER_SCHEME}://start`;
  document.body.appendChild(f);
  window.setTimeout(() => f.remove(), 5000);
}

/**
 * The helper file with the Stash address (and an API key for a Stash with a login) filled in: a .pyw runs without
 * a window (pythonw); the .py shows a console – for troubleshooting.
 */
function useHelperDownload() {
  const [status, setStatus] = useState<string | null>(null);
  const download = async (apiKey: string, withWindow = false) => {
    try {
      downloadText(withWindow ? "pmv-render-helper.py" : "pmv-render-helper.pyw", await helperScript(apiKey), "text/x-python");
      setStatus(withWindow ? t("Downloaded – start it with a double-click; its window shows what it does.") : t("Downloaded – start it once with a double-click: it runs without a window and shows up here within a few seconds."));
    } catch (e) {
      setStatus(t("Error: {error}", { error: String(e) }));
    }
  };
  return { download, status };
}

/** ⏹ for the connected helper: it quits after its next check-in (and after a render that is running). */
function QuitButton({ helper, disabled }: { helper: RenderHelper; disabled: boolean }) {
  const [state, setState] = useState<string | null>(null);
  const quit = async () => {
    try {
      const r = await quitHelper(helper.id);
      setState(r.ok ? t("Quit requested – the helper stops within half a minute.") : t("The helper is not connected any more."));
    } catch (e) {
      setState(String(e));
    }
  };
  return (
    <>
      <button className="btn btn-sm btn-link" disabled={disabled} title={t("Stops the helper on this PC (after a render that is running). ▶ Start helper starts it again.")} onClick={() => void quit()}>
        ⏹ {t("Quit helper")}
      </button>
      {state && <span className="pmv-li-meta">{state}</span>}
    </>
  );
}

const ago = (s: number) => {
  const d = Math.max(0, Date.now() / 1000 - s);
  return d < 120 ? t("{n} s ago", { n: Math.round(d) }) : d < 7200 ? t("{n} min ago", { n: Math.round(d / 60) }) : t("{n} h ago", { n: Math.round(d / 3600) });
};

/** onHelper gets the id of the selected, connected helper (null = none); `needs`: the helper version this render needs. */
export function PcRender({ onHelper, disabled, needs }: { onHelper: (id: string | null, name: string | null) => void; disabled: boolean; needs?: HelperNeed }) {
  const [helpers, setHelpers] = useState<RenderHelper[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(() => lsGet(LS_HELPER));

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const list = await listHelpers();
        if (alive) {
          setHelpers(list);
          setError(null);
        }
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    void load();
    // a freshly started helper shows up within a few seconds
    const h = window.setInterval(() => void load(), 4000);
    return () => {
      alive = false;
      window.clearInterval(h);
    };
  }, []);

  const online = (helpers ?? []).filter((h) => h.online);
  const current = online.find((h) => h.id === picked) ?? online[0] ?? null;
  useEffect(() => onHelper(current?.id ?? null, current?.name ?? null), [current?.id]);

  if (!helpers) return <div className="pmv-li-meta">{error ?? t("Loading…")}</div>;

  return (
    <div className="pmv-pc">
      {current ? (
        <>
          <div className="pmv-row pmv-wrap">
            {online.length > 1 ? (
              <select
                className="form-control form-control-sm pmv-select"
                value={current.id}
                disabled={disabled}
                onChange={(e) => {
                  setPicked(e.target.value);
                  lsSet(LS_HELPER, e.target.value);
                }}
              >
                {online.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            ) : (
              <strong>{current.name}</strong>
            )}
            <span className="pmv-ok-dot" title={current.ffmpeg}>
              ● {t("connected")}
            </span>
            <QuitButton key={current.id} helper={current} disabled={disabled} />
          </div>
          {needs && olderVersion(current.version, needs.version) && <OutdatedHelper version={current.version} needs={needs} />}
          <HelperSettings key={current.id} helper={current} disabled={disabled} />
        </>
      ) : (
        <HelperSetup known={helpers} />
      )}
      {error && <div className="pmv-error">{error}</div>}
    </div>
  );
}

function HelperSettings({ helper, disabled }: { helper: RenderHelper; disabled: boolean }) {
  const [cfg, setCfg] = useState<HelperConfig>(() => ({ outputDir: helper.config?.outputDir ?? "", mappings: helper.config?.mappings ?? [] }));
  const [saved, setSaved] = useState<string | null>(null);
  const save = async (next: HelperConfig) => {
    try {
      setCfg(await setHelperConfig(helper.id, next));
      setSaved(t("saved"));
    } catch (e) {
      setSaved(String(e));
    }
  };
  const setMapping = (i: number, patch: Partial<HelperMapping>) => setCfg((c) => ({ ...c, mappings: c.mappings.map((m, k) => (k === i ? { ...m, ...patch } : m)) }));

  return (
    <>
      <div className="pmv-grid2">
        <label>{t("Save to")}</label>
        <input
          className="form-control form-control-sm"
          value={cfg.outputDir}
          placeholder={helper.defaultOutput ?? ""}
          disabled={disabled}
          title={t("A folder on this PC, e.g. I:\\PMVs – empty: the default folder shown")}
          onChange={(e) => setCfg({ ...cfg, outputDir: e.target.value })}
          onBlur={() => void save(cfg)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      {saved && <div className="pmv-li-meta">{saved}</div>}
      <More label={t("Read the videos from a drive (optional)")}>
        <div className="pmv-li-meta">{t("By default the PC gets the videos over Stash. If they are on a drive of this PC (e.g. the NAS as Y:), enter how Stash's paths map to it.")}</div>
        {cfg.mappings.map((m, i) => (
          <div key={i} className="pmv-row">
            <input className="form-control form-control-sm" value={m.from} placeholder="/data/" disabled={disabled} onChange={(e) => setMapping(i, { from: e.target.value })} onBlur={() => void save(cfg)} onKeyDown={(e) => e.stopPropagation()} title={t("Path prefix in Stash")} />
            <span>→</span>
            <input className="form-control form-control-sm" value={m.to} placeholder="Y:\" disabled={disabled} onChange={(e) => setMapping(i, { to: e.target.value })} onBlur={() => void save(cfg)} onKeyDown={(e) => e.stopPropagation()} title={t("Replace with (path on this PC)")} />
            <button className="btn btn-sm btn-link" disabled={disabled} onClick={() => void save({ ...cfg, mappings: cfg.mappings.filter((_, k) => k !== i) })} title={t("Remove")}>
              ✕
            </button>
          </div>
        ))}
        <button className="btn btn-sm btn-secondary" disabled={disabled} onClick={() => setCfg({ ...cfg, mappings: [...cfg.mappings, { from: "/data/", to: "" }] })}>
          + {t("Path mapping")}
        </button>
        <div className="pmv-li-meta">
          {helper.serve
            ? t("The preview uses these folders too: while the helper runs, the editor plays their videos from this PC (💻 next to the player).")
            : t("Download the helper again (below) and the preview plays the videos of these folders from this PC, too.")}
        </div>
      </More>
    </>
  );
}

/** An older helper misses something this render needs (the oldest missing thing is named): offer the new one. */
function OutdatedHelper({ version, needs }: { version?: string; needs: HelperNeed }) {
  const [apiKey, setApiKey] = useState("");
  const { download, status } = useHelperDownload();
  const v = { version: version ?? "?" };
  return (
    <div className="pmv-error">
      ⚠{" "}
      {needs.looks && olderVersion(version, HELPER_FOR_LOOKS)
        ? t("The helper on this PC ({version}) renders without the colour look and the effects. Download it again, close the old window and start the new file:", v)
        : needs.split && olderVersion(version, HELPER_FOR_SPLIT)
          ? t("The helper on this PC ({version}) can't render split screens yet. Download it again, close the old window and start the new file:", v)
          : t("The helper on this PC ({version}) fails with FFmpeg 8 (“Unrecognized option 'filter_complex_script'”). Download it again, close the old window and start the new file:", v)}
      <div className="pmv-row">
        <button className="btn btn-sm btn-primary" onClick={() => void download(apiKey)}>
          ⬇ {t("Download render helper")}
        </button>
        <input className="form-control form-control-sm" value={apiKey} placeholder={t("API key (only for a Stash with a login)")} onChange={(e) => setApiKey(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </div>
      {status && <div className="pmv-li-meta">{status}</div>}
    </div>
  );
}

function HelperSetup({ known }: { known: RenderHelper[] }) {
  const [apiKey, setApiKey] = useState("");
  const [started, setStarted] = useState(false);
  const { download: fetchHelper, status } = useHelperDownload();
  const start = () => {
    launchHelper();
    setStarted(true);
  };
  return (
    <div className="pmv-pc-setup">
      <div className="pmv-li-meta">{t("No PC is connected. The render helper is a small program for your PC: it takes the render from Stash, renders with your PC's FFmpeg and saves the video on the PC.")}</div>
      <div className="pmv-row pmv-wrap">
        <button className="btn btn-sm btn-primary" onClick={start} title={t("Starts the render helper on this PC without a window – the browser asks once whether it may open it")}>
          ▶ {t("Start helper on this PC")}
        </button>
        <span className="pmv-li-meta">
          {started ? t("Starting – the PC shows up here within a few seconds. Nothing happens? Then the helper is not set up on this PC yet: see below.") : t("Works once the helper was started on this PC one time (see below).")}
        </span>
      </div>
      <More label={t("Not set up on this PC yet?")} defaultOpen={known.length === 0}>
        <ol className="pmv-help-steps">
          <li>{t("Needs Python 3 (python.org) and FFmpeg (e.g. “winget install Gyan.FFmpeg”) on the PC.")}</li>
          <li>
            <button className="btn btn-sm btn-primary" onClick={() => void fetchHelper(apiKey)}>
              ⬇ {t("Download render helper")}
            </button>{" "}
            <button className="btn btn-sm btn-link" onClick={() => void fetchHelper(apiKey, true)}>
              {t("with a window (.py, for troubleshooting)")}
            </button>{" "}
            {status && <span className="pmv-li-meta">{status}</span>}
          </li>
          <li>{t("Start it once with a double-click. It runs without a window and shows up here within a few seconds. From then on ▶ Start helper above starts it – also after Windows restarted. If nothing shows up, pmv-render-helper.log next to the file tells why.")}</li>
        </ol>
        <More label={t("Stash with a login?")}>
          <div className="pmv-li-meta">{t("Then the helper needs an API key (Stash: Settings → Security). It is written into the downloaded file.")}</div>
          <input className="form-control form-control-sm" value={apiKey} placeholder={t("API key")} onChange={(e) => setApiKey(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        </More>
      </More>
      {known.length > 0 && (
        <div className="pmv-li-meta">
          {t("Known PCs:")} {known.map((h) => `${h.name} (${t("offline")}, ${ago(h.lastSeen)})`).join(" · ")}
        </div>
      )}
    </div>
  );
}
