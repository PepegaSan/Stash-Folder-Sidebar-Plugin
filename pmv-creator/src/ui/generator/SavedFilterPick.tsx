/** Clip source "saved filter": one of the scene filters saved in Stash, with how many scenes it finds right now. */
import React, { useEffect, useState } from "react";
import { t, tn } from "../../i18n";
import { savedSceneFilter } from "../../stash/savedFilters";
import { queryScenes } from "../../stash/queries";
import type { StashRef } from "../../stash/types";
import { NumField } from "../common";

type Check = { state: "busy" } | { state: "ok"; count: number; skipped: string[] } | { state: "error"; error: string };

export function SavedFilterPick({ filters, value, onChange, limit, onLimit }: { filters: StashRef[]; value: StashRef | null; onChange: (v: StashRef | null) => void; limit: number; onLimit: (n: number) => void }) {
  const [check, setCheck] = useState<Check | null>(null);
  const known = value ? filters.some((f) => f.id === value.id) : true;
  useEffect(() => {
    if (!value) return setCheck(null);
    let alive = true;
    setCheck({ state: "busy" });
    (async () => {
      const sf = await savedSceneFilter(value.id);
      if (!sf) throw new Error(t("The saved filter “{name}” no longer exists in Stash.", { name: value.name }));
      const r = await queryScenes(sf.filter, { per_page: 1, q: sf.q || undefined });
      if (alive) setCheck({ state: "ok", count: r.count, skipped: sf.skipped });
    })().catch((e) => alive && setCheck({ state: "error", error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [value?.id]);

  return (
    <div className="pmv-grid2">
      <label>{t("Filter")}</label>
      <select className="form-control form-control-sm" value={value?.id ?? ""} onChange={(e) => onChange(filters.find((f) => f.id === e.target.value) ?? null)}>
        <option value="">{t("— choose —")}</option>
        {!known && value && <option value={value.id}>{value.name}</option>}
        {filters.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <label>{t("Count")}</label>
      <NumField value={limit} onCommit={(v) => onLimit(Math.round(v))} min={1} max={500} step={5} digits={0} suffix={t("scenes (random, seed)")} />
      {check && (
        <>
          <span />
          <span className={check.state === "error" ? "pmv-error" : "pmv-li-meta"}>
            {check.state === "busy" && t("Asking Stash…")}
            {check.state === "error" && check.error}
            {check.state === "ok" && (
              <>
                {tn(check.count, "{n} scenes match it right now", "1 scene matches it right now")}
                {check.skipped.length > 0 && ` · ⚠ ${t("not understood, left out: {list}", { list: check.skipped.join(", ") })}`}
              </>
            )}
          </span>
        </>
      )}
    </div>
  );
}
