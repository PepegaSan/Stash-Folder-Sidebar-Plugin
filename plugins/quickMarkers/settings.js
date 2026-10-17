// Settings page of Quick Markers – one module for both interfaces: quickMarkers.js mounts it into the
// PluginSettings patch (classic Stash, and Stash UI's Plugins page), stashui.js into Stash UI's settings section.
// The host passes what differs (env): theme, GraphQL, toasts, and how the presets are loaded and saved.
//
//   mountSettings(el, {
//     theme: "classic" | "stashui", lang: "de" | "en", t?(text, vars), version,
//     gql(query, vars) → data, toast(text, "ok" | "error"), confirm?({ title, text, ok, danger }) → bool,
//     load() → { config, source: "settings" | "file" | "defaults" }, save(config),
//     parseJson(text) → config, toJson(config) → text,
//   }) → { destroy() }

const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9];
const SELECT_KEY_RE = /^shift\+[1-9]$/;
const DEFAULT_KEYS = { rangeInKey: "shift+i", rangeOutKey: "shift+o", instantKey: "shift+m" };
const KEY_FIELDS = [
  ["rangeInKey", "In point"],
  ["rangeOutKey", "Out point + save"],
  ["instantKey", "Instant marker"],
];
const POSITIONS = [
  ["top-left", "Top left"],
  ["top-right", "Top right"],
  ["bottom-left", "Bottom left"],
  ["bottom-right", "Bottom right"],
  ["hidden", "Hidden (hotkeys only)"],
];
const TOUCH = [
  ["auto", "Auto"],
  ["on", "On"],
  ["off", "Off"],
];
const SUGGEST_DEBOUNCE_MS = 180;

