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
  "Performers:": "Performer:",
  Tags: "Tags",
  Performers: "Performer",
  "+ sub-tags": "+ Unter-Tags",
  "These tags were not found in Stash and were skipped:": "Diese Tags gibt es in Stash nicht und wurden übersprungen:",
  "None of the category tags exist in Stash yet.": "Keiner der Kategorie-Tags existiert bisher in Stash.",
  "These performers were not found in Stash and were skipped:": "Diese Performer gibt es in Stash nicht und wurden übersprungen:",
  "None of the category's tags or performers exist in Stash yet.": "Keiner der Tags oder Performer der Kategorie existiert bisher in Stash.",
  "Any of them": "Eines davon",
  All: "Alle",
  "Click: select · Right-click: exclude": "Klick: auswählen · Rechtsklick: ausschließen",
  "Click: select · Right-click: exclude · ★: main tag": "Klick: auswählen · Rechtsklick: ausschließen · ★: Haupt-Tag",
  "Main tag: every scene has it, the other chips count only scenes with it – click to remove":
    "Haupt-Tag: jede Szene hat ihn, die anderen Chips zählen nur Szenen mit ihm – Klick hebt es auf",
  "Make this the main tag: every scene has it, the other chips show what goes with it":
    "Zum Haupt-Tag machen: jede Szene hat ihn, die anderen Chips zeigen, was es dazu gibt",
  "Main: {names}": "Haupt-Tag: {names}",
  "Classic Stash can't show this selection as one scene list": "Klassisches Stash kann diese Auswahl nicht als eine Szenenliste zeigen",
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
      categories.push({ id, name, tags: parseTagsList(raw.tags), performers: parseTagsList(raw.performers), subTags: !!raw.subTags });
    });
    return categories;
  } catch (e) {
    return null;
  }
}

function categoriesToJson(config) {
  const categories = config.categories.map((c) => {
    const out = { id: c.id, name: c.name, tags: c.tags || [] };
    if (c.performers && c.performers.length) out.performers = c.performers;
    if (c.subTags) out.subTags = true;
    return out;
  });
  return JSON.stringify({ categories }, null, 2);
}

