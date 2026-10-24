/** Split screens in the UI: names and icons, the generator's choice, and the inspector of a range on the timeline. */
import React from "react";
import { LAYOUT_PICKS, type LayoutChoice, type LayoutPick } from "../generator/layouts";
import type { Shape } from "../generator/material";
import { t } from "../i18n";
import { type Field, LAYOUTS, LAYOUT_INFO, type LayoutKind, type LayoutRange, type SplitDir, groupTrackIndex, layoutFields } from "../model/layouts";
import { useEditor } from "../state/store";
import { beatLength, nearestGridTime } from "../timeline/time";
import { NumField, Seg } from "./common";

export function layoutLabel(k: LayoutPick): string {
  switch (k) {
    case "full":
      return t("Full screen");
    case "duo":
      return t("2-way");
    case "trim":
      return t("3-way mirrored");
    case "tri":
      return t("3-way");
    case "quad":
      return t("4-way");
    case "kaleido":
      return t("Kaleidoscope");
  }
}

export function layoutHint(k: LayoutPick): string {
  switch (k) {
    case "full":
      return t("One clip over the whole picture");
    case "duo":
      return t("Two clips next to each other");
    case "trim":
      return t("The same clip left and right (mirrored), another one in the middle");
    case "tri":
      return t("Three different clips");
    case "quad":
      return t("Four clips in a grid");
    case "kaleido":
      return t("One clip, mirrored four times");
  }
}

/** A small picture of a layout's fields (mirrored ones fainter). */
export function LayoutIcon({ kind, dir = "cols" }: { kind: LayoutPick; dir?: SplitDir }) {
  const fields: Array<Omit<Field, "group">> = kind === "full" ? [{ x: 0, y: 0, w: 1, h: 1, fx: false, fy: false }] : layoutFields(kind, dir);
  return (
    <svg className="pmv-lay-icon" viewBox="0 0 16 10" aria-hidden="true">
      {fields.map((f, i) => (
        <rect key={i} x={f.x * 16 + 0.6} y={f.y * 10 + 0.6} width={Math.max(0.6, f.w * 16 - 1.2)} height={Math.max(0.6, f.h * 10 - 1.2)} rx={0.8} opacity={f.fx || f.fy ? 0.5 : 1} />
      ))}
    </svg>
  );
}

const sided = (k: LayoutPick) => k === "duo" || k === "trim" || k === "tri";

export interface GeneratorLayoutSettings {
  layouts: LayoutChoice;
  split: SplitDir;
  layoutShape: Partial<Record<LayoutPick, Shape>>;
}

/** Which layouts the generator may use (at least one), how the fields lie, and – advanced – the clip shape per layout. */
export function GeneratorLayouts({ value, onChange, advanced, portrait }: { value: GeneratorLayoutSettings; onChange: (patch: Partial<GeneratorLayoutSettings>) => void; advanced: boolean; portrait: boolean }) {
  const on = LAYOUT_PICKS.filter((k) => value.layouts[k]);
  const toggle = (k: LayoutPick) => {
    const next = { ...value.layouts, [k]: !value.layouts[k] };
    if (LAYOUT_PICKS.some((x) => next[x])) onChange({ layouts: next });
  };
  return (
    <div className="pmv-lay">
      <div className="pmv-seg pmv-lay-picks">
        {LAYOUT_PICKS.map((k) => (
          <button key={k} type="button" className={value.layouts[k] ? "is-on" : ""} title={layoutHint(k)} onClick={() => toggle(k)}>
            <LayoutIcon kind={k} dir={value.split} />
            {layoutLabel(k)}
          </button>
        ))}
      </div>
      {on.some(sided) && (
        <span className="pmv-row">
          <span className="pmv-li-meta">{t("Fields of 2- and 3-way")}</span>
          <Seg<SplitDir> value={value.split} onChange={(v) => onChange({ split: v })} options={[["cols", t("side by side")], ["rows", t("stacked")]]} />
        </span>
      )}
      {advanced && (
        <div className="pmv-grid2 pmv-lay-shapes" title={t("E.g. landscape clips only in full screen, portrait ones only in 3-way (set “Shape” under Clips to “all”)")}>
          {on.map((k) => (
            <React.Fragment key={k}>
              <label>
                <LayoutIcon kind={k} dir={value.split} />
                {layoutLabel(k)}
              </label>
              <Seg<Shape>
                value={value.layoutShape[k] ?? "all"}
                onChange={(v) => onChange({ layoutShape: { ...value.layoutShape, [k]: v } })}
                options={[["all", t("all clips")], ["landscape", t("landscape only")], ["portrait", t("portrait only")]]}
              />
            </React.Fragment>
          ))}
        </div>
      )}
      {portrait && value.split === "cols" && (value.layouts.tri || value.layouts.trim) && <div className="pmv-li-meta">{t("In portrait format three fields side by side get very narrow – “stacked” fits better.")}</div>}
      {on.some((k) => k !== "full") && <div className="pmv-li-meta">{t("The fields come from the tracks: V1 (the bottom one) and the ones above it – the generator fills them and adds tracks when needed.")}</div>}
    </div>
  );
}

