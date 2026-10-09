// Tag Categories inside Stash UI (stash-pmv-plugins, extension API v2).
// Stash UI imports /plugin/tagCategories/assets/stashui.js and calls the default export.
// Classic Stash never loads this file; tagCategories.js is the classic-UI side.
// Both read the same plugin setting (categoriesJson) – keep the category format in sync.

const PLUGIN_ID = "tagCategories";
const ASSETS_CATEGORIES = "/plugin/" + PLUGIN_ID + "/assets/categories.json";
const PAGE_SIZE = 60; // scenes per request; more are loaded while scrolling
const CHIPS_COLLAPSED = 24; // tag chips shown before "+N more"
const SEARCH_DEBOUNCE_MS = 250;
const SORTS = [
  ["title-asc", "Title A–Z", "title", "ASC"],
  ["title-desc", "Title Z–A", "title", "DESC"],
  ["duration-desc", "Duration (long → short)", "duration", "DESC"],
  ["duration-asc", "Duration (short → long)", "duration", "ASC"],
  ["date-desc", "Date (newest)", "date", "DESC"],
  ["date-asc", "Date (oldest)", "date", "ASC"],
];

const STRINGS_DE = {
  Categories: "Kategorien",
  "No categories configured yet.": "Noch keine Kategorien angelegt.",
  "Add some in the settings of Tag Categories.": "Anlegen in den Einstellungen von Tag Categories.",
  "Open settings": "Einstellungen öffnen",
  "Tags:": "Tags:",
  "+ sub-tags": "+ Unter-Tags",
  "These tags were not found in Stash and were skipped:": "Diese Tags gibt es in Stash nicht und wurden übersprungen:",
  "None of the category tags exist in Stash yet.": "Keiner der Kategorie-Tags existiert bisher in Stash.",
  "Any of them": "Eines davon",
  All: "Alle",
  "Click: select · Right-click: exclude": "Klick: auswählen · Rechtsklick: ausschließen",
  "Excluded – click to remove": "Ausgeschlossen – Klick hebt es auf",
  Reset: "Zurücksetzen",
  "+{n} more": "+{n} weitere",
  "Show less": "Weniger",
  "Search in this category …": "In dieser Kategorie suchen …",
  Sort: "Sortierung",
  "Title A–Z": "Titel A–Z",
  "Title Z–A": "Titel Z–A",
  "Duration (long → short)": "Dauer (lang → kurz)",
  "Duration (short → long)": "Dauer (kurz → lang)",
  "Date (newest)": "Datum (neueste)",
  "Date (oldest)": "Datum (älteste)",
  List: "Liste",
  Preview: "Vorschau",
  Refresh: "Aktualisieren",
  "Open in classic Stash": "In klassischem Stash öffnen",
  "Same selection as a regular Stash scene list: pages, bulk edit, queue":
    "Dieselbe Auswahl als normale Szenenliste in Stash: Seiten, Mehrfach-Bearbeitung, Warteschlange",
  Scenes: "Szenen",
  "{d} in total": "{d} insgesamt",
  "No scenes match any of these tags.": "Keine Szenen mit einem dieser Tags.",
  "No scenes match this tag selection.": "Keine Szenen passen zu dieser Tag-Auswahl.",
  "No scenes match this search.": "Keine Szenen passen zur Suche.",
  "Load more ({shown} of {total})": "Mehr laden ({shown} von {total})",
  "Loading …": "Lade …",
};

// ---------- Categories (same format as tagCategories.js) ----------

function slugId(name) {
  return (
    String(name || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9\-_]/g, "") || "category"
  );
}

function parseTagsList(value) {
  const list = Array.isArray(value) ? value : String(value || "").split(",");
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const name = String(raw || "").trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return out;
}

function parseCategoriesJson(text) {
  try {
    const parsed = JSON.parse(String(text));
    const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.categories) ? parsed.categories : null;
    if (!list) return null;
    const categories = [];
    list.forEach((raw, index) => {
      if (!raw || typeof raw !== "object") return;
      const name = String(raw.name || raw.label || "").trim();
      if (!name) return;
      const id = String(raw.id || "").trim() || slugId(name) + "-" + index;
      categories.push({ id, name, tags: parseTagsList(raw.tags), subTags: !!raw.subTags });
    });
    return categories;
  } catch (e) {
    return null;
  }
}