// Key names in the Mousetrap spelling of quickMarkers.js ("shift+i", "shift+]", "shift+3")
const NAMED_KEYS = { arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down", escape: "esc", " ": "space", enter: "enter" };
const CODE_KEYS = {
  BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Comma: ",", Period: ".",
  Slash: "/", Semicolon: ";", Quote: "'", Backquote: "`", Backslash: "\\",
};
const MODIFIER_KEYS = new Set(["shift", "control", "alt", "meta", "altgraph", "capslock", "os"]);

export const STRINGS_DE = {
  "Set markers with hotkeys. Each preset decides which tags the marker gets.":
    "Marker per Tastenkürzel setzen. Jedes Preset legt fest, welche Tags der Marker bekommt.",
  Help: "Hilfe",
  General: "Allgemein",
  "Default preset": "Standard-Preset",
  "Active when a scene opens.": "Aktiv, wenn eine Szene öffnet.",
  "Panel position": "Panel-Position",
  "Drag the panel header to move it; double-click resets it.": "Ziehbar am Panel-Kopf; Doppelklick setzt zurück.",
  "Top left": "Oben links",
  "Top right": "Oben rechts",
  "Bottom left": "Unten links",
  "Bottom right": "Unten rechts",
  "Hidden (hotkeys only)": "Ausgeblendet (nur Tastenkürzel)",
  "Start collapsed": "Eingeklappt starten",
  "Touch controls": "Touch-Steuerung",
  Auto: "Auto",
  On: "An",
  Off: "Aus",
  "IN / OUT / INSTANT under the video. Auto: on touch devices.": "IN / OUT / SOFORT unter dem Video. Auto: auf Touch-Geräten.",
  Presets: "Presets",
  "New preset": "Neues Preset",
  Key: "Taste",
  "Preset and tags": "Preset und Tags",
  "In · Out · Instant": "In · Out · Sofort",
  Default: "Standard",
  "A tag is missing in Stash": "Ein Tag fehlt in Stash",
  "Tag doesn't exist in Stash": "Tag existiert in Stash nicht",
  "Edit {label}": "{label} bearbeiten",
  "Delete {label}": "{label} löschen",
  "Move {label}": "{label} verschieben",
  "Drag to change the order (or ↑ / ↓)": "Ziehen ändert die Reihenfolge (oder ↑ / ↓)",
  "Close editor": "Editor schließen",
  Name: "Name",
  "Primary tag": "Haupt-Tag",
  "Same as the name": "Wie der Name",
  "More tags": "Weitere Tags",
  "Add a tag …": "Tag hinzufügen …",
  "Only tags that exist in Stash. Enter takes the highlighted suggestion.":
    "Nur Tags, die es in Stash gibt. Enter übernimmt den markierten Vorschlag.",
  "Becomes the marker's primary tag. Empty: a tag named like the preset.":
    "Wird zum Haupt-Tag des Markers. Leer: ein Tag mit dem Namen des Presets.",
  "Select key": "Auswahl-Taste",
  None: "Keine",
  "With Shift. Struck through = taken by another preset.": "Mit Shift. Durchgestrichen = von einem anderen Preset belegt.",
  "Takes ⇧{n} over from “{label}”.": "Übernimmt ⇧{n} von „{label}“.",
  "taken: {label}": "belegt: {label}",
  "Keys of this preset": "Tasten dieses Presets",
  "In point": "In-Punkt",
  "Out point + save": "Out-Punkt + speichern",
  "Instant marker": "Sofort-Marker",
  "Press a key …": "Taste drücken …",
  "{what}: {key} – Enter to change": "{what}: {key} – Enter zum Ändern",
  "Click a field and press the combination. Esc cancels, Backspace resets.":
    "Feld anklicken und die Kombination drücken. Esc bricht ab, Rücktaste setzt zurück.",
  "{what}: Shift+1–9 are kept for selecting presets.": "{what}: Shift+1–9 sind für die Preset-Auswahl reserviert.",
  "{what}: Shift+[ / ] also switch the preset.": "{what}: Shift+[ / ] wechseln auch das Preset.",
  "{what}: without Shift or Ctrl the key also keeps its normal function in the player.":
    "{what}: Ohne Shift oder Strg behält die Taste auch ihre normale Funktion im Player.",
  "{a} and {b} have the same key.": "{a} und {b} haben dieselbe Taste.",
  Cancel: "Abbrechen",
  Save: "Speichern",
  Add: "Hinzufügen",
  "Give the preset a name.": "Gib dem Preset einen Namen.",
  "Preset added": "Preset hinzugefügt",
  "Preset updated": "Preset aktualisiert",
  "Preset removed": "Preset entfernt",
  "Order saved": "Reihenfolge gespeichert",
  Saved: "Gespeichert",
  Delete: "Löschen",
  'Remove preset "{label}"?': "Preset „{label}“ entfernen?",
  "Discard the changes to this preset?": "Änderungen an diesem Preset verwerfen?",
  Discard: "Verwerfen",
  "{n} scenes": "{n} Szenen",
  "1 scene": "1 Szene",
  "No matching tag": "Kein passender Tag",
  "Add “{name}”": "„{name}“ übernehmen",
  "Remove {name}": "{name} entfernen",
  Advanced: "Erweitert",
  "JSON, help": "JSON, Hilfe",
  "Saved in Stash": "Gespeichert in Stash",
  "Loaded from presets.json — saving here stores the presets in Stash.":
    "Aus presets.json geladen – Speichern hier legt die Presets in Stash ab.",
  "Built-in defaults — saving here stores the presets in Stash.":
    "Eingebaute Standardwerte – Speichern hier legt die Presets in Stash ab.",
  "These tags don't exist in Stash, so their presets can't create markers: {names}. Create the tags or fix the presets.":
    "Diese Tags gibt es in Stash nicht, die zugehörigen Presets können keine Marker anlegen: {names}. Tags anlegen oder Presets korrigieren.",
  "In the player": "Im Player",
  "select preset": "Preset wählen",
  "previous / next": "voriges / nächstes",
  "Presets as JSON": "Presets als JSON",
  "Save JSON": "JSON speichern",
  "Replaces all presets. Fields: id, label, primaryTag, tags, rangeInKey, rangeOutKey, instantKey, selectSlot (1–9 or null), plus defaultPresetIndex.":
    "Ersetzt alle Presets. Felder: id, label, primaryTag, tags, rangeInKey, rangeOutKey, instantKey, selectSlot (1–9 oder null), dazu defaultPresetIndex.",
  "How presets work": "So funktionieren Presets",
  "A preset is one kind of marker: its primary tag becomes the marker's primary tag, the more tags are added to the marker. Every tag must exist in Stash (Tags page) — missing ones are shown in red.":
    "Ein Preset ist eine Art von Marker: Sein Haupt-Tag wird zum Haupt-Tag des Markers, die weiteren Tags kommen dazu. Jeder Tag muss in Stash existieren (Seite Tags) – fehlende werden rot angezeigt.",
  "While watching, Shift+1–9 (the select key) or Shift+[ / ] pick the active preset. In, Out and Instant always work for the active preset, so usually every preset keeps Shift+I / O / M.":
    "Beim Schauen wählen Shift+1–9 (die Auswahl-Taste) oder Shift+[ / ] das aktive Preset. In, Out und Sofort gelten immer für das aktive Preset, daher behalten meist alle Presets Shift+I / O / M.",
  "The order here is the order of the preset chips on the scene page. Drag the handle on the left to change it.":
    "Die Reihenfolge hier ist die der Preset-Chips auf der Szenenseite. Zum Ändern links am Griff ziehen.",
  "Changes apply to markers created afterwards; existing markers keep their tags (edit them in Stash under Markers).":
    "Änderungen gelten für Marker, die danach entstehen; bestehende Marker behalten ihre Tags (in Stash unter Markers bearbeiten).",
  "Loading …": "Lade …",
};

export function mountSettings(el, env) {
  const stashui = env.theme === "stashui";
  const t = env.t || ((text, vars) => fill(env.lang === "de" && STRINGS_DE[text] != null ? STRINGS_DE[text] : text, vars));
  const C = stashui
    ? { btn: "kb-btn", primary: "kb-btn is-primary", ghost: "kb-btn is-ghost", danger: "kb-btn is-danger", field: "kb-field" }
    : { btn: "btn btn-secondary", primary: "btn btn-primary", ghost: "btn btn-link", danger: "btn btn-danger", field: "form-control" };
  const ac = new AbortController();
  const on = (type, fn, opts) => el.addEventListener(type, fn, Object.assign({ signal: ac.signal }, opts));
  const timers = new Map();
  const tagCache = new Map(); // lower-case name → Promise<boolean> (exists in Stash)

  const S = {
    config: null,
    source: "settings",
    open: null, // id of the preset in the editor, "new" for a new one
    draft: null,
    base: "", // the draft as it was opened (to notice changes)
    typing: { primaryTag: "", tags: "" }, // text in the tag inputs
    suggest: null, // { field, items, index }
    recording: null, // key field waiting for a key press
    missing: new Set(), // lower-case tag names that don't exist in Stash
    advanced: false,
    json: null, // text in the JSON editor (null = from the config)
  };

  // ---------- Helpers ----------

  const err = (e) => (e && e.message) || String(e);
  const fmtNum = (n) => Number(n || 0).toLocaleString(env.lang === "de" ? "de-DE" : undefined);
  const scenesText = (n) => (n === 1 ? t("1 scene") : t("{n} scenes", { n: fmtNum(n) }));
  const lower = (s) => String(s || "").trim().toLowerCase();
  const presets = () => S.config.presets;

  function keyParts(combo) {
    return String(combo || "")
      .split("+")
      .filter(Boolean)
      .map((p) => (p === "shift" ? "Shift" : p === "ctrl" ? (stashui || env.lang !== "de" ? "Ctrl" : "Strg") : p === "alt" ? "Alt" : p === "meta" ? "Meta" : p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1)));
  }

  function keyShort(combo) {
    return String(combo || "")
      .split("+")
      .map((p) => (p === "shift" ? "⇧" : p === "ctrl" ? "Ctrl+" : p === "alt" ? "Alt+" : p === "meta" ? "Meta+" : p.toUpperCase()))
      .join("");
  }

  // The combo of a key press, or null for a modifier alone. Letters as typed (keyboard layout), digits and
  // brackets by their physical key (Shift+1 gives "!" in e.key, Shift+[ gives "{").
  function comboOf(e) {
    const k = String(e.key || "").toLowerCase();
    if (!k || MODIFIER_KEYS.has(k) || k === "dead" || k === "unidentified") return null;
    const c = e.code || "";
    let key;
    if (/^[a-z]$/.test(k)) key = k;
    else if (/^Digit\d$/.test(c)) key = c.slice(5);
    else if (/^Numpad\d$/.test(c)) key = c.slice(6);
    else if (CODE_KEYS[c]) key = CODE_KEYS[c];
    else key = NAMED_KEYS[k] || k;
    const mods = [];
    if (e.ctrlKey) mods.push("ctrl");
    if (e.altKey) mods.push("alt");
    if (e.metaKey) mods.push("meta");
    if (e.shiftKey) mods.push("shift");
    return mods.concat(key).join("+");
  }

  function keyProblems(d) {
    const out = [];
    const what = Object.fromEntries(KEY_FIELDS.map(([f, label]) => [f, t(label)]));
    KEY_FIELDS.forEach(([f]) => {
      const k = d[f];
      if (SELECT_KEY_RE.test(k)) out.push({ field: f, block: true, text: t("{what}: Shift+1–9 are kept for selecting presets.", { what: what[f] }) });
      else if (k === "shift+[" || k === "shift+]") out.push({ field: f, block: false, text: t("{what}: Shift+[ / ] also switch the preset.", { what: what[f] }) });
      else if (k.split("+").length < 2) out.push({ field: f, block: false, text: t("{what}: without Shift or Ctrl the key also keeps its normal function in the player.", { what: what[f] }) });
    });
    for (let i = 0; i < KEY_FIELDS.length; i++) {
      for (let j = i + 1; j < KEY_FIELDS.length; j++) {
        const a = KEY_FIELDS[i][0];
        const b = KEY_FIELDS[j][0];
        if (d[a] === d[b]) out.push({ field: b, block: true, text: t("{a} and {b} have the same key.", { a: what[a], b: what[b] }) });
      }
    }
    return out;
  }

  // Exact name (Stash compares case-insensitively), else an exact alias – like the marker code itself
  function tagExists(name) {
    const key = lower(name);
    if (!tagCache.has(key)) {
      const q = "query($f: FindFilterType, $tf: TagFilterType) { findTags(filter: $f, tag_filter: $tf) { tags { id } } }";
      const p = (async () => {
        for (const field of ["name", "aliases"]) {
          const d = await env.gql(q, { f: { per_page: 1 }, tf: { [field]: { value: name, modifier: "EQUALS" } } });
          if (d && d.findTags && d.findTags.tags.length) return true;
        }
        return false;
      })();
      p.catch(() => tagCache.delete(key));
      tagCache.set(key, p);
    }
    return tagCache.get(key);
  }

  async function checkTags() {
    const names = new Map();
    presets().forEach((p) => [p.primaryTag].concat(p.tags || []).forEach((n) => names.set(lower(n), n)));
    if (S.draft) S.draft.primaryTag.concat(S.draft.tags).forEach((n) => names.set(lower(n), n));
    const missing = new Set();
    await Promise.all(
      [...names].map(async ([key, name]) => {
        try {
          if (!(await tagExists(name))) missing.add(key);
        } catch (e) {
          /* unknown – not marked */
        }
      })
    );
    if (ac.signal.aborted) return;
    const changed = missing.size !== S.missing.size || [...missing].some((k) => !S.missing.has(k));
    S.missing = missing;
    if (changed) paint();
  }

  async function suggest(field, text) {
    const q = text.trim();
    if (!q) {
      S.suggest = null;
      return paintSuggest(field);
    }
    const d = await env.gql("query($f: FindFilterType) { findTags(filter: $f) { tags { id name scene_count aliases } } }", { f: { q, per_page: 30 } });
    if (ac.signal.aborted || S.typing[field].trim() !== q) return;
    const ql = q.toLowerCase();
    const taken = new Set(S.draft.primaryTag.concat(S.draft.tags).map(lower));
    const rank = (tg) => {
      const n = tg.name.toLowerCase();
      return n === ql ? 0 : n.startsWith(ql) ? 1 : n.includes(ql) ? 2 : 3;
    };
    const items = ((d && d.findTags && d.findTags.tags) || [])
      .filter((tg) => !taken.has(tg.name.toLowerCase()))
      .sort((a, b) => rank(a) - rank(b) || (b.scene_count || 0) - (a.scene_count || 0) || a.name.localeCompare(b.name))
      .slice(0, 8)
      .map((tg) => {
        tagCache.set(tg.name.toLowerCase(), Promise.resolve(true));
        const alias = rank(tg) === 3 ? (tg.aliases || []).find((a) => a.toLowerCase().includes(ql)) : null;
        return { name: tg.name, count: tg.scene_count || 0, alias };
      });
    S.suggest = { field, items, index: 0, q };
    paintSuggest(field);
  }

  function later(key, ms, fn) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(fn, ms));
  }

  // ---------- Drafts ----------

  function newDraft() {
    const used = new Set(presets().map((p) => p.selectSlot).filter(Boolean));
    return { label: "", primaryTag: [], tags: [], selectSlot: SLOTS.find((n) => !used.has(n)) || null, ...DEFAULT_KEYS };
  }

  function presetDraft(p) {
    return {
      label: p.label,
      primaryTag: p.primaryTag ? [p.primaryTag] : [],
      tags: (p.tags || []).slice(),
      selectSlot: p.selectSlot || null,
      rangeInKey: p.rangeInKey || DEFAULT_KEYS.rangeInKey,
      rangeOutKey: p.rangeOutKey || DEFAULT_KEYS.rangeOutKey,
      instantKey: p.instantKey || DEFAULT_KEYS.instantKey,
    };
  }

  const dirty = () => !!S.draft && JSON.stringify(S.draft) !== S.base;

  async function openEditor(id) {
    if (S.open === id) return;
    if (dirty() && !(await ask({ title: "Quick Markers", text: t("Discard the changes to this preset?"), ok: t("Discard"), danger: true }))) return;
    const preset = id === "new" ? null : presets().find((p) => p.id === id);
    if (id !== "new" && !preset) return;
    S.open = id;
    S.draft = preset ? presetDraft(preset) : newDraft();
    S.base = JSON.stringify(S.draft);
    S.typing = { primaryTag: "", tags: "" };
    S.suggest = null;
    S.recording = null;
    paint();
    const editor = el.querySelector("[data-editor]");
    if (editor) {
      editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
      const name = editor.querySelector('[data-draft="label"]');
      if (name) name.focus({ preventScroll: true });
    }
  }

  function closeEditor() {
    S.open = null;
    S.draft = null;
    S.suggest = null;
    S.recording = null;
    paint();
  }

  function addName(field, raw) {
    const d = S.draft;
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((name) => {
        const key = lower(name);
        if (field === "primaryTag") {
          d.primaryTag = [name];
          d.tags = d.tags.filter((n) => lower(n) !== key);
        } else if (!d.tags.concat(d.primaryTag).some((n) => lower(n) === key)) {
          d.tags.push(name);
        }
        tagExists(name)
          .then((ok) => {
            if (ac.signal.aborted || ok === !S.missing.has(key)) return;
            if (ok) S.missing.delete(key);
            else S.missing.add(key);
            paint();
          })
          .catch(() => {});
      });
    S.typing[field] = "";
    S.suggest = null;
    paint();
  }

  async function saveDraft() {
    const d = S.draft;
    const label = d.label.trim();
    if (!label) {
      env.toast(t("Give the preset a name."), "error");
      const name = el.querySelector('[data-draft="label"]');
      if (name) name.focus();
      return;
    }
    if (S.typing.primaryTag.trim()) addName("primaryTag", S.typing.primaryTag);
    if (S.typing.tags.trim()) addName("tags", S.typing.tags);
    const blocking = keyProblems(d).find((p) => p.block);
    if (blocking) {
      env.toast(blocking.text, "error");
      return;
    }
    const primaryTag = (d.primaryTag[0] || label).trim();
    const fields = {
      label,
      primaryTag,
      tags: d.tags.filter((n) => lower(n) !== lower(primaryTag)),
      title: label,
      rangeInKey: d.rangeInKey,
      rangeOutKey: d.rangeOutKey,
      instantKey: d.instantKey,
      selectSlot: d.selectSlot || null,
    };
    // A select slot belongs to one preset: taking it clears it on the others
    const freeSlot = (p) => (fields.selectSlot && p.selectSlot === fields.selectSlot ? Object.assign({}, p, { selectSlot: null }) : p);
    const editing = S.open !== "new" ? S.open : null;
    const list = editing
      ? presets().map((p) => (p.id === editing ? Object.assign({}, p, fields) : freeSlot(p)))
      : presets().map(freeSlot).concat([Object.assign({ id: uniqueId(label) }, fields)]);
    if (await persist(Object.assign({}, S.config, { presets: list }), editing ? t("Preset updated") : t("Preset added"))) {
      S.open = null;
      S.draft = null;
      paint();
    }
  }

  function uniqueId(label) {
    const base = label.toLowerCase().replace(/\s+/g, "-") || "preset";
    const taken = new Set(presets().map((p) => p.id));
    let id = base;
    for (let n = 2; taken.has(id); n++) id = base + "-" + n;
    return id;
  }

  async function persist(next, message) {
    try {
      await env.save(next);
      S.config = next;
      S.source = "settings";
      S.json = null;
      if (message) env.toast(message, "ok");
      checkTags();
      return true;
    } catch (e) {
      env.toast(err(e), "error");
      return false;
    } finally {
      paint();
    }
  }

  // Moves a preset; the default preset stays the same preset
  function move(from, to) {
    const list = presets().slice();
    if (to < 0 || to >= list.length || from === to) return;
    const defaultId = list[S.config.defaultPresetIndex] && list[S.config.defaultPresetIndex].id;
    list.splice(to, 0, list.splice(from, 1)[0]);
    const defaultPresetIndex = Math.max(0, list.findIndex((p) => p.id === defaultId));
    persist(Object.assign({}, S.config, { presets: list, defaultPresetIndex }), t("Order saved"));
  }

  async function remove(id) {
    const index = presets().findIndex((p) => p.id === id);
    const preset = presets()[index];
    if (!preset || presets().length < 2) return;
    if (!(await ask({ title: "Quick Markers", text: t('Remove preset "{label}"?', { label: preset.label }), ok: t("Delete"), danger: true }))) return;
    const list = presets().filter((p) => p.id !== id);
    const cur = S.config.defaultPresetIndex;
    const defaultPresetIndex = index < cur ? cur - 1 : Math.min(cur, list.length - 1);
    if (S.open === id) {
      S.open = null;
      S.draft = null;
    }
    persist(Object.assign({}, S.config, { presets: list, defaultPresetIndex }), t("Preset removed"));
  }

  function ask(opts) {
    if (env.confirm) return Promise.resolve(env.confirm(opts)).then(Boolean);
    return new Promise((resolve) => {
      const back = document.createElement("div");
      back.className = "qms qms-modal-back is-" + env.theme;
      back.innerHTML = `<div class="qms-modal" role="dialog" aria-modal="true" aria-labelledby="qms-modal-title">
          <h3 id="qms-modal-title">${esc(opts.title)}</h3><p>${esc(opts.text)}</p>
          <div class="qms-modal-foot"><button type="button" class="${C.btn}" data-no>${esc(t("Cancel"))}</button><button type="button" class="${opts.danger ? C.danger : C.primary}" data-yes>${esc(opts.ok)}</button></div>
        </div>`;
      const done = (value) => {
        back.remove();
        document.removeEventListener("keydown", onKey, true);
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        done(false);
      };
      back.addEventListener("click", (e) => {
        if (e.target === back || e.target.closest("[data-no]")) done(false);
        else if (e.target.closest("[data-yes]")) done(true);
      });
      document.addEventListener("keydown", onKey, true);
      document.body.appendChild(back);
      back.querySelector("[data-yes]").focus();
    });
  }

  // ---------- Drawing ----------

  function chip(name, main, removeField, index) {
    const miss = S.missing.has(lower(name));
    const cls = "qms-chip" + (main ? " is-main" : "") + (miss ? " is-miss" : "");
    return `<span class="${cls}"${miss ? ` title="${esc(t("Tag doesn't exist in Stash"))}"` : ""}>${main ? ICON.star : ""}${esc(name)}${
      removeField ? `<button type="button" class="qms-chip-x" data-unchip="${removeField}" data-i="${index}" aria-label="${esc(t("Remove {name}", { name }))}">${ICON.x}</button>` : ""
    }</span>`;
  }

  function chipBox(field) {
    const d = S.draft;
    const single = field === "primaryTag";
    const list = d[field];
    const placeholder = single ? (list.length ? "" : d.label.trim() || t("Same as the name")) : t("Add a tag …");
    const open = S.suggest && S.suggest.field === field;
    return `<div class="${C.field} qms-chipbox" data-chipbox="${field}">
        ${list.map((n, i) => chip(n, single, field, i)).join("")}
        <input class="qms-chipinput" data-chipinput="${field}" data-focus="chip:${field}" value="${esc(S.typing[field])}" placeholder="${esc(placeholder)}"
          autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="${open}" aria-controls="qms-sg-${field}" aria-label="${esc(t(single ? "Primary tag" : "More tags"))}">
        <div class="qms-suggest" id="qms-sg-${field}" role="listbox" data-suggest="${field}"${open ? "" : " hidden"}>${open ? suggestHtml() : ""}</div>
      </div>`;
  }

  function suggestHtml() {
    const sg = S.suggest;
    const mark = (name) => {
      const i = name.toLowerCase().indexOf(sg.q.toLowerCase());
      return i < 0 ? esc(name) : esc(name.slice(0, i)) + "<b>" + esc(name.slice(i, i + sg.q.length)) + "</b>" + esc(name.slice(i + sg.q.length));
    };
    const exact = sg.items.some((it) => it.name.toLowerCase() === sg.q.toLowerCase());
    const rows = sg.items.map(
      (it, i) => `<div class="qms-sg-item${i === sg.index ? " is-active" : ""}" role="option" aria-selected="${i === sg.index}" data-pick="${esc(it.name)}">
          <span>${mark(it.name)}${it.alias ? ` <small>(${esc(it.alias)})</small>` : ""}</span><small>${esc(scenesText(it.count))}</small></div>`
    );
    if (!exact) rows.push(`<div class="qms-sg-item qms-sg-free${sg.index === sg.items.length ? " is-active" : ""}" role="option" data-pick="${esc(sg.q)}">${esc(t("Add “{name}”", { name: sg.q }))}${sg.items.length ? "" : ` <small>${esc(t("No matching tag"))}</small>`}</div>`);
    return rows.join("");
  }

  function paintSuggest(field) {
    const box = el.querySelector(`[data-suggest="${field}"]`);
    const input = el.querySelector(`[data-chipinput="${field}"]`);
    if (!box) return;
    const open = !!(S.suggest && S.suggest.field === field);
    box.hidden = !open;
    box.innerHTML = open ? suggestHtml() : "";
    if (input) input.setAttribute("aria-expanded", String(open));
  }

  function keyBox(field, label) {
    const d = S.draft;
    const rec = S.recording === field;
    const bad = keyProblems(d).some((p) => p.field === field && p.block);
    const keys = rec
      ? `<span class="qms-rec"><i></i>${esc(t("Press a key …"))}</span>`
      : keyParts(d[field]).map((p) => `<kbd class="qms-kbd">${esc(p)}</kbd>`).join("");
    return `<label class="${C.field} qms-keybox${rec ? " is-rec" : ""}${bad ? " is-bad" : ""}" data-keybox="${field}">
        <span class="qms-keybox-label">${esc(t(label))}</span><span class="qms-keybox-keys">${keys}</span>
        <input class="qms-keybox-input" data-keyrec="${field}" data-focus="key:${field}" readonly
          aria-label="${esc(t("{what}: {key} – Enter to change", { what: t(label), key: keyParts(d[field]).join("+") }))}">
      </label>`;
  }

  function editorHtml(preset) {
    const d = S.draft;
    const owner = d.selectSlot ? presets().find((p) => p.selectSlot === d.selectSlot && (!preset || p.id !== preset.id)) : null;
    const slotBtn = (n) => {
      const taken = presets().find((p) => p.selectSlot === n && (!preset || p.id !== preset.id));
      const on = d.selectSlot === n;
      return `<button type="button" class="qms-slotbtn${on ? " is-on" : ""}${taken && !on ? " is-taken" : ""}" data-slot="${n}" aria-pressed="${on}"${
        taken ? ` title="${esc(t("taken: {label}", { label: taken.label }))}"` : ""
      }>${n}</button>`;
    };
    const problems = keyProblems(d);
    return `<div class="qms-editor" data-editor>
        <div class="qms-ed-grid">
          <div class="qms-ed-col">
            <label class="qms-field"><span class="qms-label">${esc(t("Name"))}</span>
              <input class="${C.field}" data-draft="label" data-focus="label" value="${esc(d.label)}" placeholder="Compilation" maxlength="80" autocomplete="off"></label>
            <div class="qms-field"><span class="qms-label">${esc(t("Primary tag"))}</span>${chipBox("primaryTag")}
              <small class="qms-hint">${esc(t("Becomes the marker's primary tag. Empty: a tag named like the preset."))}</small></div>
            <div class="qms-field"><span class="qms-label">${esc(t("More tags"))}</span>${chipBox("tags")}
              <small class="qms-hint">${esc(t("Only tags that exist in Stash. Enter takes the highlighted suggestion."))}</small></div>
          </div>
          <div class="qms-ed-col">
            <div class="qms-field"><span class="qms-label">${esc(t("Select key"))}</span>
              <div class="qms-slots" role="group" aria-label="${esc(t("Select key"))}">${SLOTS.map(slotBtn).join("")}<button type="button" class="qms-slotbtn qms-slotnone${d.selectSlot ? "" : " is-on"}" data-slot="" aria-pressed="${!d.selectSlot}">${esc(t("None"))}</button></div>
              <small class="qms-hint${owner ? " is-note" : ""}">${esc(owner ? t("Takes ⇧{n} over from “{label}”.", { n: d.selectSlot, label: owner.label }) : t("With Shift. Struck through = taken by another preset."))}</small></div>
            <div class="qms-field"><span class="qms-label">${esc(t("Keys of this preset"))}</span>
              <div class="qms-keyboxes">${KEY_FIELDS.map(([f, label]) => keyBox(f, label)).join("")}</div>
              ${problems.length ? problems.map((p) => `<small class="qms-hint ${p.block ? "is-bad" : "is-note"}">${ICON.warn}${esc(p.text)}</small>`).join("") : `<small class="qms-hint">${esc(t("Click a field and press the combination. Esc cancels, Backspace resets."))}</small>`}
            </div>
          </div>
        </div>
        <div class="qms-ed-foot">
          <button type="button" class="${C.btn}" data-act="cancel">${esc(t("Cancel"))}</button>
          <button type="button" class="${C.primary}" data-act="save">${preset ? ICON.check + esc(t("Save")) : ICON.plus + esc(t("Add"))}</button>
        </div>
      </div>`;
  }

  function rowHtml(p, i) {
    const open = S.open === p.id;
    const isDefault = i === S.config.defaultPresetIndex;
    const names = [p.primaryTag].concat(p.tags || []);
    const miss = names.some((n) => S.missing.has(lower(n)));
    return `<div class="qms-row${open ? " is-open" : ""}" data-row="${esc(p.id)}">
        <button type="button" class="qms-grip" data-grip="${esc(p.id)}" data-focus="grip:${esc(p.id)}" aria-label="${esc(t("Move {label}", { label: p.label }))}" title="${esc(t("Drag to change the order (or ↑ / ↓)"))}">${ICON.grip}</button>
        <span class="qms-slot${p.selectSlot ? "" : " is-none"}">${p.selectSlot ? "⇧" + p.selectSlot : "–"}</span>
        <div class="qms-main" data-toggle="${esc(p.id)}">
          <div class="qms-name"><b>${esc(p.label)}</b>${isDefault ? `<span class="qms-badge">${esc(t("Default"))}</span>` : ""}${
            miss ? `<span class="qms-warnline">${ICON.warn}${esc(t("A tag is missing in Stash"))}</span>` : ""
          }</div>
          <div class="qms-chips">${names.map((n, j) => chip(n, j === 0)).join("")}</div>
        </div>
        <div class="qms-rowkeys">${KEY_FIELDS.map(([f, label]) => `<kbd class="qms-kbd" title="${esc(t(label))}">${esc(keyShort(p[f] || DEFAULT_KEYS[f]))}</kbd>`).join("")}</div>
        <div class="qms-actions">${
          open
            ? `<button type="button" class="qms-ib is-on" data-act="cancel" aria-label="${esc(t("Close editor"))}" title="${esc(t("Close editor"))}">${ICON.up}</button>`
            : `<button type="button" class="qms-ib" data-edit="${esc(p.id)}" aria-label="${esc(t("Edit {label}", { label: p.label }))}" title="${esc(t("Edit {label}", { label: p.label }))}">${ICON.edit}</button>
               <button type="button" class="qms-ib is-danger" data-del="${esc(p.id)}" aria-label="${esc(t("Delete {label}", { label: p.label }))}" title="${esc(t("Delete {label}", { label: p.label }))}"${presets().length < 2 ? " disabled" : ""}>${ICON.trash}</button>`
        }</div>
      </div>${open ? editorHtml(p) : ""}`;
  }

  function generalHtml() {
    const c = S.config;
    const fields = [
      `<label class="qms-field"><span class="qms-label">${esc(t("Default preset"))}</span>
        <select class="${C.field}" data-set="defaultPresetIndex">${presets().map((p, i) => `<option value="${i}"${i === c.defaultPresetIndex ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</select>
        <small class="qms-hint">${esc(t("Active when a scene opens."))}</small></label>`,
    ];
    if (!stashui) {
      const pos = c.panelPosition || "top-left";
      const touch = c.touchControls || "auto";
      fields.push(
        `<div class="qms-field"><label class="qms-label" for="qms-pos">${esc(t("Panel position"))}</label>
          <select id="qms-pos" class="${C.field}" data-set="panelPosition">${POSITIONS.map(([v, l]) => `<option value="${v}"${v === pos ? " selected" : ""}>${esc(t(l))}</option>`).join("")}</select>
          <label class="qms-check"><input type="checkbox" data-set="panelCollapsed"${c.panelCollapsed !== false ? " checked" : ""}> ${esc(t("Start collapsed"))}</label></div>`,
        `<div class="qms-field"><span class="qms-label">${esc(t("Touch controls"))}</span>
          <div class="qms-seg" role="group" aria-label="${esc(t("Touch controls"))}">${TOUCH.map(([v, l]) => `<button type="button" data-touch="${v}" class="${v === touch ? "is-on" : ""}" aria-pressed="${v === touch}">${esc(t(l))}</button>`).join("")}</div>
          <small class="qms-hint">${esc(t("IN / OUT / INSTANT under the video. Auto: on touch devices."))}</small></div>`
      );
    }
    return `<section class="qms-card qms-general${stashui ? " is-single" : ""}" aria-label="${esc(t("General"))}">${fields.join("")}</section>`;
  }

  function html() {
    if (!S.config) return `<div class="qms qms-page is-${env.theme}"><p class="qms-hint">${esc(t("Loading …"))}</p></div>`;
    const note =
      S.source === "file" ? t("Loaded from presets.json — saving here stores the presets in Stash.")
      : S.source === "defaults" ? t("Built-in defaults — saving here stores the presets in Stash.")
      : "";
    const missingNames = [...new Set(presets().flatMap((p) => [p.primaryTag].concat(p.tags || [])).filter((n) => S.missing.has(lower(n))))];
    const isNew = S.open === "new";
    const json = S.json != null ? S.json : env.toJson(S.config);
    return `<div class="qms qms-page is-${env.theme}">
        <header class="qms-head">
          <div>
            <div class="qms-title"><h2>Quick Markers</h2><span class="qms-ver">v${esc(env.version)}</span></div>
            <p class="qms-sub">${esc(t("Set markers with hotkeys. Each preset decides which tags the marker gets."))}</p>
          </div>
          <div class="qms-head-actions">
            <button type="button" class="${C.ghost} qms-hbtn" data-act="json">${ICON.code}JSON</button>
            <button type="button" class="${C.ghost} qms-hbtn" data-act="help">${ICON.help}${esc(t("Help"))}</button>
          </div>
        </header>
        ${note ? `<p class="qms-note">${esc(note)}</p>` : ""}
        ${missingNames.length ? `<p class="qms-note is-bad">${ICON.warn}<span>${esc(t("These tags don't exist in Stash, so their presets can't create markers: {names}. Create the tags or fix the presets.", { names: missingNames.join(", ") }))}</span></p>` : ""}
        ${generalHtml()}
        <section class="qms-presets">
          <div class="qms-sechead">
            <h3>${esc(t("Presets"))} <span>${presets().length}</span></h3>
            <button type="button" class="${C.primary}" data-act="new"${isNew ? " disabled" : ""}>${ICON.plus}${esc(t("New preset"))}</button>
          </div>
          <div class="qms-list" data-list>
            <div class="qms-row qms-row-head" aria-hidden="true"><span></span><span>${esc(t("Key"))}</span><span>${esc(t("Preset and tags"))}</span><span class="qms-rowkeys">${esc(t("In · Out · Instant"))}</span><span></span></div>
            ${presets().map(rowHtml).join("")}
            ${isNew ? `<div class="qms-row is-open qms-row-new"><span></span><span class="qms-slot">${S.draft.selectSlot ? "⇧" + S.draft.selectSlot : "–"}</span><div class="qms-main"><div class="qms-name"><b>${esc(S.draft.label.trim() || t("New preset"))}</b></div></div><span class="qms-rowkeys"></span>
                <div class="qms-actions"><button type="button" class="qms-ib is-on" data-act="cancel" aria-label="${esc(t("Close editor"))}">${ICON.up}</button></div></div>${editorHtml(null)}` : ""}
          </div>
          <p class="qms-hint qms-hotkeys">${esc(t("In the player"))}: <kbd class="qms-kbd">⇧1</kbd>–<kbd class="qms-kbd">⇧9</kbd> ${esc(t("select preset"))} · <kbd class="qms-kbd">⇧[</kbd> <kbd class="qms-kbd">⇧]</kbd> ${esc(t("previous / next"))}</p>
        </section>
        <details class="qms-adv" data-adv${S.advanced ? " open" : ""}>
          <summary>${ICON.right}<b>${esc(t("Advanced"))}</b><span>${esc(t("JSON, help"))}</span><small>${esc(t("Saved in Stash"))}</small></summary>
          <div class="qms-adv-body">
            <div class="qms-help" data-help>
              <h4>${esc(t("How presets work"))}</h4>
              <p>${esc(t("A preset is one kind of marker: its primary tag becomes the marker's primary tag, the more tags are added to the marker. Every tag must exist in Stash (Tags page) — missing ones are shown in red."))}</p>
              <p>${esc(t("While watching, Shift+1–9 (the select key) or Shift+[ / ] pick the active preset. In, Out and Instant always work for the active preset, so usually every preset keeps Shift+I / O / M."))}</p>
              <p>${esc(t("The order here is the order of the preset chips on the scene page. Drag the handle on the left to change it."))}</p>
              <p>${esc(t("Changes apply to markers created afterwards; existing markers keep their tags (edit them in Stash under Markers)."))}</p>
            </div>
            <div class="qms-field" data-jsonbox>
              <label class="qms-label" for="qms-json">${esc(t("Presets as JSON"))}</label>
              <textarea id="qms-json" class="${C.field} qms-json" rows="14" spellcheck="false" data-json data-focus="json">${esc(json)}</textarea>
              <small class="qms-hint">${esc(t("Replaces all presets. Fields: id, label, primaryTag, tags, rangeInKey, rangeOutKey, instantKey, selectSlot (1–9 or null), plus defaultPresetIndex."))}</small>
              <div><button type="button" class="${C.primary}" data-act="savejson">${esc(t("Save JSON"))}</button></div>
            </div>
          </div>
        </details>
      </div>`;
  }

  // Draws everything again; the focused field keeps its focus and cursor
  function paint() {
    if (ac.signal.aborted) return;
    const a = document.activeElement;
    const focus = a && el.contains(a) && a.dataset ? a.dataset.focus : null;
    const range = focus && typeof a.selectionStart === "number" ? [a.selectionStart, a.selectionEnd] : null;
    el.innerHTML = html();
    if (!focus) return;
    const n = el.querySelector(`[data-focus="${CSS.escape(focus)}"]`);
    if (!n) return;
    n.focus({ preventScroll: true });
    if (range) {
      try {
        n.setSelectionRange(range[0], range[1]);
      } catch (e) {
        /* (not a text field) */
      }
    }
  }

  function setRecording(field) {
    const prev = S.recording;
    S.recording = field;
    [prev, field].filter(Boolean).forEach((f) => {
      const box = el.querySelector(`[data-keybox="${f}"]`);
      if (!box) return;
      const rec = S.recording === f;
      box.classList.toggle("is-rec", rec);
      box.querySelector(".qms-keybox-keys").innerHTML = rec
        ? `<span class="qms-rec"><i></i>${esc(t("Press a key …"))}</span>`
        : keyParts(S.draft[f]).map((p) => `<kbd class="qms-kbd">${esc(p)}</kbd>`).join("");
    });
  }

  function openAdvanced(part) {
    S.advanced = true;
    paint();
    const target = el.querySelector(part === "json" ? "[data-jsonbox]" : "[data-help]");
    if (!target) return;
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    if (part === "json") el.querySelector("[data-json]").focus({ preventScroll: true });
  }

  // ---------- Events ----------

  on("click", (e) => {
    const pick = e.target.closest("[data-pick]");
    if (pick) return addName(pick.closest("[data-suggest]").dataset.suggest, pick.dataset.pick);
    const box = e.target.closest("[data-chipbox]");
    if (box && !e.target.closest("button")) {
      const input = box.querySelector("[data-chipinput]");
      if (input && e.target !== input) input.focus();
    }
    const keyrec = e.target.closest("[data-keyrec]");
    if (keyrec) return setRecording(keyrec.dataset.keyrec);
    const toggle = e.target.closest("[data-toggle]");
    if (toggle && !e.target.closest("button")) return S.open === toggle.dataset.toggle ? closeEditor() : openEditor(toggle.dataset.toggle);
    const b = e.target.closest("button");
    if (!b || !el.contains(b)) return;
    if (b.dataset.unchip) {
      S.draft[b.dataset.unchip].splice(Number(b.dataset.i), 1);
      return paint();
    }
    if (b.dataset.slot != null) {
      S.draft.selectSlot = b.dataset.slot ? Number(b.dataset.slot) : null;
      return paint();
    }
    if (b.dataset.touch) return persist(Object.assign({}, S.config, { touchControls: b.dataset.touch }), t("Saved"));
    if (b.dataset.edit) return openEditor(b.dataset.edit);
    if (b.dataset.del) return remove(b.dataset.del);
    const act = b.dataset.act;
    if (act === "new") openEditor("new");
    else if (act === "cancel") closeEditor();
    else if (act === "save") saveDraft();
    else if (act === "json" || act === "help") openAdvanced(act);
    else if (act === "savejson") {
      let parsed;
      try {
        parsed = env.parseJson(el.querySelector("[data-json]").value);
        if (!parsed) throw new Error("presets must be a non-empty array");
      } catch (x) {
        return env.toast("JSON: " + err(x), "error");
      }
      S.open = null;
      S.draft = null;
      persist(parsed, t("Saved"));
    }
  });

  // Picking a suggestion must not take the focus out of the tag input first
  on("mousedown", (e) => {
    if (e.target.closest("[data-pick]")) e.preventDefault();
  });

  on("input", (e) => {
    const n = e.target;
    if (n.dataset.draft) {
      S.draft[n.dataset.draft] = n.value;
      const ph = el.querySelector('[data-chipinput="primaryTag"]');
      if (n.dataset.draft === "label" && ph && !S.draft.primaryTag.length) ph.placeholder = n.value.trim() || t("Same as the name");
    } else if (n.dataset.chipinput) {
      const field = n.dataset.chipinput;
      if (n.value.includes(",")) {
        const parts = n.value.split(",");
        S.typing[field] = parts.pop();
        addName(field, parts.join(","));
        return;
      }
      S.typing[field] = n.value;
      later("sg:" + field, SUGGEST_DEBOUNCE_MS, () => suggest(field, n.value).catch(() => {}));
    } else if (n.dataset.json != null) S.json = n.value;
  });

  on("change", (e) => {
    const n = e.target;
    const key = n.dataset.set;
    if (!key) return;
    const value = key === "panelCollapsed" ? n.checked : key === "defaultPresetIndex" ? Number(n.value) : n.value;
    persist(Object.assign({}, S.config, { [key]: value }), t("Saved"));
  });

  on("keydown", (e) => {
    const n = e.target;
    if (n.dataset.keyrec) {
      const field = n.dataset.keyrec;
      if (S.recording !== field) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          setRecording(field);
        }
        return;
      }
      if (e.key === "Tab") return setRecording(null);
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") return setRecording(null);
      if ((e.key === "Backspace" || e.key === "Delete") && !e.shiftKey && !e.ctrlKey && !e.altKey) {
        S.draft[field] = DEFAULT_KEYS[field];
        S.recording = null;
        return paint();
      }
      const combo = comboOf(e);
      if (!combo) return;
      S.draft[field] = combo;
      S.recording = null;
      return paint();
    }
    if (n.dataset.chipinput) {
      const field = n.dataset.chipinput;
      const sg = S.suggest && S.suggest.field === field ? S.suggest : null;
      const options = sg ? sg.items.length + (sg.items.some((it) => it.name.toLowerCase() === sg.q.toLowerCase()) ? 0 : 1) : 0;
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && options) {
        e.preventDefault();
        sg.index = (sg.index + (e.key === "ArrowDown" ? 1 : options - 1)) % options;
        paintSuggest(field);
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = sg && sg.items[sg.index];
        if (item) addName(field, item.name);
        else if (n.value.trim()) addName(field, n.value);
      } else if (e.key === "Escape" && sg) {
        e.preventDefault();
        e.stopPropagation();
        S.suggest = null;
        paintSuggest(field);
      } else if (e.key === "Backspace" && !n.value && S.draft[field].length) {
        S.draft[field].pop();
        paint();
      }
      return;
    }
    if (n.dataset.draft === "label" && e.key === "Enter") {
      e.preventDefault();
      saveDraft();
      return;
    }
    if (n.dataset.grip && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const from = presets().findIndex((p) => p.id === n.dataset.grip);
      move(from, from + (e.key === "ArrowUp" ? -1 : 1));
    }
  });

  on("focusout", (e) => {
    const n = e.target;
    if (n.dataset.keyrec && S.recording === n.dataset.keyrec) setRecording(null);
    if (n.dataset.chipinput) {
      const field = n.dataset.chipinput;
      // (after the click that moved the focus, so a button in the editor still gets it)
      setTimeout(() => {
        if (ac.signal.aborted || !S.draft || document.activeElement === el.querySelector(`[data-chipinput="${field}"]`)) return;
        if (S.typing[field].trim()) addName(field, S.typing[field]);
        else if (S.suggest && S.suggest.field === field) {
          S.suggest = null;
          paintSuggest(field);
        }
      }, 120);
    }
  });

  on("toggle", (e) => {
    if (e.target.matches("[data-adv]")) S.advanced = e.target.open;
  }, { capture: true });

  // Dragging a row by its handle (mouse and touch)
  on("pointerdown", (e) => {
    const grip = e.target.closest("[data-grip]");
    if (!grip || e.button !== 0) return;
    e.preventDefault();
    const rows = [...el.querySelectorAll(".qms-row[data-row]")];
    const row = grip.closest("[data-row]");
    const from = rows.indexOf(row);
    const startY = e.clientY;
    let to = from;
    try {
      grip.setPointerCapture(e.pointerId);
    } catch (x) {
      /* (pointer already gone) */
    }
    row.classList.add("is-dragging");
    const mid = (r) => {
      const b = r.getBoundingClientRect();
      return b.top + b.height / 2;
    };
    const onMove = (ev) => {
      row.style.transform = `translateY(${ev.clientY - startY}px)`;
      to = rows.filter((r) => r !== row && mid(r) < ev.clientY).length;
      rows.forEach((r) => r.classList.remove("drop-before", "drop-after"));
      const others = rows.filter((r) => r !== row);
      if (to !== from) {
        if (to < others.length) others[to].classList.add("drop-before");
        else others[others.length - 1].classList.add("drop-after");
      }
    };
    const onUp = () => {
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onUp);
      row.classList.remove("is-dragging");
      row.style.transform = "";
      rows.forEach((r) => r.classList.remove("drop-before", "drop-after"));
      if (to !== from) move(from, to);
    };
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onUp);
  });

  loadStyles();
  paint();
  Promise.resolve(env.load())
    .then((r) => {
      if (ac.signal.aborted) return;
      S.config = r.config;
      S.source = r.source || "settings";
      paint();
      checkTags();
    })
    .catch((e) => {
      if (ac.signal.aborted) return;
      el.innerHTML = `<div class="qms qms-page is-${env.theme}"><p class="qms-note is-bad">${esc(err(e))}</p></div>`;
    });

  return {
    destroy() {
      ac.abort();
      timers.forEach((id) => clearTimeout(id));
      el.innerHTML = "";
    },
  };
}

