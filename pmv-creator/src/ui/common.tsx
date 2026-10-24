/** Small shared UI pieces. Styling relies on Stash's Bootstrap plus styles.css. */
import React, { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { LOOKS, type Look, type LookSettings } from "../model/look";
import type { TransitionType } from "../model/project";
import { stashUrl } from "../stash/graphql";
import { type SpriteSheet, cueAt } from "../stash/sprites";
import type { StashRef } from "../stash/types";
import { useClickOutside } from "./hooks";

/** Number input that only commits on blur/Enter, so typing does not flood the undo history. */
export function NumField(props: {
  value: number;
  onCommit: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  digits?: number;
  suffix?: string;
  title?: string;
  disabled?: boolean;
}) {
  const { value, onCommit, step = 0.01, min, max, digits = 3, suffix, title, disabled } = props;
  const fmt = (v: number) => (Number.isFinite(v) ? String(Math.round(v * 10 ** digits) / 10 ** digits) : "");
  const [draft, setDraft] = useState(fmt(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(fmt(value));
  });
  const commit = () => {
    const v = parseFloat(draft.replace(",", "."));
    if (!Number.isFinite(v)) return setDraft(fmt(value));
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
    if (Math.abs(clamped - value) > 1e-9) onCommit(clamped);
    setDraft(fmt(clamped));
  };
  return (
    <span className="pmv-num" title={title}>
      <input
        className="form-control form-control-sm"
        type="number"
        step={step}
        min={min}
        max={max}
        value={draft}
        disabled={disabled}
        onFocus={() => (focused.current = true)}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(fmt(value));
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation();
        }}
      />
      {suffix && <span className="pmv-num-suffix">{suffix}</span>}
    </span>
  );
}