/** The selected split screen range: layout, fields, where it lies. */
export function LayoutInspector({ range }: { range: LayoutRange }) {
  const { state, dispatch, transport } = useEditor();
  const p = state.present;
  const put = (patch: Partial<LayoutRange>) => dispatch({ type: "layout/put", layout: { ...range, ...patch } });
  const groups = LAYOUT_INFO[range.kind].groups;
  const names = Array.from({ length: groups }, (_, g) => p.tracks[groupTrackIndex(p.tracks.length, g)]?.name ?? `V${g + 1}`);
  const grid = (time: number) => nearestGridTime(time, p.beatGrid, state.ui.snapDivision);
  const end = range.start + range.duration;
  return (
    <div className="pmv-panel">
      <div className="pmv-section-head is-static">
        {t("Split screen")}
        <span className="pmv-spacer" />
        <button className="btn btn-sm btn-link" onClick={() => dispatch({ type: "ui", patch: { selectedLayoutId: null } })} title={t("Clear selection (Esc)")}>
          ✕
        </button>
      </div>
      <div className="pmv-seg pmv-lay-picks">
        {LAYOUTS.map((k: LayoutKind) => (
          <button key={k} type="button" className={range.kind === k ? "is-on" : ""} title={layoutHint(k)} onClick={() => put({ kind: k })}>
            <LayoutIcon kind={k} dir={range.dir} />
            {layoutLabel(k)}
          </button>
        ))}
      </div>
      <div className="pmv-grid2">
        {sided(range.kind) && (
          <>
            <label>{t("Fields")}</label>
            <Seg<SplitDir> value={range.dir} onChange={(v) => put({ dir: v })} options={[["cols", t("side by side")], ["rows", t("stacked")]]} />
          </>
        )}
        <label>{t("Start")}</label>
        <NumField value={range.start} min={0} onCommit={(v) => put({ start: v })} suffix="s" />
        <label>{t("Duration")}</label>
        <NumField value={range.duration} min={0.05} onCommit={(v) => put({ duration: v })} suffix="s" />
        <label>{t("In beats")}</label>
        <NumField value={range.duration / beatLength(p.beatGrid)} min={0.25} step={1} onCommit={(v) => put({ duration: v * beatLength(p.beatGrid) })} suffix={t("beats")} />
      </div>
      <div className="pmv-li-meta">{groups > 1 ? t("Its fields show the tracks {list}.", { list: names.join(", ") }) : t("It shows the clips of track {name}.", { name: names[0] })}</div>
      <div className="pmv-row pmv-wrap">
        <button
          className="btn btn-sm btn-secondary"
          title={t("Put start and end on the snap grid")}
          onClick={() => {
            const s = grid(range.start);
            put({ start: s, duration: Math.max(beatLength(p.beatGrid) * state.ui.snapDivision, grid(end) - s) });
          }}
        >
          ⌗ {t("To the grid")}
        </button>
        <button className="btn btn-sm btn-secondary" title={t("Jump to its start")} onClick={() => transport.seek(range.start)}>
          ⏮ {t("To its start")}
        </button>
      </div>
      <div className="pmv-row pmv-wrap">
        <button className="btn btn-sm btn-danger" title={t("Back to full screen here (Del) – the clips stay on their tracks")} onClick={() => dispatch({ type: "layout/remove", layoutId: range.id })}>
          {t("Remove")}
        </button>
      </div>
    </div>
  );
}