export default function setup(stashui) {
  if (!stashui || !stashui.has || !stashui.has("route") || !stashui.has("navItem")) return;
  const ui = stashui.ui;
  const t = (text, vars) => stashui.t(text, vars);
  const esc = (s) => ui.esc(s == null ? "" : String(s));
  stashui.addStrings("de", STRINGS_DE);
  loadStyles();

  let configPromise = null;
  const tagCache = new Map(); // lower-case tag name → Stash tag
  const childCache = new Map(); // sorted parent ids → all sub-tags (any depth)

  stashui.on("plugins-changed", () => {
    configPromise = null;
    tagCache.clear();
    childCache.clear();
  });

  function loadStyles() {
    if (document.querySelector("link[data-tag-categories]")) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.dataset.tagCategories = "";
    // Same ?v= as this module, so a plugin update also refreshes the styles.
    link.href = new URL("stashui.css" + new URL(import.meta.url).search, import.meta.url).href;
    document.head.appendChild(link);
  }

  // Plugin setting first, then categories.json in the plugin folder (like the classic side)
  function loadCategories() {
    if (!configPromise) {
      configPromise = (async () => {
        const d = await stashui.gql("query { configuration { plugins } }");
        const own = ((d && d.configuration && d.configuration.plugins) || {})[PLUGIN_ID] || {};
        const fromSettings = own.categoriesJson && String(own.categoriesJson).trim() ? parseCategoriesJson(own.categoriesJson) : null;
        if (fromSettings) return fromSettings;
        try {
          const res = await fetch(ASSETS_CATEGORIES, { cache: "no-store" });
          const fromFile = res.ok ? parseCategoriesJson(await res.text()) : null;
          if (fromFile) return fromFile;
        } catch (e) {
          /* no categories.json */
        }
        return [];
      })();
      configPromise.catch(() => (configPromise = null));
    }
    return configPromise;
  }

  const TAG_FIELDS = "id name scene_count all: scene_count(depth: -1)";
  const tagCount = (tag, withSub) => (withSub && tag.all != null ? tag.all : tag.scene_count) || 0;

  // Tag names → Stash tags (exact name, case-insensitive). withSub: also every sub-tag, any depth.
  async function resolveTags(names, withSub) {
    const tags = [];
    const missing = [];
    const q = `query($f: FindFilterType, $tf: TagFilterType) { findTags(filter: $f, tag_filter: $tf) { tags { ${TAG_FIELDS} } } }`;
    for (const name of names) {
      const key = name.toLowerCase();
      if (tagCache.has(key)) {
        tags.push(tagCache.get(key));
        continue;
      }
      let exact = null;
      for (const modifier of ["EQUALS", "INCLUDES"]) {
        const d = await stashui.gql(q, { f: { per_page: 25, q: name }, tf: { name: { value: name, modifier } } });
        exact = ((d && d.findTags && d.findTags.tags) || []).find((tg) => tg.name.toLowerCase() === key) || null;
        if (exact) break;
      }
      if (exact) {
        tagCache.set(key, exact);
        tags.push(exact);
      } else missing.push(name);
    }
    let children = [];
    if (withSub && tags.length) {
      const ids = tags.map((tg) => tg.id);
      const key = ids.slice().sort().join(",");
      if (childCache.has(key)) children = childCache.get(key);
      else {
        const d = await stashui.gql(q, {
          f: { per_page: -1, sort: "name", direction: "ASC" },
          tf: { parents: { value: ids, modifier: "INCLUDES", depth: -1 } },
        });
        children = (d && d.findTags && d.findTags.tags) || [];
        childCache.set(key, children);
      }
    }
    return { tags, missing, children };
  }

  // Tag criterion for the scene list: the whole category, or narrowed by the chips (sel.on / sel.not)
  function sceneCriterion(category, baseIds, sel) {
    const depth = category.subTags ? -1 : 0;
    const crit = sel.on.length
      ? { value: sel.on, modifier: sel.mode === "all" ? "INCLUDES_ALL" : "INCLUDES", depth }
      : { value: baseIds, modifier: "INCLUDES", depth };
    if (sel.not.length) crit.excludes = sel.not;
    return crit;
  }

  // Classic Stash puts a criterion into the URL as JSON with { } replaced by ( ) outside of strings
  function encodeCriterion(obj) {
    const json = JSON.stringify(obj);
    let inString = false;
    let escaped = false;
    let out = "";
    for (const ch of json) {
      let c = ch;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = inString;
      else if (c === '"') inString = !inString;
      else if (!inString && c === "{") c = "(";
      else if (!inString && c === "}") c = ")";
      out += c;
    }
    out = encodeURI(out);
    ["?", "#", "&", ";", "=", "+"].forEach((ch) => (out = out.split(ch).join(encodeURIComponent(ch))));
    return out;
  }

  // The same selection as a regular scene list in classic Stash (embedded in Stash UI)
  function classicScenesHref(crit, names, query, sortKey) {
    const sort = SORTS.find((s) => s[0] === sortKey) || SORTS[0];
    const item = (id) => ({ id: String(id), label: names[id] || String(id) });
    const parts = [];
    if (query) parts.push("q=" + encodeURIComponent(query));
    parts.push("c=" + encodeCriterion({ type: "tags", modifier: crit.modifier, value: { items: crit.value.map(item), excluded: (crit.excludes || []).map(item), depth: crit.depth || 0 } }));
    parts.push("sortby=" + sort[2]);
    const isDefault = sort[2] === "date" ? sort[3] === "DESC" : sort[3] === "ASC"; // Stash's defaults
    if (!isDefault) parts.push("sortdir=" + sort[3].toLowerCase());
    return "#/extern/classic?path=" + encodeURIComponent("/scenes?" + parts.join("&"));
  }

  const sceneTitle = (s) => (s.title && s.title.trim()) || String((s.files[0] || {}).path || "").split(/[/\\]/).pop() || "Scene " + s.id;

  // ---------- The page: #/p/tagCategories/<category id> ----------

  stashui.addRoute({
    path: "*",
    title: t("Categories"),
    async render(el, { rest, signal }) {
      el.innerHTML = `<p class="kb-hint">${t("Loading …")}</p>`;
      const categories = await loadCategories();
      if (signal.aborted) return;
      if (!categories.length) {
        el.innerHTML = `<div class="kb-empty"><b>${t("No categories configured yet.")}</b><p>${t("Add some in the settings of Tag Categories.")}</p><a class="kb-btn" href="#/plugins?focus=${PLUGIN_ID}">${t("Open settings")}</a></div>`;
        return;
      }
      const category = categories.find((c) => c.id === rest) || categories[0];
      el.innerHTML = `<div class="tcx-page">
          <nav class="tcx-nav" aria-label="${esc(t("Categories"))}">${categories
            .map(
              (c) => `<a class="tcx-cat${c.id === category.id ? " is-on" : ""}" href="#/p/${PLUGIN_ID}/${encodeURIComponent(c.id)}" title="${esc(c.tags.join(", "))}">
                <span class="tcx-cat-name"><span>${esc(c.name)}</span><small data-catcount="${esc(c.id)}"></small></span>
                <span class="tcx-cat-tags">${esc(c.tags.join(", "))}${c.subTags ? " " + esc(t("+ sub-tags")) : ""}</span></a>`
            )
            .join("")}</nav>
          <section class="tcx-main" data-main></section>
        </div>`;
      paintCounts(el, categories, signal);
      return mountCategory(el.querySelector("[data-main]"), category, signal);
    },
  });

  stashui.addNavItem({
    id: "categories",
    label: t("Categories"),
    icon: "tag",
    route: "",
    group: "Library",
    place: { after: "tags" },
  });

  // Number of scenes per category in the list on the left (count only)
  async function paintCounts(el, categories, signal) {
    for (const c of categories) {
      if (signal.aborted) return;
      try {
        const r = await resolveTags(c.tags, false);
        const box = el.querySelector(`[data-catcount="${CSS.escape(c.id)}"]`);
        if (!box) continue;
        if (!r.tags.length) {
          box.textContent = "–";
          continue;
        }
        const d = await stashui.gql(`query($x: SceneFilterType) { findScenes(scene_filter: $x, filter: { per_page: 0 }) { count } }`, {
          x: { tags: { value: r.tags.map((tg) => tg.id), modifier: "INCLUDES", depth: c.subTags ? -1 : 0 } },
        });
        box.textContent = ui.fmtNum(d.findScenes.count);
      } catch (e) {
        /* (a count that can't be had stays empty) */
      }
    }
  }

  function mountCategory(main, category, signal) {
    const S = {
      sel: { on: [], not: [], mode: "any" },
      showAll: false,
      q: "",
      sort: SORTS.some((s) => s[0] === stashui.store.get("sort")) ? stashui.store.get("sort") : SORTS[0][0],
      view: stashui.store.get("view") === "preview" ? "preview" : "list",
      chips: [],
      names: {},
      baseIds: [],
      scenes: [],
      total: null,
      duration: null,
      page: 0,
      busy: false,
      seq: 0,
    };
    let observer = null;

    const tagsLine = `${t("Tags:")} ${category.tags.join(", ")}${category.subTags ? " " + t("+ sub-tags") : ""}`;
    main.innerHTML = `<header class="tcx-head"><h2 class="kb-h2">${esc(category.name)}</h2><p class="kb-hint">${esc(tagsLine)}</p><p class="tcx-warn" data-missing hidden></p></header>
      <div data-chipbox></div>
      <div class="tcx-tools" data-tools hidden>
        <input class="kb-field tcx-search" type="search" data-q placeholder="${esc(t("Search in this category …"))}" aria-label="${esc(t("Search in this category …"))}">
        <select class="kb-field tcx-sort" data-sort aria-label="${esc(t("Sort"))}" title="${esc(t("Sort"))}">${SORTS.map((s) => `<option value="${s[0]}"${s[0] === S.sort ? " selected" : ""}>${esc(t(s[1]))}</option>`).join("")}</select>
        <div class="kb-seg" data-view><button type="button" data-v="list">${t("List")}</button><button type="button" data-v="preview">${t("Preview")}</button></div>
        <button type="button" class="kb-btn" data-refresh>${ui.icon("repeat")}${t("Refresh")}</button>
        <a class="kb-btn" data-classic title="${esc(t("Same selection as a regular Stash scene list: pages, bulk edit, queue"))}">${t("Open in classic Stash")}</a>
      </div>
      <h3 class="tcx-count" data-count></h3>
      <div data-list></div>
      <div class="tcx-more" data-more hidden><button type="button" class="kb-btn" data-loadmore></button></div>`;
    const $ = (s) => main.querySelector(s);

    const crit = () => sceneCriterion(category, S.baseIds, S.sel);

    function paintChips() {
      const box = $("[data-chipbox]");
      if (S.chips.length < 2) {
        box.innerHTML = "";
        return;
      }
      const marked = (tg) => S.sel.on.includes(tg.id) || S.sel.not.includes(tg.id);
      const visible = S.showAll || S.chips.length <= CHIPS_COLLAPSED ? S.chips : S.chips.filter((tg, i) => i < CHIPS_COLLAPSED || marked(tg));
      const hidden = S.chips.length - visible.length;
      const active = S.sel.on.length || S.sel.not.length;
      box.innerHTML = `<div class="tcx-filter">
          <div class="tcx-filter-head">
            <div class="kb-seg" data-mode><button type="button" data-v="any" class="${S.sel.mode === "any" ? "is-on" : ""}">${t("Any of them")}</button><button type="button" data-v="all" class="${S.sel.mode === "all" ? "is-on" : ""}">${t("All")}</button></div>
            <span class="kb-hint">${t("Click: select · Right-click: exclude")}</span>
            ${active ? `<button type="button" class="kb-btn is-ghost" data-reset>${t("Reset")}</button>` : ""}
          </div>
          <div class="kb-chips">${visible
            .map((tg) => {
              const on = S.sel.on.includes(tg.id);
              const not = S.sel.not.includes(tg.id);
              return `<button type="button" class="kb-chip tcx-chip${on ? " is-on" : not ? " is-not" : ""}" data-chip="${esc(tg.id)}" aria-pressed="${on}" title="${esc(not ? t("Excluded – click to remove") : t("Click: select · Right-click: exclude"))}">${esc(tg.name)}<small>${ui.fmtNum(tagCount(tg, category.subTags))}</small></button>`;
            })
            .join("")}${hidden > 0 || (S.showAll && S.chips.length > CHIPS_COLLAPSED) ? `<button type="button" class="kb-chip tcx-chip-more" data-allchips>${S.showAll ? t("Show less") : t("+{n} more", { n: hidden })}</button>` : ""}</div>
        </div>`;
    }

    function paintTools() {
      main.querySelectorAll("[data-view] [data-v]").forEach((b) => b.classList.toggle("is-on", b.dataset.v === S.view));
      $("[data-classic]").href = classicScenesHref(crit(), S.names, S.q, S.sort);
    }

    function cardHtml(s) {
      const file = s.files[0] || {};
      const dur = file.duration ? ui.fmtDuration(file.duration) : "";
      const href = `#/scene/${encodeURIComponent(s.id)}`;
      if (S.view === "preview") {
        return `<a class="tcx-card" href="${href}" title="${esc(sceneTitle(s))}">
            <span class="tcx-thumb">${s.paths.screenshot ? `<img loading="lazy" src="${esc(s.paths.screenshot)}" alt="">` : ""}${s.paths.preview ? `<video muted loop playsinline preload="none" data-src="${esc(s.paths.preview)}"></video>` : ""}${dur ? `<em>${dur}</em>` : ""}</span>
            <span class="tcx-card-title">${esc(sceneTitle(s))}</span></a>`;
      }
      return `<a class="tcx-row" href="${href}"><b>${esc(sceneTitle(s))}</b><small>${esc([dur, file.path].filter(Boolean).join(" · "))}</small></a>`;
    }

    function paintList() {
      const box = $("[data-list]");
      const count = $("[data-count]");
      const selecting = S.sel.on.length || S.sel.not.length;
      if (S.total == null) {
        count.textContent = "";
        box.innerHTML = `<p class="kb-hint">${t("Loading …")}</p>`;
      } else if (S.total === 0) {
        count.textContent = "";
        box.innerHTML = `<div class="kb-empty"><b>${t(S.q ? "No scenes match this search." : selecting ? "No scenes match this tag selection." : "No scenes match any of these tags.")}</b></div>`;
      } else {
        count.innerHTML = `${t("Scenes")} <span>${ui.fmtNum(S.total)}</span>${S.duration ? `<small class="kb-hint">${esc(t("{d} in total", { d: ui.fmtDuration(S.duration) }))}</small>` : ""}`;
        box.innerHTML = `<div class="${S.view === "preview" ? "tcx-grid" : "tcx-rows"}">${S.scenes.map(cardHtml).join("")}</div>`;
      }
      const more = S.total != null && S.scenes.length < S.total;
      $("[data-more]").hidden = !more;
      $("[data-loadmore]").textContent = t("Load more ({shown} of {total})", { shown: ui.fmtNum(S.scenes.length), total: ui.fmtNum(S.total || 0) });
    }

    // page 1 of a new selection, or the next page
    async function load(next) {
      if (next && (S.busy || S.total == null || S.scenes.length >= S.total)) return;
      const seq = next ? S.seq : ++S.seq;
      if (!next) {
        S.page = 0;
        S.scenes = [];
        S.total = null;
        S.duration = null;
        paintList();
      }
      S.busy = true;
      const sort = SORTS.find((s) => s[0] === S.sort) || SORTS[0];
      try {
        const d = await stashui.gql(
          `query($f: FindFilterType, $x: SceneFilterType) { findScenes(filter: $f, scene_filter: $x) { count duration scenes { id title paths { screenshot preview } files { path duration } } } }`,
          { f: { page: S.page + 1, per_page: PAGE_SIZE, sort: sort[2], direction: sort[3], q: S.q || undefined }, x: { tags: crit() } }
        );
        if (seq !== S.seq || signal.aborted) return;
        S.page += 1;
        S.scenes = S.scenes.concat(d.findScenes.scenes);
        S.total = d.findScenes.count;
        S.duration = d.findScenes.duration;
        paintList();
      } catch (e) {
        if (seq === S.seq && !signal.aborted) ui.errorToast(e, "Tag Categories");
      } finally {
        if (seq === S.seq) S.busy = false;
      }
    }

    const reload = () => {
      paintTools();
      load(false);
    };
    const searchLater = ui.debounce(() => {
      S.q = $("[data-q]").value.trim();
      reload();
    }, SEARCH_DEBOUNCE_MS);

    function toggleChip(id, exclude) {
      const s = S.sel;
      const drop = (l) => l.filter((x) => x !== id);
      if (exclude) S.sel = s.not.includes(id) ? { ...s, not: drop(s.not) } : { ...s, on: drop(s.on), not: s.not.concat(id) };
      else if (s.on.includes(id)) S.sel = { ...s, on: drop(s.on) };
      else if (s.not.includes(id)) S.sel = { ...s, not: drop(s.not) };
      else S.sel = { ...s, on: s.on.concat(id) };
      paintChips();
      reload();
    }

    main.addEventListener("click", (e) => {
      const chip = e.target.closest("[data-chip]");
      if (chip) return toggleChip(chip.dataset.chip, false);
      const mode = e.target.closest("[data-mode] [data-v]");
      if (mode) {
        S.sel = { ...S.sel, mode: mode.dataset.v };
        paintChips();
        if (S.sel.on.length > 1) reload();
        return;
      }
      if (e.target.closest("[data-reset]")) {
        S.sel = { on: [], not: [], mode: S.sel.mode };
        paintChips();
        return reload();
      }
      if (e.target.closest("[data-allchips]")) {
        S.showAll = !S.showAll;
        return paintChips();
      }
      const view = e.target.closest("[data-view] [data-v]");
      if (view) {
        S.view = view.dataset.v;
        stashui.store.set("view", S.view);
        paintTools();
        return paintList();
      }
      if (e.target.closest("[data-refresh]")) return reload();
      if (e.target.closest("[data-loadmore]")) return load(true);
    });
    main.addEventListener("contextmenu", (e) => {
      const chip = e.target.closest("[data-chip]");
      if (!chip) return;
      e.preventDefault();
      toggleChip(chip.dataset.chip, true);
    });
    main.addEventListener("input", (e) => e.target.matches("[data-q]") && searchLater());
    main.addEventListener("change", (e) => {
      if (!e.target.matches("[data-sort]")) return;
      S.sort = e.target.value;
      stashui.store.set("sort", S.sort);
      reload();
    });
    // the preview plays while the mouse is on a card
    main.addEventListener("pointerover", (e) => {
      const v = e.target.closest(".tcx-card") && e.target.closest(".tcx-card").querySelector("video[data-src]");
      if (!v) return;
      if (!v.src) v.src = v.dataset.src;
      v.play().catch(() => {});
    });
    main.addEventListener("pointerout", (e) => {
      const card = e.target.closest(".tcx-card");
      if (!card || card.contains(e.relatedTarget)) return;
      const v = card.querySelector("video");
      if (v) v.pause();
    });

    // the next page shortly before the end of the list is reached
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((entries) => entries.some((x) => x.isIntersecting) && load(true), { rootMargin: "600px 0px" });
      observer.observe($("[data-more]"));
    }

    (async () => {
      try {
        const r = await resolveTags(category.tags, category.subTags);
        if (signal.aborted) return;
        if (r.missing.length) {
          const warn = $("[data-missing]");
          warn.hidden = false;
          warn.textContent = t("These tags were not found in Stash and were skipped:") + " " + r.missing.join(", ");
        }
        if (!r.tags.length) {
          $("[data-list]").innerHTML = `<div class="kb-empty"><b>${t("None of the category tags exist in Stash yet.")}</b></div>`;
          return;
        }
        S.baseIds = r.tags.map((tg) => tg.id);
        const list = category.subTags && r.children.length ? r.children : r.tags;
        S.chips = list.slice().sort((a, b) => tagCount(b, category.subTags) - tagCount(a, category.subTags) || a.name.localeCompare(b.name));
        r.tags.concat(r.children).forEach((tg) => (S.names[tg.id] = tg.name));
        $("[data-tools]").hidden = false;
        paintChips();
        reload();
      } catch (e) {
        if (!signal.aborted) ui.errorToast(e, "Tag Categories");
      }
    })();

    return () => {
      S.seq++;
      if (observer) observer.disconnect();
      main.querySelectorAll("video").forEach((v) => v.removeAttribute("src"));
    };
  }
}
