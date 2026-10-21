/**
 * "Render on my PC" (opt-in): pick a connected render helper, its output folder and optional path mappings;
 * without a helper, offer it for download (one .py file with the Stash address filled in).
 */
import React, { useEffect, useState } from "react";
import { t } from "../i18n";
import { type HelperConfig, type HelperMapping, type RenderHelper, helperScript, listHelpers, setHelperConfig } from "../stash/backend";
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

const ago = (s: number) => {
  const d = Math.max(0, Date.now() / 1000 - s);
  return d < 120 ? t("{n} s ago", { n: Math.round(d) }) : d < 7200 ? t("{n} min ago", { n: Math.round(d / 60) }) : t("{n} h ago", { n: Math.round(d / 3600) });
};

/** onHelper gets the id of the selected, connected helper (null = none). */
export function PcRender({ onHelper, disabled }: { onHelper: (id: string | null, name: string | null) => void; disabled: boolean }) {
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
          </div>
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
      </More>
    </>
  );
}

function HelperSetup({ known }: { known: RenderHelper[] }) {
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const download = async () => {
    try {
      downloadText("pmv-render-helper.py", await helperScript(apiKey), "text/x-python");
      setStatus(t("Downloaded – start it with a double-click."));
    } catch (e) {
      setStatus(t("Error: {error}", { error: String(e) }));
    }
  };
  return (
    <div className="pmv-pc-setup">
      <div className="pmv-li-meta">{t("No PC is connected. The render helper is a small program for your PC: it takes the render from Stash, renders with your PC's FFmpeg and saves the video on the PC.")}</div>
      <ol className="pmv-help-steps">
        <li>{t("Needs Python 3 (python.org) and FFmpeg (e.g. “winget install Gyan.FFmpeg”) on the PC.")}</li>
        <li>
          <button className="btn btn-sm btn-primary" onClick={() => void download()}>
            ⬇ {t("Download render helper")}
          </button>{" "}
          {status && <span className="pmv-li-meta">{status}</span>}
        </li>
        <li>{t("Double-click the file and keep the window open – the PC shows up here within a few seconds. For every start of Windows: put it into the startup folder (Win+R → shell:startup).")}</li>
      </ol>
      <More label={t("Stash with a login?")}>
        <div className="pmv-li-meta">{t("Then the helper needs an API key (Stash: Settings → Security). It is written into the downloaded file.")}</div>
        <input className="form-control form-control-sm" value={apiKey} placeholder={t("API key")} onChange={(e) => setApiKey(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      </More>
      {known.length > 0 && (
        <div className="pmv-li-meta">
          {t("Known PCs:")} {known.map((h) => `${h.name} (${t("offline")}, ${ago(h.lastSeen)})`).join(" · ")}
        </div>
      )}
    </div>
  );
}
