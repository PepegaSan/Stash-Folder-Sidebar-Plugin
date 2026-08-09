(function () {
  "use strict";

  const PLUGIN_ID = "tagCategories";
  const PLUGIN_VERSION = "1.2.1";
  const ROUTE_PATH = "/plugin/tag-categories";
  const ASSETS_CATEGORIES = "/plugin/" + PLUGIN_ID + "/assets/categories.json";
  const VIEW_MODE_STORAGE_KEY = "tagCategories.viewMode";
  const VIEW_MODES = ["list", "preview"];

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

  const DEFAULT_CONFIG = {
    categories: [],
  };

  const I18N = {
    en: {
      navLabel: "Categories",
      versionLine:
        "Tag Categories v" +
        PLUGIN_VERSION +
        " — if you do not see this version, Stash is still using old plugin files.",
      intro:
        "Define named categories with comma-separated tags. Open Categories in the main menu, click a category, and see every scene that has any of those tags.",
      loadedFromFile: "Loaded from",
      loadedFromFileSuffix: ". Saving here overrides the file.",
      usingDefaultsPrefix: "Using built-in defaults (no",
      usingDefaultsSuffix:
        "yet). Add a category or save JSON to store settings in Stash. Optional: copy",
      usingDefaultsArrow: "→",
      usingDefaultsInFolder: "in the plugin folder.",
      categories: "Categories",
      emptyCategories: "No categories yet.",
      colName: "Name",
      colTags: "Tags",
      edit: "Edit",
      delete: "Delete",
      addCategory: "Add category",
      editCategory: "Edit category",
      editing: "Editing:",
      nameLabel: "Category name",
      namePlaceholder: "e.g. Genre",
      tagsLabel: "Tags (comma-separated)",
      tagsPlaceholder: "Action, Comedy, Drama",
      tagsHelp:
        "Comma-separated tag names, exactly as in Stash under Tags. Scenes matching any of these tags are shown when you open the category.",
      add: "Add",
      saveChanges: "Save changes",
      cancel: "Cancel",
      editJson: "Edit JSON (advanced)…",
      helpJson: "Help: categories JSON",
      jsonModalTitle: "Edit categories (JSON)",
      jsonModalHint:
        "categories array: name, tags. Optional id = fixed browser URL.",
      close: "Close",
      save: "Save",
      nameRequired: "Category name is required.",
      tagsRequired: "Enter at least one tag (comma-separated).",
      categoryNotFound: "Category not found.",
      categoryAdded: "Category added.",
      categoryUpdated: "Category updated.",
      categoryRemoved: "Category removed.",
      removeConfirm: 'Remove category "{name}"?',
      jsonSaved: "JSON saved.",
      jsonInvalid: "JSON must include a categories array.",
      pageNavTitle: "Categories",
      pageEmptyConfig:
        "No categories configured. Add some under Settings → Plugins → Tag Categories.",
      pageSelectHint: "Select a category to list matching scenes.",
      scenesTitle: "Scenes",
      noScenes: "No scenes match any of these tags.",
      missingTags: "These tags were not found in Stash and were skipped:",
      noResolvedTags: "None of the category tags exist in Stash yet.",
      refresh: "Refresh",
      updating: "Updating…",
      tagsLabelShort: "Tags:",
      viewList: "List",
      viewPreview: "Preview",
      viewModeLabel: "View",
      helpTitle: "Categories in JSON",
      helpIntro:
        "How to define categories in the JSON editor. Settings are stored in the Stash database (plugin settings). Each category is a filter: scenes that have any of the listed tags.",
      helpStep1:
        "In these plugin settings, click Edit JSON (advanced) (button at the bottom of this page).",
      helpStep2:
        "Edit the categories array: each entry needs a name and a tags array of exact Stash tag names.",
      helpStep3:
        "Open Categories in the main menu and click a category to load matching scenes.",
      helpId: "id — for a fixed URL in the browser (optional; otherwise made from the name).",
      helpSave:
        "Click Save in the JSON dialog, then Reload plugins / Reload UI if the menu page does not update.",
      helpWarning:
        "Matching is OR: a scene appears if it has at least one of the category tags. Tag names must match Stash exactly (case-insensitive lookup).",
      helpOk: "OK",
    },
    de: {
      navLabel: "Kategorien",
      versionLine:
        "Tag Categories v" +
        PLUGIN_VERSION +
        " — wenn diese Version fehlt, nutzt Stash noch alte Plugin-Dateien.",
      intro:
        "Kategorien mit komma-getrennten Tags anlegen. Im Hauptmenü Kategorien öffnen, eine Kategorie anklicken — dann erscheinen alle Szenen, die eines dieser Tags haben.",
      loadedFromFile: "Geladen aus",
      loadedFromFileSuffix: ". Speichern hier überschreibt die Datei.",
      usingDefaultsPrefix: "Eingebaute Defaults (keine",
      usingDefaultsSuffix:
        "vorhanden). Kategorie hinzufügen oder JSON speichern, um Einstellungen in Stash zu sichern. Optional:",
      usingDefaultsArrow: "→",
      usingDefaultsInFolder: "im Plugin-Ordner kopieren.",
      categories: "Kategorien",
      emptyCategories: "Noch keine Kategorien.",
      colName: "Name",
      colTags: "Tags",
      edit: "Bearbeiten",
      delete: "Löschen",
      addCategory: "Kategorie hinzufügen",
      editCategory: "Kategorie bearbeiten",
      editing: "Bearbeitung:",
      nameLabel: "Kategoriename",
      namePlaceholder: "z. B. Genre",
      tagsLabel: "Tags (komma-getrennt)",
      tagsPlaceholder: "Action, Comedy, Drama",
      tagsHelp:
        "Komma-getrennte Tag-Namen, exakt wie unter Tags in Stash. Beim Öffnen der Kategorie erscheinen Szenen mit einem dieser Tags.",
      add: "Hinzufügen",
      saveChanges: "Änderungen speichern",
      cancel: "Abbrechen",
      editJson: "JSON bearbeiten (erweitert)…",
      helpJson: "Hilfe: Kategorien-JSON",
      jsonModalTitle: "Kategorien bearbeiten (JSON)",
      jsonModalHint:
        "categories-Array: name, tags. Optionale id = feste URL im Browser.",
      close: "Schließen",
      save: "Speichern",
      nameRequired: "Kategoriename ist erforderlich.",
      tagsRequired: "Mindestens einen Tag eintragen (komma-getrennt).",
      categoryNotFound: "Kategorie nicht gefunden.",
      categoryAdded: "Kategorie hinzugefügt.",
      categoryUpdated: "Kategorie aktualisiert.",
      categoryRemoved: "Kategorie entfernt.",
      removeConfirm: 'Kategorie "{name}" entfernen?',
      jsonSaved: "JSON gespeichert.",
      jsonInvalid: "JSON muss ein categories-Array enthalten.",
      pageNavTitle: "Kategorien",
      pageEmptyConfig:
        "Keine Kategorien konfiguriert. Anlegen unter Settings → Plugins → Tag Categories.",
      pageSelectHint: "Kategorie wählen, um passende Szenen anzuzeigen.",
      scenesTitle: "Szenen",
      noScenes: "Keine Szenen mit einem dieser Tags.",
      missingTags: "Diese Tags gibt es in Stash nicht und wurden übersprungen:",
      noResolvedTags: "Keiner der Kategorie-Tags existiert bisher in Stash.",
      refresh: "Aktualisieren",
      updating: "Aktualisiere…",
      tagsLabelShort: "Tags:",
      viewList: "Liste",
      viewPreview: "Vorschau",
      viewModeLabel: "Ansicht",
      helpTitle: "Kategorien im JSON",
      helpIntro:
        "So legst du Kategorien im JSON-Editor an. Gespeichert wird in der Stash-Datenbank. Jede Kategorie ist ein Filter: Szenen mit mindestens einem der genannten Tags.",
      helpStep1:
        "In diesen Plugin-Settings auf JSON bearbeiten (erweitert) klicken (Button unten).",
      helpStep2:
        "Im Array categories Einträge mit name und tags (exakte Stash-Tag-Namen) setzen.",
      helpStep3:
        "Im Hauptmenü Kategorien öffnen und eine Kategorie anklicken, um passende Szenen zu laden.",
      helpId: "id — für eine feste URL im Browser (optional; sonst aus dem Namen).",
      helpSave:
        "Im JSON-Dialog Speichern — danach ggf. Reload plugins / Reload UI.",
      helpWarning:
        "ODER-Logik: Eine Szene erscheint, wenn sie mindestens eines der Tags hat. Tag-Namen müssen zu Stash passen (Suche ohne Groß-/Kleinschreibung).",
      helpOk: "OK",
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
    return { id: id, name: name, tags: tags };
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
          return {
            id: c.id,
            name: c.name,
            tags: c.tags || [],
          };
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

  const tagIdCache = new Map();

  function useResolveTagIds() {
    const [findTags] = GQL.useFindTagsLazyQuery({ fetchPolicy: "cache-first" });
    const equalsModifier =
      GQL.CriterionModifier && GQL.CriterionModifier.Equals
        ? GQL.CriterionModifier.Equals
        : "EQUALS";
    const includesModifier =
      GQL.CriterionModifier && GQL.CriterionModifier.Includes
        ? GQL.CriterionModifier.Includes
        : "INCLUDES";

    return React.useCallback(
      async function resolveTagNames(tagNames) {
        const ids = [];
        const missing = [];
        for (let i = 0; i < tagNames.length; i++) {
          const tagName = tagNames[i];
          const key = tagName.toLowerCase();
          if (tagIdCache.has(key)) {
            ids.push(tagIdCache.get(key));
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

          let result = await queryTags(equalsModifier);
          let tags =
            result.data && result.data.findTags && result.data.findTags.tags;
          if (!tags || !tags.length) {
            result = await queryTags(includesModifier);
            tags =
              result.data && result.data.findTags && result.data.findTags.tags;
          }
          const exact =
            (tags &&
              tags.find(function (tag) {
                return tag.name.toLowerCase() === key;
              })) ||
            null;
          if (exact) {
            tagIdCache.set(key, exact.id);
            ids.push(exact.id);
          } else {
            missing.push(tagName);
          }
        }
        return { ids: ids, missing: missing };
      },
      [findTags, equalsModifier, includesModifier]
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

  function CategoryScenesPanel(props) {
    const { category, lang } = props;
    const { LoadingIndicator } = PluginApi.components;
    const resolveTagNames = useResolveTagIds();
    const [viewMode, setViewMode] = React.useState(readStoredViewMode);
    const [tagState, setTagState] = React.useState({
      ids: null,
      missing: [],
      loading: true,
    });

    const includesModifier =
      GQL.CriterionModifier && GQL.CriterionModifier.Includes
        ? GQL.CriterionModifier.Includes
        : "INCLUDES";

    function setAndStoreViewMode(mode) {
      const next = normalizeViewMode(mode);
      setViewMode(next);
      storeViewMode(next);
    }

    React.useEffect(
      function () {
        let cancelled = false;
        setTagState({ ids: null, missing: [], loading: true });
        resolveTagNames(category.tags || []).then(function (result) {
          if (!cancelled) {
            setTagState({
              ids: result.ids,
              missing: result.missing,
              loading: false,
            });
          }
        });
        return function () {
          cancelled = true;
        };
      },
      [category.id, category.tags, resolveTagNames]
    );

    const skip =
      tagState.loading || !tagState.ids || tagState.ids.length === 0;

    const { data, loading, error, refetch } = GQL.useFindScenesQuery({
      skip: skip,
      fetchPolicy: "cache-and-network",
      variables: {
        filter: {
          per_page: -1,
          sort: "title",
          direction: "ASC",
        },
        scene_filter: {
          tags: {
            value: tagState.ids || [],
            modifier: includesModifier,
            depth: 0,
          },
        },
      },
    });

    if (tagState.loading) {
      return React.createElement(LoadingIndicator);
    }

    if (!tagState.ids || !tagState.ids.length) {
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "div",
          { className: "tag-categories-header" },
          React.createElement("h1", null, category.name),
          React.createElement(
            "p",
            { className: "tag-categories-header-meta text-muted" },
            t(lang, "tagsLabelShort") + " " + (category.tags || []).join(", ")
          )
        ),
        React.createElement(
          "p",
          { className: "tag-categories-error" },
          t(lang, "noResolvedTags")
        )
      );
    }

    const scenes =
      data && data.findScenes && data.findScenes.scenes
        ? data.findScenes.scenes
        : [];
    const count =
      data && data.findScenes && data.findScenes.count != null
        ? data.findScenes.count
        : scenes.length;
    const showFullLoading = loading && !data;
    const isRefreshing = loading && !!data;

    if (showFullLoading) {
      return React.createElement(LoadingIndicator);
    }

    if (error && !scenes.length) {
      return React.createElement(
        "p",
        { className: "tag-categories-error" },
        error.message
      );
    }

    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "div",
        { className: "tag-categories-header" },
        React.createElement("h1", null, category.name),
        React.createElement(
          "p",
          { className: "tag-categories-header-meta text-muted" },
          t(lang, "tagsLabelShort") + " " + (category.tags || []).join(", ")
        ),
        tagState.missing.length
          ? React.createElement(
              "p",
              { className: "tag-categories-warning" },
              t(lang, "missingTags") + " " + tagState.missing.join(", ")
            )
          : null,
        React.createElement(
          "div",
          { className: "tag-categories-header-actions mt-2" },
          React.createElement(
            "div",
            {
              className: "btn-group tag-categories-view-toggle",
              role: "group",
              "aria-label": t(lang, "viewModeLabel"),
            },
            React.createElement(
              "button",
              {
                type: "button",
                className:
                  "btn btn-sm " +
                  (viewMode === "list" ? "btn-primary" : "btn-secondary"),
                "aria-pressed": viewMode === "list",
                onClick: function () {
                  setAndStoreViewMode("list");
                },
              },
              t(lang, "viewList")
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className:
                  "btn btn-sm " +
                  (viewMode === "preview" ? "btn-primary" : "btn-secondary"),
                "aria-pressed": viewMode === "preview",
                onClick: function () {
                  setAndStoreViewMode("preview");
                },
              },
              t(lang, "viewPreview")
            )
          ),
          React.createElement(
            Button,
            {
              variant: "secondary",
              size: "sm",
              onClick: function () {
                refetch({ fetchPolicy: "network-only" });
              },
            },
            t(lang, "refresh")
          ),
          isRefreshing
            ? React.createElement(
                "span",
                { className: "tag-categories-refreshing text-muted" },
                t(lang, "updating")
              )
            : null
        )
      ),
      React.createElement(
        "h2",
        { className: "tag-categories-section-title" },
        t(lang, "scenesTitle") + " (" + count + ")"
      ),
      scenes.length === 0
        ? React.createElement(
            "p",
            { className: "tag-categories-empty" },
            t(lang, "noScenes")
          )
        : viewMode === "preview"
          ? React.createElement(ScenePreviewView, { scenes: scenes })
          : React.createElement(SceneListView, { scenes: scenes })
    );
  }

  function TagCategoriesPage() {
    const location = useLocation();
    const history = useHistory();
    const { config, error, loading, lang } = useCategoryConfig();
    const { LoadingIndicator } = PluginApi.components;

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
      history.push(ROUTE_PATH + "?" + q.toString());
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
              title: (category.tags || []).join(", "),
            },
            category.name,
            React.createElement(
              "span",
              { className: "tag-categories-nav-tags" },
              (category.tags || []).join(", ")
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

  function CategoriesNavMenuItem() {
    try {
      if (typeof useLocation !== "function" || !Link || !Button || !Nav || !Nav.Link) {
        return null;
      }
      const location = useLocation();
      const lang = usePluginLang();
      const components = PluginApi.components || {};
      const Icon = components.Icon;
      const faTags =
        faSolid.faTags || faSolid.faTag || faSolid.faFolder || faSolid.faHome;
      const pathname =
        (location && location.pathname) ||
        (typeof window !== "undefined" && window.location.pathname) ||
        "";
      const isActive =
        pathname === ROUTE_PATH || pathname.indexOf(ROUTE_PATH + "/") === 0;
      const label = React.createElement("span", null, t(lang, "navLabel"));
      const iconEl =
        Icon && faTags
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
    } catch (e) {
      console.error("[Tag Categories] CategoriesNavMenuItem failed", e);
      return null;
    }
  }

  PluginApi.patch.before("MainNavBar.MenuItems", function (props) {
    try {
      return [
        {
          children: React.createElement(
            React.Fragment,
            null,
            props && props.children,
            React.createElement(CategoriesNavMenuItem, null)
          ),
        },
      ];
    } catch (e) {
      console.error("[Tag Categories] MainNavBar.MenuItems patch failed", e);
      return [props || {}];
    }
  });

  function HelpModal(props) {
    if (!props.open) return null;
    const lang = props.lang;
    return React.createElement(
      "div",
      {
        className: "tag-categories-modal-backdrop",
        role: "presentation",
        onClick: props.onClose,
      },
      React.createElement(
        "div",
        {
          className: "tag-categories-modal tag-categories-help-modal",
          role: "dialog",
          "aria-modal": true,
          "aria-labelledby": "tc-help-title",
          onClick: function (e) {
            e.stopPropagation();
          },
        },
        React.createElement(
          "div",
          { className: "tag-categories-modal-header" },
          React.createElement(
            "h3",
            { id: "tc-help-title", className: "tag-categories-modal-title" },
            t(lang, "helpTitle")
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "tag-categories-modal-close",
              "aria-label": t(lang, "close"),
              onClick: props.onClose,
            },
            "×"
          )
        ),
        React.createElement(
          "div",
          { className: "tag-categories-modal-body tag-categories-help-body" },
          React.createElement("p", null, t(lang, "helpIntro")),
          React.createElement(
            "ol",
            { className: "tag-categories-help-steps" },
            React.createElement("li", null, t(lang, "helpStep1")),
            React.createElement("li", null, t(lang, "helpStep2")),
            React.createElement("li", null, t(lang, "helpStep3"))
          ),
          React.createElement(
            "pre",
            { className: "tag-categories-help-code" },
            '{\n  "categories": [\n    {\n      "id": "genre",\n      "name": "Genre",\n      "tags": ["Action", "Comedy"]\n    }\n  ]\n}'
          ),
          React.createElement("p", null, t(lang, "helpId")),
          React.createElement("p", null, t(lang, "helpSave")),
          React.createElement(
            "p",
            { className: "text-muted small mb-0" },
            t(lang, "helpWarning")
          )
        ),
        React.createElement(
          "div",
          { className: "tag-categories-modal-footer" },
          React.createElement(
            "button",
            {
              type: "button",
              className: "btn btn-primary",
              onClick: props.onClose,
            },
            t(lang, "helpOk")
          )
        )
      )
    );
  }

  function TagCategoriesSettings() {
    const { plugins, savePluginSettings, loading, interface: iface } =
      PluginApi.hooks.useSettings();
    const Toast = PluginApi.hooks.useToast();
    const lang = getUiLang(iface);

    const [config, setConfig] = React.useState(DEFAULT_CONFIG);
    const [usingFile, setUsingFile] = React.useState(false);
    const [usingDefaults, setUsingDefaults] = React.useState(false);
    const [loadError, setLoadError] = React.useState(null);

    const [showCategoryList, setShowCategoryList] = React.useState(false);
    const [showAddForm, setShowAddForm] = React.useState(false);
    const [showJsonModal, setShowJsonModal] = React.useState(false);
    const [showHelpModal, setShowHelpModal] = React.useState(false);
    const [jsonModalDraft, setJsonModalDraft] = React.useState("");

    const [editingId, setEditingId] = React.useState(null);
    const [newName, setNewName] = React.useState("");
    const [newTags, setNewTags] = React.useState("");

    function resetForm() {
      setEditingId(null);
      setNewName("");
      setNewTags("");
    }

    function fillForm(category) {
      setEditingId(category.id);
      setNewName(category.name || "");
      setNewTags(
        category.tags && category.tags.length ? category.tags.join(", ") : ""
      );
    }

    React.useEffect(
      function () {
        if (loading) return;
        let cancelled = false;
        async function load() {
          setLoadError(null);
          try {
            const fromSettings = getConfigFromSettings(plugins);
            if (fromSettings) {
              if (!cancelled) {
                setConfig(fromSettings);
                setUsingFile(false);
                setUsingDefaults(false);
              }
              return;
            }
            const fromFile = await loadCategoriesFromFile();
            if (!cancelled) {
              if (fromFile) {
                setConfig(fromFile);
                setUsingFile(true);
                setUsingDefaults(false);
              } else {
                setConfig(DEFAULT_CONFIG);
                setUsingFile(false);
                setUsingDefaults(true);
              }
            }
          } catch (e) {
            if (!cancelled) {
              setLoadError(e.message || String(e));
              setConfig(DEFAULT_CONFIG);
              setUsingFile(false);
              setUsingDefaults(true);
            }
          }
        }
        load();
        return function () {
          cancelled = true;
        };
      },
      [plugins, loading]
    );

    function persistConfig(updates) {
      const nextConfig = Object.assign(
        { categories: config.categories },
        updates
      );
      savePluginSettings(PLUGIN_ID, {
        categoriesJson: categoriesToJson(nextConfig),
      });
      setConfig(nextConfig);
      setUsingFile(false);
      setUsingDefaults(false);
      tagIdCache.clear();
    }

    function openJsonModal() {
      setJsonModalDraft(categoriesToJson(config));
      setShowJsonModal(true);
    }

    function closeJsonModal() {
      setShowJsonModal(false);
    }

    function onSaveJsonModal() {
      try {
        const parsed = parseCategoriesJson(jsonModalDraft);
        persistConfig(parsed);
        setShowJsonModal(false);
        Toast.success(t(lang, "jsonSaved"));
      } catch (e) {
        Toast.error(e.message || t(lang, "jsonInvalid"));
      }
    }

    function onSaveCategory() {
      const name = newName.trim();
      const tags = uniqueStrings(parseTagsList(newTags));
      if (!name) {
        Toast.error(t(lang, "nameRequired"));
        return;
      }
      if (!tags.length) {
        Toast.error(t(lang, "tagsRequired"));
        return;
      }

      if (editingId != null) {
        const idx = config.categories.findIndex(function (c) {
          return c.id === editingId;
        });
        if (idx < 0) {
          Toast.error(t(lang, "categoryNotFound"));
          resetForm();
          setShowAddForm(false);
          return;
        }
        const categories = config.categories.map(function (c, i) {
          if (i !== idx) return c;
          return { id: c.id, name: name, tags: tags };
        });
        persistConfig({ categories: categories });
        resetForm();
        setShowAddForm(false);
        Toast.success(t(lang, "categoryUpdated"));
        return;
      }

      const id = slugId(name);
      let uniqueId = id;
      let n = 2;
      while (
        config.categories.some(function (c) {
          return c.id === uniqueId;
        })
      ) {
        uniqueId = id + "-" + n;
        n += 1;
      }
      persistConfig({
        categories: config.categories.concat([
          { id: uniqueId, name: name, tags: tags },
        ]),
      });
      resetForm();
      setShowAddForm(false);
      Toast.success(t(lang, "categoryAdded"));
    }

    function onEditCategory(category) {
      fillForm(category);
      setShowAddForm(true);
      setShowCategoryList(true);
    }

    function onCancelForm() {
      resetForm();
      setShowAddForm(false);
    }

    function onRemoveCategory(category) {
      const message = t(lang, "removeConfirm", { name: category.name });
      if (!window.confirm(message)) return;
      const categories = config.categories.filter(function (c) {
        return c.id !== category.id;
      });
      if (editingId === category.id) {
        resetForm();
        setShowAddForm(false);
      }
      persistConfig({ categories: categories });
      Toast.success(t(lang, "categoryRemoved"));
    }

    return React.createElement(
      "div",
      { className: "plugin-settings tag-categories-settings" },
      React.createElement(
        "p",
        { className: "tag-categories-settings-version text-muted" },
        t(lang, "versionLine")
      ),
      React.createElement(
        "p",
        { className: "tag-categories-settings-intro text-muted" },
        t(lang, "intro")
      ),
      React.createElement(HelpModal, {
        open: showHelpModal,
        lang: lang,
        onClose: function () {
          setShowHelpModal(false);
        },
      }),
      usingFile
        ? React.createElement(
            "p",
            { className: "tag-categories-settings-note text-muted" },
            t(lang, "loadedFromFile") + " ",
            React.createElement("code", null, "categories.json"),
            t(lang, "loadedFromFileSuffix")
          )
        : usingDefaults
          ? React.createElement(
              "p",
              { className: "tag-categories-settings-note text-muted" },
              t(lang, "usingDefaultsPrefix") + " ",
              React.createElement("code", null, "categories.json"),
              " " + t(lang, "usingDefaultsSuffix") + " ",
              React.createElement("code", null, "categories.json.example"),
              " " + t(lang, "usingDefaultsArrow") + " ",
              React.createElement("code", null, "categories.json"),
              " " + t(lang, "usingDefaultsInFolder")
            )
          : null,
      loadError
        ? React.createElement("p", { className: "text-warning" }, loadError)
        : null,
      React.createElement(
        "div",
        { className: "tag-categories-settings-list-section" },
        React.createElement(
          "button",
          {
            type: "button",
            className:
              "btn btn-secondary btn-sm tag-categories-settings-toggle mb-2" +
              (showCategoryList ? " tag-categories-settings-toggle-open" : ""),
            onClick: function () {
              setShowCategoryList(!showCategoryList);
            },
            "aria-expanded": showCategoryList,
          },
          (showCategoryList ? "▼ " : "▶ ") +
            t(lang, "categories") +
            " (" +
            config.categories.length +
            ")"
        ),
        showCategoryList
          ? config.categories.length > 0
            ? React.createElement(
                "div",
                { className: "tag-categories-settings-list" },
                React.createElement(
                  "div",
                  { className: "tag-categories-settings-list-header" },
                  React.createElement("span", null, t(lang, "colName")),
                  React.createElement("span", null, t(lang, "colTags")),
                  React.createElement("span", {
                    className: "tag-categories-settings-list-actions-hdr",
                    "aria-hidden": true,
                  })
                ),
                config.categories.map(function (category) {
                  return React.createElement(
                    "div",
                    {
                      key: category.id,
                      className: "tag-categories-settings-list-row",
                    },
                    React.createElement("span", null, category.name),
                    React.createElement(
                      "span",
                      { className: "tag-categories-settings-tags text-muted" },
                      (category.tags || []).join(", ") || "—"
                    ),
                    React.createElement(
                      "div",
                      { className: "tag-categories-settings-list-actions" },
                      React.createElement(
                        "button",
                        {
                          type: "button",
                          className:
                            "btn btn-primary btn-sm" +
                            (editingId === category.id ? " active" : ""),
                          onClick: function () {
                            onEditCategory(category);
                          },
                        },
                        t(lang, "edit")
                      ),
                      React.createElement(
                        "button",
                        {
                          type: "button",
                          className: "btn btn-danger btn-sm",
                          onClick: function () {
                            onRemoveCategory(category);
                          },
                        },
                        t(lang, "delete")
                      )
                    )
                  );
                })
              )
            : React.createElement(
                "p",
                { className: "text-muted" },
                t(lang, "emptyCategories")
              )
          : null
      ),
      React.createElement(
        "div",
        { className: "tag-categories-settings-add" },
        React.createElement(
          "button",
          {
            type: "button",
            className:
              "btn btn-secondary btn-sm tag-categories-settings-toggle mb-2" +
              (showAddForm ? " tag-categories-settings-toggle-open" : ""),
            onClick: function () {
              if (showAddForm) {
                onCancelForm();
                return;
              }
              resetForm();
              setShowAddForm(true);
            },
            "aria-expanded": showAddForm,
          },
          showAddForm
            ? "▼ " +
              (editingId != null
                ? t(lang, "editCategory")
                : t(lang, "addCategory"))
            : "▶ " + t(lang, "addCategory")
        ),
        showAddForm
          ? React.createElement(
              "div",
              { className: "tag-categories-settings-add-body" },
              editingId != null
                ? React.createElement(
                    "p",
                    { className: "text-muted small" },
                    t(lang, "editing") + " ",
                    React.createElement("strong", null, newName || editingId)
                  )
                : null,
              React.createElement(
                "div",
                { className: "form-group" },
                React.createElement(
                  "label",
                  { htmlFor: "tc-new-name" },
                  t(lang, "nameLabel")
                ),
                React.createElement("input", {
                  id: "tc-new-name",
                  type: "text",
                  className: "form-control",
                  value: newName,
                  placeholder: t(lang, "namePlaceholder"),
                  onChange: function (e) {
                    setNewName(e.target.value);
                  },
                })
              ),
              React.createElement(
                "div",
                { className: "form-group" },
                React.createElement(
                  "label",
                  { htmlFor: "tc-new-tags" },
                  t(lang, "tagsLabel")
                ),
                React.createElement("input", {
                  id: "tc-new-tags",
                  type: "text",
                  className: "form-control",
                  value: newTags,
                  placeholder: t(lang, "tagsPlaceholder"),
                  onChange: function (e) {
                    setNewTags(e.target.value);
                  },
                  onKeyDown: function (e) {
                    if (e.key === "Enter") onSaveCategory();
                  },
                }),
                React.createElement(
                  "p",
                  { className: "text-muted small mb-0" },
                  t(lang, "tagsHelp")
                )
              ),
              React.createElement(
                "div",
                { className: "tag-categories-settings-form-actions" },
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-primary",
                    onClick: onSaveCategory,
                  },
                  editingId != null ? t(lang, "saveChanges") : t(lang, "add")
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-secondary",
                    onClick: onCancelForm,
                  },
                  t(lang, "cancel")
                )
              )
            )
          : null
      ),
      React.createElement(
        "div",
        { className: "tag-categories-settings-json-actions mt-2" },
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-secondary btn-sm",
            onClick: openJsonModal,
          },
          t(lang, "editJson")
        ),
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-outline-info btn-sm",
            onClick: function () {
              setShowHelpModal(true);
            },
          },
          t(lang, "helpJson")
        )
      ),
      showJsonModal
        ? React.createElement(
            "div",
            {
              className: "tag-categories-modal-backdrop",
              role: "presentation",
              onClick: closeJsonModal,
            },
            React.createElement(
              "div",
              {
                className: "tag-categories-modal",
                role: "dialog",
                "aria-modal": true,
                "aria-labelledby": "tc-json-modal-title",
                onClick: function (e) {
                  e.stopPropagation();
                },
              },
              React.createElement(
                "div",
                { className: "tag-categories-modal-header" },
                React.createElement(
                  "h3",
                  {
                    id: "tc-json-modal-title",
                    className: "tag-categories-modal-title",
                  },
                  t(lang, "jsonModalTitle")
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "tag-categories-modal-close",
                    "aria-label": t(lang, "close"),
                    onClick: closeJsonModal,
                  },
                  "×"
                )
              ),
              React.createElement(
                "div",
                { className: "tag-categories-modal-body" },
                React.createElement(
                  "p",
                  { className: "text-muted small mb-2" },
                  t(lang, "jsonModalHint")
                ),
                React.createElement("textarea", {
                  className: "form-control tag-categories-json",
                  rows: 16,
                  value: jsonModalDraft,
                  onChange: function (e) {
                    setJsonModalDraft(e.target.value);
                  },
                })
              ),
              React.createElement(
                "div",
                { className: "tag-categories-modal-footer" },
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-secondary",
                    onClick: closeJsonModal,
                  },
                  t(lang, "cancel")
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-primary",
                    onClick: onSaveJsonModal,
                  },
                  t(lang, "save")
                )
              )
            )
          )
        : null
    );
  }

  PluginApi.patch.instead("PluginSettings", function () {
    var args = Array.prototype.slice.call(arguments);
    var next = args.pop();
    var props = args[0];
    if (!props || props.pluginID !== PLUGIN_ID) {
      return next.apply(null, args);
    }
    return React.createElement(TagCategoriesSettings, null);
  });
})();
