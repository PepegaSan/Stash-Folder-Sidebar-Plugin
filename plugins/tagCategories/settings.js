// Settings page of Tag Categories – one module for both interfaces: tagCategories.js mounts it into the
// PluginSettings patch (classic Stash, and Stash UI's Plugins page), stashui.js into Stash UI's settings section.
// The host passes what differs (env): theme, GraphQL, toasts, and how the categories are loaded and saved.
//
//   mountSettings(el, {
//     theme: "classic" | "stashui", lang: "de" | "en", t?(text, vars), version,
//     gql(query, vars) → data, toast(text, "ok" | "error"), confirm?({ title, text, ok, danger }) → bool,
//     load() → { config: { categories }, source: "settings" | "file" | "defaults" }, save(config),
//     parseJson(text) → config, toJson(config) → text,
//   }) → { destroy() }

const SUGGEST_DEBOUNCE_MS = 180;
const PREVIEW_DEBOUNCE_MS = 400;

export const STRINGS_DE = {
  "Browse scenes by your own categories. A category combines tags and performers.":
    "Szenen nach eigenen Kategorien durchsuchen. Eine Kategorie fasst Tags und Darsteller zusammen.",
  Help: "Hilfe",
  Categories: "Kategorien",
  "New category": "Neue Kategorie",
  Category: "Kategorie",
  "Tags and performers": "Tags und Darsteller",
  "+ sub-tags": "+ Unter-Tags",
  "{n} scenes": "{n} Szenen",
  "1 scene": "1 Szene",
  "No scenes": "Keine Szenen",
  "Tag doesn't exist in Stash": "Tag existiert in Stash nicht",
  "Performer doesn't exist in Stash": "Darsteller existiert in Stash nicht",
  "Something is missing in Stash": "Etwas fehlt in Stash",
  "Edit {name}": "{name} bearbeiten",
  "Delete {name}": "{name} löschen",
  "Move {name}": "{name} verschieben",
  "Drag to change the order (or ↑ / ↓)": "Ziehen ändert die Reihenfolge (oder ↑ / ↓)",
  "Close editor": "Editor schließen",
  Name: "Name",
  "e.g. Outdoor": "z. B. Outdoor",
  Tags: "Tags",
  "Add a tag …": "Tag hinzufügen …",
  "Scenes with any of these tags belong to the category. Enter takes the highlighted suggestion.":
    "Szenen mit einem dieser Tags gehören zur Kategorie. Enter übernimmt den markierten Vorschlag.",
  "Include sub-tags": "Unter-Tags einbeziehen",
  "Scenes with a child tag of these tags count too (any depth).": "Auch Szenen mit Tags, die unter diesen Tags hängen (beliebig tief).",
  Performers: "Darsteller",
  "(optional)": "(optional)",
  "Add a performer …": "Darsteller hinzufügen …",
  "Their scenes belong to the category too; each gets a chip of its own.":
    "Ihre Szenen gehören auch zur Kategorie; jeder bekommt einen eigenen Chip.",
  "Preview: {scenes} match this category.": "Vorschau: {scenes} passen zu dieser Kategorie.",
  "Preview: add tags or performers.": "Vorschau: Tags oder Darsteller hinzufügen.",
  "Preview: none of these exist in Stash yet.": "Vorschau: Nichts davon gibt es bisher in Stash.",
  "Counting …": "Zähle …",
  Cancel: "Abbrechen",
  Save: "Speichern",
  Add: "Hinzufügen",
  "Give the category a name.": "Gib der Kategorie einen Namen.",
  "Add at least one tag or performer.": "Mindestens einen Tag oder Darsteller hinzufügen.",
  "Category added": "Kategorie hinzugefügt",
  "Category updated": "Kategorie aktualisiert",
  "Category removed": "Kategorie entfernt",
  "Order saved": "Reihenfolge gespeichert",
  Saved: "Gespeichert",
  Delete: "Löschen",
  'Remove category "{name}"?': "Kategorie „{name}“ entfernen?",
  "Discard the changes to this category?": "Änderungen an dieser Kategorie verwerfen?",
  Discard: "Verwerfen",
  "No matching tag": "Kein passender Tag",
  "No matching performer": "Kein passender Darsteller",
  "Add “{name}”": "„{name}“ übernehmen",
  "Remove {name}": "{name} entfernen",
  "No categories yet": "Noch keine Kategorien",
  "A category is a list of tags and performers. Its page shows every scene that has any of them.":
    "Eine Kategorie ist eine Liste von Tags und Darstellern. Ihre Seite zeigt jede Szene, die eines davon hat.",
  Advanced: "Erweitert",
  "JSON, help": "JSON, Hilfe",
  "Saved in Stash": "Gespeichert in Stash",
  "Loaded from categories.json — saving here stores the categories in Stash.":
    "Aus categories.json geladen – Speichern hier legt die Kategorien in Stash ab.",
  "No categories saved yet — the first one you add is stored in Stash.":
    "Noch keine Kategorien gespeichert – die erste, die du anlegst, landet in Stash.",
  "These don't exist in Stash and are skipped on the category pages: {names}.":
    "Diese gibt es in Stash nicht, auf den Kategorie-Seiten werden sie übersprungen: {names}.",
  "Categories as JSON": "Kategorien als JSON",
  "Save JSON": "JSON speichern",
  "Replaces all categories. Fields per category: name, tags, optional performers, subTags (true = include sub-tags) and id (fixed address of its page).":
    "Ersetzt alle Kategorien. Felder je Kategorie: name, tags, optional performers, subTags (true = Unter-Tags einbeziehen) und id (feste Adresse ihrer Seite).",
  "How categories work": "So funktionieren Kategorien",
  "Open Categories in the main menu and pick one: it lists every scene that has at least one of its tags or performers. Names must match Stash (case doesn't matter) — missing ones are shown in red.":
    "Im Hauptmenü Kategorien öffnen und eine wählen: Sie zeigt jede Szene, die mindestens einen ihrer Tags oder Darsteller hat. Die Namen müssen zu Stash passen (Groß-/Kleinschreibung egal) – fehlende werden rot angezeigt.",
  "On the category page, the chips narrow the list down; ★ makes a chip the main one: every scene has it, and the other chips show only what goes with it.":
    "Auf der Kategorie-Seite grenzen die Chips die Liste ein; ★ macht einen Chip zum Haupt-Chip: Jede Szene hat ihn, und die anderen Chips zeigen nur, was dazu passt.",
  "The order here is the order in the menu of the category page. Drag the handle on the left to change it.":
    "Die Reihenfolge hier ist die im Menü der Kategorie-Seite. Zum Ändern links am Griff ziehen.",
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
  const found = { t: new Map(), p: new Map() }; // lower-case name → Promise<id | null>
  const counts = new Map(); // category signature → number of scenes (null = nothing exists)

  const S = {
    config: null,
    source: "settings",
    open: null, // id of the category in the editor, "new" for a new one
    draft: null,
    base: "", // the draft as it was opened (to notice changes)
    typing: { tags: "", performers: "" }, // text in the chip inputs
    suggest: null, // { field, items, index, q }
    missing: { t: new Set(), p: new Set() }, // lower-case names that don't exist in Stash
    preview: undefined, // scenes of the draft: undefined = counting, null = nothing exists
    advanced: false,
    json: null, // text in the JSON editor (null = from the config)
  };

  // ---------- Helpers ----------

  const err = (e) => (e && e.message) || String(e);
  const fmtNum = (n) => Number(n || 0).toLocaleString(env.lang === "de" ? "de-DE" : undefined);
  const scenesText = (n) => (n === 1 ? t("1 scene") : t("{n} scenes", { n: fmtNum(n) }));
  const lower = (s) => String(s || "").trim().toLowerCase();
  const cats = () => S.config.categories;
  const kindOf = (field) => (field === "tags" ? "t" : "p");
  const signature = (c) => JSON.stringify([c.tags.map(lower).sort(), c.performers.map(lower).sort(), !!c.subTags]);

  // Name → Stash id, the same way the category page finds them: exact tag name; performer name, else an alias
  function findId(kind, name) {
    const key = lower(name);
    const cache = found[kind];
    if (!cache.has(key)) {
      const p = (async () => {
        if (kind === "t") {
          const q = "query($f: FindFilterType, $tf: TagFilterType) { findTags(filter: $f, tag_filter: $tf) { tags { id name } } }";
          for (const modifier of ["EQUALS", "INCLUDES"]) {
            const d = await env.gql(q, { f: { per_page: 25, q: name }, tf: { name: { value: name, modifier } } });
            const hit = ((d && d.findTags && d.findTags.tags) || []).find((tg) => lower(tg.name) === key);
            if (hit) return hit.id;
          }
          return null;
        }
        const q = "query($f: FindFilterType, $pf: PerformerFilterType) { findPerformers(filter: $f, performer_filter: $pf) { performers { id name alias_list } } }";
        let d = await env.gql(q, { f: { per_page: 25 }, pf: { name: { value: name, modifier: "EQUALS" } } });
        let hit = ((d && d.findPerformers && d.findPerformers.performers) || []).find((p) => lower(p.name) === key);
        if (!hit) {
          d = await env.gql(q, { f: { per_page: 25, q: name } });
          hit = ((d && d.findPerformers && d.findPerformers.performers) || []).find((p) => (p.alias_list || []).some((a) => lower(a) === key));
        }
        return hit ? hit.id : null;
      })();
      p.catch(() => cache.delete(key));
      cache.set(key, p);
    }
    return cache.get(key);
  }

  // Scenes with any of the tags or performers (like the category page without a selection); null = none exists
  async function countScenes(c) {
    const tagIds = (await Promise.all(c.tags.map((n) => findId("t", n)))).filter(Boolean);
    const perfIds = (await Promise.all(c.performers.map((n) => findId("p", n)))).filter(Boolean);
    if (!tagIds.length && !perfIds.length) return null;
    const depth = c.subTags ? -1 : 0;
    const filter = !perfIds.length
      ? { tags: { value: tagIds, modifier: "INCLUDES", depth } }
      : !tagIds.length
        ? { performers: { value: perfIds, modifier: "INCLUDES" } }
        : // "none of the tags and none of the performers", negated (one OR across both kinds)
          { NOT: { tags: { value: tagIds, modifier: "EXCLUDES", depth }, performers: { value: perfIds, modifier: "EXCLUDES" } } };
    const d = await env.gql("query($x: SceneFilterType) { findScenes(scene_filter: $x, filter: { per_page: 0 }) { count } }", { x: filter });
    return d.findScenes.count;
  }

  async function checkNames() {
    const names = { t: new Map(), p: new Map() };
    const add = (c) => {
      c.tags.forEach((n) => names.t.set(lower(n), n));
      c.performers.forEach((n) => names.p.set(lower(n), n));
    };
    cats().forEach(add);
    if (S.draft) add(S.draft);
    const missing = { t: new Set(), p: new Set() };
    await Promise.all(
      ["t", "p"].flatMap((kind) =>
        [...names[kind]].map(async ([key, name]) => {
          try {
            if (!(await findId(kind, name))) missing[kind].add(key);
          } catch (e) {
            /* unknown – not marked */
          }
        })
      )
    );
    if (ac.signal.aborted) return;
    const same = (a, b) => a.size === b.size && [...a].every((k) => b.has(k));
    const changed = !same(missing.t, S.missing.t) || !same(missing.p, S.missing.p);
    S.missing = missing;
    if (changed) paint();
  }

  // Scene numbers in the list, one category after the other
  let countRun = 0;
  async function countAll() {
    const run = ++countRun;
    for (const c of cats()) {
      const sig = signature(c);
      if (counts.has(sig)) continue;
      try {
        counts.set(sig, await countScenes(c));
      } catch (e) {
        counts.set(sig, undefined);
      }
      if (ac.signal.aborted || run !== countRun) return;
      const box = el.querySelector(`[data-count="${CSS.escape(c.id)}"]`);
      if (box) box.textContent = countText(counts.get(sig));
    }
  }

  const countText = (n) => (n === undefined ? "" : n === null ? t("No scenes") : scenesText(n));

  function previewLater() {
    if (!S.draft) return;
    S.preview = undefined;
    paintPreview();
    later("preview", PREVIEW_DEBOUNCE_MS, async () => {
      const d = S.draft;
      if (!d) return;
      const sig = signature(d);
      try {
        const n = d.tags.length || d.performers.length ? await countScenes(d) : 0;
        if (ac.signal.aborted || !S.draft || signature(S.draft) !== sig) return;
        S.preview = n;
      } catch (e) {
        S.preview = "error";
      }
      paintPreview();
    });
  }

  async function suggest(field, text) {
    const q = text.trim();
    if (!q) {
      S.suggest = null;
      return paintSuggest(field);
    }
    const tags = field === "tags";
    const d = await env.gql(
      tags
        ? "query($f: FindFilterType) { findTags(filter: $f) { tags { id name scene_count aliases } } }"
        : "query($f: FindFilterType) { findPerformers(filter: $f) { performers { id name scene_count alias_list disambiguation } } }",
      { f: { q, per_page: 30 } }
    );
    if (ac.signal.aborted || !S.draft || S.typing[field].trim() !== q) return;
    const list = (tags ? d && d.findTags && d.findTags.tags : d && d.findPerformers && d.findPerformers.performers) || [];
    const ql = q.toLowerCase();
    const taken = new Set(S.draft[field].map(lower));
    const rank = (x) => {
      const n = x.name.toLowerCase();
      return n === ql ? 0 : n.startsWith(ql) ? 1 : n.includes(ql) ? 2 : 3;
    };
    const items = list
      .filter((x) => !taken.has(x.name.toLowerCase()))
      .sort((a, b) => rank(a) - rank(b) || (b.scene_count || 0) - (a.scene_count || 0) || a.name.localeCompare(b.name))
      .slice(0, 8)
      .map((x) => {
        found[kindOf(field)].set(x.name.toLowerCase(), Promise.resolve(x.id));
        const aliases = (tags ? x.aliases : x.alias_list) || [];
        const alias = rank(x) === 3 ? aliases.find((a) => a.toLowerCase().includes(ql)) : x.disambiguation || null;
        return { name: x.name, count: x.scene_count || 0, alias };
      });
    S.suggest = { field, items, index: 0, q };
    paintSuggest(field);
  }

  function later(key, ms, fn) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(fn, ms));
  }

  // ---------- Drafts ----------

  const dirty = () => !!S.draft && JSON.stringify(S.draft) !== S.base;

  async function openEditor(id) {
    if (S.open === id) return;
    if (dirty() && !(await ask({ title: "Tag Categories", text: t("Discard the changes to this category?"), ok: t("Discard"), danger: true }))) return;
    const cat = id === "new" ? null : cats().find((c) => c.id === id);
    if (id !== "new" && !cat) return;
    S.open = id;
    S.draft = cat
      ? { name: cat.name, tags: cat.tags.slice(), performers: cat.performers.slice(), subTags: !!cat.subTags }
      : { name: "", tags: [], performers: [], subTags: false };
    S.base = JSON.stringify(S.draft);
    S.typing = { tags: "", performers: "" };
    S.suggest = null;
    S.preview = cat ? counts.get(signature(cat)) : 0;
    paint();
    if (S.preview === undefined) previewLater();
    const editor = el.querySelector("[data-editor]");
    if (editor) {
      editor.scrollIntoView({ behavior: "smooth", block: "nearest" });
      const name = editor.querySelector('[data-draft="name"]');
      if (name) name.focus({ preventScroll: true });
    }
  }

  function closeEditor() {
    S.open = null;
    S.draft = null;
    S.suggest = null;
    paint();
  }

  function addName(field, raw) {
    const d = S.draft;
    const kind = kindOf(field);
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((name) => {
        const key = lower(name);
        if (d[field].some((n) => lower(n) === key)) return;
        d[field].push(name);
        findId(kind, name)
          .then((id) => {
            if (ac.signal.aborted || !!id === !S.missing[kind].has(key)) return;
            if (id) S.missing[kind].delete(key);
            else S.missing[kind].add(key);
            paint();
          })
          .catch(() => {});
      });
    S.typing[field] = "";
    S.suggest = null;
    paint();
    previewLater();
  }

  async function saveDraft() {
    const d = S.draft;
    if (S.typing.tags.trim()) addName("tags", S.typing.tags);
    if (S.typing.performers.trim()) addName("performers", S.typing.performers);
    const name = d.name.trim();
    if (!name) {
      env.toast(t("Give the category a name."), "error");
      const input = el.querySelector('[data-draft="name"]');
      if (input) input.focus();
      return;
    }
    if (!d.tags.length && !d.performers.length) {
      env.toast(t("Add at least one tag or performer."), "error");
      return;
    }
    const fields = { name, tags: d.tags.slice(), performers: d.performers.slice(), subTags: !!d.subTags };
    const editing = S.open !== "new" ? S.open : null;
    const categories = editing
      ? cats().map((c) => (c.id === editing ? Object.assign({ id: c.id }, fields) : c))
      : cats().concat([Object.assign({ id: uniqueId(name) }, fields)]);
    if (typeof S.preview === "number") counts.set(signature(fields), S.preview);
    if (await persist(Object.assign({}, S.config, { categories }), editing ? t("Category updated") : t("Category added"))) {
      S.open = null;
      S.draft = null;
      paint();
    }
  }

  function uniqueId(name) {
    const base =
      String(name || "")
        .trim()
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9\-_]/g, "") || "category";
    const taken = new Set(cats().map((c) => c.id));
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
      checkNames();
      return true;
    } catch (e) {
      env.toast(err(e), "error");
      return false;
    } finally {
      paint();
      countAll();
    }
  }

  function move(from, to) {
    const list = cats().slice();
    if (to < 0 || to >= list.length || from === to) return;
    list.splice(to, 0, list.splice(from, 1)[0]);
    persist(Object.assign({}, S.config, { categories: list }), t("Order saved"));
  }

  async function remove(id) {
    const cat = cats().find((c) => c.id === id);
    if (!cat) return;
    if (!(await ask({ title: "Tag Categories", text: t('Remove category "{name}"?', { name: cat.name }), ok: t("Delete"), danger: true }))) return;
    if (S.open === id) {
      S.open = null;
      S.draft = null;
    }
    persist(Object.assign({}, S.config, { categories: cats().filter((c) => c.id !== id) }), t("Category removed"));
  }

  function ask(opts) {
    if (env.confirm) return Promise.resolve(env.confirm(opts)).then(Boolean);
    return new Promise((resolve) => {
      const back = document.createElement("div");
      back.className = "tcs tcs-modal-back is-" + env.theme;
      back.innerHTML = `<div class="tcs-modal" role="dialog" aria-modal="true" aria-labelledby="tcs-modal-title">
          <h3 id="tcs-modal-title">${esc(opts.title)}</h3><p>${esc(opts.text)}</p>
          <div class="tcs-modal-foot"><button type="button" class="${C.btn}" data-no>${esc(t("Cancel"))}</button><button type="button" class="${opts.danger ? C.danger : C.primary}" data-yes>${esc(opts.ok)}</button></div>
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

  function chip(name, kind, removeField, index) {
    const miss = S.missing[kind].has(lower(name));
    const cls = "tcs-chip" + (kind === "p" ? " is-perf" : "") + (miss ? " is-miss" : "");
    const title = miss ? t(kind === "p" ? "Performer doesn't exist in Stash" : "Tag doesn't exist in Stash") : "";
    return `<span class="${cls}"${title ? ` title="${esc(title)}"` : ""}>${kind === "p" ? ICON.person : ""}${esc(name)}${
      removeField ? `<button type="button" class="tcs-chip-x" data-unchip="${removeField}" data-i="${index}" aria-label="${esc(t("Remove {name}", { name }))}">${ICON.x}</button>` : ""
    }</span>`;
  }

  function chipBox(field) {
    const d = S.draft;
    const kind = kindOf(field);
    const open = S.suggest && S.suggest.field === field;
    const label = t(field === "tags" ? "Tags" : "Performers");
    return `<div class="${C.field} tcs-chipbox" data-chipbox="${field}">
        ${d[field].map((n, i) => chip(n, kind, field, i)).join("")}
        <input class="tcs-chipinput" data-chipinput="${field}" data-focus="chip:${field}" value="${esc(S.typing[field])}" placeholder="${esc(t(field === "tags" ? "Add a tag …" : "Add a performer …"))}"
          autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="${open}" aria-controls="tcs-sg-${field}" aria-label="${esc(label)}">
        <div class="tcs-suggest" id="tcs-sg-${field}" role="listbox" data-suggest="${field}"${open ? "" : " hidden"}>${open ? suggestHtml() : ""}</div>
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
      (it, i) => `<div class="tcs-sg-item${i === sg.index ? " is-active" : ""}" role="option" aria-selected="${i === sg.index}" data-pick="${esc(it.name)}">
          <span>${mark(it.name)}${it.alias ? ` <small>(${esc(it.alias)})</small>` : ""}</span><small>${esc(scenesText(it.count))}</small></div>`
    );
    if (!exact) {
      const none = sg.field === "tags" ? "No matching tag" : "No matching performer";
      rows.push(`<div class="tcs-sg-item tcs-sg-free${sg.index === sg.items.length ? " is-active" : ""}" role="option" data-pick="${esc(sg.q)}">${esc(t("Add “{name}”", { name: sg.q }))}${sg.items.length ? "" : ` <small>${esc(t(none))}</small>`}</div>`);
    }
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

  function previewHtml() {
    const d = S.draft;
    const n = S.preview;
    const text =
      !d.tags.length && !d.performers.length ? t("Preview: add tags or performers.")
      : n === undefined ? t("Counting …")
      : n === null ? t("Preview: none of these exist in Stash yet.")
      : n === "error" ? ""
      : t("Preview: {scenes} match this category.", { scenes: scenesText(n) });
    return text ? `${ICON.eye}<span>${esc(text)}</span>` : "";
  }

  function paintPreview() {
    const box = el.querySelector("[data-preview]");
    if (box) box.innerHTML = previewHtml();
  }

  function editorHtml(cat) {
    const d = S.draft;
    return `<div class="tcs-editor" data-editor>
        <div class="tcs-ed-grid">
          <div class="tcs-ed-col">
            <label class="tcs-field"><span class="tcs-label">${esc(t("Name"))}</span>
              <input class="${C.field}" data-draft="name" data-focus="name" value="${esc(d.name)}" placeholder="${esc(t("e.g. Outdoor"))}" maxlength="80" autocomplete="off"></label>
            <div class="tcs-field"><span class="tcs-label">${esc(t("Tags"))}</span>${chipBox("tags")}
              <small class="tcs-hint">${esc(t("Scenes with any of these tags belong to the category. Enter takes the highlighted suggestion."))}</small></div>
            <label class="tcs-switchrow">
              <span><b>${esc(t("Include sub-tags"))}</b><small>${esc(t("Scenes with a child tag of these tags count too (any depth)."))}</small></span>
              <input type="checkbox" class="tcs-switch" data-subtags${d.subTags ? " checked" : ""} data-focus="subtags">
            </label>
          </div>
          <div class="tcs-ed-col">
            <div class="tcs-field"><span class="tcs-label">${esc(t("Performers"))} <span class="tcs-opt">${esc(t("(optional)"))}</span></span>${chipBox("performers")}
              <small class="tcs-hint">${esc(t("Their scenes belong to the category too; each gets a chip of its own."))}</small></div>
            <div class="tcs-preview" data-preview aria-live="polite">${previewHtml()}</div>
          </div>
        </div>
        <div class="tcs-ed-foot">
          <button type="button" class="${C.btn}" data-act="cancel">${esc(t("Cancel"))}</button>
          <button type="button" class="${C.primary}" data-act="save">${cat ? ICON.check + esc(t("Save")) : ICON.plus + esc(t("Add"))}</button>
        </div>
      </div>`;
  }

  function rowHtml(c) {
    const open = S.open === c.id;
    const miss = c.tags.some((n) => S.missing.t.has(lower(n))) || c.performers.some((n) => S.missing.p.has(lower(n)));
    return `<div class="tcs-row${open ? " is-open" : ""}" data-row="${esc(c.id)}">
        <button type="button" class="tcs-grip" data-grip="${esc(c.id)}" data-focus="grip:${esc(c.id)}" aria-label="${esc(t("Move {name}", { name: c.name }))}" title="${esc(t("Drag to change the order (or ↑ / ↓)"))}">${ICON.grip}</button>
        <div class="tcs-name" data-toggle="${esc(c.id)}"><b>${esc(c.name)}</b><small data-count="${esc(c.id)}">${esc(countText(counts.get(signature(c))))}</small></div>
        <div class="tcs-main" data-toggle="${esc(c.id)}">
          <div class="tcs-chips">${c.tags.map((n) => chip(n, "t")).join("")}${c.performers.map((n) => chip(n, "p")).join("")}${
            c.subTags ? `<span class="tcs-badge">${esc(t("+ sub-tags"))}</span>` : ""
          }</div>
          ${miss ? `<span class="tcs-warnline">${ICON.warn}${esc(t("Something is missing in Stash"))}</span>` : ""}
        </div>
        <div class="tcs-actions">${
          open
            ? `<button type="button" class="tcs-ib is-on" data-act="cancel" aria-label="${esc(t("Close editor"))}" title="${esc(t("Close editor"))}">${ICON.up}</button>`
            : `<button type="button" class="tcs-ib" data-edit="${esc(c.id)}" aria-label="${esc(t("Edit {name}", { name: c.name }))}" title="${esc(t("Edit {name}", { name: c.name }))}">${ICON.edit}</button>
               <button type="button" class="tcs-ib is-danger" data-del="${esc(c.id)}" aria-label="${esc(t("Delete {name}", { name: c.name }))}" title="${esc(t("Delete {name}", { name: c.name }))}">${ICON.trash}</button>`
        }</div>
      </div>${open ? editorHtml(c) : ""}`;
  }

  function html() {
    if (!S.config) return `<div class="tcs tcs-page is-${env.theme}"><p class="tcs-hint">${esc(t("Loading …"))}</p></div>`;
    const note =
      S.source === "file" ? t("Loaded from categories.json — saving here stores the categories in Stash.")
      : S.source === "defaults" && !cats().length ? t("No categories saved yet — the first one you add is stored in Stash.")
      : "";
    const missingNames = [
      ...new Set(cats().flatMap((c) => c.tags.filter((n) => S.missing.t.has(lower(n))).concat(c.performers.filter((n) => S.missing.p.has(lower(n)))))),
    ];
    const isNew = S.open === "new";
    const empty = !cats().length && !isNew;
    const json = S.json != null ? S.json : env.toJson(S.config);
    return `<div class="tcs tcs-page is-${env.theme}">
        <header class="tcs-head">
          <div>
            <div class="tcs-title"><h2>Tag Categories</h2><span class="tcs-ver">v${esc(env.version)}</span></div>
            <p class="tcs-sub">${esc(t("Browse scenes by your own categories. A category combines tags and performers."))}</p>
          </div>
          <div class="tcs-head-actions">
            <button type="button" class="${C.ghost} tcs-hbtn" data-act="json">${ICON.code}JSON</button>
            <button type="button" class="${C.ghost} tcs-hbtn" data-act="help">${ICON.help}${esc(t("Help"))}</button>
          </div>
        </header>
        ${note ? `<p class="tcs-note">${esc(note)}</p>` : ""}
        ${missingNames.length ? `<p class="tcs-note is-bad">${ICON.warn}<span>${esc(t("These don't exist in Stash and are skipped on the category pages: {names}.", { names: missingNames.join(", ") }))}</span></p>` : ""}
        <section class="tcs-cats">
          <div class="tcs-sechead">
            <h3>${esc(t("Categories"))} <span>${cats().length}</span></h3>
            <button type="button" class="${C.primary}" data-act="new"${isNew ? " disabled" : ""}>${ICON.plus}${esc(t("New category"))}</button>
          </div>
          ${
            empty
              ? `<div class="tcs-empty"><b>${esc(t("No categories yet"))}</b><p>${esc(t("A category is a list of tags and performers. Its page shows every scene that has any of them."))}</p>
                  <button type="button" class="${C.primary}" data-act="new">${ICON.plus}${esc(t("New category"))}</button></div>`
              : `<div class="tcs-list" data-list>
                  <div class="tcs-row tcs-row-head" aria-hidden="true"><span></span><span>${esc(t("Category"))}</span><span>${esc(t("Tags and performers"))}</span><span></span></div>
                  ${cats().map(rowHtml).join("")}
                  ${isNew ? `<div class="tcs-row is-open tcs-row-new"><span></span><div class="tcs-name"><b>${esc(S.draft.name.trim() || t("New category"))}</b></div><span class="tcs-main"></span>
                      <div class="tcs-actions"><button type="button" class="tcs-ib is-on" data-act="cancel" aria-label="${esc(t("Close editor"))}">${ICON.up}</button></div></div>${editorHtml(null)}` : ""}
                </div>`
          }
        </section>
        <details class="tcs-adv" data-adv${S.advanced ? " open" : ""}>
          <summary>${ICON.right}<b>${esc(t("Advanced"))}</b><span>${esc(t("JSON, help"))}</span><small>${esc(t("Saved in Stash"))}</small></summary>
          <div class="tcs-adv-body">
            <div class="tcs-help" data-help>
              <h4>${esc(t("How categories work"))}</h4>
              <p>${esc(t("Open Categories in the main menu and pick one: it lists every scene that has at least one of its tags or performers. Names must match Stash (case doesn't matter) — missing ones are shown in red."))}</p>
              <p>${esc(t("On the category page, the chips narrow the list down; ★ makes a chip the main one: every scene has it, and the other chips show only what goes with it."))}</p>
              <p>${esc(t("The order here is the order in the menu of the category page. Drag the handle on the left to change it."))}</p>
            </div>
            <div class="tcs-field" data-jsonbox>
              <label class="tcs-label" for="tcs-json">${esc(t("Categories as JSON"))}</label>
              <textarea id="tcs-json" class="${C.field} tcs-json" rows="14" spellcheck="false" data-json data-focus="json">${esc(json)}</textarea>
              <small class="tcs-hint">${esc(t("Replaces all categories. Fields per category: name, tags, optional performers, subTags (true = include sub-tags) and id (fixed address of its page)."))}</small>
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
      return;
    }
    const toggle = e.target.closest("[data-toggle]");
    if (toggle && !e.target.closest("button")) return S.open === toggle.dataset.toggle ? closeEditor() : openEditor(toggle.dataset.toggle);
    const b = e.target.closest("button");
    if (!b || !el.contains(b)) return;
    if (b.dataset.unchip) {
      S.draft[b.dataset.unchip].splice(Number(b.dataset.i), 1);
      paint();
      return previewLater();
    }
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
      } catch (x) {
        return env.toast("JSON: " + err(x), "error");
      }
      S.open = null;
      S.draft = null;
      persist(parsed, t("Saved"));
    }
  });

  // Picking a suggestion must not take the focus out of the chip input first
  on("mousedown", (e) => {
    if (e.target.closest("[data-pick]")) e.preventDefault();
  });

  on("input", (e) => {
    const n = e.target;
    if (n.dataset.draft) S.draft[n.dataset.draft] = n.value;
    else if (n.dataset.chipinput) {
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
    if (e.target.matches("[data-subtags]")) {
      S.draft.subTags = e.target.checked;
      previewLater();
    }
  });

  on("keydown", (e) => {
    const n = e.target;
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
        previewLater();
      }
      return;
    }
    if (n.dataset.draft === "name" && e.key === "Enter") {
      e.preventDefault();
      saveDraft();
      return;
    }
    if (n.dataset.grip && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      const from = cats().findIndex((c) => c.id === n.dataset.grip);
      move(from, from + (e.key === "ArrowUp" ? -1 : 1));
    }
  });

  on("focusout", (e) => {
    const n = e.target;
    if (!n.dataset.chipinput) return;
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
  });

  on("toggle", (e) => {
    if (e.target.matches("[data-adv]")) S.advanced = e.target.open;
  }, { capture: true });

  // Dragging a row by its handle (mouse and touch)
  on("pointerdown", (e) => {
    const grip = e.target.closest("[data-grip]");
    if (!grip || e.button !== 0) return;
    e.preventDefault();
    const rows = [...el.querySelectorAll(".tcs-row[data-row]")];
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
      checkNames();
      countAll();
    })
    .catch((e) => {
      if (ac.signal.aborted) return;
      el.innerHTML = `<div class="tcs tcs-page is-${env.theme}"><p class="tcs-note is-bad">${esc(err(e))}</p></div>`;
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
  if (document.querySelector("link[data-tc-settings]")) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.dataset.tcSettings = "";
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

const svg = (body, w = 16, h = 16) =>
  `<svg class="tcs-ic" width="${w}" height="${h}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICON = {
  grip: `<svg class="tcs-ic" width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true"><circle cx="2" cy="3" r="1.4"/><circle cx="8" cy="3" r="1.4"/><circle cx="2" cy="8" r="1.4"/><circle cx="8" cy="8" r="1.4"/><circle cx="2" cy="13" r="1.4"/><circle cx="8" cy="13" r="1.4"/></svg>`,
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  trash: svg('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  check: svg('<path d="M20 6 9 17l-5-5"/>'),
  up: svg('<path d="m6 15 6-6 6 6"/>'),
  right: svg('<path d="m9 6 6 6-6 6"/>'),
  code: svg('<path d="m8 6-6 6 6 6M16 6l6 6-6 6"/>'),
  help: svg('<circle cx="12" cy="12" r="10"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>'),
  warn: svg('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>', 14, 14),
  eye: svg('<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'),
  x: svg('<path d="M18 6 6 18M6 6l12 12"/>', 12, 12),
  person: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', 12, 12),
};
