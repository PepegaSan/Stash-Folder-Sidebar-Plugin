(function () {
  "use strict";

  const PLUGIN_ID = "folderSidebar";
  const ROUTE_PATH = "/plugin/folder-sidebar";
  const ASSETS_JSON = "/plugin/" + PLUGIN_ID + "/assets/folders.json";

  const PluginApi = window.PluginApi;
  if (!PluginApi) {
    console.error("[Folder Sidebar] PluginApi not available");
    return;
  }

  const React = PluginApi.React;
  const GQL = PluginApi.GQL;
  const { Link, useLocation, useHistory } = PluginApi.libraries.ReactRouterDOM;
  const { Button, Nav } = PluginApi.libraries.Bootstrap;

  function pathSeparator(p) {
    return String(p).indexOf("\\") >= 0 ? "\\" : "/";
  }

  function ensureTrailingSep(p) {
    if (!p) return p;
    const s = String(p);
    if (s.endsWith("/") || s.endsWith("\\")) return s;
    return s + pathSeparator(s);
  }

  function pathsEqual(a, b) {
    return (
      ensureTrailingSep(a).toLowerCase() === ensureTrailingSep(b).toLowerCase()
    );
  }

  function joinFolderPath(parent, childName) {
    const sep = pathSeparator(parent);
    const base = String(parent).replace(/[/\\]+$/, "");
    return ensureTrailingSep(base + sep + childName);
  }

  function parentFolderPath(currentPath) {
    const trimmed = String(currentPath).replace(/[/\\]+$/, "");
    const i = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
    if (i <= 0) return ensureTrailingSep(trimmed);
    return ensureTrailingSep(trimmed.slice(0, i + 1));
  }

  function isUnderRoot(path, rootPath) {
    return ensureTrailingSep(path)
      .toLowerCase()
      .startsWith(ensureTrailingSep(rootPath).toLowerCase());
  }

  function relativeParts(rootPath, currentPath) {
    const root = ensureTrailingSep(rootPath);
    const cur = ensureTrailingSep(currentPath);
    if (!cur.toLowerCase().startsWith(root.toLowerCase())) return [];
    const rest = cur.slice(root.length).replace(/^[/\\]+/, "");
    return rest ? rest.split(/[/\\]/).filter(Boolean) : [];
  }

  function pathUpTo(rootPath, parts, count) {
    let p = ensureTrailingSep(rootPath);
    for (let i = 0; i < count && i < parts.length; i++) {
      p = joinFolderPath(p, parts[i]);
    }
    return p;
  }

  function basename(path) {
    if (!path) return "";
    const parts = String(path).split(/[/\\]/);
    return parts[parts.length - 1] || path;
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

  function isFileDirectlyInFolder(filePath, folderPath) {
    const folder = ensureTrailingSep(folderPath);
    const file = String(filePath || "");
    if (!file.toLowerCase().startsWith(folder.toLowerCase())) return false;
    let rest = file.slice(folder.length).replace(/^[/\\]+/, "");
    return rest.length > 0 && !/[/\\]/.test(rest);
  }

  function getImmediateSubfolders(scenes, folderPath) {
    const folder = ensureTrailingSep(folderPath);
    const names = new Set();
    scenes.forEach(function (scene) {
      const fp = sceneFilePath(scene);
      if (!fp.toLowerCase().startsWith(folder.toLowerCase())) return;
      const rest = fp.slice(folder.length).replace(/^[/\\]+/, "");
      const parts = rest.split(/[/\\]/).filter(Boolean);
      if (parts.length > 1) names.add(parts[0]);
    });
    return Array.from(names).sort(function (a, b) {
      return a.localeCompare(b, undefined, { sensitivity: "base" });
    });
  }

  function parseFoldersJson(text) {
    if (!text || !String(text).trim()) return null;
    const parsed = JSON.parse(String(text));
    if (!Array.isArray(parsed)) {
      throw new Error("JSON must be an array");
    }
    return parsed
      .map(function (entry, index) {
        const label = (entry.label || entry.name || "Folder " + (index + 1))
          .trim();
        const path = ensureTrailingSep((entry.path || "").trim());
        if (!path) return null;
        return { id: String(index), label: label, path: path };
      })
      .filter(Boolean);
  }

  function foldersToJsonString(folders) {
    const data = folders.map(function (entry) {
      return {
        label: entry.label,
        path: String(entry.path).replace(/[/\\]+$/, ""),
      };
    });
    return JSON.stringify(data, null, 2);
  }

  function getFoldersFromPluginSettings(plugins) {
    if (!plugins || typeof plugins !== "object") return null;
    const raw = plugins[PLUGIN_ID] && plugins[PLUGIN_ID].foldersJson;
    if (!raw || !String(raw).trim()) return null;
    return parseFoldersJson(raw);
  }

  /** In-memory browse cache (survives navigation to a scene and browser back). */
  const browseCache = new Map();
  const BROWSE_CACHE_TTL_MS = 30 * 60 * 1000;

  function browseCacheKey(path) {
    return ensureTrailingSep(path).toLowerCase();
  }

  function getBrowseCache(path) {
    if (!path) return null;
    const key = browseCacheKey(path);
    const entry = browseCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > BROWSE_CACHE_TTL_MS) {
      browseCache.delete(key);
      return null;
    }
    return entry.scenes;
  }

  function setBrowseCache(path, scenes) {
    if (!path || !scenes) return;
    browseCache.set(browseCacheKey(path), { scenes: scenes, ts: Date.now() });
  }

  function clearBrowseCache(path) {
    if (!path) return;
    browseCache.delete(browseCacheKey(path));
  }

  async function loadFoldersFromFile() {
    const res = await fetch(ASSETS_JSON, { credentials: "same-origin" });
    if (!res.ok) {
      throw new Error("folders.json not found (" + res.status + ")");
    }
    return parseFoldersJson(await res.text());
  }

  function useFolderConfig() {
    const [folders, setFolders] = React.useState([]);
    const [error, setError] = React.useState(null);
    const [loading, setLoading] = React.useState(true);

    const { data: configData } = GQL.useConfigurationQuery({
      fetchPolicy: "cache-and-network",
    });

    React.useEffect(function () {
      let cancelled = false;

      async function load() {
        setLoading(true);
        setError(null);
        try {
          const plugins =
            configData && configData.configuration
              ? configData.configuration.plugins
              : null;
          let list = getFoldersFromPluginSettings(plugins);
          if (!list) {
            list = await loadFoldersFromFile();
          }

          if (!list || !list.length) {
            throw new Error(
              "No folders configured. Edit folders.json or the plugin setting."
            );
          }

          if (!cancelled) setFolders(list);
        } catch (e) {
          if (!cancelled) {
            setError(e.message || String(e));
            setFolders([]);
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      }

      load();
      return function () {
        cancelled = true;
      };
    }, [configData]);

    return { folders, error, loading };
  }

  function FolderBrowsePanel(props) {
    const { root, currentPath, onNavigate } = props;
    const { LoadingIndicator } = PluginApi.components;
    const modifier =
      GQL.CriterionModifier && GQL.CriterionModifier.Includes
        ? GQL.CriterionModifier.Includes
        : "INCLUDES";

    const cachedScenes = React.useMemo(
      function () {
        return getBrowseCache(currentPath);
      },
      [currentPath]
    );

    const { data, loading, error, refetch } = GQL.useFindScenesQuery({
      skip: !currentPath,
      fetchPolicy: "cache-first",
      nextFetchPolicy: "cache-first",
      variables: {
        filter: {
          per_page: -1,
          sort: "path",
          direction: "ASC",
        },
        scene_filter: {
          path: {
            value: currentPath,
            modifier: modifier,
          },
        },
      },
    });

    const hasQueryData = !!(data && data.findScenes);
    const queryScenes = hasQueryData ? data.findScenes.scenes || [] : null;

    React.useEffect(
      function () {
        if (hasQueryData) {
          setBrowseCache(currentPath, data.findScenes.scenes || []);
        }
      },
      [currentPath, hasQueryData, data]
    );

    const allScenes =
      queryScenes !== null ? queryScenes : cachedScenes || [];
    const showFullLoading = loading && !hasQueryData && !cachedScenes;

    if (showFullLoading) {
      return React.createElement(LoadingIndicator);
    }
    if (error && !allScenes.length) {
      return React.createElement(
        "p",
        { className: "folder-sidebar-error" },
        "Failed to load: ",
        error.message
      );
    }

    const isRefreshing = loading && allScenes.length > 0;
    const subfolders = getImmediateSubfolders(allScenes, currentPath);
    const directScenes = allScenes.filter(function (scene) {
      return isFileDirectlyInFolder(sceneFilePath(scene), currentPath);
    });
    const relParts = relativeParts(root.path, currentPath);
    const atRoot = pathsEqual(currentPath, root.path);

    function breadcrumb() {
      const crumbs = [
        React.createElement(
          "button",
          {
            key: "root",
            type: "button",
            className: "folder-sidebar-crumb" + (atRoot ? " active" : ""),
            onClick: function () {
              onNavigate(root.path);
            },
          },
          root.label
        ),
      ];
      relParts.forEach(function (part, index) {
        const target = pathUpTo(root.path, relParts, index + 1);
        const isLast = index === relParts.length - 1;
        crumbs.push(
          React.createElement("span", { key: "sep-" + index, className: "folder-sidebar-crumb-sep" }, " › "),
          React.createElement(
            "button",
            {
              key: "part-" + index,
              type: "button",
              className: "folder-sidebar-crumb" + (isLast ? " active" : ""),
              onClick: function () {
                onNavigate(target);
              },
            },
            part
          )
        );
      });
      return React.createElement(
        "nav",
        { className: "folder-sidebar-breadcrumb", "aria-label": "Path" },
        crumbs
      );
    }

    return React.createElement(
      React.Fragment,
      null,
      React.createElement(
        "div",
        { className: "folder-sidebar-header" },
        breadcrumb(),
        React.createElement(
          "div",
          { className: "text-muted folder-sidebar-current-path" },
          currentPath
        ),
        React.createElement(
          "div",
          { className: "folder-sidebar-header-actions mt-2" },
          React.createElement(
            Button,
            {
              variant: "secondary",
              size: "sm",
              onClick: function () {
                clearBrowseCache(currentPath);
                refetch({ fetchPolicy: "network-only" });
              },
            },
            "Refresh"
          ),
          isRefreshing
            ? React.createElement(
                "span",
                { className: "folder-sidebar-refreshing text-muted" },
                "Updating…"
              )
            : null
        )
      ),
      !atRoot
        ? React.createElement(
            "button",
            {
              type: "button",
              className: "folder-sidebar-up-btn",
              onClick: function () {
                onNavigate(parentFolderPath(currentPath));
              },
            },
            "← Up one level"
          )
        : null,
      subfolders.length > 0
        ? React.createElement(
            "section",
            { className: "folder-sidebar-section" },
            React.createElement(
              "h2",
              { className: "folder-sidebar-section-title" },
              "Subfolders"
            ),
            React.createElement(
              "ul",
              { className: "folder-sidebar-subfolder-list" },
              subfolders.map(function (name) {
                return React.createElement(
                  "li",
                  { key: name },
                  React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "folder-sidebar-subfolder-btn",
                      onClick: function () {
                        onNavigate(joinFolderPath(currentPath, name));
                      },
                    },
                    React.createElement(
                      "span",
                      { className: "folder-sidebar-subfolder-icon" },
                      "📁"
                    ),
                    name
                  )
                );
              })
            )
          )
        : null,
      React.createElement(
        "section",
        { className: "folder-sidebar-section" },
        React.createElement(
          "h2",
          { className: "folder-sidebar-section-title" },
          "Files in this folder",
          " (",
          directScenes.length,
          ")"
        ),
        directScenes.length === 0
          ? React.createElement(
              "p",
              { className: "folder-sidebar-empty" },
              atRoot && subfolders.length > 0
                ? "No files directly in the root folder — open a subfolder."
                : "No files directly in this folder."
            )
          : React.createElement(
              "ul",
              { className: "folder-sidebar-list" },
              directScenes.map(function (scene) {
                const path = sceneFilePath(scene);
                const title =
                  scene.title && scene.title.trim()
                    ? scene.title
                    : basename(path) || "Scene " + scene.id;
                const dur = formatDuration(sceneDuration(scene));
                const meta = [dur, path].filter(Boolean).join(" · ");
                return React.createElement(
                  "li",
                  { key: scene.id, className: "folder-sidebar-row" },
                  React.createElement(
                    Link,
                    { to: "/scenes/" + scene.id },
                    React.createElement(
                      "div",
                      { className: "folder-sidebar-row-title" },
                      title
                    ),
                    meta
                      ? React.createElement(
                          "div",
                          { className: "folder-sidebar-row-meta" },
                          meta
                        )
                      : null
                  )
                );
              })
            )
      )
    );
  }

  function FolderSidebarPage() {
    const location = useLocation();
    const history = useHistory();
    const { folders, error, loading } = useFolderConfig();

    const params = new URLSearchParams(location.search || "");
    const folderParam = params.get("folder");
    const cwdParam = params.get("cwd");

    const selectedId = React.useMemo(
      function () {
        if (
          folderParam &&
          folders.some(function (f) {
            return f.id === folderParam;
          })
        ) {
          return folderParam;
        }
        return folders.length ? folders[0].id : null;
      },
      [folderParam, folders]
    );

    const selected = folders.find(function (f) {
      return f.id === selectedId;
    });

    const currentPath = React.useMemo(
      function () {
        if (!selected) return null;
        if (cwdParam && isUnderRoot(cwdParam, selected.path)) {
          return ensureTrailingSep(cwdParam);
        }
        return selected.path;
      },
      [selected, cwdParam]
    );

    function selectRoot(id) {
      const root = folders.find(function (f) {
        return f.id === id;
      });
      if (!root) return;
      const q = new URLSearchParams();
      q.set("folder", id);
      q.set("cwd", root.path);
      history.push(ROUTE_PATH + "?" + q.toString());
    }

    function navigateTo(path) {
      if (!selected) return;
      const q = new URLSearchParams();
      q.set("folder", selected.id);
      q.set("cwd", ensureTrailingSep(path));
      history.push(ROUTE_PATH + "?" + q.toString());
    }

    const { LoadingIndicator } = PluginApi.components;

    if (loading) {
      return React.createElement(
        "div",
        { className: "container-fluid p-3" },
        React.createElement(LoadingIndicator)
      );
    }

    return React.createElement(
      "div",
      { className: "folder-sidebar-page" },
      React.createElement(
        "nav",
        { className: "folder-sidebar-nav", "aria-label": "Root folders" },
        React.createElement("h2", null, "Root folders"),
        folders.map(function (folder) {
          return React.createElement(
            "button",
            {
              key: folder.id,
              type: "button",
              className:
                "folder-sidebar-nav-btn" +
                (folder.id === selectedId ? " active" : ""),
              onClick: function () {
                selectRoot(folder.id);
              },
              title: folder.path,
            },
            folder.label,
            React.createElement(
              "span",
              { className: "folder-sidebar-nav-path" },
              folder.path
            )
          );
        })
      ),
      React.createElement(
        "main",
        { className: "folder-sidebar-main" },
        error
          ? React.createElement(
              "p",
              { className: "folder-sidebar-error" },
              error,
              React.createElement("br"),
              React.createElement(
                "span",
                { className: "folder-sidebar-hint" },
                "Add folders in ",
                React.createElement("code", null, "folders.json"),
                " or under Settings → Plugins → Folder Sidebar."
              )
            )
          : selected && currentPath
            ? React.createElement(FolderBrowsePanel, {
                root: selected,
                currentPath: currentPath,
                onNavigate: navigateTo,
              })
            : null
      )
    );
  }

  PluginApi.register.route(ROUTE_PATH, FolderSidebarPage);

  function FolderPluginSettings() {
    const { plugins, savePluginSettings, loading } = PluginApi.hooks.useSettings();
    const Toast = PluginApi.hooks.useToast();
    const [folders, setFolders] = React.useState([]);
    const [newLabel, setNewLabel] = React.useState("");
    const [newPath, setNewPath] = React.useState("");
    const [usingFile, setUsingFile] = React.useState(false);
    const [loadError, setLoadError] = React.useState(null);
    const [showFolderList, setShowFolderList] = React.useState(true);
    const [showAddForm, setShowAddForm] = React.useState(false);
    const [showJson, setShowJson] = React.useState(false);
    const [jsonDraft, setJsonDraft] = React.useState("[]");

    React.useEffect(function () {
      let cancelled = false;

      async function load() {
        setLoadError(null);
        try {
          const fromSettings = getFoldersFromPluginSettings(plugins);
          if (fromSettings && fromSettings.length) {
            if (!cancelled) {
              setFolders(fromSettings);
              setUsingFile(false);
            }
            return;
          }
          const fromFile = await loadFoldersFromFile();
          if (!cancelled) {
            setFolders(fromFile || []);
            setUsingFile(true);
          }
        } catch (e) {
          if (!cancelled) {
            setLoadError(e.message || String(e));
            setFolders([]);
          }
        }
      }

      if (!loading) load();
      return function () {
        cancelled = true;
      };
    }, [plugins, loading]);

    React.useEffect(
      function () {
        setJsonDraft(foldersToJsonString(folders));
      },
      [folders]
    );

    function persistFolders(nextFolders) {
      savePluginSettings(PLUGIN_ID, {
        foldersJson: foldersToJsonString(nextFolders),
      });
      setFolders(
        nextFolders.map(function (entry, index) {
          return {
            id: String(index),
            label: entry.label,
            path: ensureTrailingSep(entry.path),
          };
        })
      );
      setUsingFile(false);
    }

    function onAdd() {
      const label = newLabel.trim();
      const path = newPath.trim();
      if (!label || !path) {
        Toast.error("Label and path are required.");
        return;
      }
      const next = folders.concat([
        {
          id: String(folders.length),
          label: label,
          path: ensureTrailingSep(path),
        },
      ]);
      persistFolders(next);
      setNewLabel("");
      setNewPath("");
      setShowAddForm(false);
      Toast.success("Folder added.");
    }

    function onRemove(folder) {
      const message =
        'Remove root folder "' + folder.label + '" from the list?';
      if (!window.confirm(message)) return;
      const next = folders.filter(function (f) {
        return f.path !== folder.path;
      });
      persistFolders(next);
      Toast.success("Folder removed.");
    }

    function onSaveJson() {
      try {
        const parsed = parseFoldersJson(jsonDraft);
        if (!parsed) {
          throw new Error("JSON must be a non-empty array of folders.");
        }
        persistFolders(parsed);
        Toast.success("JSON saved.");
      } catch (e) {
        Toast.error(e.message || String(e));
      }
    }

    return React.createElement(
      "div",
      { className: "plugin-settings folder-sidebar-plugin-settings" },
      React.createElement(
        "p",
        { className: "folder-sidebar-settings-intro text-muted" },
        "Root folders shown in the ",
        React.createElement("strong", null, "Folder"),
        " navigation page."
      ),
      usingFile
        ? React.createElement(
            "p",
            { className: "folder-sidebar-settings-note" },
            "Currently loaded from ",
            React.createElement("code", null, "folders.json"),
            ". Adding a folder saves to plugin settings and overrides the file."
          )
        : null,
      loadError
        ? React.createElement(
            "p",
            { className: "folder-sidebar-error" },
            loadError
          )
        : null,
      React.createElement(
        "div",
        { className: "folder-sidebar-settings-list-section" },
        React.createElement(
          Button,
          {
            variant: "secondary",
            size: "sm",
            className:
              "folder-sidebar-settings-toggle mb-2" +
              (showFolderList ? " folder-sidebar-settings-toggle-open" : ""),
            onClick: function () {
              setShowFolderList(!showFolderList);
            },
            "aria-expanded": showFolderList,
          },
          (showFolderList ? "▼ " : "▶ ") +
            "Root folders (" +
            folders.length +
            ")"
        ),
        showFolderList
          ? folders.length > 0
            ? React.createElement(
                "div",
                { className: "folder-sidebar-settings-list" },
                React.createElement(
                  "div",
                  { className: "folder-sidebar-settings-list-header" },
                  React.createElement("span", null, "Label"),
                  React.createElement("span", null, "Path"),
                  React.createElement("span", {
                    className: "folder-sidebar-settings-list-actions-hdr",
                    "aria-hidden": true,
                  })
                ),
                folders.map(function (folder) {
                  return React.createElement(
                    "div",
                    {
                      key: folder.id + folder.path,
                      className: "folder-sidebar-settings-list-row",
                    },
                    React.createElement("span", null, folder.label),
                    React.createElement(
                      "code",
                      { className: "folder-sidebar-settings-path" },
                      folder.path
                    ),
                    React.createElement(
                      Button,
                      {
                        variant: "danger",
                        size: "sm",
                        className: "folder-sidebar-settings-delete-btn",
                        title: "Remove " + folder.label,
                        onClick: function () {
                          onRemove(folder);
                        },
                      },
                      "Delete"
                    )
                  );
                })
              )
            : React.createElement(
                "p",
                { className: "folder-sidebar-empty" },
                "No folders configured yet."
              )
          : null
      ),
      React.createElement(
        "div",
        { className: "folder-sidebar-settings-add" },
        React.createElement(
          Button,
          {
            variant: "secondary",
            size: "sm",
            className:
              "folder-sidebar-settings-toggle mb-2" +
              (showAddForm ? " folder-sidebar-settings-toggle-open" : ""),
            onClick: function () {
              setShowAddForm(!showAddForm);
            },
            "aria-expanded": showAddForm,
          },
          showAddForm ? "▼ Add folder" : "▶ Add folder"
        ),
        showAddForm
          ? React.createElement(
              "div",
              { className: "folder-sidebar-settings-add-body" },
              React.createElement(
                "div",
                { className: "form-group" },
                React.createElement("label", { htmlFor: "fs-new-label" }, "Label"),
                React.createElement("input", {
                  id: "fs-new-label",
                  type: "text",
                  className: "form-control",
                  value: newLabel,
                  placeholder: "e.g. AMV",
                  onChange: function (e) {
                    setNewLabel(e.target.value);
                  },
                })
              ),
              React.createElement(
                "div",
                { className: "form-group" },
                React.createElement("label", { htmlFor: "fs-new-path" }, "Path"),
                React.createElement("input", {
                  id: "fs-new-path",
                  type: "text",
                  className: "form-control",
                  value: newPath,
                  placeholder: "e.g. D:\\Media\\AMV or /data/AMV",
                  onChange: function (e) {
                    setNewPath(e.target.value);
                  },
                  onKeyDown: function (e) {
                    if (e.key === "Enter") onAdd();
                  },
                })
              ),
              React.createElement(
                Button,
                { variant: "primary", onClick: onAdd },
                "Add"
              )
            )
          : null
      ),
      React.createElement(
        Button,
        {
          variant: "secondary",
          size: "sm",
          className: "mb-2",
          onClick: function () {
            setShowJson(!showJson);
          },
        },
        showJson ? "Hide JSON" : "Edit JSON (advanced)"
      ),
      showJson
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement("textarea", {
              className: "form-control folder-sidebar-settings-json",
              rows: 10,
              value: jsonDraft,
              onChange: function (e) {
                setJsonDraft(e.target.value);
              },
            }),
            React.createElement(
              Button,
              {
                variant: "secondary",
                size: "sm",
                className: "mt-2",
                onClick: onSaveJson,
              },
              "Save JSON"
            )
          )
        : null
    );
  }

  PluginApi.patch.instead("PluginSettings", function (props, next) {
    if (props.pluginID !== PLUGIN_ID) {
      return next(props);
    }
    return React.createElement(FolderPluginSettings, null);
  });

  /** Match stock MainNavbar menu item layout (Nav.Link → LinkContainer → Button → Icon). */
  function FolderNavMenuItem() {
    const location = useLocation();
    const { Icon } = PluginApi.components;
    const faSolid = PluginApi.libraries.FontAwesomeSolid;
    const faFolder = faSolid.faFolder || faSolid.faFolderOpen;
    const isActive =
      location.pathname === ROUTE_PATH ||
      location.pathname.indexOf(ROUTE_PATH + "/") === 0;

    return React.createElement(
      Nav.Link,
      {
        as: "div",
        eventKey: ROUTE_PATH,
        key: "folder-sidebar-nav",
        className: "col-4 col-sm-3 col-md-2 col-lg-auto",
      },
      React.createElement(
        Link,
        { to: ROUTE_PATH, className: "folder-sidebar-nav-link-wrap" },
        React.createElement(
          Button,
          {
            className:
              "minimal p-4 p-xl-2 d-flex d-xl-inline-block flex-column justify-content-between align-items-center" +
              (isActive ? " active" : ""),
          },
          React.createElement(Icon, {
            icon: faFolder,
            className: "nav-menu-icon d-block d-xl-inline mb-2 mb-xl-0",
          }),
          React.createElement("span", null, "Folder")
        )
      )
    );
  }

  PluginApi.patch.before("MainNavBar.MenuItems", function (props) {
    return [
      {
        children: React.createElement(
          React.Fragment,
          null,
          props.children,
          React.createElement(FolderNavMenuItem, null)
        ),
      },
    ];
  });
})();