export default function setup(stashui) {
  if (!stashui || !stashui.has || !stashui.has("route") || !stashui.has("navItem")) return;
  const ui = stashui.ui;
  const t = (text, vars) => stashui.t(text, vars);
  const esc = (s) => ui.esc(s == null ? "" : String(s));
  stashui.addStrings("de", STRINGS_DE);
  loadStyles();

  let configPromise = null;
  let configSource = "settings"; // where the categories came from: settings, file or defaults
  const tagCache = new Map(); // lower-case tag name → Stash tag
  const childCache = new Map(); // sorted parent ids → all sub-tags (any depth)
  const perfCache = new Map(); // lower-case performer name → Stash performer

  stashui.on("plugins-changed", () => {
    configPromise = null;
    tagCache.clear();
    childCache.clear();
    perfCache.clear();
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
        if (fromSettings) {
          configSource = "settings";
          return fromSettings;
        }
        try {
          const res = await fetch(ASSETS_CATEGORIES, { cache: "no-store" });
          const fromFile = res.ok ? parseCategoriesJson(await res.text()) : null;
          if (fromFile) {
            configSource = "file";
            return fromFile;
          }
        } catch (e) {
          /* no categories.json */
        }
        configSource = "defaults";
        return [];
      })();
      configPromise.catch(() => (configPromise = null));
    }
    return configPromise;
  }

  async function saveCategories(config) {
    const d = await stashui.gql("query { configuration { plugins } }");
    const cur = ((d && d.configuration && d.configuration.plugins) || {})[PLUGIN_ID] || {};
    const input = Object.assign({}, cur, { categoriesJson: categoriesToJson(config) });
    await stashui.gql("mutation($id: ID!, $i: Map!) { configurePlugin(plugin_id: $id, input: $i) }", { id: PLUGIN_ID, i: input });
    configPromise = Promise.resolve(config.categories);
    configSource = "settings";
  }

  const TAG_FIELDS = "id name scene_count all: scene_count(depth: -1) parents { id }";
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

  // Performer names → Stash performers (exact name, else an exact alias; case-insensitive)
  async function resolvePerformers(names) {
    const performers = [];
    const missing = [];
    const q = `query($f: FindFilterType, $pf: PerformerFilterType) { findPerformers(filter: $f, performer_filter: $pf) { performers { id name alias_list scene_count } } }`;
    for (const name of names) {
      const key = name.toLowerCase();
      let found = perfCache.get(key) || null;
      if (!found) {
        let d = await stashui.gql(q, { f: { per_page: 25 }, pf: { name: { value: name, modifier: "EQUALS" } } });
        found = ((d && d.findPerformers && d.findPerformers.performers) || []).find((p) => p.name.toLowerCase() === key) || null;
        if (!found) {
          d = await stashui.gql(q, { f: { per_page: 25, q: name } });
          found = ((d && d.findPerformers && d.findPerformers.performers) || []).find((p) => (p.alias_list || []).some((a) => a.toLowerCase() === key)) || null;
        }
        if (found) perfCache.set(key, found);
      }
      if (!found) missing.push(name);
      else if (!performers.some((p) => p.id === found.id)) performers.push(found);
    }
    return { performers, missing };
  }

  // Chips, the selection and the names use keys "t:<tag id>" and "p:<performer id>"
  const idsOf = (keys, kind) => keys.filter((k) => k[0] === kind).map((k) => k.slice(2));
  const NO_SEL = { main: [], on: [], not: [], mode: "any" };

  // What Stash is asked for the list: every main chip (sel.main), any / all of the selected chips (sel.on), none of
  // the excluded ones (sel.not); with nothing selected, any tag or performer of the category (base).
  // Stash joins the tags only twice per query (one join for "has", one for "has none of") and the performers once
  // (their "none of" is a subquery) – a second criterion on a join that is taken breaks both. So "all of" is
  // INCLUDES_ALL, "any of" one kind is INCLUDES while that join is free, otherwise "not none of" (NOT + EXCLUDES),
  // and excluded tags go where there is room. Main tags + "any of" tags + excluded tags would need three tag joins:
  // then the excluded tags come back as dropTags (chip keys) and the caller drops those scenes itself.
  function sceneQuery(category, base, sel) {
    const depth = category.subTags ? -1 : 0;
    const tagCrit = (value, modifier) => ({ value, modifier, depth });
    const perfCrit = (value, modifier) => ({ value, modifier });
    const uniq = (l) => [...new Set(l)];
    const nothing = !sel.main.length && !sel.on.length;
    const any = sel.mode !== "all";
    let allT = uniq(idsOf(sel.main, "t").concat(any ? [] : idsOf(sel.on, "t")));
    let allP = uniq(idsOf(sel.main, "p").concat(any ? [] : idsOf(sel.on, "p")));
    let anyT = nothing ? base.tags : any ? idsOf(sel.on, "t") : [];
    let anyP = nothing ? base.perfs : any ? idsOf(sel.on, "p") : [];
    if (!nothing && anyT.length + anyP.length === 1) {
      // "any of" one chip is "all of" it
      allT = uniq(allT.concat(anyT));
      allP = uniq(allP.concat(anyP));
      anyT = anyP = [];
    }
    const notT = idsOf(sel.not, "t");
    const notP = idsOf(sel.not, "p");
    const filter = {};
    const noneOf = {}; // goes in as NOT: "none of these" negated = any of them
    const plainT = anyT.length && !anyP.length && !allT.length;
    const plainP = anyP.length && !anyT.length && !allP.length;
    if (allT.length) filter.tags = tagCrit(allT, "INCLUDES_ALL");
    else if (plainT) filter.tags = tagCrit(anyT, "INCLUDES");
    if (anyT.length && !plainT) noneOf.tags = tagCrit(anyT, "EXCLUDES");
    if (allP.length) filter.performers = perfCrit(allP, "INCLUDES_ALL");
    else if (plainP) filter.performers = perfCrit(anyP, "INCLUDES");
    if (anyP.length && !plainP) noneOf.performers = perfCrit(anyP, "EXCLUDES");
    if (notP.length) {
      if (filter.performers) filter.performers.excludes = notP;
      else filter.performers = perfCrit(notP, "EXCLUDES");
    }
    let orHas = null;
    let dropTags = [];
    if (notT.length) {
      if (!noneOf.tags) {
        if (filter.tags) filter.tags.excludes = notT;
        else filter.tags = tagCrit(notT, "EXCLUDES");
      } else if (!filter.tags) orHas = { tags: tagCrit(notT, "INCLUDES") }; // NOT (none of the chips OR one of these)
      else dropTags = notT.map((id) => "t:" + id);
    }
    if (Object.keys(noneOf).length) filter.NOT = orHas ? { ...noneOf, OR: orHas } : noneOf;
    return { filter, dropTags };
  }

  // The same selection as classic Stash criteria (one tags and one performers criterion, both apply).
  // null = classic Stash can't express it: "any of" tags or performers, or a main chip plus "any of" more of its kind.
  function classicCriteria(category, base, sel) {
    const any = sel.mode !== "all" && sel.on.length > 1; // ("any of" one chip is "all of" it)
    const nothing = !sel.main.length && !sel.on.length;
    const across = nothing ? base.tags.length && base.perfs.length : any && idsOf(sel.on, "t").length && idsOf(sel.on, "p").length;
    if (across) return null;
    const crits = [];
    for (const [kind, type, baseIds] of [["t", "tags", base.tags], ["p", "performers", base.perfs]]) {
      const mainIds = idsOf(sel.main, kind);
      const onIds = idsOf(sel.on, kind);
      if (any && mainIds.length && onIds.length) return null;
      const ids = nothing ? baseIds : mainIds.concat(onIds);
      const excluded = idsOf(sel.not, kind);
      if (!ids.length && !excluded.length) continue;
      const modifier = nothing || (any && !mainIds.length) ? "INCLUDES" : "INCLUDES_ALL";
      crits.push({ type, kind, modifier, ids, excluded, depth: category.subTags ? -1 : 0 });
    }
    return crits;
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
  function classicScenesHref(crits, names, query, sortKey) {
    const sort = SORTS.find((s) => s[0] === sortKey) || SORTS[0];
    const parts = [];
    if (query) parts.push("q=" + encodeURIComponent(query));
    for (const c of crits) {
      const item = (id) => ({ id: String(id), label: names[c.kind + ":" + id] || String(id) });
      const value = { items: c.ids.map(item), excluded: c.excluded.map(item) };
      if (c.type === "tags") value.depth = c.depth;
      parts.push("c=" + encodeCriterion({ type: c.type, modifier: c.modifier, value }));
    }
    parts.push("sortby=" + sort[2]);
    const isDefault = sort[2] === "date" ? sort[3] === "DESC" : sort[3] === "ASC"; // Stash's defaults
    if (!isDefault) parts.push("sortdir=" + sort[3].toLowerCase());
    return "#/extern/classic?path=" + encodeURIComponent("/scenes?" + parts.join("&"));
  }

  const sceneTitle = (s) => (s.title && s.title.trim()) || String((s.files[0] || {}).path || "").split(/[/\\]/).pop() || "Scene " + s.id;
  const categoryLine = (c) => c.tags.concat(c.performers).join(", ");

  // ---------- The page: #/p/tagCategories/<category id> ----------

  stashui.addRoute({
    path: "*",
    title: t("Categories"),
    async render(el, { rest, signal }) {
      el.innerHTML = `<p class="kb-hint">${t("Loading …")}</p>`;
      const categories = await loadCategories();
      if (signal.aborted) return;
      if (!categories.length) {
        el.innerHTML = `<div class="kb-empty"><b>${t("No categories configured yet.")}</b><p>${t("Add some in the settings of Tag Categories.")}</p><a class="kb-btn" href="${stashui.has("slot:settings.section") ? `#/settings/x:${PLUGIN_ID}:settings` : `#/plugins?focus=${PLUGIN_ID}`}">${t("Open settings")}</a></div>`;
        return;
      }
      const category = categories.find((c) => c.id === rest) || categories[0];
      el.innerHTML = `<div class="tcx-page">
          <nav class="tcx-nav" aria-label="${esc(t("Categories"))}">${categories
            .map(
              (c) => `<a class="tcx-cat${c.id === category.id ? " is-on" : ""}" href="#/p/${PLUGIN_ID}/${encodeURIComponent(c.id)}" title="${esc(categoryLine(c))}">
                <span class="tcx-cat-name"><span>${esc(c.name)}</span><small data-catcount="${esc(c.id)}"></small></span>
                <span class="tcx-cat-tags">${esc(categoryLine(c))}${c.subTags ? " " + esc(t("+ sub-tags")) : ""}</span></a>`
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

  // ---------- Settings → Plugins → Tag Categories ----------
  // settings.js draws the page (the same module as in classic Stash).

  if (stashui.has("slot:settings.section")) {
    stashui.addSlot("settings.section", {
      id: "settings",
      title: "Tag Categories",
      mount(el, ctx) {
        const search = new URL(import.meta.url).search;
        let handle = null;
        el.innerHTML = `<div class="kb-loading">…</div>`;
        import(new URL("settings.js" + search, import.meta.url).href)
          .then((mod) => {
            if (ctx.signal.aborted) return;
            stashui.addStrings("de", mod.STRINGS_DE);
            handle = mod.mountSettings(el, {
              theme: "stashui",
              t,
              version: (new URLSearchParams(search).get("v") || "").split("-")[0],
              gql: (q, v) => stashui.gql(q, v),
              toast: (text, kind) => ui.toast(text, kind),
              confirm: async (o) => {
                const answer = await ui.confirmDialog({ title: o.title, text: o.text, ok: o.ok, danger: o.danger });
                return !!(answer && answer.ok);
              },
              load: async () => ({ config: { categories: await loadCategories() }, source: configSource }),
              save: saveCategories,
              parseJson: (text) => {
                JSON.parse(text); // (its own error message for broken JSON)
                const categories = parseCategoriesJson(text);
                if (!categories) throw new Error("categories array required");
                return { categories };
              },
              toJson: categoriesToJson,
              categoryHref: (id) => `#/p/${PLUGIN_ID}/${encodeURIComponent(id)}`,
            });
          })
          .catch((e) => ui.errorToast(e, "Tag Categories"));
        return () => handle && handle.destroy();
      },
    });
  }

  // Number of scenes per category in the list on the left (count only)
  async function paintCounts(el, categories, signal) {
    for (const c of categories) {
      if (signal.aborted) return;
      try {
        const [r, rp] = await Promise.all([resolveTags(c.tags, false), resolvePerformers(c.performers)]);
        const box = el.querySelector(`[data-catcount="${CSS.escape(c.id)}"]`);
        if (!box) continue;
        if (!r.tags.length && !rp.performers.length) {
          box.textContent = "–";
          continue;
        }
        const base = { tags: r.tags.map((tg) => tg.id), perfs: rp.performers.map((p) => p.id) };
        const d = await stashui.gql(`query($x: SceneFilterType) { findScenes(scene_filter: $x, filter: { per_page: 0 }) { count } }`, {
          x: sceneQuery(c, base, NO_SEL).filter,
        });
        box.textContent = ui.fmtNum(d.findScenes.count);
      } catch (e) {
        /* (a count that can't be had stays empty) */
      }
    }
  }

  function mountCategory(main, category, signal) {
    const S = {
      sel: NO_SEL,
      showAll: false,
      q: "",
      sort: SORTS.some((s) => s[0] === stashui.store.get("sort")) ? stashui.store.get("sort") : SORTS[0][0],
      view: stashui.store.get("view") === "preview" ? "preview" : "list",
      chips: [], // { key, kind: "t" | "p", name, count }
      names: {}, // chip key → name
      base: { tags: [], perfs: [] },
      parents: new Map(), // tag id → its parent tag ids (a sub-tag counts for its parents too)
      mainCounts: null, // chip key → scenes with the main chips and this one; null = no main chip
      counting: false,
      mainSeq: 0,
      scenes: [],
      all: null, // every scene of the list, when it had to be filtered here (see sceneQuery)
      total: null,
      duration: null,
      page: 0,
      busy: false,
      seq: 0,
    };
    let observer = null;

    const lines = [];
    if (category.tags.length) lines.push(`${t("Tags:")} ${category.tags.join(", ")}${category.subTags ? " " + t("+ sub-tags") : ""}`);
    if (category.performers.length) lines.push(`${t("Performers:")} ${category.performers.join(", ")}`);
    main.innerHTML = `<header class="tcx-head"><h2 class="kb-h2">${esc(category.name)}</h2><p class="kb-hint">${esc(lines.join(" · "))}</p><p class="tcx-warn" data-missing hidden></p></header>
      <div data-chipbox></div>
      <div class="tcx-tools" data-tools hidden>
        <input class="kb-field tcx-search" type="search" data-q placeholder="${esc(t("Search in this category …"))}" aria-label="${esc(t("Search in this category …"))}">
        <select class="kb-field tcx-sort" data-sort aria-label="${esc(t("Sort"))}" title="${esc(t("Sort"))}">${SORTS.map((s) => `<option value="${s[0]}"${s[0] === S.sort ? " selected" : ""}>${esc(t(s[1]))}</option>`).join("")}</select>
        <div class="kb-seg" data-view><button type="button" data-v="list">${t("List")}</button><button type="button" data-v="preview">${t("Preview")}</button></div>
        <button type="button" class="kb-btn" data-refresh>${ui.icon("repeat")}${t("Refresh")}</button>
        <a class="kb-btn" data-classic>${t("Open in classic Stash")}</a>
      </div>
      <h3 class="tcx-count" data-count></h3>
      <div data-list></div>
      <div class="tcx-more" data-more hidden><button type="button" class="kb-btn" data-loadmore></button></div>`;
    const $ = (s) => main.querySelector(s);

    const query = () => sceneQuery(category, S.base, S.sel);

    function paintChips() {
      const box = $("[data-chipbox]");
      if (S.chips.length < 2) {
        box.innerHTML = "";
        return;
      }
      const sel = S.sel;
      const isMain = (c) => sel.main.includes(c.key);
      const marked = (c) => isMain(c) || sel.on.includes(c.key) || sel.not.includes(c.key);
      // with a main chip: only what goes with it, counted within its scenes, most first
      const withMain = S.mainCounts && !S.counting;
      const count = (c) => (withMain ? S.mainCounts.get(c.key) || 0 : c.count);
      let hidden = 0;
      let long = false;
      const group = (kind) => {
        let list = S.chips.filter((c) => c.kind === kind);
        if (withMain) list = list.filter((c) => marked(c) || count(c) > 0).sort((a, b) => isMain(b) - isMain(a) || count(b) - count(a) || a.name.localeCompare(b.name));
        const visible = S.showAll || list.length <= CHIPS_COLLAPSED ? list : list.filter((c, i) => i < CHIPS_COLLAPSED || marked(c));
        hidden += list.length - visible.length;
        long = long || list.length > CHIPS_COLLAPSED;
        return visible;
      };
      const hint = t("Click: select · Right-click: exclude · ★: main tag");
      const chip = (c) => {
        const main = isMain(c);
        const on = sel.on.includes(c.key);
        const not = sel.not.includes(c.key);
        const title = main ? t("Main tag: every scene has it, the other chips count only scenes with it – click to remove") : not ? t("Excluded – click to remove") : hint;
        return `<button type="button" class="kb-chip tcx-chip${main ? " is-main" : on ? " is-on" : not ? " is-not" : ""}" data-chip="${esc(c.key)}" aria-pressed="${main || on}" title="${esc(title)}"><span class="tcx-star" data-star title="${esc(t("Make this the main tag: every scene has it, the other chips show what goes with it"))}">★</span>${on ? '<span class="tcx-mark" aria-hidden="true">✓</span>' : not ? '<span class="tcx-mark" aria-hidden="true">✕</span>' : ""}${esc(c.name)}<small>${S.counting && !main ? "…" : ui.fmtNum(count(c))}</small></button>`;
      };
      const tags = group("t");
      const perfs = group("p");
      const labelled = S.chips.some((c) => c.kind === "p") && S.chips.some((c) => c.kind === "t");
      const row = (label, list) => (list.length ? `<div class="tcx-chiprow">${labelled ? `<span class="tcx-chiplabel">${esc(t(label))}</span>` : ""}<div class="kb-chips">${list.map(chip).join("")}</div></div>` : "");
      const active = sel.main.length || sel.on.length || sel.not.length;
      const mainNames = sel.main.map((k) => S.names[k] || k).join(", ");
      box.innerHTML = `<div class="tcx-filter${active ? " has-sel" : ""}">
          <div class="tcx-filter-head">
            <div class="kb-seg" data-mode><button type="button" data-v="any" class="${sel.mode === "any" ? "is-on" : ""}">${t("Any of them")}</button><button type="button" data-v="all" class="${sel.mode === "all" ? "is-on" : ""}">${t("All")}</button></div>
            ${sel.main.length ? `<span class="tcx-mainnote">★ ${esc(t("Main: {names}", { names: mainNames }))}</span>` : `<span class="kb-hint">${esc(hint)}</span>`}
            ${active ? `<button type="button" class="kb-btn is-ghost" data-reset>${t("Reset")}</button>` : ""}
          </div>
          ${row("Tags", tags)}${row("Performers", perfs)}
          ${hidden > 0 || (S.showAll && long) ? `<div class="kb-chips"><button type="button" class="kb-chip tcx-chip-more" data-allchips>${S.showAll ? t("Show less") : t("+{n} more", { n: hidden })}</button></div>` : ""}
        </div>`;
    }

    function paintTools() {
      main.querySelectorAll("[data-view] [data-v]").forEach((b) => b.classList.toggle("is-on", b.dataset.v === S.view));
      const a = $("[data-classic]");
      const crits = classicCriteria(category, S.base, S.sel);
      a.classList.toggle("is-disabled", !crits);
      if (crits) {
        a.href = classicScenesHref(crits, S.names, S.q, S.sort);
        a.title = t("Same selection as a regular Stash scene list: pages, bulk edit, queue");
        a.removeAttribute("aria-disabled");
      } else {
        a.removeAttribute("href");
        a.title = t("Classic Stash can't show this selection as one scene list");
        a.setAttribute("aria-disabled", "true");
      }
    }

    function cardHtml(s) {
      const file = s.files[0] || {};
      const dur = file.duration ? ui.fmtDuration(file.duration) : "";
      const href = `#/scene/${encodeURIComponent(s.id)}`;
      if (S.view === "preview") {
        return `<a class="tcx-card" href="${href}" data-scene="${esc(s.id)}" title="${esc(sceneTitle(s))}">
            <span class="tcx-thumb">${s.paths.screenshot ? `<img loading="lazy" src="${esc(s.paths.screenshot)}" alt="">` : ""}${s.paths.preview ? `<video muted loop playsinline preload="none" data-src="${esc(s.paths.preview)}"></video>` : ""}${dur ? `<em>${dur}</em>` : ""}</span>
            <span class="tcx-card-title">${esc(sceneTitle(s))}</span></a>`;
      }
      return `<a class="tcx-row" href="${href}" data-scene="${esc(s.id)}"><b>${esc(sceneTitle(s))}</b><small>${esc([dur, file.path].filter(Boolean).join(" · "))}</small></a>`;
    }

    // Open a scene so that the player's next / previous go on in this list (same selection, search and order).
    // Only the pages loaded so far are shown; the rest of the list follows in the background. false = plain link.
    function playFrom(id) {
      const i = S.scenes.findIndex((s) => String(s.id) === id);
      if (i < 0 || !stashui.has("play")) return false;
      const piece = (s) => ({ id: s.id, title: sceneTitle(s), thumb: s.paths.screenshot });
      const queue = stashui.play((S.all || S.scenes).map(piece), i);
      if (!queue) return false;
      if (!S.all && S.total != null && S.scenes.length < S.total) {
        const sort = SORTS.find((s) => s[0] === S.sort) || SORTS[0];
        stashui
          .gql(
            `query($f: FindFilterType, $x: SceneFilterType) { findScenes(filter: $f, scene_filter: $x) { scenes { id title paths { screenshot } files { path } } } }`,
            { f: { per_page: -1, sort: sort[2], direction: sort[3], q: S.q || undefined }, x: query().filter },
            { heavy: true }
          )
          .then((d) => queue.add(d.findScenes.scenes.map(piece)))
          .catch(() => {}); // (then "next" stops at the end of the pages loaded so far)
      }
      return true;
    }

    function paintList() {
      const box = $("[data-list]");
      const count = $("[data-count]");
      const selecting = S.sel.main.length || S.sel.on.length || S.sel.not.length;
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
      if (next && S.all) {
        S.scenes = S.all.slice(0, S.scenes.length + PAGE_SIZE);
        return paintList();
      }
      const seq = next ? S.seq : ++S.seq;
      if (!next) {
        S.page = 0;
        S.scenes = [];
        S.all = null;
        S.total = null;
        S.duration = null;
        paintList();
      }
      S.busy = true;
      const sort = SORTS.find((s) => s[0] === S.sort) || SORTS[0];
      const { filter, dropTags } = query();
      try {
        if (dropTags.length) {
          // all scenes at once; the ones with an excluded tag are dropped here, pages are cut from the rest
          const d = await stashui.gql(
            `query($f: FindFilterType, $x: SceneFilterType) { findScenes(filter: $f, scene_filter: $x) { scenes { id title paths { screenshot preview } files { path duration } tags { id } } } }`,
            { f: { per_page: -1, sort: sort[2], direction: sort[3], q: S.q || undefined }, x: filter },
            { heavy: true }
          );
          if (seq !== S.seq || signal.aborted) return;
          S.all =d.findScenes.scenes.filter((s) => {
            const keys = new Set();
            s.tags.forEach((tg) => addTag(keys, tg.id));
            return !dropTags.some((k) => keys.has(k));
          });
          S.scenes = S.all.slice(0, PAGE_SIZE);
          S.total = S.all.length;
          S.duration = S.all.reduce((sum, s) => sum + ((s.files[0] || {}).duration || 0), 0);
          return paintList();
        }
        const d = await stashui.gql(
          `query($f: FindFilterType, $x: SceneFilterType) { findScenes(filter: $f, scene_filter: $x) { count duration scenes { id title paths { screenshot preview } files { path duration } } } }`,
          { f: { page: S.page + 1, per_page: PAGE_SIZE, sort: sort[2], direction: sort[3], q: S.q || undefined }, x: filter }
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

    // A scene with a sub-tag counts for every parent of it in the category too (like depth -1 in the filter)
    function addTag(keys, id) {
      const key = "t:" + id;
      if (keys.has(key)) return;
      keys.add(key);
      if (category.subTags) (S.parents.get(String(id)) || []).forEach((p) => addTag(keys, p));
    }

    // Chip numbers under the main chips: the tags and performers of all their scenes, counted here
    async function countWithMain() {
      const seq = ++S.mainSeq;
      if (!S.sel.main.length) {
        S.mainCounts = null;
        S.counting = false;
        return paintChips();
      }
      S.counting = true;
      paintChips();
      try {
        const d = await stashui.gql(
          `query($x: SceneFilterType) { findScenes(scene_filter: $x, filter: { per_page: -1 }) { scenes { tags { id } performers { id } } } }`,
          { x: sceneQuery(category, S.base, { ...NO_SEL, main: S.sel.main }).filter },
          { heavy: true }
        );
        if (seq !== S.mainSeq || signal.aborted) return;
        const counts = new Map();
        for (const s of d.findScenes.scenes) {
          const keys = new Set();
          s.tags.forEach((tg) => addTag(keys, tg.id));
          s.performers.forEach((p) => keys.add("p:" + p.id));
          keys.forEach((k) => counts.set(k, (counts.get(k) || 0) + 1));
        }
        S.mainCounts = counts;
      } catch (e) {
        if (seq !== S.mainSeq || signal.aborted) return;
        S.mainCounts = null; // (the chips keep their numbers for the whole category)
        ui.errorToast(e, "Tag Categories");
      }
      S.counting = false;
      paintChips();
    }

    const reload = () => {
      paintTools();
      load(false);
    };
    const searchLater = ui.debounce(() => {
      S.q = $("[data-q]").value.trim();
      reload();
    }, SEARCH_DEBOUNCE_MS);

    function select(sel, mainChanged) {
      S.sel = sel;
      paintChips();
      reload();
      if (mainChanged) countWithMain();
    }

    function toggleChip(key, exclude) {
      const s = S.sel;
      const drop = (l) => l.filter((x) => x !== key);
      // a main chip: click takes it back, right-click excludes it instead
      if (s.main.includes(key)) return select({ ...s, main: drop(s.main), not: exclude ? s.not.concat(key) : s.not }, true);
      if (exclude) select(s.not.includes(key) ? { ...s, not: drop(s.not) } : { ...s, on: drop(s.on), not: s.not.concat(key) });
      else if (s.on.includes(key)) select({ ...s, on: drop(s.on) });
      else if (s.not.includes(key)) select({ ...s, not: drop(s.not) });
      else select({ ...s, on: s.on.concat(key) });
    }

    function toggleMain(key) {
      const s = S.sel;
      const drop = (l) => l.filter((x) => x !== key);
      select(s.main.includes(key) ? { ...s, main: drop(s.main) } : { ...s, main: s.main.concat(key), on: drop(s.on), not: drop(s.not) }, true);
    }

    main.addEventListener("click", (e) => {
      const card = e.target.closest("[data-scene]");
      if (card) {
        const plain = e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey; // (new tab / window)
        if (!plain && playFrom(card.dataset.scene)) e.preventDefault();
        return;
      }
      const chip = e.target.closest("[data-chip]");
      if (chip) return e.target.closest("[data-star]") || e.shiftKey ? toggleMain(chip.dataset.chip) : toggleChip(chip.dataset.chip, false);
      const mode = e.target.closest("[data-mode] [data-v]");
      if (mode) {
        S.sel = { ...S.sel, mode: mode.dataset.v };
        paintChips();
        if (S.sel.on.length > 1) reload();
        else paintTools();
        return;
      }
      if (e.target.closest("[data-reset]")) return select({ ...NO_SEL, mode: S.sel.mode }, S.sel.main.length > 0);
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
      if (e.target.closest("[data-refresh]")) {
        reload();
        if (S.sel.main.length) countWithMain();
        return;
      }
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
        const [r, rp] = await Promise.all([resolveTags(category.tags, category.subTags), resolvePerformers(category.performers)]);
        if (signal.aborted) return;
        const warn = [];
        if (r.missing.length) warn.push(t("These tags were not found in Stash and were skipped:") + " " + r.missing.join(", "));
        if (rp.missing.length) warn.push(t("These performers were not found in Stash and were skipped:") + " " + rp.missing.join(", "));
        if (warn.length) {
          $("[data-missing]").hidden = false;
          $("[data-missing]").textContent = warn.join(" ");
        }
        if (!r.tags.length && !rp.performers.length) {
          const none = category.performers.length ? "None of the category's tags or performers exist in Stash yet." : "None of the category tags exist in Stash yet.";
          $("[data-list]").innerHTML = `<div class="kb-empty"><b>${t(none)}</b></div>`;
          return;
        }
        S.base = { tags: r.tags.map((tg) => tg.id), perfs: rp.performers.map((p) => p.id) };
        const byCount = (a, b) => b.count - a.count || a.name.localeCompare(b.name);
        const tagList = category.subTags && r.children.length ? r.children : r.tags;
        S.chips = tagList
          .map((tg) => ({ key: "t:" + tg.id, kind: "t", name: tg.name, count: tagCount(tg, category.subTags) }))
          .sort(byCount)
          .concat(rp.performers.map((p) => ({ key: "p:" + p.id, kind: "p", name: p.name, count: p.scene_count || 0 })).sort(byCount));
        r.tags.concat(r.children).forEach((tg) => {
          S.names["t:" + tg.id] = tg.name;
          S.parents.set(String(tg.id), (tg.parents || []).map((p) => String(p.id)));
        });
        rp.performers.forEach((p) => (S.names["p:" + p.id] = p.name));
        $("[data-tools]").hidden = false;
        paintChips();
        reload();
      } catch (e) {
        if (!signal.aborted) ui.errorToast(e, "Tag Categories");
      }
    })();

    return () => {
      S.seq++;
      S.mainSeq++;
      if (observer) observer.disconnect();
      main.querySelectorAll("video").forEach((v) => v.removeAttribute("src"));
    };
  }
}
