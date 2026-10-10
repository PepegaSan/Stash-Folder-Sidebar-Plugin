// Quick Markers inside Stash UI (stash-pmv-plugins, extension API v2).
// Stash UI imports /plugin/quickMarkers/assets/stashui.js and calls the default export.
// Classic Stash never loads this file; quickMarkers.js is the classic-UI side.
// The preset format and hotkeys match quickMarkers.js — keep both in sync.

const PLUGIN_ID = "quickMarkers";
const ASSETS_PRESETS = "/plugin/" + PLUGIN_ID + "/assets/presets.json";
const DEFAULT_INSTANT_KEY = "shift+m";
const PRESET_SELECT_KEY_RE = /^shift\+[1-9]$/;

const DEFAULT_PRESETS_CONFIG = {
  defaultPresetIndex: 0,
  presets: [
    {
      id: "compilation",
      label: "Compilation",
      primaryTag: "Compilation",
      title: "Compilation",
      rangeInKey: "shift+i",
      rangeOutKey: "shift+o",
      instantKey: "shift+m",
      selectSlot: 1,
    },
  ],
};

const STRINGS_DE = {
  "Quick Markers": "Quick Markers",
  In: "In",
  Out: "Out",
  Instant: "Sofort",
  "Discard in point": "In-Punkt verwerfen",
  "Set the in point (start of the range)": "In-Punkt setzen (Anfang des Bereichs)",
  "Set the out point and save the range marker": "Out-Punkt setzen und Bereichs-Marker speichern",
  "Marker at the current position": "Marker an der aktuellen Stelle",
  "Active preset — click to select": "Aktives Preset – klicken zum Auswählen",
  "Recording from {time}": "Aufnahme ab {time}",
  "In point: {time}": "In-Punkt: {time}",
  "Set In first ({key})": "Zuerst In setzen ({key})",
  "Marker: {label} ({range})": "Marker: {label} ({range})",
  "Last: {text}": "Zuletzt: {text}",
  'Tag "{name}" not found': "Tag „{name}“ nicht gefunden",
  "Create tag": "Tag anlegen",
  'Tag "{name}" created': "Tag „{name}“ angelegt",
  "Presets": "Presets",
  "Default preset": "Standard-Preset",
  "Used when a scene opens. Shift+1–9 and Shift+[ / ] switch while watching.":
    "Ist beim Öffnen einer Szene aktiv. Shift+1–9 und Shift+[ / ] wechseln beim Schauen.",
  "Add preset": "Preset hinzufügen",
  Label: "Name",
  "Primary tag": "Primärtag",
  "Additional tags (comma-separated)": "Zusätzliche Tags (mit Komma getrennt)",
  "Select hotkey": "Auswahl-Hotkey",
  None: "Keiner",
  Add: "Hinzufügen",
  Edit: "Bearbeiten",
  Copy: "Kopieren",
  Paste: "Einfügen",
  "Same videos": "Gleiche Videos",
  Close: "Schließen",
  Start: "Starten",
  "Copied from": "Kopiert aus",
  "Copy all markers of this scene (times, titles, tags)": "Alle Marker dieser Szene kopieren (Zeiten, Titel, Tags)",
  "Paste {n} markers from {title}": "{n} Marker aus {title} einfügen",
  "Copy the markers of another scene first": "Zuerst die Marker einer anderen Szene kopieren",
  "Copy markers to scenes with the same video": "Marker auf Szenen mit demselben Video übertragen",
  "{n} markers copied — open the other scene and paste them": "{n} Marker kopiert – jetzt die andere Szene öffnen und einfügen",
  "These markers were copied from this scene.": "Diese Marker wurden aus dieser Szene kopiert.",
  "Paste markers": "Marker einfügen",
  "Shift (seconds)": "Versatz (Sekunden)",
  "Only needed when this video starts earlier or later than the copied one (e.g. -12.5).":
    "Nur nötig, wenn dieses Video früher oder später beginnt als das kopierte (z. B. -12.5).",
  "Paste {n} markers": "{n} Marker einfügen",
  "Nothing new to paste": "Nichts Neues zum Einfügen",
  "{n} markers pasted": "{n} Marker eingefügt",
  "already there": "schon vorhanden",
  "outside the video": "außerhalb des Videos",
  "{n} of {total} scenes have a fingerprint so far.": "Bisher haben {n} von {total} Szenen einen Fingerabdruck.",
  "No other scene with the same video was found.": "Keine andere Szene mit demselben Video gefunden.",
  "This scene has no video fingerprint (phash) yet, so same videos can't be found.":
    "Diese Szene hat noch keinen Video-Fingerabdruck (phash), daher können gleiche Videos nicht gefunden werden.",
  "Only scenes with a fingerprint are found. Stash creates them with Tasks → Generate → Phashes.":
    "Gefunden werden nur Szenen mit Fingerabdruck. Stash erzeugt sie über Tasks → Generate → Phashes.",
  "Generate missing phashes now": "Fehlende Phashes jetzt erzeugen",
  "Copy & paste works without fingerprints.": "Kopieren & Einfügen funktioniert auch ohne Fingerabdruck.",
  "Starts a Stash task for all scenes without a fingerprint. It runs in the background (see Tasks) and can take a while.":
    "Startet eine Stash-Aufgabe für alle Szenen ohne Fingerabdruck. Sie läuft im Hintergrund (siehe Tasks) und kann eine Weile dauern.",
  "Phash task started — see Tasks": "Phash-Aufgabe gestartet – siehe Tasks",
  "This scene has {n} markers. Pick the scenes that should get them:": "Diese Szene hat {n} Marker. Wähle die Szenen, die sie bekommen sollen:",
  "This scene has no markers yet — take them from one of the videos below.":
    "Diese Szene hat noch keine Marker – übernimm sie von einem der Videos unten.",
  "same length": "gleiche Länge",
  "{n} markers": "{n} Marker",
  "+{n} new": "+{n} neu",
  "has all markers": "hat alle Marker",
  "Copy its markers into this scene": "Seine Marker in diese Szene übernehmen",
  "Take {n}": "{n} übernehmen",
  "Not ticked: a length that differs by more than a second, or clips under 30 s — compare the pictures before copying.":
    "Nicht angehakt: mehr als eine Sekunde Längenunterschied oder Clips unter 30 s – vor dem Kopieren die Bilder vergleichen.",
  "short clip — check": "kurzer Clip – prüfen",
  "This scene": "Diese Szene",
  "Open in a new tab": "In neuem Tab öffnen",
  Undo: "Rückgängig",
  "Marker sync": "Marker-Abgleich",
  "{n} videos": "{n} Videos",
  "+{n} markers missing": "+{n} fehlende Marker",
  "all have the same markers": "alle haben dieselben Marker",
  "Copy {n} markers": "{n} Marker übertragen",
  Source: "Quelle",
  "copy here": "hierher kopieren",
  "Copy from this video instead": "Stattdessen von diesem Video kopieren",
  "Use as source": "Als Quelle",
  Reload: "Neu laden",
  "Comparing the fingerprints of the library …": "Fingerabdrücke der Bibliothek werden verglichen …",
  "Groups of scenes with the same video (fingerprint at most 4 of 64 bits apart, length within 3 s). Ticked are only videos within 1 s that are not short clips — compare the pictures.":
    "Gruppen von Szenen mit demselben Video (Fingerabdruck höchstens 4 von 64 Bits verschieden, Länge innerhalb von 3 s). Angehakt sind nur Videos mit höchstens 1 s Unterschied, die keine kurzen Clips sind – die Bilder vergleichen.",
  "Only those are compared.": "Nur diese werden verglichen.",
  "Markers missing": "Marker fehlen",
  "All groups": "Alle Gruppen",
  "Copy all ticked ({n} markers)": "Alle angehakten übertragen ({n} Marker)",
  "No group with missing markers — every video has the markers of its copies.":
    "Keine Gruppe mit fehlenden Markern – jedes Video hat die Marker seiner Kopien.",
  "No scenes with the same video found.": "Keine Szenen mit demselben Video gefunden.",
  "Show more ({n} left)": "Mehr anzeigen (noch {n})",
  "Copy {n} markers into {k} scenes? Undo stays possible afterwards.":
    "{n} Marker in {k} Szenen übertragen? Rückgängig bleibt danach möglich.",
  "All same videos of the library": "Alle gleichen Videos der Bibliothek",
  "Undo last transfer": "Letzte Übertragung rückgängig machen",
  "Delete the {n} markers that were copied last (into {k} scenes)?": "Die {n} zuletzt übertragenen Marker (in {k} Szenen) löschen?",
  "{n} markers removed": "{n} Marker entfernt",
  "Remove the markers of the last transfer": "Marker der letzten Übertragung wieder entfernen",
  "Copy markers to {n} scenes": "Marker auf {n} Szenen übertragen",
  "{n} markers copied to {k} scenes": "{n} Marker auf {k} Szenen übertragen",
  'Edit preset "{label}"': "Preset „{label}“ bearbeiten",
  "Save changes": "Änderungen speichern",
  Cancel: "Abbrechen",
  "Preset added": "Preset hinzugefügt",
  "Preset updated": "Preset aktualisiert",
  "Hotkeys of this preset": "Hotkeys dieses Presets",
  "In point": "In-Punkt",
  "Out point + save": "Out-Punkt + speichern",
  "Instant marker": "Sofort-Marker",
  "Written like shift+i or shift+]. In / Out / Instant work for the active preset; Shift+1–9 are only for selecting.":
    "Schreibweise wie shift+i oder shift+]. In / Out / Sofort gelten für das aktive Preset; Shift+1–9 sind nur zum Auswählen.",
  Delete: "Löschen",
  'Remove preset "{label}"?': "Preset „{label}“ entfernen?",
  "Label and primary tag are required.": "Name und Primärtag sind Pflicht.",
  "Edit JSON (advanced)": "JSON bearbeiten (erweitert)",
  "Save JSON": "JSON speichern",
  Saved: "Gespeichert",
  "Hotkeys in the player": "Hotkeys im Player",
  "select preset": "Preset wählen",
  "previous / next preset": "voriges / nächstes Preset",
  "in point": "In-Punkt",
  "out point + save": "Out-Punkt + speichern",
  "instant marker": "Sofort-Marker",
  "They replace the plain I / O / M of the player only together with Shift.":
    "Sie überschreiben I / O / M des Players nur zusammen mit Shift.",
  "Loaded from presets.json — saving here stores the presets in Stash.":
    "Aus presets.json geladen – Speichern hier legt die Presets in Stash ab.",
  "Built-in defaults — saving here stores the presets in Stash.":
    "Eingebaute Standardwerte – Speichern hier legt die Presets in Stash ab.",
  "Tags must exist in Stash (exact name).": "Tags müssen in Stash existieren (exakter Name).",
};