export function Menu({ label, children, title, className = "" }: { label: React.ReactNode; children: (close: () => void) => React.ReactNode; title?: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => setOpen(false);
  useClickOutside(ref, open, close);
  return (
    <div className={`pmv-menu ${className}`} ref={ref}>
      <button className="btn btn-sm btn-secondary" title={title} onClick={() => setOpen(!open)}>
        {label} ▾
      </button>
      {open && <div className="pmv-menu-pop">{children(close)}</div>}
    </div>
  );
}

/** Thumbnail from Stash's scrubber sprite at time t, falling back to the scene cover. */
export function SpriteThumb({ sheet, t, height, fallback }: { sheet: SpriteSheet | null; t: number; height: number; fallback?: string | null }) {
  const cue = sheet ? cueAt(sheet, t) : null;
  if (!cue) {
    return fallback ? (
      <div className="pmv-thumb" style={{ height, width: (height * 16) / 9, backgroundImage: `url("${stashUrl(fallback)}")`, backgroundSize: "cover", backgroundPosition: "center" }} />
    ) : (
      <div className="pmv-thumb pmv-thumb-empty" style={{ height, width: (height * 16) / 9 }} />
    );
  }
  const scale = height / cue.h;
  const sheetSize = sheet!.sheets[cue.url];
  return (
    <div
      className="pmv-thumb"
      style={{
        height,
        width: cue.w * scale,
        backgroundImage: `url("${cue.url}")`,
        backgroundPosition: `${-cue.x * scale}px ${-cue.y * scale}px`,
        backgroundSize: `${sheetSize.w * scale}px ${sheetSize.h * scale}px`,
      }}
    />
  );
}

/** Async multi-select for tags/performers. */
export function RefPicker({ placeholder, value, onChange, search }: { placeholder: string; value: StashRef[]; onChange: (v: StashRef[]) => void; search: (q: string) => Promise<StashRef[]> }) {
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<StashRef[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useClickOutside(ref, open, () => setOpen(false));
  useEffect(() => {
    if (!q.trim()) {
      setOptions([]);
      return;
    }
    let alive = true;
    const h = window.setTimeout(() => {
      search(q.trim()).then((r) => alive && setOptions(r), () => alive && setOptions([]));
    }, 200);
    return () => {
      alive = false;
      window.clearTimeout(h);
    };
  }, [q, search]);
  return (
    <div className="pmv-refpicker" ref={ref}>
      <div className="pmv-chips">
        {value.map((v) => (
          <span key={v.id} className="pmv-chip">
            {v.name}
            <button onClick={() => onChange(value.filter((x) => x.id !== v.id))} title={t("Remove")}>
              ×
            </button>
          </span>
        ))}
        <input
          className="form-control form-control-sm"
          placeholder={placeholder}
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => e.stopPropagation()}
        />
      </div>
      {open && options.length > 0 && (
        <div className="pmv-menu-pop">
          {options
            .filter((o) => !value.some((v) => v.id === o.id))
            .map((o) => (
              <button
                key={o.id}
                className="pmv-menu-item"
                onClick={() => {
                  onChange([...value, o]);
                  setQ("");
                  setOpen(false);
                }}
              >
                {o.name}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

/** Collapsible "More…" block for settings that the everyday workflow does not need. */
export function More({ label, children, defaultOpen = false }: { label?: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="pmv-more">
      <button type="button" className="pmv-more-head" onClick={() => setOpen(!open)}>
        {open ? "▾" : "▸"} {label ?? t("More…")}
      </button>
      {open && <div className="pmv-more-body">{children}</div>}
    </div>
  );
}

/** Segmented control (one of a few options). */
/** Segmented buttons; `value` null = none of them on. */
export function Seg<T extends string | number>({ value, options, onChange, disabled }: { value: T | null; options: Array<[T, string, string?]>; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="pmv-seg">
      {options.map(([v, label, title]) => (
        <button key={String(v)} type="button" title={title} disabled={disabled} className={v === value ? "is-on" : ""} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export const sceneHue = (sceneId: string): number => {
  let h = 0;
  for (const ch of sceneId) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return (h * 47) % 360;
};

/** Display name of a colour look. */
export function lookLabel(look: Look): string {
  switch (look) {
    case "none":
      return t("Original");
    case "warm":
      return t("Warm");
    case "pink":
      return t("Pink");
    case "cold":
      return t("Cold");
    case "vivid":
      return t("Vivid");
    case "bw":
      return t("Black & white");
    case "noir":
      return t("Noir");
    case "custom":
      return t("Own color");
  }
}

/** The project's colour look, its strength, own colour and extra brightness – the same in the inspector and the generator. */
export function LookFields({ output, onChange }: { output: LookSettings; onChange: (patch: Partial<LookSettings>) => void }) {
  return (
    <>
      <label>{t("Look")}</label>
      <select className="form-control form-control-sm pmv-look" value={output.look} title={t("Colour mood of the whole PMV – preview, quick record and render")} onChange={(e) => onChange({ look: e.target.value as Look })}>
        {LOOKS.map((l) => (
          <option key={l} value={l}>
            {lookLabel(l)}
          </option>
        ))}
      </select>
      {output.look !== "none" && (
        <>
          <label>{t("Strength")}</label>
          <span className="pmv-row">
            <input type="range" min={0} max={1} step={0.05} value={output.lookAmount} onChange={(e) => onChange({ lookAmount: +e.target.value })} />
            <span className="pmv-mono">{Math.round(output.lookAmount * 100)}%</span>
          </span>
        </>
      )}
      {output.look === "custom" && (
        <>
          <label>{t("Color")}</label>
          <input type="color" className="pmv-color" value={output.lookColor} onChange={(e) => onChange({ lookColor: e.target.value })} />
        </>
      )}
      <label>{t("Brightness")}</label>
      <span className="pmv-row" title={t("Brighter without burning out the highlights")}>
        <input type="range" min={0} max={1} step={0.05} value={output.brightness} onChange={(e) => onChange({ brightness: +e.target.value })} />
        <span className="pmv-mono">{Math.round(output.brightness * 100)}%</span>
      </span>
    </>
  );
}

/** Display name of a transition (the ids are FFmpeg's xfade names). */
export function transitionLabel(type: TransitionType): string {
  switch (type) {
    case "fade":
      return t("Crossfade");
    case "fadeblack":
      return t("Fade through black");
    case "fadewhite":
      return t("Fade through white");
    case "dissolve":
      return t("Dissolve");
    case "wipeleft":
      return t("Wipe to the left");
    case "wiperight":
      return t("Wipe to the right");
    case "slideleft":
      return t("Slide to the left");
    case "slideright":
      return t("Slide to the right");
    case "circleopen":
      return t("Circle opens");
    case "pixelize":
      return t("Pixelate");
    case "zoomin":
      return t("Zoom in");
    case "hblur":
      return t("Blur");
    case "radial":
      return t("Clock wipe");
  }
}