function loadStyles() {
  if (document.querySelector("link[data-qm-settings]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.dataset.qmSettings = "";
  // Same ?v= as this module, so a plugin update also refreshes the styles
  link.href = new URL("settings.css" + new URL(import.meta.url).search, import.meta.url).href;
  document.head.appendChild(link);
}

function fill(text, vars) {
  return vars ? String(text).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m)) : String(text);
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const svg = (body, w = 16, h = 16, box = "0 0 24 24") =>
  `<svg class="qms-ic" width="${w}" height="${h}" viewBox="${box}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICON = {
  grip: `<svg class="qms-ic" width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="2" cy="3" r="1.4"/><circle cx="8" cy="3" r="1.4"/><circle cx="2" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="2" cy="13" r="1.4"/><circle cx="8" cy="13" r="1.4"/></svg>`,
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  up: svg('<path d="m6 15 6-6 6 6"/>'),
  right: svg('<path d="m9 6 6 6-6 6"/>'),
  code: svg('<path d="m8 6-6 6 6 6M16 6l6 6-6 6"/>'),
  help: svg('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>'),
  warn: svg('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>', 14, 14),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>', 12, 12),
  star: `<svg class="qms-ic" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m12 2 3 6.6 7 .8-5.2 4.8 1.5 7L12 17.8 5.7 21.2l1.5-7L2 9.4l7-.8Z"/></svg>`,
};
