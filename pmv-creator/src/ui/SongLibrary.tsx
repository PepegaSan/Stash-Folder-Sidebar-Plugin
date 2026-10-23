/** 🎵 The song library: songs uploaded before (the media folder on the server) – pick one instead of uploading it again. */
import React, { useEffect, useState } from "react";
import { t, tn } from "../i18n";
import { type LibrarySong, listMedia } from "../stash/backend";

export function SongLibraryButton({ onPick, current, primary }: { onPick: (s: LibrarySong) => void; current?: string | null; primary?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className={`btn btn-sm ${primary ? "btn-primary" : "btn-secondary"}`} title={t("Songs uploaded before – no new upload")} onClick={() => setOpen(true)}>
        🎵 {t("From the library…")}
      </button>
      {open && (
        <SongLibraryDialog
          current={current ?? null}
          onClose={() => setOpen(false)}
          onPick={(s) => {
            setOpen(false);
            onPick(s);
          }}
        />
      )}
    </>
  );
}

/** One song (onPick) or several (onPickMany: ticks, then "Add"). */
export function SongLibraryDialog({ onPick, onPickMany, onClose, current }: { onPick?: (s: LibrarySong) => void; onPickMany?: (s: LibrarySong[]) => void; onClose: () => void; current: string | null }) {
  const [songs, setSongs] = useState<LibrarySong[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [ticked, setTicked] = useState<string[]>([]);
  useEffect(() => {
    listMedia().then((x) => setSongs(Array.isArray(x) ? x : []), (e) => setError(String(e)));
  }, []);
  const shown = (songs ?? []).filter((s) => s.name.toLowerCase().includes(q.trim().toLowerCase()));
  const many = !!onPickMany;
  const toggle = (s: LibrarySong) => setTicked((x) => (x.includes(s.path) ? x.filter((p) => p !== s.path) : [...x, s.path]));
  return (
    <div className="pmv-modal" onClick={onClose}>
      <div className="pmv-modal-body pmv-songs" onClick={(e) => e.stopPropagation()}>
        <div className="pmv-section-head is-static">
          🎵 {t("Song library")} <span className="pmv-spacer" />
          <button className="btn btn-sm btn-link" onClick={onClose}>
            ✕
          </button>
        </div>
        <input className="form-control form-control-sm" placeholder={t("Search…")} value={q} autoFocus onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        {error && <div className="pmv-error">{error}</div>}
        {!songs && !error && <div className="pmv-li-meta">{t("Loading…")}</div>}
        {songs && !songs.length && <div className="pmv-li-meta">{t("No songs yet – a song you upload lands here.")}</div>}
        <ul className="pmv-list">
          {shown.map((s) => {
            const on = many ? ticked.includes(s.path) : s.name === current;
            return (
              <li key={s.path} className={`pmv-list-item ${on ? "is-picked" : ""}`} onClick={() => (many ? toggle(s) : onPick?.(s))} title={s.path}>
                {many && <input type="checkbox" checked={on} readOnly />}
                <div className="pmv-li-main">
                  <div className="pmv-li-title">
                    {!many && (on ? "✓ " : "♪ ")}
                    {s.name}
                  </div>
                  <div className="pmv-li-meta">
                    {new Date(s.mtime * 1000).toLocaleDateString()} · {(s.size / 1048576).toFixed(1)} MB
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        {many && (
          <div className="pmv-row">
            {shown.length > 0 && (
              <button className="btn btn-sm btn-link" onClick={() => setTicked(ticked.length === shown.length ? [] : shown.map((s) => s.path))}>
                {ticked.length === shown.length ? t("None") : t("All")}
              </button>
            )}
            <span className="pmv-spacer" />
            <button className="btn btn-sm btn-primary" disabled={!ticked.length} onClick={() => onPickMany?.((songs ?? []).filter((s) => ticked.includes(s.path)))}>
              {ticked.length ? tn(ticked.length, "Add {n} songs", "Add 1 song") : t("Tick the songs")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
