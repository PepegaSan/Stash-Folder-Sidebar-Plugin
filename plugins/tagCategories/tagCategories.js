(function () {
  "use strict";

  const PLUGIN_ID = "tagCategories";
  const PLUGIN_VERSION = "1.9.0";
  const SEARCH_DEBOUNCE_MS = 250;
  const PAGE_SIZE = 60; // scenes per request; more are loaded while scrolling
  const CHIPS_COLLAPSED = 24; // tag chips shown before "+N more"
  const ROUTE_PATH = "/plugins/tag-categories";
  const LEGACY_ROUTE_PATH = "/plugin/tag-categories";
  const ASSETS_CATEGORIES = "/plugin/" + PLUGIN_ID + "/assets/categories.json";
  const VIEW_MODE_STORAGE_KEY = "tagCategories.viewMode";
  const SORT_MODE_STORAGE_KEY = "tagCategories.sortMode";
  const VIEW_MODES = ["list", "preview"];
  const SORT_MODES = [
    "title-asc",
    "title-desc",
    "duration-desc",
    "duration-asc",
    "date-desc",
    "date-asc",
  ];
  // Sort modes are applied by the Stash server (sort + direction of the scene query)
  const SORT_QUERY = {
    "title-asc": { sort: "title", direction: "ASC" },
    "title-desc": { sort: "title", direction: "DESC" },
    "duration-desc": { sort: "duration", direction: "DESC" },
    "duration-asc": { sort: "duration", direction: "ASC" },
    "date-desc": { sort: "date", direction: "DESC" },
    "date-asc": { sort: "date", direction: "ASC" },
  };
  const EMPTY_SEL = { main: [], on: [], not: [], mode: "any" };

  const PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.React) {
    console.error("[Tag Categories] PluginApi not available");
    return;
  }

  const React = PluginApi.React;
  const GQL = PluginApi.GQL;
  const libraries = PluginApi.libraries || {};
  const RR = libraries.ReactRouterDOM || {};
  const BS = libraries.Bootstrap || {};
  const faSolid = libraries.FontAwesomeSolid || {};
  const Link = RR.Link;
  const useLocation = RR.useLocation;
  const useHistory = RR.useHistory;
  const useNavigate = RR.useNavigate;
  const Button = BS.Button;
  const Nav = BS.Nav;

  if (!Link || typeof useLocation !== "function" || !Button || !Nav || !Nav.Link) {
    console.error(
      "[Tag Categories] incompatible PluginApi libraries — refusing to patch UI",
      {
        hasLink: !!Link,
        hasUseLocation: typeof useLocation === "function",
        hasButton: !!Button,
        hasNavLink: !!(Nav && Nav.Link),
      }
    );
    return;
  }

  function usePluginNavigate() {
    const history =
      typeof useHistory === "function" ? useHistory() : null;
    const navigate =
      typeof useNavigate === "function" ? useNavigate() : null;
    return React.useCallback(
      function (url) {
        if (navigate) {
          navigate(url);
          return;
        }
        if (history && typeof history.push === "function") {
          history.push(url);
          return;
        }
        window.location.assign(url);
      },
      [history, navigate]
    );
  }

  var PatchErrorBoundary = (function () {
    if (!React.Component) {
      return function Passthrough(props) {
        return props.children || null;
      };
    }
    function Boundary(props) {
      React.Component.call(this, props);
      this.state = { hasError: false };
    }
    Boundary.prototype = Object.create(React.Component.prototype);
    Boundary.prototype.constructor = Boundary;
    Boundary.getDerivedStateFromError = function () {
      return { hasError: true };
    };
    Boundary.prototype.componentDidCatch = function (err, info) {
      console.error("[Tag Categories] patched UI render failed", err, info);
    };
    Boundary.prototype.render = function () {
      if (this.state.hasError) return null;
      return this.props.children;
    };
    return Boundary;
  })();

  const DEFAULT_CONFIG = {
    categories: [],
  };

  const I18N = {
    en: {
      navLabel: "Categories",
      pageNavTitle: "Categories",
      pageEmptyConfig:
        "No categories configured. Add some under Settings → Plugins → Tag Categories.",
      pageSelectHint: "Select a category to list matching scenes.",
      scenesTitle: "Scenes",
      noScenes: "No scenes match any of these tags.",
      missingTags: "These tags were not found in Stash and were skipped:",
      missingPerformers: "These performers were not found in Stash and were skipped:",
      noResolvedTags: "None of the category tags exist in Stash yet.",
      noResolvedAny: "None of the category's tags or performers exist in Stash yet.",
      refresh: "Refresh",
      updating: "Updating…",
      tagsLabelShort: "Tags:",
      performersLabelShort: "Performers:",
      viewList: "List",
      viewPreview: "Preview",
      viewModeLabel: "View",
      searchPlaceholder: "Search in this category…",
      searchClear: "Clear search",
      noSearchMatches: "No scenes match this search.",
      sortLabel: "Sort",
      sortTitleAsc: "Title A–Z",
      sortTitleDesc: "Title Z–A",
      sortDurationDesc: "Duration (long → short)",
      sortDurationAsc: "Duration (short → long)",
      sortDateDesc: "Date (newest)",
      sortDateAsc: "Date (oldest)",
      subTagsShort: "+ sub-tags",
      chipsHint: "Click: select · Right-click: exclude · ★: main tag",
      mainTitle:
        "Main tag: every scene has it, the other chips count only scenes with it – click to remove",
      starTitle:
        "Make this the main tag: every scene has it, the other chips show what goes with it",
      mainNote: "Main: {names}",
      chipsTags: "Tags",
      chipsPerformers: "Performers",
      matchLabel: "Selected tags",
      matchAny: "Any of them",
      matchAll: "All",
      chipsReset: "Reset",
      chipsMore: "+{n} more",
      chipsLess: "Show less",
      excludedTitle: "Excluded – click to remove",
      loadMore: "Load more ({shown} of {total})",
      openInStash: "Open in Stash",
      openInStashTitle:
        "Same selection as a regular Stash scene list: pages, bulk edit, queue",
      openInStashNo: "Stash can't show this selection as one scene list",
      noSelectionMatches: "No scenes match this tag selection.",
      totalDuration: "{d} in total",
    },
    de: {
      navLabel: "Kategorien",
      pageNavTitle: "Kategorien",
      pageEmptyConfig:
        "Keine Kategorien konfiguriert. Anlegen unter Settings → Plugins → Tag Categories.",
      pageSelectHint: "Kategorie wählen, um passende Szenen anzuzeigen.",
      scenesTitle: "Szenen",
      noScenes: "Keine Szenen mit einem dieser Tags.",
      missingTags: "Diese Tags gibt es in Stash nicht und wurden übersprungen:",
      missingPerformers: "Diese Performer gibt es in Stash nicht und wurden übersprungen:",
      noResolvedTags: "Keiner der Kategorie-Tags existiert bisher in Stash.",
      noResolvedAny: "Keiner der Tags oder Performer der Kategorie existiert bisher in Stash.",
      refresh: "Aktualisieren",
      updating: "Aktualisiere…",
      tagsLabelShort: "Tags:",
      performersLabelShort: "Performer:",
      viewList: "Liste",
      viewPreview: "Vorschau",
      viewModeLabel: "Ansicht",
      searchPlaceholder: "In dieser Kategorie suchen…",
      searchClear: "Suche leeren",
      noSearchMatches: "Keine Szenen passen zur Suche.",
      sortLabel: "Sortierung",
      sortTitleAsc: "Titel A–Z",
      sortTitleDesc: "Titel Z–A",
      sortDurationDesc: "Dauer (lang → kurz)",
      sortDurationAsc: "Dauer (kurz → lang)",
      sortDateDesc: "Datum (neueste)",
      sortDateAsc: "Datum (älteste)",
      subTagsShort: "+ Unter-Tags",
      chipsHint: "Klick: auswählen · Rechtsklick: ausschließen · ★: Haupt-Tag",
      mainTitle:
        "Haupt-Tag: jede Szene hat ihn, die anderen Chips zählen nur Szenen mit ihm – Klick hebt es auf",
      starTitle:
        "Zum Haupt-Tag machen: jede Szene hat ihn, die anderen Chips zeigen, was es dazu gibt",
      mainNote: "Haupt-Tag: {names}",
      chipsTags: "Tags",
      chipsPerformers: "Performer",
      matchLabel: "Ausgewählte Tags",
      matchAny: "Eines davon",
      matchAll: "Alle",
      chipsReset: "Zurücksetzen",
      chipsMore: "+{n} weitere",
      chipsLess: "Weniger",
      excludedTitle: "Ausgeschlossen – Klick hebt es auf",
      loadMore: "Mehr laden ({shown} von {total})",
      openInStash: "In Stash öffnen",
      openInStashTitle:
        "Dieselbe Auswahl als normale Szenenliste in Stash: Seiten, Mehrfach-Bearbeitung, Warteschlange",
      openInStashNo: "Stash kann diese Auswahl nicht als eine Szenenliste zeigen",
      noSelectionMatches: "Keine Szenen passen zu dieser Tag-Auswahl.",
      totalDuration: "{d} insgesamt",
    },
  };

  console.info("[Tag Categories] loaded v" + PLUGIN_VERSION);

  function getUiLang(interfaceConfig) {
    const raw = String(
      (interfaceConfig && interfaceConfig.language) || ""
    ).toLowerCase();
    if (raw.startsWith("de")) return "de";
    if (raw.startsWith("en")) return "en";
    return "en";
  }

  function t(lang, key, vars) {
    const table = I18N[lang] || I18N.en;
    let text = table[key] != null ? table[key] : I18N.en[key] || key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        text = text.split("{" + k + "}").join(String(vars[k]));
      });
    }
    return text;
  }

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
    if (Array.isArray(value)) {
      return value
        .map(function (x) {
          return String(x || "").trim();
        })
        .filter(Boolean);
    }
    return String(value || "")
      .split(",")
      .map(function (x) {
        return x.trim();
      })
      .filter(Boolean);
  }

  function uniqueStrings(list) {
    const seen = {};
    const out = [];
    list.forEach(function (item) {
      const key = item.toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      out.push(item);
    });
    return out;
  }

  function normalizeCategory(raw, index) {
    if (!raw || typeof raw !== "object") return null;
    const name = String(raw.name || raw.label || "").trim();
    if (!name) return null;
    const tags = uniqueStrings(parseTagsList(raw.tags));
    const id = String(raw.id || "").trim() || slugId(name) + "-" + index;
    const performers = uniqueStrings(parseTagsList(raw.performers));
    return { id: id, name: name, tags: tags, performers: performers, subTags: !!raw.subTags };
  }

  function parseCategoriesJson(text) {
    const parsed = JSON.parse(String(text));
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid JSON object");
    }
    const list = Array.isArray(parsed.categories)
      ? parsed.categories
      : Array.isArray(parsed)
        ? parsed
        : null;
    if (!list) {
      throw new Error("categories array required");
    }
    const categories = [];
    list.forEach(function (item, index) {
      const cat = normalizeCategory(item, index);
      if (cat) categories.push(cat);
    });
    return { categories: categories };
  }

  function categoriesToJson(config) {
    return JSON.stringify(
      {
        categories: (config.categories || []).map(function (c) {
          const out = {
            id: c.id,
            name: c.name,
            tags: c.tags || [],
          };
          if (c.performers && c.performers.length) out.performers = c.performers;
          if (c.subTags) out.subTags = true;
          return out;
        }),
      },
      null,
      2
    );
  }

  function getConfigFromSettings(plugins) {
    const raw =
      plugins && plugins[PLUGIN_ID] && plugins[PLUGIN_ID].categoriesJson;
    if (!raw || !String(raw).trim()) return null;
    try {
      return parseCategoriesJson(raw);
    } catch (e) {
      return null;
    }
  }

  async function loadCategoriesFromFile() {
    try {
      const res = await fetch(ASSETS_CATEGORIES, { cache: "no-store" });
      if (!res.ok) return null;
      return parseCategoriesJson(await res.text());
    } catch (e) {
      return null;
    }
  }

  function formatDuration(seconds) {
    if (seconds == null || isNaN(seconds)) return "";
    const s = Math.floor(seconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) {
      return (
        h +
        ":" +
        String(m).padStart(2, "0") +
        ":" +
        String(sec).padStart(2, "0")
      );
    }
    return m + ":" + String(sec).padStart(2, "0");
  }

  function sceneFilePath(scene) {
    const files = scene && scene.files;
    if (!files || !files.length) return "";
    return files[0].path || "";
  }

  function sceneDuration(scene) {
    const files = scene && scene.files;
    if (!files || !files.length) return null;
    return files[0].duration;
  }

  function basename(path) {
    if (!path) return "";
    const parts = String(path).split(/[/\\]/);
    return parts[parts.length - 1] || path;
  }

  function normalizeViewMode(value) {
    const mode = String(value || "list").trim().toLowerCase();
    return VIEW_MODES.indexOf(mode) >= 0 ? mode : "list";
  }

  function readStoredViewMode() {
    try {
      return normalizeViewMode(localStorage.getItem(VIEW_MODE_STORAGE_KEY));
    } catch (e) {
      return "list";
    }
  }

  function storeViewMode(mode) {
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, normalizeViewMode(mode));
    } catch (e) {
      /* ignore */
    }
  }

  function normalizeSortMode(value) {
    const mode = String(value || "title-asc").trim().toLowerCase();
    return SORT_MODES.indexOf(mode) >= 0 ? mode : "title-asc";
  }

  function readStoredSortMode() {
    try {
      return normalizeSortMode(localStorage.getItem(SORT_MODE_STORAGE_KEY));
    } catch (e) {
      return "title-asc";
    }
  }

  function storeSortMode(mode) {
    try {
      localStorage.setItem(SORT_MODE_STORAGE_KEY, normalizeSortMode(mode));
    } catch (e) {
      /* ignore */
    }
  }

  function sceneTitle(scene) {
    const path = sceneFilePath(scene);
    if (scene.title && scene.title.trim()) return scene.title.trim();
    return basename(path) || "Scene " + scene.id;
  }

  function sceneThumbUrl(scene) {
    const paths = scene && scene.paths;
    if (!paths) return "";
    return (
      paths.screenshot ||
      paths.preview ||
      paths.sprite ||
      paths.webp ||
      ""
    );
  }

  function usePluginLang() {
    const { data } = GQL.useConfigurationQuery({ fetchPolicy: "cache-first" });
    return getUiLang(
      data && data.configuration && data.configuration.interface
    );
  }

  function useCategoryConfig() {
    const [config, setConfig] = React.useState(DEFAULT_CONFIG);
    const [error, setError] = React.useState(null);
    const [loading, setLoading] = React.useState(true);
    const { data: configData } = GQL.useConfigurationQuery({
      fetchPolicy: "cache-and-network",
    });

    React.useEffect(
      function () {
        let cancelled = false;
        async function load() {
          setLoading(true);
          setError(null);
          try {
            const plugins =
              configData && configData.configuration
                ? configData.configuration.plugins
                : null;
            let cfg = getConfigFromSettings(plugins);
            if (!cfg) cfg = await loadCategoriesFromFile();
            if (!cfg) cfg = DEFAULT_CONFIG;
            if (!cancelled) setConfig(cfg);
          } catch (e) {
            if (!cancelled) {
              setError(e.message || String(e));
              setConfig(DEFAULT_CONFIG);
            }
          } finally {
            if (!cancelled) setLoading(false);
          }
        }
        load();
        return function () {
          cancelled = true;
        };
      },
      [configData]
    );

    const lang = getUiLang(
      configData &&
        configData.configuration &&
        configData.configuration.interface
    );

    return { config: config, error: error, loading: loading, lang: lang };
  }

  function criterionModifier(name, fallback) {
    return GQL.CriterionModifier && GQL.CriterionModifier[name]
      ? GQL.CriterionModifier[name]
      : fallback;
  }
  const MOD = {
    equals: criterionModifier("Equals", "EQUALS"),
    includes: criterionModifier("Includes", "INCLUDES"),
    includesAll: criterionModifier("IncludesAll", "INCLUDES_ALL"),
    excludes: criterionModifier("Excludes", "EXCLUDES"),
  };

  const tagCache = new Map(); // lower-case tag name -> Stash tag
  const childCache = new Map(); // sorted parent ids -> all sub-tags (any depth)
  const perfCache = new Map(); // lower-case performer name -> Stash performer

  function clearTagCaches() {
    tagCache.clear();
    childCache.clear();
    perfCache.clear();
  }

  function tagCount(tag, withSubTags) {
    if (!tag) return 0;
    const n =
      withSubTags && tag.scene_count_all != null
        ? tag.scene_count_all
        : tag.scene_count;
    return n || 0;
  }

  function formatCount(n) {
    return n == null ? "" : Number(n).toLocaleString();
  }

  // Tag names -> Stash tags (exact name, case-insensitive). withSubTags: also every sub-tag, any depth.
  function useResolveTags() {
    const [findTags] = GQL.useFindTagsLazyQuery({ fetchPolicy: "cache-first" });

    return React.useCallback(
      async function resolveTags(tagNames, withSubTags) {
        const tags = [];
        const missing = [];
        for (let i = 0; i < tagNames.length; i++) {
          const tagName = tagNames[i];
          const key = tagName.toLowerCase();
          if (tagCache.has(key)) {
            tags.push(tagCache.get(key));
            continue;
          }

          async function queryTags(modifier) {
            return findTags({
              variables: {
                filter: { per_page: 25, q: tagName },
                tag_filter: {
                  name: { value: tagName, modifier: modifier },
                },
              },
            });
          }

          let result = await queryTags(MOD.equals);
          let found =
            result.data && result.data.findTags && result.data.findTags.tags;
          if (!found || !found.length) {
            result = await queryTags(MOD.includes);
            found =
              result.data && result.data.findTags && result.data.findTags.tags;
          }
          const exact =
            (found &&
              found.find(function (tag) {
                return tag.name.toLowerCase() === key;
              })) ||
            null;
          if (exact) {
            tagCache.set(key, exact);
            tags.push(exact);
          } else {
            missing.push(tagName);
          }
        }

        let children = [];
        if (withSubTags && tags.length) {
          const ids = tags.map(function (tag) {
            return tag.id;
          });
          const cacheKey = ids.slice().sort().join(",");
          if (childCache.has(cacheKey)) {
            children = childCache.get(cacheKey);
          } else {
            const result = await findTags({
              variables: {
                filter: { per_page: -1, sort: "name", direction: "ASC" },
                tag_filter: {
                  parents: { value: ids, modifier: MOD.includes, depth: -1 },
                },
              },
            });
            children =
              (result.data &&
                result.data.findTags &&
                result.data.findTags.tags) ||
              [];
            childCache.set(cacheKey, children);
          }
        }
        return { tags: tags, missing: missing, children: children };
      },
      [findTags]
    );
  }

  // Plain GraphQL request (for queries the generated hooks don't have, e.g. scenes with only their tag ids)
  async function gqlFetch(query, variables) {
    const res = await fetch("/graphql", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, variables: variables }),
    });
    if (!res.ok) throw new Error("Stash answered " + res.status);
    const json = await res.json();
    if (json.errors && json.errors.length) {
      throw new Error(
        json.errors
          .map(function (e) {
            return e.message;
          })
          .join("; ")
      );
    }
    return json.data;
  }

  const PERFORMERS_QUERY =
    "query($f: FindFilterType, $pf: PerformerFilterType) { findPerformers(filter: $f, performer_filter: $pf) { performers { id name alias_list scene_count } } }";

  // Performer names -> Stash performers (exact name, else an exact alias; case-insensitive)
  async function resolvePerformers(names) {
    const performers = [];
    const missing = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const key = name.toLowerCase();
      let found = perfCache.get(key) || null;
      if (!found) {
        let d = await gqlFetch(PERFORMERS_QUERY, {
          f: { per_page: 25 },
          pf: { name: { value: name, modifier: MOD.equals } },
        });
        found =
          ((d.findPerformers && d.findPerformers.performers) || []).find(function (p) {
            return p.name.toLowerCase() === key;
          }) || null;
        if (!found) {
          d = await gqlFetch(PERFORMERS_QUERY, { f: { per_page: 25, q: name } });
          found =
            ((d.findPerformers && d.findPerformers.performers) || []).find(function (p) {
              return (p.alias_list || []).some(function (a) {
                return a.toLowerCase() === key;
              });
            }) || null;
        }
        if (found) perfCache.set(key, found);
      }
      if (!found) missing.push(name);
      else if (
        !performers.some(function (p) {
          return p.id === found.id;
        })
      ) {
        performers.push(found);
      }
    }
    return { performers: performers, missing: missing };
  }

  function ids(list) {
    return list.map(function (x) {
      return x.id;
    });
  }

  // Chips, the selection and the names use keys "t:<tag id>" and "p:<performer id>"
  function idsOf(keys, kind) {
    return keys
      .filter(function (k) {
        return k[0] === kind;
      })
      .map(function (k) {
        return k.slice(2);
      });
  }

  function unique(list) {
    return list.filter(function (x, i) {
      return list.indexOf(x) === i;
    });
  }

  // What Stash is asked for the list: every main chip (sel.main), any / all of the selected chips (sel.on), none of
  // the excluded ones (sel.not); with nothing selected, any tag or performer of the category (base).
  // Stash joins the tags only twice per query (one join for "has", one for "has none of") and the performers once
  // (their "none of" is a subquery) – a second criterion on a join that is taken breaks both. So "all of" is
  // INCLUDES_ALL, "any of" one kind is INCLUDES while that join is free, otherwise "not none of" (NOT + EXCLUDES),
  // and excluded tags go where there is room. Main tags + "any of" tags + excluded tags would need three tag joins:
  // then the excluded tags come back as dropTags (chip keys) and the caller drops those scenes itself.
  function sceneQuery(category, base, sel) {
    const depth = category.subTags ? -1 : 0;
    function tagCrit(value, modifier) {
      return { value: value, modifier: modifier, depth: depth };
    }
    function perfCrit(value, modifier) {
      return { value: value, modifier: modifier };
    }
    const nothing = !sel.main.length && !sel.on.length;
    const any = sel.mode !== "all";
    let allT = unique(idsOf(sel.main, "t").concat(any ? [] : idsOf(sel.on, "t")));
    let allP = unique(idsOf(sel.main, "p").concat(any ? [] : idsOf(sel.on, "p")));
    let anyT = nothing ? base.tags : any ? idsOf(sel.on, "t") : [];
    let anyP = nothing ? base.perfs : any ? idsOf(sel.on, "p") : [];
    if (!nothing && anyT.length + anyP.length === 1) {
      // "any of" one chip is "all of" it
      allT = unique(allT.concat(anyT));
      allP = unique(allP.concat(anyP));
      anyT = [];
      anyP = [];
    }
    const notT = idsOf(sel.not, "t");
    const notP = idsOf(sel.not, "p");
    const filter = {};
    const noneOf = {}; // goes in as NOT: "none of these" negated = any of them
    const plainT = anyT.length > 0 && !anyP.length && !allT.length;
    const plainP = anyP.length > 0 && !anyT.length && !allP.length;
    if (allT.length) filter.tags = tagCrit(allT, MOD.includesAll);
    else if (plainT) filter.tags = tagCrit(anyT, MOD.includes);
    if (anyT.length && !plainT) noneOf.tags = tagCrit(anyT, MOD.excludes);
    if (allP.length) filter.performers = perfCrit(allP, MOD.includesAll);
    else if (plainP) filter.performers = perfCrit(anyP, MOD.includes);
    if (anyP.length && !plainP) noneOf.performers = perfCrit(anyP, MOD.excludes);
    if (notP.length) {
      if (filter.performers) filter.performers.excludes = notP;
      else filter.performers = perfCrit(notP, MOD.excludes);
    }
    let orHas = null;
    let dropTags = [];
    if (notT.length) {
      if (!noneOf.tags) {
        if (filter.tags) filter.tags.excludes = notT;
        else filter.tags = tagCrit(notT, MOD.excludes);
      } else if (!filter.tags) {
        orHas = { tags: tagCrit(notT, MOD.includes) }; // NOT (none of the chips OR one of these)
      } else {
        dropTags = notT.map(function (id) {
          return "t:" + id;
        });
      }
    }
    if (Object.keys(noneOf).length) filter.NOT = orHas ? Object.assign(noneOf, { OR: orHas }) : noneOf;
    return { filter: filter, dropTags: dropTags };
  }

  // The same selection as regular Stash criteria (one tags and one performers criterion, both apply).
  // null = Stash's scene list can't express it: "any of" tags or performers, or a main chip plus "any of"
  // more of its kind.
  function stashCriteria(category, base, sel) {
    const any = sel.mode !== "all" && sel.on.length > 1; // ("any of" one chip is "all of" it)
    const nothing = !sel.main.length && !sel.on.length;
    const across = nothing
      ? base.tags.length && base.perfs.length
      : any && idsOf(sel.on, "t").length && idsOf(sel.on, "p").length;
    if (across) return null;
    const crits = [];
    const kinds = [
      ["t", "tags", base.tags],
      ["p", "performers", base.perfs],
    ];
    for (let i = 0; i < kinds.length; i++) {
      const kind = kinds[i][0];
      const mainIds = idsOf(sel.main, kind);
      const onIds = idsOf(sel.on, kind);
      if (any && mainIds.length && onIds.length) return null;
      const value = nothing ? kinds[i][2] : mainIds.concat(onIds);
      const excluded = idsOf(sel.not, kind);
      if (!value.length && !excluded.length) continue;
      crits.push({
        type: kinds[i][1],
        kind: kind,
        modifier: nothing || (any && !mainIds.length) ? MOD.includes : MOD.includesAll,
        value: value,
        excluded: excluded,
        depth: category.subTags ? -1 : 0,
      });
    }
    return crits;
  }

  // Stash puts a criterion into the URL as JSON with { } replaced by ( ) outside of strings
  // (ListFilterModel.translateJSON / getEncodedParams in the Stash UI)
  function encodeCriterion(obj) {
    const json = JSON.stringify(obj);
    let inString = false;
    let escaped = false;
    let out = "";
    for (let i = 0; i < json.length; i++) {
      let c = json[i];
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        if (inString) escaped = true;
      } else if (c === '"') {
        inString = !inString;
      } else if (!inString && c === "{") {
        c = "(";
      } else if (!inString && c === "}") {
        c = ")";
      }
      out += c;
    }
    out = encodeURI(out);
    ["?", "#", "&", ";", "=", "+"].forEach(function (ch) {
      out = out.split(ch).join(encodeURIComponent(ch));
    });
    return out;
  }

  // Link to the regular Stash scene list with the same tags / performers, search and sort
  function stashScenesUrl(crits, names, query, sortMode) {
    const sort = SORT_QUERY[sortMode] || SORT_QUERY[SORT_MODES[0]];
    const parts = [];
    if (query) parts.push("q=" + encodeURIComponent(query));
    crits.forEach(function (crit) {
      function item(id) {
        return { id: String(id), label: names[crit.kind + ":" + id] || String(id) };
      }
      const value = { items: crit.value.map(item), excluded: crit.excluded.map(item) };
      if (crit.type === "tags") value.depth = crit.depth;
      parts.push("c=" + encodeCriterion({ type: crit.type, modifier: crit.modifier, value: value }));
    });
    parts.push("sortby=" + sort.sort);
    // Stash defaults: date descending, everything else ascending
    const isDefault =
      sort.sort === "date" ? sort.direction === "DESC" : sort.direction === "ASC";
    if (!isDefault) parts.push("sortdir=" + sort.direction.toLowerCase());
    return "/scenes?" + parts.join("&");
  }

  // Chip keys of a scene. With sub-tags, a scene's tag counts for every parent of it in the category too
  // (like depth -1 in the filter).
  function sceneChipKeys(scene, parents, withSubTags) {
    const keys = new Set();
    function addTag(id) {
      const key = "t:" + id;
      if (keys.has(key)) return;
      keys.add(key);
      if (withSubTags) (parents[id] || []).forEach(addTag);
    }
    (scene.tags || []).forEach(function (tag) {
      addTag(String(tag.id));
    });
    (scene.performers || []).forEach(function (p) {
      keys.add("p:" + p.id);
    });
    return keys;
  }

  // Chip numbers under the main chips: how many of their scenes have each tag / performer
  const MAIN_SCENES_QUERY =
    "query($x: SceneFilterType) { findScenes(scene_filter: $x, filter: { per_page: -1 }) { scenes { tags { id } performers { id } } } }";

  function countChips(scenes, parents, withSubTags) {
    const counts = new Map();
    scenes.forEach(function (scene) {
      sceneChipKeys(scene, parents, withSubTags).forEach(function (k) {
        counts.set(k, (counts.get(k) || 0) + 1);
      });
    });
    return counts;
  }

  // The whole list at once, for a selection whose excluded tags are dropped here (see sceneQuery)
  const ALL_SCENES_QUERY =
    "query($f: FindFilterType, $x: SceneFilterType) { findScenes(filter: $f, scene_filter: $x) { scenes { id title paths { screenshot preview webp sprite } files { path duration } tags { id } } } }";

  function dropScenes(scenes, dropTags, parents, withSubTags) {
    return scenes.filter(function (scene) {
      const keys = sceneChipKeys(scene, parents, withSubTags);
      return !dropTags.some(function (k) {
        return keys.has(k);
      });
    });
  }

  // Sub-tag id -> its parent tag ids, for all sub-tags of these tags (Stash's own tag queries don't always carry them)
  async function loadTagParents(tags) {
    const parents = {};
    if (!tags.length) return parents;
    const d = await gqlFetch(
      "query($tf: TagFilterType) { findTags(tag_filter: $tf, filter: { per_page: -1 }) { tags { id parents { id } } } }",
      { tf: { parents: { value: ids(tags), modifier: MOD.includes, depth: -1 } } }
    );
    ((d.findTags && d.findTags.tags) || []).forEach(function (tag) {
      parents[String(tag.id)] = (tag.parents || []).map(function (p) {
        return String(p.id);
      });
    });
    return parents;
  }

  function categoryLine(category, lang) {
    return (
      (category.tags || []).concat(category.performers || []).join(", ") +
      (category.subTags ? " " + t(lang, "subTagsShort") : "")
    );
  }

  function SceneListView(props) {
    const scenes = props.scenes;
    return React.createElement(
      "ul",
      { className: "tag-categories-list" },
      scenes.map(function (scene) {
        const path = sceneFilePath(scene);
        const title = sceneTitle(scene);
        const dur = formatDuration(sceneDuration(scene));
        const meta = [dur, path].filter(Boolean).join(" · ");
        return React.createElement(
          "li",
          { key: scene.id, className: "tag-categories-row" },
          React.createElement(
            Link,
            { to: "/scenes/" + scene.id },
            React.createElement(
              "div",
              { className: "tag-categories-row-title" },
              title
            ),
            meta
              ? React.createElement(
                  "div",
                  { className: "tag-categories-row-meta" },
                  meta
                )
              : null
          )
        );
      })
    );
  }

  function ScenePreviewView(props) {
    const scenes = props.scenes;
    return React.createElement(
      "div",
      { className: "tag-categories-preview-grid" },
      scenes.map(function (scene) {
        const title = sceneTitle(scene);
        const thumb = sceneThumbUrl(scene);
        const dur = formatDuration(sceneDuration(scene));
        return React.createElement(
          Link,
          {
            key: scene.id,
            to: "/scenes/" + scene.id,
            className: "tag-categories-preview-card",
            title: title,
          },
          React.createElement(
            "div",
            { className: "tag-categories-preview-thumb-wrap" },
            thumb
              ? React.createElement("img", {
                  className: "tag-categories-preview-thumb",
                  src: thumb,
                  alt: title,
                  loading: "lazy",
                })
              : React.createElement(
                  "div",
                  { className: "tag-categories-preview-placeholder" },
                  "▶"
                ),
            dur
              ? React.createElement(
                  "span",
                  { className: "tag-categories-preview-duration" },
                  dur
                )
              : null
          ),
          React.createElement(
            "div",
            { className: "tag-categories-preview-title" },
            title
          )
        );
      })
    );
  }

  // Chips like in the PMV Generator: click = select, right-click = exclude, ★ (or shift-click) = main chip.
  // With a main chip, only what goes with it is shown, counted within its scenes (props.mainCounts).
  function TagChips(props) {
    const sel = props.sel;
    const lang = props.lang;
    const withMain = !!props.mainCounts;
    const isMain = function (chip) {
      return sel.main.indexOf(chip.key) >= 0;
    };
    const marked = function (chip) {
      return isMain(chip) || sel.on.indexOf(chip.key) >= 0 || sel.not.indexOf(chip.key) >= 0;
    };
    const count = function (chip) {
      return withMain ? props.mainCounts.get(chip.key) || 0 : chip.count;
    };
    let hidden = 0;
    let long = false;
    function group(kind) {
      let list = props.chips.filter(function (chip) {
        return chip.kind === kind;
      });
      if (withMain) {
        list = list
          .filter(function (chip) {
            return marked(chip) || count(chip) > 0;
          })
          .sort(function (a, b) {
            return isMain(b) - isMain(a) || count(b) - count(a) || a.name.localeCompare(b.name);
          });
      }
      const visible =
        props.showAll || list.length <= CHIPS_COLLAPSED
          ? list
          : list.filter(function (chip, i) {
              return i < CHIPS_COLLAPSED || marked(chip);
            });
      hidden += list.length - visible.length;
      long = long || list.length > CHIPS_COLLAPSED;
      return visible;
    }
    const tags = group("t");
    const perfs = group("p");
    const labelled =
      props.chips.some(function (c) {
        return c.kind === "t";
      }) &&
      props.chips.some(function (c) {
        return c.kind === "p";
      });
    const active = sel.main.length > 0 || sel.on.length > 0 || sel.not.length > 0;

    function chipButton(chip) {
      const main = isMain(chip);
      const on = sel.on.indexOf(chip.key) >= 0;
      const not = sel.not.indexOf(chip.key) >= 0;
      return React.createElement(
        "button",
        {
          key: chip.key,
          type: "button",
          className: "tc-chip" + (main ? " is-main" : on ? " is-on" : not ? " is-not" : ""),
          "aria-pressed": main || on,
          title: main
            ? t(lang, "mainTitle")
            : not
              ? t(lang, "excludedTitle")
              : t(lang, "chipsHint"),
          onClick: function (e) {
            const star = e.target && e.target.closest && e.target.closest(".tc-star");
            if (star || e.shiftKey) props.onMain(chip.key);
            else props.onToggle(chip.key);
          },
          onContextMenu: function (e) {
            e.preventDefault();
            props.onExclude(chip.key);
          },
        },
        React.createElement("span", { className: "tc-star", title: t(lang, "starTitle") }, "★"),
        on || not
          ? React.createElement("span", { className: "tc-mark", "aria-hidden": true }, on ? "✓" : "✕")
          : null,
        chip.name,
        React.createElement(
          "small",
          null,
          props.counting && !main ? "…" : formatCount(count(chip))
        )
      );
    }

    function row(labelKey, list) {
      if (!list.length) return null;
      return React.createElement(
        "div",
        { key: labelKey, className: "tc-chip-row" },
        labelled ? React.createElement("span", { className: "tc-chip-label" }, t(lang, labelKey)) : null,
        React.createElement("div", { className: "tc-chips" }, list.map(chipButton))
      );
    }

    return React.createElement(
      "div",
      { className: "tc-filter" + (active ? " has-sel" : "") },
      React.createElement(
        "div",
        { className: "tc-filter-head" },
        React.createElement(
          "div",
          { className: "tc-seg", role: "group", "aria-label": t(lang, "matchLabel") },
          [
            ["any", "matchAny"],
            ["all", "matchAll"],
          ].map(function (m) {
            return React.createElement(
              "button",
              {
                key: m[0],
                type: "button",
                className: sel.mode === m[0] ? "is-on" : "",
                "aria-pressed": sel.mode === m[0],
                onClick: function () {
                  props.onMode(m[0]);
                },
              },
              t(lang, m[1])
            );
          })
        ),
        sel.main.length
          ? React.createElement(
              "span",
              { className: "tc-main-note" },
              "★ " +
                t(lang, "mainNote", {
                  names: sel.main
                    .map(function (k) {
                      return props.names[k] || k;
                    })
                    .join(", "),
                })
            )
          : React.createElement("span", { className: "tc-filter-hint" }, t(lang, "chipsHint")),
        active
          ? React.createElement(
              "button",
              { type: "button", className: "tc-filter-reset", onClick: props.onReset },
              t(lang, "chipsReset")
            )
          : null
      ),
      row("chipsTags", tags),
      row("chipsPerformers", perfs),
      hidden > 0 || (props.showAll && long)
        ? React.createElement(
            "div",
            { className: "tc-chips" },
            React.createElement(
              "button",
              { type: "button", className: "tc-chip tc-chip-more", onClick: props.onToggleAll },
              props.showAll ? t(lang, "chipsLess") : t(lang, "chipsMore", { n: hidden })
            )
          )
        : null
    );
  }

  function without(list, id) {
    return list.filter(function (x) {
      return x !== id;
    });
  }

  // Tags and performers of a category -> Stash ids (base), chips, names, sub-tag parents
  function useCategoryItems(category) {
    const resolveTags = useResolveTags();
    const [state, setState] = React.useState({ loading: true });

    React.useEffect(
      function () {
        let cancelled = false;
        setState({ loading: true });
        Promise.all([
          resolveTags(category.tags || [], !!category.subTags),
          resolvePerformers(category.performers || []),
        ])
          .then(function (res) {
            return loadTagParents(category.subTags ? res[0].tags : []).then(function (parents) {
              return res.concat([parents]);
            });
          })
          .then(function (res) {
            if (cancelled) return;
            const r = res[0];
            const rp = res[1];
            const parents = res[2];
            function byCount(a, b) {
              return b.count - a.count || a.name.localeCompare(b.name);
            }
            const tagList = category.subTags && r.children.length ? r.children : r.tags;
            const chips = tagList
              .map(function (tag) {
                return { key: "t:" + tag.id, kind: "t", name: tag.name, count: tagCount(tag, category.subTags) };
              })
              .sort(byCount)
              .concat(
                rp.performers
                  .map(function (p) {
                    return { key: "p:" + p.id, kind: "p", name: p.name, count: p.scene_count || 0 };
                  })
                  .sort(byCount)
              );
            const names = {};
            r.tags.concat(r.children).forEach(function (tag) {
              names["t:" + tag.id] = tag.name;
            });
            rp.performers.forEach(function (p) {
              names["p:" + p.id] = p.name;
            });
            setState({
              loading: false,
              base: { tags: ids(r.tags), perfs: ids(rp.performers) },
              chips: chips,
              names: names,
              parents: parents,
              missing: r.missing,
              missingPerformers: rp.missing,
            });
          })
          .catch(function (e) {
            if (!cancelled) setState({ loading: false, error: e.message || String(e) });
          });
        return function () {
          cancelled = true;
        };
      },
      [category.id, category.tags, category.performers, category.subTags, resolveTags]
    );
    return state;
  }

  function CategoryScenesPanel(props) {
    const { category, lang } = props;
    const { LoadingIndicator } = PluginApi.components;
    const [viewMode, setViewMode] = React.useState(readStoredViewMode);
    const [sortMode, setSortMode] = React.useState(readStoredSortMode);
    const [searchInput, setSearchInput] = React.useState("");
    const [searchQuery, setSearchQuery] = React.useState("");
    const items = useCategoryItems(category);
    const [sel, setSel] = React.useState(EMPTY_SEL);
    const [showAllChips, setShowAllChips] = React.useState(false);
    // chip numbers under the main chips; key = the main chips they were counted for
    const [mainCount, setMainCount] = React.useState({ key: "", counts: null });
    const [recount, setRecount] = React.useState(0);
    // page belongs to one filter; a new filter starts at page 1 again
    const [paging, setPaging] = React.useState({ key: "", page: 1 });
    const [pages, setPages] = React.useState({ key: "", list: {}, count: null, duration: null });
    const sentinel = React.useRef(null);

    function setAndStoreViewMode(mode) {
      const next = normalizeViewMode(mode);
      setViewMode(next);
      storeViewMode(next);
    }

    function setAndStoreSortMode(mode) {
      const next = normalizeSortMode(mode);
      setSortMode(next);
      storeSortMode(next);
    }

    React.useEffect(
      function () {
        setSearchInput("");
        setSearchQuery("");
        setSel(EMPTY_SEL);
        setShowAllChips(false);
      },
      [category.id]
    );

    React.useEffect(
      function () {
        const timer = window.setTimeout(function () {
          setSearchQuery(searchInput.trim());
        }, SEARCH_DEBOUNCE_MS);
        return function () {
          window.clearTimeout(timer);
        };
      },
      [searchInput]
    );

    const base = items.base || null;
    const hasBase = !!base && (base.tags.length > 0 || base.perfs.length > 0);
    const mainKey = sel.main.join(",");

    React.useEffect(
      function () {
        if (!hasBase || !sel.main.length) return undefined;
        let cancelled = false;
        gqlFetch(MAIN_SCENES_QUERY, {
          x: sceneQuery(category, base, Object.assign({}, EMPTY_SEL, { main: sel.main })).filter,
        })
          .then(function (d) {
            if (!cancelled) {
              setMainCount({ key: mainKey, counts: countChips(d.findScenes.scenes, items.parents, category.subTags) });
            }
          })
          .catch(function (e) {
            // (the chips keep their numbers for the whole category)
            console.error("[Tag Categories] counting the main tag's scenes failed", e);
            if (!cancelled) setMainCount({ key: mainKey, counts: null });
          });
        return function () {
          cancelled = true;
        };
      },
      [mainKey, base, recount]
    );

    const query = hasBase ? sceneQuery(category, base, sel) : null;
    const filter = query ? query.filter : null;
    // excluded tags Stash can't take here (see sceneQuery): the whole list is loaded and they are dropped here
    const local = !!query && query.dropTags.length > 0;
    const sort = SORT_QUERY[sortMode] || SORT_QUERY[SORT_MODES[0]];
    const filterKey = JSON.stringify([filter, local && query.dropTags, searchQuery, sortMode]);
    const page = paging.key === filterKey ? paging.page : 1;

    const { data, loading: serverLoading, error: serverError, refetch } = GQL.useFindScenesQuery({
      skip: !filter || local,
      fetchPolicy: "cache-and-network",
      variables: {
        filter: {
          page: page,
          per_page: PAGE_SIZE,
          sort: sort.sort,
          direction: sort.direction,
          q: searchQuery || undefined,
        },
        scene_filter: filter || undefined,
      },
    });

    React.useEffect(
      function () {
        const found = data && data.findScenes;
        if (!found) return;
        setPages(function (prev) {
          const list = prev.key === filterKey ? Object.assign({}, prev.list) : {};
          list[page] = found.scenes || [];
          return { key: filterKey, list: list, count: found.count, duration: found.duration };
        });
      },
      [data, filterKey, page]
    );

    const [localList, setLocalList] = React.useState({ key: "", scenes: null, error: null });
    const [reloadLocal, setReloadLocal] = React.useState(0);
    React.useEffect(
      function () {
        if (!local) return undefined;
        let cancelled = false;
        gqlFetch(ALL_SCENES_QUERY, {
          f: { per_page: -1, sort: sort.sort, direction: sort.direction, q: searchQuery || undefined },
          x: filter,
        })
          .then(function (d) {
            if (cancelled) return;
            setLocalList({
              key: filterKey,
              scenes: dropScenes(d.findScenes.scenes, query.dropTags, items.parents, category.subTags),
              error: null,
            });
          })
          .catch(function (e) {
            if (!cancelled) setLocalList({ key: filterKey, scenes: null, error: e });
          });
        return function () {
          cancelled = true;
        };
      },
      [filterKey, local, reloadLocal]
    );

    let current;
    let scenes = [];
    let loading;
    let error;
    if (local) {
      const ready = localList.key === filterKey;
      const all = ready ? localList.scenes : null;
      current = {
        list: {},
        count: all ? all.length : null,
        duration: all
          ? all.reduce(function (sum, scene) {
              return sum + (sceneDuration(scene) || 0);
            }, 0)
          : null,
      };
      scenes = all ? all.slice(0, page * PAGE_SIZE) : [];
      loading = !ready;
      error = ready ? localList.error : null;
    } else {
      current = pages.key === filterKey ? pages : { list: {}, count: null, duration: null };
      for (let p = 1; p <= page; p++) {
        if (current.list[p]) scenes = scenes.concat(current.list[p]);
      }
      loading = serverLoading;
      error = serverError;
    }
    const total = current.count;
    const hasMore = total != null && scenes.length < total;

    function loadMore() {
      if (loading || !hasMore || (!local && !current.list[page])) return;
      setPaging({ key: filterKey, page: page + 1 });
    }
    const loadMoreRef = React.useRef(loadMore);
    loadMoreRef.current = loadMore;

    // load the next page shortly before the end of the list is reached
    React.useEffect(
      function () {
        const el = sentinel.current;
        if (!el || typeof IntersectionObserver === "undefined") return undefined;
        const observer = new IntersectionObserver(
          function (entries) {
            if (entries.some(function (e) { return e.isIntersecting; })) loadMoreRef.current();
          },
          { rootMargin: "600px 0px" }
        );
        observer.observe(el);
        return function () {
          observer.disconnect();
        };
      },
      [hasMore, scenes.length, filterKey]
    );

    function refresh() {
      if (local) {
        setLocalList({ key: "", scenes: null, error: null });
        setReloadLocal(reloadLocal + 1);
        setPaging({ key: filterKey, page: 1 });
      } else {
        setPages({ key: "", list: {}, count: null, duration: null });
        if (page === 1) refetch();
        else setPaging({ key: filterKey, page: 1 });
      }
      if (sel.main.length) setRecount(recount + 1);
    }

    function toggleChip(key) {
      setSel(function (s) {
        if (s.main.indexOf(key) >= 0) return Object.assign({}, s, { main: without(s.main, key) });
        if (s.on.indexOf(key) >= 0) return Object.assign({}, s, { on: without(s.on, key) });
        if (s.not.indexOf(key) >= 0) return Object.assign({}, s, { not: without(s.not, key) });
        return Object.assign({}, s, { on: s.on.concat([key]) });
      });
    }

    function excludeChip(key) {
      setSel(function (s) {
        if (s.not.indexOf(key) >= 0) return Object.assign({}, s, { not: without(s.not, key) });
        return Object.assign({}, s, {
          main: without(s.main, key),
          on: without(s.on, key),
          not: s.not.concat([key]),
        });
      });
    }

    function mainChip(key) {
      setSel(function (s) {
        if (s.main.indexOf(key) >= 0) return Object.assign({}, s, { main: without(s.main, key) });
        return Object.assign({}, s, {
          main: s.main.concat([key]),
          on: without(s.on, key),
          not: without(s.not, key),
        });
      });
    }

    if (items.loading) {
      return React.createElement(LoadingIndicator);
    }

    const headLines = [];
    if ((category.tags || []).length) {
      headLines.push(
        t(lang, "tagsLabelShort") +
          " " +
          category.tags.join(", ") +
          (category.subTags ? " " + t(lang, "subTagsShort") : "")
      );
    }
    if ((category.performers || []).length) {
      headLines.push(t(lang, "performersLabelShort") + " " + category.performers.join(", "));
    }
    const tagsLine = headLines.join(" · ");

    if (!hasBase) {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "div",
          { className: "tag-categories-header" },
          React.createElement("h1", null, category.name),
          React.createElement("p", { className: "tag-categories-header-meta text-muted" }, tagsLine)
        ),
        React.createElement(
          "p",
          { className: "tag-categories-error" },
          items.error ||
            t(lang, (category.performers || []).length ? "noResolvedAny" : "noResolvedTags")
        )
      );
    }

    const counting = sel.main.length > 0 && mainCount.key !== mainKey;
    const mainCounts = !counting && sel.main.length ? mainCount.counts : null;
    const crits = stashCriteria(category, base, sel);
    const selecting = sel.main.length > 0 || sel.on.length > 0 || sel.not.length > 0;
    let body;
    if (error && !scenes.length) {
      body = React.createElement("p", { className: "tag-categories-error" }, error.message);
    } else if (total == null) {
      body = React.createElement(LoadingIndicator);
    } else if (total === 0) {
      body = React.createElement(
        "p",
        { className: "tag-categories-empty" },
        t(lang, searchQuery ? "noSearchMatches" : selecting ? "noSelectionMatches" : "noScenes")
      );
    } else {
      body = React.createElement(
        React.Fragment,
        null,
        viewMode === "preview"
          ? React.createElement(ScenePreviewView, { scenes: scenes })
          : React.createElement(SceneListView, { scenes: scenes }),
        hasMore
          ? React.createElement(
              "div",
              { className: "tag-categories-load-more", ref: sentinel },
              loading
                ? React.createElement(LoadingIndicator)
                : React.createElement(
                    Button,
                    { variant: "secondary", size: "sm", onClick: loadMore },
                    t(lang, "loadMore", { shown: formatCount(scenes.length), total: formatCount(total) })
                  )
            )
          : null
      );
    }

    const warnings = [];
    if (items.missing.length) warnings.push(t(lang, "missingTags") + " " + items.missing.join(", "));
    if (items.missingPerformers.length) {
      warnings.push(t(lang, "missingPerformers") + " " + items.missingPerformers.join(", "));
    }

    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "div",
        { className: "tag-categories-header" },
        React.createElement("h1", null, category.name),
        React.createElement("p", { className: "tag-categories-header-meta text-muted" }, tagsLine),
        warnings.length
          ? React.createElement("p", { className: "tag-categories-warning" }, warnings.join(" "))
          : null,
        items.chips.length > 1
          ? React.createElement(TagChips, {
              chips: items.chips,
              names: items.names,
              sel: sel,
              lang: lang,
              mainCounts: mainCounts,
              counting: counting,
              showAll: showAllChips,
              onToggle: toggleChip,
              onExclude: excludeChip,
              onMain: mainChip,
              onMode: function (mode) {
                setSel(function (s) {
                  return Object.assign({}, s, { mode: mode });
                });
              },
              onReset: function () {
                setSel(function (s) {
                  return Object.assign({}, EMPTY_SEL, { mode: s.mode });
                });
              },
              onToggleAll: function () {
                setShowAllChips(!showAllChips);
              },
            })
          : null,
        React.createElement(
          "div",
          { className: "tag-categories-header-actions mt-2" },
          React.createElement(
            "div",
            { className: "tag-categories-search" },
            React.createElement("input", {
              type: "search",
              className: "form-control form-control-sm tag-categories-search-input",
              value: searchInput,
              placeholder: t(lang, "searchPlaceholder"),
              "aria-label": t(lang, "searchPlaceholder"),
              onChange: function (e) {
                setSearchInput(e.target.value);
              },
            }),
            searchInput
              ? React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "tag-categories-search-clear",
                    title: t(lang, "searchClear"),
                    "aria-label": t(lang, "searchClear"),
                    onClick: function () {
                      setSearchInput("");
                      setSearchQuery("");
                    },
                  },
                  "×"
                )
              : null
          ),
          React.createElement(
            "label",
            { className: "tag-categories-sort", htmlFor: "tc-sort-mode" },
            React.createElement(
              "select",
              {
                id: "tc-sort-mode",
                className: "form-control form-control-sm",
                value: sortMode,
                "aria-label": t(lang, "sortLabel"),
                title: t(lang, "sortLabel"),
                onChange: function (e) {
                  setAndStoreSortMode(e.target.value);
                },
              },
              [
                ["title-asc", "sortTitleAsc"],
                ["title-desc", "sortTitleDesc"],
                ["duration-desc", "sortDurationDesc"],
                ["duration-asc", "sortDurationAsc"],
                ["date-desc", "sortDateDesc"],
                ["date-asc", "sortDateAsc"],
              ].map(function (o) {
                return React.createElement("option", { key: o[0], value: o[0] }, t(lang, o[1]));
              })
            )
          ),
          React.createElement(
            "div",
            {
              className: "btn-group tag-categories-view-toggle",
              role: "group",
              "aria-label": t(lang, "viewModeLabel"),
            },
            ["list", "preview"].map(function (mode) {
              return React.createElement(
                "button",
                {
                  key: mode,
                  type: "button",
                  className: "btn btn-sm " + (viewMode === mode ? "btn-primary" : "btn-secondary"),
                  "aria-pressed": viewMode === mode,
                  onClick: function () {
                    setAndStoreViewMode(mode);
                  },
                },
                t(lang, mode === "list" ? "viewList" : "viewPreview")
              );
            })
          ),
          React.createElement(
            Button,
            { variant: "secondary", size: "sm", onClick: refresh },
            t(lang, "refresh")
          ),
          crits
            ? React.createElement(
                Link,
                {
                  to: stashScenesUrl(crits, items.names, searchQuery, sortMode),
                  className: "btn btn-secondary btn-sm tag-categories-open-stash",
                  title: t(lang, "openInStashTitle"),
                },
                t(lang, "openInStash")
              )
            : React.createElement(
                "span",
                {
                  className: "btn btn-secondary btn-sm tag-categories-open-stash disabled",
                  "aria-disabled": true,
                  title: t(lang, "openInStashNo"),
                },
                t(lang, "openInStash")
              ),
          loading && total != null && page === 1
            ? React.createElement("span", { className: "tag-categories-refreshing text-muted" }, t(lang, "updating"))
            : null
        )
      ),
      React.createElement(
        "h2",
        { className: "tag-categories-section-title" },
        t(lang, "scenesTitle") +
          (total != null ? " (" + formatCount(total) + ")" : ""),
        total && current.duration
          ? React.createElement(
              "span",
              { className: "tag-categories-section-meta text-muted" },
              t(lang, "totalDuration", { d: formatDuration(current.duration) })
            )
          : null
      ),
      body
    );
  }

  // Number of scenes of a category, shown in the sidebar (count only, per_page 0)
  function CategoryNavCount(props) {
    const category = props.category;
    const resolveTags = useResolveTags();
    const [base, setBase] = React.useState(null);

    React.useEffect(
      function () {
        let cancelled = false;
        Promise.all([resolveTags(category.tags || [], false), resolvePerformers(category.performers || [])])
          .then(function (res) {
            if (!cancelled) setBase({ tags: ids(res[0].tags), perfs: ids(res[1].performers) });
          })
          .catch(function () {
            if (!cancelled) setBase({ tags: [], perfs: [] });
          });
        return function () {
          cancelled = true;
        };
      },
      [category.id, category.tags, category.performers, resolveTags]
    );

    const empty = !!base && !base.tags.length && !base.perfs.length;
    const { data } = GQL.useFindScenesQuery({
      skip: !base || empty,
      fetchPolicy: "cache-and-network",
      variables: {
        filter: { per_page: 0 },
        scene_filter: base && !empty ? sceneQuery(category, base, EMPTY_SEL).filter : undefined,
      },
    });
    const count = data && data.findScenes ? data.findScenes.count : null;
    if (empty) return React.createElement("span", { className: "tag-categories-nav-count" }, "–");
    if (count == null) return null;
    return React.createElement("span", { className: "tag-categories-nav-count" }, formatCount(count));
  }

  function TagCategoriesPage() {
    const location = useLocation();
    const goTo = usePluginNavigate();
    const { config, error, loading, lang } = useCategoryConfig();
    const LoadingIndicator =
      (PluginApi.components && PluginApi.components.LoadingIndicator) || "div";

    const params = new URLSearchParams(location.search || "");
    const categoryParam = params.get("category");
    const categories = config.categories || [];

    const selectedId = React.useMemo(
      function () {
        if (
          categoryParam &&
          categories.some(function (c) {
            return c.id === categoryParam;
          })
        ) {
          return categoryParam;
        }
        return categories.length ? categories[0].id : null;
      },
      [categoryParam, categories]
    );

    const selected = categories.find(function (c) {
      return c.id === selectedId;
    });

    function selectCategory(id) {
      const q = new URLSearchParams();
      q.set("category", id);
      goTo(ROUTE_PATH + "?" + q.toString());
    }

    if (loading) {
      return React.createElement(
        "div",
        { className: "container-fluid p-3" },
        React.createElement(LoadingIndicator)
      );
    }

    return React.createElement(
      "div",
      { className: "tag-categories-page" },
      React.createElement(
        "nav",
        { className: "tag-categories-nav", "aria-label": t(lang, "pageNavTitle") },
        React.createElement("h2", null, t(lang, "pageNavTitle")),
        categories.map(function (category) {
          return React.createElement(
            "button",
            {
              key: category.id,
              type: "button",
              className:
                "tag-categories-nav-btn" +
                (category.id === selectedId ? " active" : ""),
              onClick: function () {
                selectCategory(category.id);
              },
              title: categoryLine(category, lang),
            },
            React.createElement(
              "span",
              { className: "tag-categories-nav-name" },
              React.createElement("span", null, category.name),
              React.createElement(CategoryNavCount, { category: category })
            ),
            React.createElement(
              "span",
              { className: "tag-categories-nav-tags" },
              categoryLine(category, lang)
            )
          );
        })
      ),
      React.createElement(
        "main",
        { className: "tag-categories-main" },
        error
          ? React.createElement(
              "p",
              { className: "tag-categories-error" },
              error
            )
          : !categories.length
            ? React.createElement(
                "p",
                { className: "tag-categories-empty" },
                t(lang, "pageEmptyConfig")
              )
            : selected
              ? React.createElement(CategoryScenesPanel, {
                  category: selected,
                  lang: lang,
                })
              : React.createElement(
                  "p",
                  { className: "tag-categories-hint" },
                  t(lang, "pageSelectHint")
                )
      )
    );
  }

  PluginApi.register.route(ROUTE_PATH, TagCategoriesPage);

  function LegacyTagCategoriesRedirect() {
    const location = useLocation();
    const goTo = usePluginNavigate();
    React.useEffect(
      function () {
        const search = (location && location.search) || "";
        goTo(ROUTE_PATH + search);
      },
      [goTo, location]
    );
    return null;
  }

  PluginApi.register.route(LEGACY_ROUTE_PATH, LegacyTagCategoriesRedirect);

  function isCategoriesPath(pathname) {
    const p = String(pathname || "");
    return (
      p === ROUTE_PATH ||
      p.indexOf(ROUTE_PATH + "/") === 0 ||
      p === LEGACY_ROUTE_PATH ||
      p.indexOf(LEGACY_ROUTE_PATH + "/") === 0
    );
  }

  function CategoriesNavMenuItem() {
    // No GQL in the shell — usePluginLang() would query config on every page.
    const location = useLocation();
    const pathname =
      (location && location.pathname) ||
      (typeof window !== "undefined" && window.location.pathname) ||
      "";
    const isActive = isCategoriesPath(pathname);
    const components = PluginApi.components || {};
    const Icon = components.Icon;
    const faTags =
      faSolid.faTags || faSolid.faTag || faSolid.faFolder || faSolid.faHome;
    const useIcon = !!(Icon && faTags && typeof faTags === "object");
    const navLang = getUiLang({
      language:
        (typeof navigator !== "undefined" && navigator.language) || "en",
    });
    const label = React.createElement("span", null, t(navLang, "navLabel"));
    const iconEl = useIcon
      ? React.createElement(Icon, {
          icon: faTags,
          className: "nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0",
        })
      : null;

    return React.createElement(
      Nav.Link,
      {
        as: "div",
        eventKey: ROUTE_PATH,
        key: "tag-categories-nav",
        className: "col-4 col-sm-3 col-md-2 col-lg-auto",
      },
      React.createElement(
        Link,
        { to: ROUTE_PATH, className: "tag-categories-nav-link-wrap" },
        React.createElement(
          Button,
          {
            className:
              "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center" +
              (isActive ? " active" : ""),
          },
          iconEl,
          label
        )
      )
    );
  }

  PluginApi.patch.before("MainNavBar.MenuItems", function (props) {
    try {
      return [
        {
          children: React.createElement(
            React.Fragment,
            null,
            props && props.children,
            React.createElement(
              PatchErrorBoundary,
              null,
              React.createElement(CategoriesNavMenuItem, null)
            )
          ),
        },
      ];
    } catch (e) {
      console.error("[Tag Categories] MainNavBar.MenuItems patch failed", e);
      return [props || {}];
    }
  });

  // ---------- Settings page ----------
  // settings.js draws it (the same module as in Stash UI); this only connects it to classic Stash.

  const SETTINGS_URL = "/plugin/" + PLUGIN_ID + "/assets/settings.js?v=" + PLUGIN_VERSION;

  // Inside Stash UI's plugin host (its Plugins page) the settings take Stash UI's look
  function isStashUiHost() {
    const app = document.getElementById("app");
    return !!(app && app.classList.contains("kb-app"));
  }

  function TagCategoriesSettings() {
    const settingsApi =
      PluginApi.hooks && typeof PluginApi.hooks.useSettings === "function"
        ? PluginApi.hooks.useSettings()
        : { plugins: {}, savePluginSettings: function () {}, loading: false, interface: null };
    const toastApi =
      PluginApi.hooks && typeof PluginApi.hooks.useToast === "function"
        ? PluginApi.hooks.useToast()
        : null;
    const ref = React.useRef(null);
    // The module keeps running across renders; it reads the newest settings and toast from here
    const latest = React.useRef(null);
    latest.current = { settings: settingsApi, toast: toastApi };
    const loading = settingsApi.loading;

    React.useEffect(
      function () {
        if (loading || !ref.current) return;
        const el = ref.current;
        let handle = null;
        let cancelled = false;
        const iface = settingsApi.interface;
        import(SETTINGS_URL)
          .then(function (mod) {
            if (cancelled) return;
            handle = mod.mountSettings(el, {
              theme: isStashUiHost() ? "stashui" : "classic",
              lang: iface ? getUiLang(iface) : getUiLang({ language: navigator.language }),
              version: PLUGIN_VERSION,
              gql: gqlFetch,
              toast: function (text, kind) {
                const api = latest.current.toast;
                if (api && kind === "error" && api.error) api.error(text);
                else if (api && api.success) api.success(text);
                else console.info("[Tag Categories]", text);
              },
              load: async function () {
                const fromSettings = getConfigFromSettings(latest.current.settings.plugins);
                if (fromSettings) return { config: fromSettings, source: "settings" };
                const fromFile = await loadCategoriesFromFile();
                if (fromFile) return { config: fromFile, source: "file" };
                return { config: DEFAULT_CONFIG, source: "defaults" };
              },
              save: async function (config) {
                latest.current.settings.savePluginSettings(PLUGIN_ID, {
                  categoriesJson: categoriesToJson(config),
                });
                clearTagCaches();
              },
              parseJson: parseCategoriesJson,
              toJson: categoriesToJson,
            });
          })
          .catch(function (e) {
            console.error("[Tag Categories] settings.js not loaded", e);
            if (!cancelled) el.textContent = "Tag Categories: the settings could not be loaded (" + (e.message || String(e)) + ").";
          });
        return function () {
          cancelled = true;
          if (handle) handle.destroy();
        };
      },
      [loading]
    );

    return React.createElement("div", { ref: ref, className: "plugin-settings tag-categories-settings" });
  }

  PluginApi.patch.instead("PluginSettings", function () {
    var args = Array.prototype.slice.call(arguments);
    var next = args.pop();
    var props = args[0];
    try {
      if (!props || props.pluginID !== PLUGIN_ID) {
        return next.apply(null, args);
      }
      if (
        !PluginApi.hooks ||
        typeof PluginApi.hooks.useSettings !== "function"
      ) {
        return next.apply(null, args);
      }
      return React.createElement(
        PatchErrorBoundary,
        null,
        React.createElement(TagCategoriesSettings, null)
      );
    } catch (e) {
      console.error("[Tag Categories] PluginSettings patch failed", e);
      return next.apply(null, args);
    }
  });
})();