// ---------- Presets (same rules as quickMarkers.js) ----------

function normalizeSelectSlot(value, index) {
  if (value === null || value === "" || value === false || value === 0) return null;
  if (value === undefined) return index < 9 ? index + 1 : null;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed || trimmed === "none" || trimmed === "off") return null;
    const fromKey = trimmed.match(/^shift\+([1-9])$/);
    if (fromKey) return Number(fromKey[1]);
    const asNum = Number(trimmed);
    return asNum >= 1 && asNum <= 9 ? asNum : null;
  }
  const n = Number(value);
  return n >= 1 && n <= 9 ? n : null;
}

function normalizeInstantKey(value) {
  const key = String(value == null ? "" : value).trim().toLowerCase();
  // Shift+1–9 are reserved for selecting the active preset.
  if (!key || PRESET_SELECT_KEY_RE.test(key)) return DEFAULT_INSTANT_KEY;
  return key;
}

function normalizePresetTags(value, primaryTag) {
  let list = [];
  if (Array.isArray(value)) list = value.map((t) => String(t).trim());
  else if (typeof value === "string" && value.trim()) list = value.split(",").map((t) => t.trim());
  const primaryKey = String(primaryTag || "").trim().toLowerCase();
  const seen = new Set();
  return list.filter((name) => {
    const key = name.toLowerCase();
    if (!name || (primaryKey && key === primaryKey) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function parsePresetsJson(text) {
  if (!text || !String(text).trim()) return null;
  const parsed = JSON.parse(String(text));
  const presets = Array.isArray(parsed.presets) ? parsed.presets : parsed;
  if (!Array.isArray(presets) || !presets.length) throw new Error("presets must be a non-empty array");
  const normalized = presets.map((p, index) => {
    const label = (p.label || p.id || "Preset " + (index + 1)).trim();
    const primaryTag = (p.primaryTag || p.tag || label).trim();
    if (!primaryTag) throw new Error("preset " + label + ": primaryTag required");
    return {
      id: (p.id || String(index)).trim(),
      label,
      primaryTag,
      tags: normalizePresetTags(p.tags, primaryTag),
      title: (p.title || label).trim(),
      rangeInKey: (p.rangeInKey || "shift+i").trim().toLowerCase(),
      rangeOutKey: (p.rangeOutKey || "shift+o").trim().toLowerCase(),
      instantKey: normalizeInstantKey(p.instantKey),
      selectSlot: normalizeSelectSlot(p.selectSlot, index),
    };
  });
  const claimed = {};
  normalized.forEach((preset) => {
    if (!preset.selectSlot) return;
    if (claimed[preset.selectSlot]) preset.selectSlot = null;
    else claimed[preset.selectSlot] = true;
  });
  let defaultIndex = typeof parsed.defaultPresetIndex === "number" ? parsed.defaultPresetIndex : 0;
  if (defaultIndex < 0 || defaultIndex >= normalized.length) defaultIndex = 0;
  // Keep the classic-only UI options so saving here does not drop them.
  const extra = {};
  ["panelPosition", "panelCollapsed", "touchControls"].forEach((k) => {
    if (parsed[k] !== undefined && !Array.isArray(parsed)) extra[k] = parsed[k];
  });
  return Object.assign(extra, { presets: normalized, defaultPresetIndex: defaultIndex });
}

function presetsToJson(config) {
  const root = {
    defaultPresetIndex: config.defaultPresetIndex,
    presets: config.presets.map((p) => {
      const o = { id: p.id, label: p.label, primaryTag: p.primaryTag, title: p.title };
      if (p.rangeInKey) o.rangeInKey = p.rangeInKey;
      if (p.rangeOutKey) o.rangeOutKey = p.rangeOutKey;
      if (p.instantKey) o.instantKey = p.instantKey;
      o.selectSlot = p.selectSlot || null;
      if (p.tags && p.tags.length) o.tags = p.tags;
      return o;
    }),
  };
  if (config.panelPosition && config.panelPosition !== "top-left") root.panelPosition = config.panelPosition;
  if (config.panelCollapsed === false) root.panelCollapsed = false;
  if (config.touchControls && config.touchControls !== "auto") root.touchControls = config.touchControls;
  return JSON.stringify(root, null, 2);
}

const defaultConfig = () => parsePresetsJson(JSON.stringify(DEFAULT_PRESETS_CONFIG));

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? h + ":" + String(m).padStart(2, "0") + ":" + sec : m + ":" + sec;
}

// ---------- Hotkeys ----------
// Combos use the Mousetrap spelling of quickMarkers.js ("shift+i", "shift+]", "shift+3").

const NAMED_KEYS = { arrowleft: "left", arrowright: "right", arrowup: "up", arrowdown: "down", escape: "esc", " ": "space" };
const CODE_KEYS = {
  BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Comma: ",", Period: ".",
  Slash: "/", Semicolon: ";", Quote: "'", Backquote: "`", Backslash: "\\",
};

function parseCombo(text) {
  const parts = String(text || "").toLowerCase().split("+").map((p) => p.trim());
  const key = parts.pop();
  if (!key) return null;
  const mods = new Set(parts);
  return {
    key,
    shift: mods.has("shift"),
    ctrl: mods.has("ctrl") || mods.has("control"),
    alt: mods.has("alt") || mods.has("option"),
    meta: mods.has("meta") || mods.has("cmd") || mods.has("command"),
  };
}

// The names an event can stand for: its letter, and for digits / brackets also the physical key
// (Shift+1 yields "!" in e.key, Shift+[ yields "{"), so layouts don't matter there.
function eventKeys(e) {
  const out = new Set();
  const k = String(e.key || "").toLowerCase();
  out.add(NAMED_KEYS[k] || k);
  if (/^[a-z]$/.test(k)) return out;
  const c = e.code || "";
  if (/^Digit\d$/.test(c)) out.add(c.slice(5));
  else if (/^Numpad\d$/.test(c)) out.add(c.slice(6));
  else if (CODE_KEYS[c]) out.add(CODE_KEYS[c]);
  else if (/^Key[A-Z]$/.test(c) && !/^[a-z]$/.test(k)) out.add(c.slice(3).toLowerCase());
  return out;
}

function comboMatches(combo, e, keys) {
  return (
    !!combo &&
    combo.shift === e.shiftKey &&
    combo.ctrl === e.ctrlKey &&
    combo.alt === e.altKey &&
    combo.meta === e.metaKey &&
    keys.has(combo.key)
  );
}

function prettyKey(text) {
  return String(text || "")
    .split("+")
    .map((p) => (p === "shift" ? "⇧" : p === "ctrl" ? "Ctrl " : p === "alt" ? "Alt " : p.toUpperCase()))
    .join("");
}

// ---------- The module ----------

export default function setup(stashui) {
  if (!stashui || !stashui.has || !stashui.has("slot:scene.info")) return;
  const ui = stashui.ui;
  const t = (text, vars) => stashui.t(text, vars);
  const esc = (s) => ui.esc(s == null ? "" : String(s));
  stashui.addStrings("de", STRINGS_DE);
  loadStyles();

  const tagIdCache = new Map();
  const inPoints = new Map(); // scene id → seconds (survives the info bar being redrawn)
  let configPromise = null;
  let configSource = "settings";
  let activeId = null; // the preset picked while watching, kept across scenes

  stashui.on("plugins-changed", () => {
    configPromise = null;
    tagIdCache.clear();
  });

  function loadStyles() {
    if (document.querySelector("link[data-quick-markers]")) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.dataset.quickMarkers = "";
    // Same ?v= as this module, so a plugin update also refreshes the styles.
    link.href = new URL("stashui.css" + new URL(import.meta.url).search, import.meta.url).href;
    document.head.appendChild(link);
  }

  // markerCopy.js is shared with classic Stash; loaded once, with this module's ?v=.
  let copyModule = null;
  function markerCopy() {
    if (!copyModule) {
      copyModule = import(new URL("markerCopy.js" + new URL(import.meta.url).search, import.meta.url).href);
      copyModule.catch(() => (copyModule = null));
    }
    return copyModule;
  }

  async function readPluginSettings() {
    const d = await stashui.gql("query { configuration { plugins } }");
    const plugins = (d && d.configuration && d.configuration.plugins) || {};
    return plugins[PLUGIN_ID] || {};
  }

  function loadConfig() {
    if (!configPromise) {
      configPromise = (async () => {
        const fromSettings = parsePresetsJson((await readPluginSettings()).presetsJson);
        if (fromSettings) {
          configSource = "settings";
          return fromSettings;
        }
        try {
          const res = await fetch(ASSETS_PRESETS, { credentials: "same-origin" });
          const fromFile = res.ok ? parsePresetsJson(await res.text()) : null;
          if (fromFile) {
            configSource = "file";
            return fromFile;
          }
        } catch (e) {
          /* no presets.json */
        }
        configSource = "defaults";
        return defaultConfig();
      })();
      configPromise.catch(() => (configPromise = null));
    }
    return configPromise;
  }

  async function saveConfig(config) {
    const cur = await readPluginSettings();
    const input = Object.assign({}, cur, { presetsJson: presetsToJson(config) });
    await stashui.gql("mutation($id: ID!, $i: Map!) { configurePlugin(plugin_id: $id, input: $i) }", { id: PLUGIN_ID, i: input });
    configPromise = Promise.resolve(config);
    configSource = "settings";
    tagIdCache.clear();
  }

  async function findTagId(name) {
    const key = name.toLowerCase();
    if (tagIdCache.has(key)) return tagIdCache.get(key);
    const q = `query($f: FindFilterType, $tf: TagFilterType) { findTags(filter: $f, tag_filter: $tf) { tags { id name } } }`;
    let tags = [];
    for (const modifier of ["EQUALS", "INCLUDES"]) {
      const d = await stashui.gql(q, { f: { per_page: 25, q: name }, tf: { name: { value: name, modifier } } });
      tags = (d && d.findTags && d.findTags.tags) || [];
      if (tags.length) break;
    }
    if (!tags.length) return null;
    const exact = tags.find((tag) => tag.name.toLowerCase() === key) || tags[0];
    tagIdCache.set(key, exact.id);
    return exact.id;
  }

  // A missing tag offers "Create tag" in the message instead of failing silently.
  async function resolveTagId(name, retry) {
    const id = await findTagId(name);
    if (id) return id;
    ui.toast(t('Tag "{name}" not found', { name }), "error", {
      label: t("Create tag"),
      run: async () => {
        try {
          const d = await stashui.gql("mutation($i: TagCreateInput!) { tagCreate(input: $i) { id } }", { i: { name } });
          tagIdCache.set(name.toLowerCase(), d.tagCreate.id);
          ui.toast(t('Tag "{name}" created', { name }), "ok");
          if (retry) retry();
        } catch (e) {
          ui.errorToast(e, "Quick Markers");
        }
      },
    });
    return null;
  }

  // ---------- Copying markers between scenes (markerCopy.js) ----------

  const STATUS_NOTE = { exists: "already there", outside: "outside the video" };

  function planHtml(mc, plan) {
    return `<ul class="qm-x-plan">${plan
      .map((p) => {
        const time = mc.formatTime(p.seconds) + (p.end_seconds != null ? " – " + mc.formatTime(p.end_seconds) : "");
        const tags = p.marker.tags.filter((tag) => !p.marker.primaryTag || tag.id !== p.marker.primaryTag.id);
        return `<li class="is-${p.status}">
          <b>${esc(time)}</b>
          <span>${esc(mc.markerLabel(p.marker))}${p.marker.primaryTag && p.marker.title ? ` <i class="kb-chip is-on">${esc(p.marker.primaryTag.name)}</i>` : ""}${tags.map((tag) => ` <i class="kb-chip">${esc(tag.name)}</i>`).join("")}</span>
          ${p.status !== "new" ? `<small>${esc(t(STATUS_NOTE[p.status]))}</small>` : ""}
        </li>`;
      })
      .join("")}</ul>`;
  }

  async function copyMarkers(sceneId) {
    try {
      const mc = await markerCopy();
      const data = await mc.copySceneMarkers(stashui.gql, sceneId);
      ui.toast(t("{n} markers copied — open the other scene and paste them", { n: data.markers.length }), "ok");
    } catch (e) {
      ui.errorToast(e, "Quick Markers");
    }
  }

  // reload belongs to a player that may be closed by now (the undo button sits in a toast).
  const safeReload = (reload) => {
    try {
      if (reload) reload();
    } catch (e) {
      /* player gone */
    }
  };

  // One transfer: jobs = [{ sceneId, plan }]. Whatever was created — also before an error — is
  // remembered, so "Undo" can remove it again. → number of markers created.
  async function transfer(mc, jobs, onProgress) {
    const created = [];
    try {
      for (let i = 0; i < jobs.length; i++) {
        await mc.applyPlan(mc.createWithGql(stashui.gql), jobs[i].sceneId, jobs[i].plan, (done, total) => onProgress && onProgress(i, done, total), created);
      }
    } finally {
      mc.rememberTransfer(created, jobs.map((j) => j.sceneId));
    }
    return created.length;
  }

  const doneToast = (message, reload) => ui.toast(message, "ok", { label: t("Undo"), run: () => undoTransfer(reload, false) });

  async function undoTransfer(reload, ask) {
    try {
      const mc = await markerCopy();
      const rec = mc.readUndo();
      if (!rec) return;
      if (ask) {
        const answer = await ui.confirmDialog({
          title: t("Undo last transfer"),
          text: t("Delete the {n} markers that were copied last (into {k} scenes)?", { n: rec.ids.length, k: rec.sceneIds.length }),
          ok: t("Delete"),
          danger: true,
        });
        if (!answer || !answer.ok) return;
      }
      await mc.undoLastTransfer(stashui.gql);
      ui.toast(t("{n} markers removed", { n: rec.ids.length }), "ok");
      safeReload(reload);
    } catch (e) {
      ui.errorToast(e, "Quick Markers");
    }
  }

  async function openPasteDrawer(sceneId, reload) {
    let mc, clip, target;
    try {
      mc = await markerCopy();
      clip = mc.readClipboard();
      if (!clip) return;
      if (clip.sceneId === String(sceneId)) {
        ui.toast(t("These markers were copied from this scene."), "error");
        return;
      }
      target = await mc.loadScene(stashui.gql, sceneId);
    } catch (e) {
      ui.errorToast(e, "Quick Markers");
      return;
    }
    let offset = 0;
    let plan = mc.planCopy(clip.markers, target, offset);
    const d = ui.openDrawer({
      title: t("Paste markers"),
      body: `
        <p class="kb-hint">${esc(t("Copied from"))} <b>${esc(clip.sceneTitle)}</b> (${esc(mc.formatTime(clip.duration))}) → <b>${esc(target.title)}</b> (${esc(mc.formatTime(target.duration))})</p>
        <label class="qm-set-field qm-x-offset"><span>${esc(t("Shift (seconds)"))}</span><input class="kb-field" type="number" step="0.5" value="0" data-offset></label>
        <p class="kb-hint">${esc(t("Only needed when this video starts earlier or later than the copied one (e.g. -12.5)."))}</p>
        <div data-plan></div>`,
      foot: `<button type="button" class="kb-btn" data-cancel>${esc(t("Cancel"))}</button><span class="kb-spacer"></span><button type="button" class="kb-btn is-primary" data-go></button>`,
    });
    const body = d.el.querySelector(".kb-drawer-body");
    const go = d.el.querySelector("[data-go]");
    function update() {
      plan = mc.planCopy(clip.markers, target, offset);
      const n = mc.countNew(plan);
      body.querySelector("[data-plan]").innerHTML = planHtml(mc, plan);
      go.textContent = n ? t("Paste {n} markers", { n }) : t("Nothing new to paste");
      go.disabled = !n;
    }
    body.querySelector("[data-offset]").addEventListener("input", (e) => {
      offset = Number(e.target.value) || 0;
      update();
    });
    d.el.querySelector("[data-cancel]").onclick = d.close;
    go.onclick = async () => {
      go.disabled = true;
      try {
        const n = await transfer(mc, [{ sceneId, plan }], (job, i, total) => (go.textContent = i + " / " + total));
        doneToast(t("{n} markers pasted", { n }), reload);
      } catch (e) {
        // Some may already exist now: close, so opening again plans from the real state.
        ui.errorToast(e, "Quick Markers");
      }
      d.close();
      safeReload(reload);
    };
    update();
  }

  async function openSameDrawer(sceneId, reload) {
    const d = ui.openDrawer({
      title: t("Same videos"),
      body: `<div class="kb-loading">…</div>`,
      foot: `<button type="button" class="kb-btn" data-cancel>${esc(t("Close"))}</button><a class="kb-btn is-ghost" href="#/${SYNC_ROUTE}" data-sync>${ui.icon("layers")}${esc(t("All same videos of the library"))}</a><span class="kb-spacer"></span><button type="button" class="kb-btn is-primary" data-go hidden></button>`,
    });
    const body = d.el.querySelector(".kb-drawer-body");
    const go = d.el.querySelector("[data-go]");
    d.el.querySelector("[data-cancel]").onclick = d.close;
    d.el.querySelector("[data-sync]").addEventListener("click", d.close);
    let mc, scene, list;
    try {
      mc = await markerCopy();
      scene = await mc.loadScene(stashui.gql, sceneId);
      list = scene.phashes.length ? await mc.findSameVideos(stashui.gql, scene) : [];
    } catch (e) {
      body.innerHTML = `<div class="kb-empty"><p>${esc(e.message || String(e))}</p></div>`;
      return;
    }

    async function coverageHint() {
      try {
        const c = await mc.phashCoverage(stashui.gql);
        return t("{n} of {total} scenes have a fingerprint so far.", { n: c.withPhash, total: c.total });
      } catch (e) {
        return "";
      }
    }

    if (!list.length) {
      const reason = scene.phashes.length
        ? t("No other scene with the same video was found.")
        : t("This scene has no video fingerprint (phash) yet, so same videos can't be found.");
      body.innerHTML = `
        <div class="qm-x-same-empty">
          <p>${esc(reason)}</p>
          <p class="kb-hint">${esc(t("Only scenes with a fingerprint are found. Stash creates them with Tasks → Generate → Phashes."))} <span data-coverage></span></p>
          <button type="button" class="kb-btn" data-gen>${ui.icon("bolt")}${esc(t("Generate missing phashes now"))}</button>
          <p class="kb-hint">${esc(t("Copy & paste works without fingerprints."))}</p>
        </div>`;
      coverageHint().then((h) => {
        const s = body.querySelector("[data-coverage]");
        if (s) s.textContent = h;
      });
      body.querySelector("[data-gen]").onclick = async () => {
        const answer = await ui.confirmDialog({ title: t("Generate missing phashes now"), text: t("Starts a Stash task for all scenes without a fingerprint. It runs in the background (see Tasks) and can take a while."), ok: t("Start") });
        if (!answer || !answer.ok) return;
        try {
          await mc.generatePhashes(stashui.gql);
          ui.toast(t("Phash task started — see Tasks"), "ok");
        } catch (e) {
          ui.errorToast(e, "Quick Markers");
        }
      };
      return;
    }

    const picked = new Set(list.filter((x) => x.sure && x.add > 0).map((x) => x.scene.id));
    function paintList() {
      const thumb = (x) => `<a class="qm-x-thumb" href="#/scene/${esc(x.id)}" target="_blank" rel="noreferrer" title="${esc(t("Open in a new tab"))}">${x.screenshot ? `<img alt="" loading="lazy" src="${esc(x.screenshot)}">` : ""}<span>${esc(mc.formatTime(x.duration))}</span></a>`;
      body.innerHTML = `
        <div class="qm-x-same-row is-self">${thumb(scene)}<div class="qm-x-same-info"><b>${esc(scene.title)}</b><small>${esc(scene.path)}</small><small>${esc(t("This scene"))} · ${esc(t("{n} markers", { n: scene.markers.length }))}</small></div></div>
        <p class="kb-hint">${scene.markers.length
          ? esc(t("This scene has {n} markers. Pick the scenes that should get them:", { n: scene.markers.length }))
          : esc(t("This scene has no markers yet — take them from one of the videos below."))}</p>
        <div class="qm-x-same">
          ${list
            .map((x) => {
              const pull = mc.countNew(mc.planCopy(x.scene.markers, scene, 0));
              return `<div class="qm-x-same-row${x.sure ? "" : " is-unsure"}">
                <label class="kb-check"><input type="checkbox" data-pick="${esc(x.scene.id)}"${picked.has(x.scene.id) ? " checked" : ""}${x.add ? "" : " disabled"}></label>
                ${thumb(x.scene)}
                <div class="qm-x-same-info">
                  <b>${esc(x.scene.title)}${x.short ? ` <em class="qm-x-flag">${esc(t("short clip — check"))}</em>` : ""}</b>
                  <small>${esc(x.scene.path)}</small>
                  <small>${esc(mc.formatTime(x.scene.duration))} (${x.durationDiff < 0.05 ? esc(t("same length")) : "± " + x.durationDiff.toFixed(1) + " s"}) · ${esc(t("{n} markers", { n: x.scene.markers.length }))}${x.add ? " · " + esc(t("+{n} new", { n: x.add })) : " · " + esc(t("has all markers"))}</small>
                </div>
                ${pull ? `<button type="button" class="kb-btn is-ghost" data-pull="${esc(x.scene.id)}" title="${esc(t("Copy its markers into this scene"))}">${ui.icon("download")}${esc(t("Take {n}", { n: pull }))}</button>` : ""}
              </div>`;
            })
            .join("")}
        </div>
        ${list.some((x) => !x.sure) ? `<p class="kb-hint">${esc(t("Not ticked: a length that differs by more than a second, or clips under 30 s — compare the pictures before copying."))}</p>` : ""}`;
      const n = list.filter((x) => picked.has(x.scene.id)).length;
      go.hidden = !scene.markers.length;
      go.disabled = !n;
      go.textContent = t("Copy markers to {n} scenes", { n });
    }

    body.addEventListener("change", (e) => {
      const id = e.target.dataset && e.target.dataset.pick;
      if (id == null) return;
      if (e.target.checked) picked.add(id);
      else picked.delete(id);
      paintList();
    });
    body.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-pull]");
      if (!b) return;
      const x = list.find((y) => y.scene.id === b.dataset.pull);
      b.disabled = true;
      try {
        const n = await transfer(mc, [{ sceneId, plan: mc.planCopy(x.scene.markers, scene, 0) }]);
        doneToast(t("{n} markers pasted", { n }), reload);
      } catch (err) {
        ui.errorToast(err, "Quick Markers");
      }
      d.close();
      safeReload(reload);
    });
    go.onclick = async () => {
      const targets = list.filter((x) => picked.has(x.scene.id));
      go.disabled = true;
      try {
        const jobs = targets.map((x) => ({ sceneId: x.scene.id, plan: x.plan }));
        const total = await transfer(mc, jobs, (job) => (go.textContent = job + 1 + " / " + targets.length));
        doneToast(t("{n} markers copied to {k} scenes", { n: total, k: targets.length }), reload);
      } catch (e) {
        ui.errorToast(e, "Quick Markers");
      }
      d.close();
    };
    paintList();
  }

  // ---------- Library page: Marker sync (#/p/quickMarkers/sync) ----------

  const SYNC_PAGE_SIZE = 30;
  const SYNC_ROUTE = "p/" + PLUGIN_ID + "/sync";

  function renderSyncPage(el, ctx) {
    const signal = ctx.signal;
    let mc = null;
    let groups = null;
    let error = "";
    let showAll = false;
    let shown = SYNC_PAGE_SIZE;
    let busy = false;
    let coverage = null;
    let undo = null;
    const picked = new Map(); // group key → ids of the ticked targets

    const visible = () => (groups || []).filter((g) => showAll || g.missing > 0);
    const pickedOf = (g) => {
      if (!picked.has(g.key)) picked.set(g.key, new Set(g.targets.filter((x) => x.sure && x.add > 0).map((x) => x.scene.id)));
      return picked.get(g.key);
    };
    const jobsOf = (g) => g.targets.filter((x) => x.add > 0 && pickedOf(g).has(x.scene.id)).map((x) => ({ sceneId: x.scene.id, plan: x.plan, add: x.add }));
    const groupOf = (key) => (groups || []).findIndex((g) => g.key === key);
    const sumAdd = (jobs) => jobs.reduce((n, j) => n + j.add, 0);
    const lengthNote = (x) => (x.durationDiff < 0.05 ? t("same length") : "± " + x.durationDiff.toFixed(1) + " s");

    async function load() {
      groups = null;
      error = "";
      paint();
      try {
        mc = await markerCopy();
        const found = await mc.findSameVideoGroups(stashui.gql);
        coverage = await mc.phashCoverage(stashui.gql);
        groups = found;
        undo = mc.readUndo();
      } catch (e) {
        if (e && e.name === "AbortError") return;
        error = e.message || String(e);
      }
      paint();
    }

    function thumb(s) {
      return `<a class="qm-x-thumb" href="#/scene/${esc(s.id)}" target="_blank" rel="noreferrer" title="${esc(t("Open in a new tab"))}">${s.screenshot ? `<img alt="" loading="lazy" src="${esc(s.screenshot)}">` : ""}<span>${esc(mc.formatTime(s.duration))}</span></a>`;
    }

    function groupHtml(g) {
      const jobs = jobsOf(g);
      const picks = pickedOf(g);
      return `<section class="qm-sync-group${g.missing ? "" : " is-complete"}" data-group="${esc(g.key)}">
        <header>
          <b>${esc(t("{n} videos", { n: g.scenes.length }))}</b>
          <span class="${g.missing ? "qm-sync-missing" : "qm-sync-ok"}">${esc(g.missing ? t("+{n} markers missing", { n: g.missing }) : t("all have the same markers"))}</span>
          <span class="kb-spacer"></span>
          ${g.missing ? `<button type="button" class="kb-btn" data-go${jobs.length && !busy ? "" : " disabled"}>${ui.icon("copies")}${esc(t("Copy {n} markers", { n: sumAdd(jobs) }))}</button>` : ""}
        </header>
        <div class="qm-sync-cards">
          <div class="qm-sync-card is-source">
            ${thumb(g.source)}
            <b>${esc(g.source.title)}</b>
            <small>${esc(g.source.path)}</small>
            <small><em class="qm-sync-badge">${esc(t("Source"))}</em> ${esc(t("{n} markers", { n: g.source.markers.length }))}</small>
          </div>
          ${g.targets
            .map(
              (x) => `<div class="qm-sync-card${x.sure ? "" : " is-unsure"}">
            ${thumb(x.scene)}
            <b>${esc(x.scene.title)}${x.short ? ` <em class="qm-x-flag">${esc(t("short clip — check"))}</em>` : ""}</b>
            <small>${esc(x.scene.path)}</small>
            <small>${esc(lengthNote(x))} · ${esc(t("{n} markers", { n: x.scene.markers.length }))}${x.add ? " · " + esc(t("+{n} new", { n: x.add })) : ""}</small>
            <div class="qm-sync-card-actions">
              ${x.add ? `<label class="kb-check"><input type="checkbox" data-pick="${esc(x.scene.id)}"${picks.has(x.scene.id) ? " checked" : ""}${busy ? " disabled" : ""}>${esc(t("copy here"))}</label>` : `<span class="qm-sync-ok">${esc(t("has all markers"))}</span>`}
              ${x.scene.markers.length ? `<button type="button" class="kb-btn is-ghost" data-source="${esc(x.scene.id)}"${busy ? " disabled" : ""} title="${esc(t("Copy from this video instead"))}">${esc(t("Use as source"))}</button>` : ""}
            </div>
          </div>`
            )
            .join("")}
        </div>
      </section>`;
    }

    function paint() {
      if (signal.aborted) return;
      if (error) {
        el.innerHTML = `<div class="kb-empty"><b>${esc(t("Marker sync"))}</b><p>${esc(error)}</p><button type="button" class="kb-btn" data-reload>${esc(t("Reload"))}</button></div>`;
        return;
      }
      if (!groups) {
        el.innerHTML = `<div class="kb-loading">${esc(t("Comparing the fingerprints of the library …"))}</div>`;
        return;
      }
      const list = visible();
      const missingGroups = groups.filter((g) => g.missing > 0).length;
      const bulkJobs = list.flatMap(jobsOf);
      el.innerHTML = `
        <div class="qm-sync">
          <p class="kb-hint">${esc(t("Groups of scenes with the same video (fingerprint at most 4 of 64 bits apart, length within 3 s). Ticked are only videos within 1 s that are not short clips — compare the pictures."))}</p>
          ${coverage && coverage.withPhash < coverage.total ? `<p class="kb-hint qm-sync-coverage">${esc(t("{n} of {total} scenes have a fingerprint so far.", { n: coverage.withPhash, total: coverage.total }))} ${esc(t("Only those are compared."))} <button type="button" class="kb-btn is-ghost" data-gen>${ui.icon("bolt")}${esc(t("Generate missing phashes now"))}</button></p>` : ""}
          <div class="qm-sync-bar">
            <div class="kb-seg">
              <button type="button" data-filter="missing" class="${showAll ? "" : "is-on"}">${esc(t("Markers missing"))} (${missingGroups})</button>
              <button type="button" data-filter="all" class="${showAll ? "is-on" : ""}">${esc(t("All groups"))} (${groups.length})</button>
            </div>
            <span class="kb-spacer"></span>
            <span class="kb-hint" data-busy></span>
            ${undo ? `<button type="button" class="kb-btn is-ghost" data-undo${busy ? " disabled" : ""}>${ui.icon("undo")}${esc(t("Undo"))} (${undo.ids.length})</button>` : ""}
            <button type="button" class="kb-btn is-ghost" data-reload${busy ? " disabled" : ""}>${esc(t("Reload"))}</button>
            <button type="button" class="kb-btn is-primary" data-bulk${bulkJobs.length && !busy ? "" : " disabled"}>${esc(t("Copy all ticked ({n} markers)", { n: sumAdd(bulkJobs) }))}</button>
          </div>
          ${list.length
            ? list.slice(0, shown).map(groupHtml).join("")
            : `<div class="kb-empty"><p>${esc(groups.length ? t("No group with missing markers — every video has the markers of its copies.") : t("No scenes with the same video found."))}</p></div>`}
          ${list.length > shown ? `<button type="button" class="kb-btn qm-sync-more" data-more>${esc(t("Show more ({n} left)", { n: list.length - shown }))}</button>` : ""}
        </div>`;
    }

    const setBusy = (text) => {
      const s = el.querySelector("[data-busy]");
      if (s) s.textContent = text;
    };

    async function run(jobs, message) {
      busy = true;
      paint();
      try {
        const n = await transfer(mc, jobs, (job, done, total) => setBusy(job + 1 + " / " + jobs.length + " · " + done + " / " + total));
        doneToast(t(message, { n, k: jobs.length }), load);
        return true;
      } catch (e) {
        ui.errorToast(e, "Quick Markers");
        return false;
      } finally {
        busy = false;
        undo = mc.readUndo();
      }
    }

    el.addEventListener("click", async (e) => {
      const b = e.target.closest("button");
      if (!b || !el.contains(b) || b.disabled) return;
      const section = b.closest("[data-group]");
      const gi = section ? groupOf(section.dataset.group) : -1;
      if (b.dataset.filter) {
        showAll = b.dataset.filter === "all";
        shown = SYNC_PAGE_SIZE;
        paint();
      } else if (b.hasAttribute("data-reload")) {
        load();
      } else if (b.hasAttribute("data-more")) {
        shown += SYNC_PAGE_SIZE;
        paint();
      } else if (b.dataset.source && gi >= 0) {
        const g = groups[gi];
        groups[gi] = mc.analyzeGroup(g.scenes, b.dataset.source);
        picked.delete(g.key);
        paint();
      } else if (b.hasAttribute("data-go") && gi >= 0) {
        const g = groups[gi];
        if (await run(jobsOf(g), "{n} markers copied to {k} scenes")) {
          try {
            groups[gi] = await mc.reloadGroup(stashui.gql, g);
            picked.delete(g.key);
          } catch (err) {
            /* shown again after Reload */
          }
        }
        paint();
      } else if (b.hasAttribute("data-bulk")) {
        const jobs = visible().flatMap(jobsOf);
        const answer = await ui.confirmDialog({
          title: t("Marker sync"),
          text: t("Copy {n} markers into {k} scenes? Undo stays possible afterwards.", { n: sumAdd(jobs), k: jobs.length }),
          ok: t("Copy"),
        });
        if (!answer || !answer.ok) return;
        await run(jobs, "{n} markers copied to {k} scenes");
        load();
      } else if (b.hasAttribute("data-undo")) {
        undoTransfer(load, true);
      } else if (b.hasAttribute("data-gen")) {
        const answer = await ui.confirmDialog({ title: t("Generate missing phashes now"), text: t("Starts a Stash task for all scenes without a fingerprint. It runs in the background (see Tasks) and can take a while."), ok: t("Start") });
        if (!answer || !answer.ok) return;
        try {
          await mc.generatePhashes(stashui.gql);
          ui.toast(t("Phash task started — see Tasks"), "ok");
        } catch (err) {
          ui.errorToast(err, "Quick Markers");
        }
      }
    }, { signal });

    el.addEventListener("change", (e) => {
      const id = e.target.dataset && e.target.dataset.pick;
      const section = e.target.closest("[data-group]");
      if (id == null || !section) return;
      const g = groups[groupOf(section.dataset.group)];
      if (!g) return;
      if (e.target.checked) pickedOf(g).add(id);
      else pickedOf(g).delete(id);
      paint();
    }, { signal });

    // An undo or a transfer in another tab or in the player changes the undo button here too.
    const onState = () => {
      if (!mc || busy) return;
      undo = mc.readUndo();
      paint();
    };
    window.addEventListener("storage", onState, { signal });
    window.addEventListener("quickMarkers:clipboard", onState, { signal });

    load();
    return () => {};
  }

  if (stashui.has("route") && typeof stashui.addRoute === "function") {
    stashui.addRoute({ path: "sync", title: t("Marker sync"), render: renderSyncPage });
    if (stashui.has("navItem") && typeof stashui.addNavItem === "function") {
      stashui.addNavItem({ id: "sync", label: t("Marker sync"), icon: "layers", route: "sync", group: "Manage" });
    }
  }

  // ---------- Player: a section in the info bar ----------

  stashui.addSlot("scene.info", {
    id: "panel",
    title: "Quick Markers",
    match: (ctx) => ctx.kind === "scene" && !!ctx.id,
    mount(el, ctx) {
      const signal = ctx.signal;
      const sceneId = String(ctx.id);
      let config = null;
      let status = "";
      let busy = false;

      const now = () => {
        const v = typeof ctx.time === "function" ? ctx.time() : ctx.video && ctx.video.currentTime;
        return typeof v === "number" && !isNaN(v) ? v : null;
      };
      const presets = () => (config ? config.presets : []);
      const activeIndex = () => {
        const i = presets().findIndex((p) => p.id === activeId);
        return i >= 0 ? i : Math.min(config ? config.defaultPresetIndex : 0, Math.max(0, presets().length - 1));
      };
      const active = () => presets()[activeIndex()] || null;
      const select = (index) => {
        const p = presets()[index];
        if (!p) return;
        activeId = p.id;
        paint();
      };

      // clearsIn: the marker closes the range started with In (also when retried after "Create tag").
      async function create(preset, from, to, clearsIn) {
        if (busy) return;
        busy = true;
        const retry = () => create(preset, from, to, clearsIn);
        try {
          const tagId = await resolveTagId(preset.primaryTag, retry);
          if (!tagId) return;
          const extra = [];
          for (const name of preset.tags || []) {
            const id = await resolveTagId(name, retry);
            if (!id) return;
            if (id !== tagId && extra.indexOf(id) < 0) extra.push(id);
          }
          const input = {
            scene_id: sceneId,
            title: preset.title,
            seconds: Math.round(from * 1000) / 1000,
            primary_tag_id: tagId,
            tag_ids: extra,
          };
          if (to != null) input.end_seconds = Math.round(to * 1000) / 1000;
          await stashui.gql("mutation($input: SceneMarkerCreateInput!) { sceneMarkerCreate(input: $input) { id } }", { input });
          if (clearsIn) inPoints.delete(sceneId);
          const range = to != null ? formatTime(from) + " – " + formatTime(to) : formatTime(from);
          status = preset.label + " @ " + range;
          ui.toast(t("Marker: {label} ({range})", { label: preset.label, range }), "ok");
          // Redraws the info bar (markers list + timeline pins); this section mounts again with the same state.
          if (ctx.reload) ctx.reload();
        } catch (e) {
          ui.errorToast(e, "Quick Markers");
        } finally {
          busy = false;
          if (!signal.aborted) paint();
        }
      }

      function onIn() {
        const at = now();
        if (at == null) return;
        inPoints.set(sceneId, at);
        status = "";
        ui.toast(t("In point: {time}", { time: formatTime(at) }), "ok");
        paint();
      }

      function onOut() {
        const preset = active();
        const at = now();
        if (!preset || at == null) return;
        const start = inPoints.get(sceneId);
        if (start == null) {
          ui.toast(t("Set In first ({key})", { key: prettyKey(preset.rangeInKey) }), "error");
          return;
        }
        const from = Math.min(start, at);
        const to = Math.max(start, at);
        // A range of (almost) zero length becomes an instant marker, like in classic Stash.
        create(preset, from, to > from + 0.05 ? to : null, true);
      }

      function onInstant(preset) {
        const at = now();
        if (preset && at != null) create(preset, at, null);
      }

      function discardIn() {
        inPoints.delete(sceneId);
        paint();
      }

      // Runs before the player's own keys (capture on window), so Shift+I/O/M
      // no longer also fold the info bar, count an O or mute.
      function onKey(e) {
        if (!config || e.repeat) return;
        const target = e.target;
        if (target && target.closest && target.closest("input, textarea, select, [contenteditable], .kb-drawer, .kb-dialog")) return;
        if (document.querySelector(".kb-drawer, .kb-dialog")) return;
        const keys = eventKeys(e);
        const hit = (combo) => comboMatches(parseCombo(combo), e, keys);
        const preset = active();
        let run = null;
        if (preset && hit(preset.rangeInKey)) run = onIn;
        else if (preset && hit(preset.rangeOutKey)) run = onOut;
        else if (preset && !PRESET_SELECT_KEY_RE.test(preset.instantKey) && hit(preset.instantKey)) run = () => onInstant(preset);
        else if (hit("shift+]")) run = () => select((activeIndex() + 1) % presets().length);
        else if (hit("shift+[")) run = () => select((activeIndex() - 1 + presets().length) % presets().length);
        else {
          const bySlot = presets().findIndex((p) => p.selectSlot && hit("shift+" + p.selectSlot));
          if (bySlot >= 0) run = () => select(bySlot);
          else {
            const other = presets().find((p) => p !== preset && p.instantKey && !PRESET_SELECT_KEY_RE.test(p.instantKey) && (!preset || p.instantKey !== preset.instantKey) && hit(p.instantKey));
            if (other) run = () => onInstant(other);
          }
        }
        if (!run) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        run();
      }
      window.addEventListener("keydown", onKey, { capture: true, signal });

      // While recording, the In button shows the running length of the range.
      function onTime() {
        const span = el.querySelector("[data-qm-elapsed]");
        const start = inPoints.get(sceneId);
        const at = now();
        if (span && start != null && at != null) span.textContent = formatTime(start) + " → " + formatTime(at);
      }
      if (ctx.video && ctx.video.addEventListener) ctx.video.addEventListener("timeupdate", onTime, { signal });

      function paint() {
        if (signal.aborted) return;
        if (!config) {
          el.innerHTML = `<p class="kb-hint">…</p>`;
          return;
        }
        const preset = active();
        const start = inPoints.get(sceneId);
        const armed = start != null;
        el.innerHTML = `
          <div class="qm-x${armed ? " is-armed" : ""}">
            <div class="qm-x-actions">
              <button type="button" class="kb-btn qm-x-in" data-qm="in" title="${esc(t("Set the in point (start of the range)"))} · ${esc(prettyKey(preset && preset.rangeInKey))}">
                <i class="qm-x-dot" aria-hidden="true"></i>${armed ? `<span data-qm-elapsed>${esc(formatTime(start))}</span>` : esc(t("In"))}
              </button>
              <button type="button" class="kb-btn" data-qm="out" ${armed ? "" : "disabled"} title="${esc(t("Set the out point and save the range marker"))} · ${esc(prettyKey(preset && preset.rangeOutKey))}">${esc(t("Out"))}</button>
              <button type="button" class="kb-btn is-primary" data-qm="instant" title="${esc(t("Marker at the current position"))} · ${esc(prettyKey(preset && preset.instantKey))}">${ui.icon("plus")}${esc(t("Instant"))}</button>
              ${armed ? `<button type="button" class="kb-btn is-icon is-ghost" data-qm="discard" title="${esc(t("Discard in point"))}">${ui.icon("close")}</button>` : ""}
            </div>
            <div class="qm-x-presets" role="listbox" aria-label="${esc(t("Presets"))}">
              ${presets()
                .map((p, i) => `<button type="button" role="option" aria-selected="${p === preset}" class="kb-chip qm-x-chip${p === preset ? " is-on" : ""}" data-qm-preset="${i}" title="${esc(t("Active preset — click to select"))}">${esc(p.label)}${p.selectSlot ? `<kbd>⇧${p.selectSlot}</kbd>` : ""}</button>`)
                .join("")}
            </div>
            ${status ? `<p class="kb-hint qm-x-status">${ui.icon("check")}${esc(t("Last: {text}", { text: status }))}</p>` : ""}
            <div class="qm-x-tools">
              <button type="button" class="kb-btn is-ghost" data-qm="copy" title="${esc(t("Copy all markers of this scene (times, titles, tags)"))}">${ui.icon("copies")}${esc(t("Copy"))}</button>
              <button type="button" class="kb-btn is-ghost" data-qm="paste"${clip ? "" : " disabled"} title="${esc(clip ? t("Paste {n} markers from {title}", { n: clip.markers.length, title: clip.sceneTitle }) : t("Copy the markers of another scene first"))}">${ui.icon("download")}${esc(t("Paste"))}${clip ? `<small>${clip.markers.length}</small>` : ""}</button>
              <button type="button" class="kb-btn is-ghost" data-qm="same" title="${esc(t("Copy markers to scenes with the same video"))}">${ui.icon("layers")}${esc(t("Same videos"))}</button>
              ${undo ? `<button type="button" class="kb-btn is-ghost" data-qm="undo" title="${esc(t("Remove the markers of the last transfer"))}">${ui.icon("undo")}${esc(t("Undo"))}<small>${undo.ids.length}</small></button>` : ""}
            </div>
          </div>`;
      }

      el.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b || !el.contains(b)) return;
        if (b.dataset.qmPreset != null) return select(Number(b.dataset.qmPreset));
        const action = b.dataset.qm;
        if (action === "in") onIn();
        else if (action === "out") onOut();
        else if (action === "instant") onInstant(active());
        else if (action === "discard") discardIn();
        else if (action === "copy") copyMarkers(sceneId);
        else if (action === "paste") openPasteDrawer(sceneId, ctx.reload);
        else if (action === "same") openSameDrawer(sceneId, ctx.reload);
        else if (action === "undo") undoTransfer(ctx.reload, true);
      }, { signal });

      // The clipboard can change in another tab (storage) or another section (CLIPBOARD_EVENT).
      let clip = null;
      let undo = null;
      const readClip = () => {
        markerCopy()
          .then((mc) => {
            clip = mc.readClipboard();
            undo = mc.readUndo();
            paint();
          })
          .catch(() => {});
      };
      window.addEventListener("storage", readClip, { signal });
      window.addEventListener("quickMarkers:clipboard", readClip, { signal });
      readClip();

      paint();
      loadConfig()
        .then((c) => {
          config = c;
          paint();
        })
        .catch((e) => {
          config = defaultConfig();
          paint();
          ui.errorToast(e, "Quick Markers");
        });
    },
  });

  // ---------- Settings → Plugins → Quick Markers ----------

  if (!stashui.has("slot:settings.section")) return;

  stashui.addSlot("settings.section", {
    id: "settings",
    title: "Quick Markers",
    mount(el, ctx) {
      const signal = ctx.signal;
      let config = null;
      let showJson = false;
      let editingId = null; // id of the preset in the form, null = adding a new one
      let draft = null; // what is typed in the form, kept when the page is redrawn

      const SLOTS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

      function emptyDraft() {
        const used = new Set(config.presets.map((p) => p.selectSlot).filter(Boolean));
        return {
          label: "",
          primaryTag: "",
          tags: "",
          selectSlot: String(SLOTS.find((n) => !used.has(n)) || ""),
          rangeInKey: "shift+i",
          rangeOutKey: "shift+o",
          instantKey: DEFAULT_INSTANT_KEY,
        };
      }

      function presetDraft(p) {
        return {
          label: p.label,
          primaryTag: p.primaryTag,
          tags: (p.tags || []).join(", "),
          selectSlot: p.selectSlot ? String(p.selectSlot) : "",
          rangeInKey: p.rangeInKey || "shift+i",
          rangeOutKey: p.rangeOutKey || "shift+o",
          instantKey: p.instantKey || DEFAULT_INSTANT_KEY,
        };
      }

      function startEdit(id) {
        const preset = config.presets.find((p) => p.id === id);
        if (!preset) return;
        editingId = id;
        draft = presetDraft(preset);
        paint();
        const form = el.querySelector("[data-qm-form]");
        if (form) {
          form.scrollIntoView({ behavior: "smooth", block: "start" });
          form.label.focus({ preventScroll: true });
        }
      }

      function stopEdit() {
        editingId = null;
        draft = emptyDraft();
        paint();
      }

      function uniqueId(label) {
        const base = label.toLowerCase().replace(/\s+/g, "-") || "preset";
        const taken = new Set(config.presets.map((p) => p.id));
        let id = base;
        for (let n = 2; taken.has(id); n++) id = base + "-" + n;
        return id;
      }

      async function persist(next, message) {
        try {
          await saveConfig(next);
          config = next;
          ui.toast(message || t("Saved"), "ok");
          return true;
        } catch (e) {
          ui.errorToast(e, "Quick Markers");
          return false;
        } finally {
          paint();
        }
      }

      function slotOptions(selected) {
        return `<option value="">${esc(t("None"))}</option>` + SLOTS
          .map((n) => `<option value="${n}"${String(n) === selected ? " selected" : ""}>Shift+${n}</option>`)
          .join("");
      }

      function field(name, label, attrs) {
        return `<label class="qm-set-field"><span>${esc(label)}</span><input class="kb-field" name="${name}" value="${esc(draft[name])}" autocomplete="off" ${attrs || ""}></label>`;
      }

      function paint() {
        if (signal.aborted) return;
        if (!config) {
          el.innerHTML = `<div class="kb-loading">…</div>`;
          return;
        }
        if (editingId != null && !config.presets.some((p) => p.id === editingId)) editingId = null;
        if (!draft) draft = emptyDraft();
        const editing = editingId != null ? config.presets.find((p) => p.id === editingId) : null;
        const note =
          configSource === "file" ? t("Loaded from presets.json — saving here stores the presets in Stash.")
          : configSource === "defaults" ? t("Built-in defaults — saving here stores the presets in Stash.")
          : "";
        el.innerHTML = `
          <div class="qm-set">
            ${note ? `<p class="kb-hint qm-set-note">${esc(note)}</p>` : ""}
            <section class="qm-set-keys">
              <h2 class="kb-h2">${esc(t("Hotkeys in the player"))}</h2>
              <dl>
                <dt><kbd>⇧1</kbd>–<kbd>⇧9</kbd></dt><dd>${esc(t("select preset"))}</dd>
                <dt><kbd>⇧[</kbd> <kbd>⇧]</kbd></dt><dd>${esc(t("previous / next preset"))}</dd>
                <dt><kbd>⇧I</kbd></dt><dd>${esc(t("in point"))}</dd>
                <dt><kbd>⇧O</kbd></dt><dd>${esc(t("out point + save"))}</dd>
                <dt><kbd>⇧M</kbd></dt><dd>${esc(t("instant marker"))}</dd>
              </dl>
              <p class="kb-hint">${esc(t("They replace the plain I / O / M of the player only together with Shift."))}</p>
            </section>

            <section>
              <h2 class="kb-h2">${esc(t("Presets"))} <small>${config.presets.length}</small></h2>
              <div class="qm-set-list">
                ${config.presets
                  .map((p, i) => `
                  <div class="qm-set-row${p === editing ? " is-editing" : ""}">
                    <span class="qm-set-label">${esc(p.label)}${p.selectSlot ? ` <kbd>⇧${p.selectSlot}</kbd>` : ""}</span>
                    <span class="qm-set-tags"><span class="kb-chip is-on">${esc(p.primaryTag)}</span>${(p.tags || []).map((tag) => `<span class="kb-chip">${esc(tag)}</span>`).join("")}</span>
                    <span class="qm-set-actions">
                      <button type="button" class="kb-btn is-icon is-ghost" data-qm-edit="${esc(p.id)}" title="${esc(t("Edit"))}" aria-label="${esc(t("Edit"))} ${esc(p.label)}">${ui.icon("edit")}</button>
                      <button type="button" class="kb-btn is-icon is-ghost" data-qm-del="${i}" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))} ${esc(p.label)}"${config.presets.length < 2 ? " disabled" : ""}>${ui.icon("trash")}</button>
                    </span>
                  </div>`)
                  .join("")}
              </div>
              <label class="qm-set-field">
                <span>${esc(t("Default preset"))}</span>
                <select class="kb-field" data-qm-default>
                  ${config.presets.map((p, i) => `<option value="${i}"${i === config.defaultPresetIndex ? " selected" : ""}>${esc(p.label)}</option>`).join("")}
                </select>
                <small class="kb-hint">${esc(t("Used when a scene opens. Shift+1–9 and Shift+[ / ] switch while watching."))}</small>
              </label>
            </section>

            <form class="qm-set-form${editing ? " is-editing" : ""}" data-qm-form>
              <h2 class="kb-h2">${editing ? esc(t('Edit preset "{label}"', { label: editing.label })) : esc(t("Add preset"))}</h2>
              <div class="qm-set-grid">
                ${field("label", t("Label"), 'placeholder="Compilation" required')}
                ${field("primaryTag", t("Primary tag"), 'placeholder="Compilation"')}
                ${field("tags", t("Additional tags (comma-separated)"), 'placeholder="Favorite, Outdoor"')}
                <label class="qm-set-field"><span>${esc(t("Select hotkey"))}</span><select class="kb-field" name="selectSlot">${slotOptions(draft.selectSlot)}</select></label>
              </div>
              <p class="kb-hint">${esc(t("Tags must exist in Stash (exact name)."))}</p>
              <fieldset class="qm-set-keyset">
                <legend>${esc(t("Hotkeys of this preset"))}</legend>
                <div class="qm-set-grid">
                  ${field("rangeInKey", t("In point"), 'placeholder="shift+i" spellcheck="false"')}
                  ${field("rangeOutKey", t("Out point + save"), 'placeholder="shift+o" spellcheck="false"')}
                  ${field("instantKey", t("Instant marker"), `placeholder="${DEFAULT_INSTANT_KEY}" spellcheck="false"`)}
                </div>
                <p class="kb-hint">${esc(t("Written like shift+i or shift+]. In / Out / Instant work for the active preset; Shift+1–9 are only for selecting."))}</p>
              </fieldset>
              <div class="qm-set-form-actions">
                <button type="submit" class="kb-btn is-primary">${editing ? ui.icon("check") + esc(t("Save changes")) : ui.icon("plus") + esc(t("Add"))}</button>
                ${editing ? `<button type="button" class="kb-btn" data-qm-cancel>${esc(t("Cancel"))}</button>` : ""}
              </div>
            </form>

            <section>
              <button type="button" class="kb-btn" data-qm-json aria-expanded="${showJson}">${ui.icon("edit")}${esc(t("Edit JSON (advanced)"))}</button>
              ${showJson ? `
                <textarea class="kb-field qm-set-json" rows="16" spellcheck="false" data-qm-json-text>${esc(presetsToJson(config))}</textarea>
                <button type="button" class="kb-btn is-primary" data-qm-json-save>${esc(t("Save JSON"))}</button>` : ""}
            </section>
          </div>`;
      }

      const inForm = (target) => !!(draft && target.form && target.form.matches("[data-qm-form]") && target.name in draft);

      el.addEventListener("input", (e) => {
        if (inForm(e.target)) draft[e.target.name] = e.target.value;
      }, { signal });

      el.addEventListener("change", (e) => {
        if (inForm(e.target)) {
          draft[e.target.name] = e.target.value;
          return;
        }
        if (!e.target.matches("[data-qm-default]")) return;
        persist(Object.assign({}, config, { defaultPresetIndex: Number(e.target.value) }));
      }, { signal });

      el.addEventListener("submit", async (e) => {
        e.preventDefault();
        const label = draft.label.trim();
        const primaryTag = (draft.primaryTag || label).trim();
        if (!label || !primaryTag) {
          ui.toast(t("Label and primary tag are required."), "error");
          return;
        }
        const fields = {
          label,
          primaryTag,
          tags: normalizePresetTags(draft.tags, primaryTag),
          title: label,
          rangeInKey: (draft.rangeInKey.trim() || "shift+i").toLowerCase(),
          rangeOutKey: (draft.rangeOutKey.trim() || "shift+o").toLowerCase(),
          instantKey: normalizeInstantKey(draft.instantKey),
          selectSlot: normalizeSelectSlot(draft.selectSlot || null, 99),
        };
        // A select slot belongs to one preset: taking it clears it on the others.
        const freeSlot = (p) => (fields.selectSlot && p.selectSlot === fields.selectSlot ? Object.assign({}, p, { selectSlot: null }) : p);
        const editing = editingId;
        const presets = editing != null
          ? config.presets.map((p) => (p.id === editing ? Object.assign({}, p, fields) : freeSlot(p)))
          : config.presets.map(freeSlot).concat([Object.assign({ id: uniqueId(label) }, fields)]);
        const ok = await persist(Object.assign({}, config, { presets }), editing != null ? t("Preset updated") : t("Preset added"));
        if (ok) stopEdit();
      }, { signal });

      el.addEventListener("click", async (e) => {
        const b = e.target.closest("button");
        if (!b || !el.contains(b)) return;
        if (b.dataset.qmEdit != null) {
          startEdit(b.dataset.qmEdit);
        } else if (b.dataset.qmCancel != null) {
          stopEdit();
        } else if (b.dataset.qmDel != null) {
          const index = Number(b.dataset.qmDel);
          const preset = config.presets[index];
          if (!preset || config.presets.length < 2) return;
          const answer = await ui.confirmDialog({ title: "Quick Markers", text: t('Remove preset "{label}"?', { label: preset.label }), ok: t("Delete"), danger: true });
          if (!answer || !answer.ok) return;
          const presets = config.presets.filter((p, i) => i !== index);
          const defaultPresetIndex = Math.min(config.defaultPresetIndex, presets.length - 1);
          if (preset.id === editingId) {
            editingId = null;
            draft = null;
          }
          persist(Object.assign({}, config, { presets, defaultPresetIndex }));
        } else if (b.dataset.qmJson != null) {
          showJson = !showJson;
          paint();
        } else if (b.dataset.qmJsonSave != null) {
          try {
            const parsed = parsePresetsJson(el.querySelector("[data-qm-json-text]").value);
            if (!parsed) throw new Error("presets must be a non-empty array");
            if (await persist(parsed)) {
              editingId = null;
              draft = null;
              paint();
            }
          } catch (err) {
            ui.errorToast(err, "JSON");
          }
        }
      }, { signal });

      paint();
      loadConfig()
        .then((c) => {
          config = c;
          paint();
        })
        .catch((e) => ui.errorToast(e, "Quick Markers"));
    },
  });
}
