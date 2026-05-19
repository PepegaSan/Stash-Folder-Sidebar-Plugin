(function () {
  "use strict";

  const PLUGIN_ID = "quickMarkers";
  const ASSETS_PRESETS = "/plugin/" + PLUGIN_ID + "/assets/presets.json";

  const PluginApi = window.PluginApi;
  if (!PluginApi) {
    console.error("[Quick Markers] PluginApi not available");
    return;
  }

  const React = PluginApi.React;
  const GQL = PluginApi.GQL;
  const Mousetrap = PluginApi.libraries.Mousetrap;
  const MousetrapPause = PluginApi.libraries.MousetrapPause;

  const tagIdCache = new Map();
  const inPointByScene = new Map();

  function getPlayerTime() {
    const player = PluginApi.utils.InteractiveUtils.getPlayer();
    if (!player || typeof player.currentTime !== "function") return null;
    const t = player.currentTime();
    return typeof t === "number" && !isNaN(t) ? t : null;
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m + ":" + String(sec).padStart(2, "0");
  }

  function parsePresetsJson(text) {
    if (!text || !String(text).trim()) return null;
    const parsed = JSON.parse(String(text));
    const presets = Array.isArray(parsed.presets) ? parsed.presets : parsed;
    if (!Array.isArray(presets) || !presets.length) {
      throw new Error("presets must be a non-empty array");
    }
    const normalized = presets.map(function (p, index) {
      const label = (p.label || p.id || "Preset " + (index + 1)).trim();
      const primaryTag = (p.primaryTag || p.tag || label).trim();
      if (!primaryTag) throw new Error("preset " + label + ": primaryTag required");
      return {
        id: (p.id || String(index)).trim(),
        label: label,
        primaryTag: primaryTag,
        title: (p.title || label).trim(),
        rangeInKey: (p.rangeInKey || "").trim().toLowerCase(),
        rangeOutKey: (p.rangeOutKey || "").trim().toLowerCase(),
        instantKey: (p.instantKey || "").trim().toLowerCase(),
      };
    });
    let defaultIndex = 0;
    if (typeof parsed.defaultPresetIndex === "number") {
      defaultIndex = parsed.defaultPresetIndex;
    }
    if (defaultIndex < 0 || defaultIndex >= normalized.length) defaultIndex = 0;
    return { presets: normalized, defaultPresetIndex: defaultIndex };
  }

  function presetsToJson(config) {
    return JSON.stringify(
      {
        defaultPresetIndex: config.defaultPresetIndex,
        presets: config.presets.map(function (p) {
          const o = {
            id: p.id,
            label: p.label,
            primaryTag: p.primaryTag,
            title: p.title,
          };
          if (p.rangeInKey) o.rangeInKey = p.rangeInKey;
          if (p.rangeOutKey) o.rangeOutKey = p.rangeOutKey;
          if (p.instantKey) o.instantKey = p.instantKey;
          return o;
        }),
      },
      null,
      2
    );
  }

  function getPresetsFromSettings(plugins) {
    if (!plugins || typeof plugins !== "object") return null;
    const raw = plugins[PLUGIN_ID] && plugins[PLUGIN_ID].presetsJson;
    if (!raw || !String(raw).trim()) return null;
    return parsePresetsJson(raw);
  }

  async function loadPresetsFromFile() {
    const res = await fetch(ASSETS_PRESETS, { credentials: "same-origin" });
    if (!res.ok) throw new Error("presets.json not found (" + res.status + ")");
    return parsePresetsJson(await res.text());
  }

  function usePresetsConfig() {
    const [config, setConfig] = React.useState(null);
    const [error, setError] = React.useState(null);
    const { data } = GQL.useConfigurationQuery({ fetchPolicy: "cache-first" });

    React.useEffect(function () {
      let cancelled = false;
      async function load() {
        setError(null);
        try {
          const plugins =
            data && data.configuration ? data.configuration.plugins : null;
          let cfg = getPresetsFromSettings(plugins);
          if (!cfg) cfg = await loadPresetsFromFile();
          if (!cancelled) setConfig(cfg);
        } catch (e) {
          if (!cancelled) {
            setError(e.message || String(e));
            setConfig(null);
          }
        }
      }
      load();
      return function () {
        cancelled = true;
      };
    }, [data]);

    return { config, error };
  }

  function useResolveTagId() {
    const [findTags] = GQL.useFindTagsLazyQuery({ fetchPolicy: "cache-first" });
    const modifier =
      GQL.CriterionModifier && GQL.CriterionModifier.Equals
        ? GQL.CriterionModifier.Equals
        : "EQUALS";

    return React.useCallback(
      async function resolveTagId(tagName) {
        const key = tagName.toLowerCase();
        if (tagIdCache.has(key)) return tagIdCache.get(key);

        const result = await findTags({
          variables: {
            filter: { per_page: 1 },
            tag_filter: {
              name: { value: tagName, modifier: modifier },
            },
          },
        });

        const tags =
          result.data && result.data.findTags && result.data.findTags.tags;
        if (!tags || !tags.length) {
          throw new Error(
            'Tag "' +
              tagName +
              '" not found. Create it in Stash (Tags) or fix primaryTag in presets.'
          );
        }
        tagIdCache.set(key, tags[0].id);
        return tags[0].id;
      },
      [findTags, modifier]
    );
  }

  function QuickMarkersSceneHook(props) {
    const scene = props.scene;
    const Toast = PluginApi.hooks.useToast();
    const { config, error: configError } = usePresetsConfig();
    const resolveTagId = useResolveTagId();
    const [activeIndex, setActiveIndex] = React.useState(0);
    const [inPoint, setInPoint] = React.useState(null);
    const [status, setStatus] = React.useState("");
    const [panelOpen, setPanelOpen] = React.useState(true);

    const [createMarker] = GQL.useSceneMarkerCreateMutation({
      refetchQueries: ["FindScene", "FindSceneMarkers"],
      awaitRefetchQueries: false,
    });

    React.useEffect(
      function () {
        if (config) setActiveIndex(config.defaultPresetIndex);
      },
      [config]
    );

    React.useEffect(
      function () {
        setInPoint(null);
        inPointByScene.delete(scene.id);
      },
      [scene.id]
    );

    const activePreset =
      config && config.presets.length
        ? config.presets[
            Math.min(activeIndex, config.presets.length - 1)
          ]
        : null;

    const createAt = React.useCallback(
      async function (preset, startSeconds, endSeconds) {
        const tagId = await resolveTagId(preset.primaryTag);
        const input = {
          title: preset.title,
          seconds: startSeconds,
          scene_id: scene.id,
          primary_tag_id: tagId,
        };
        if (
          typeof endSeconds === "number" &&
          endSeconds > startSeconds + 0.05
        ) {
          input.end_seconds = endSeconds;
        }
        await createMarker({ variables: { input: input } });
        const rangeMsg =
          input.end_seconds != null
            ? formatTime(startSeconds) + " – " + formatTime(endSeconds)
            : formatTime(startSeconds);
        setStatus(preset.label + " @ " + rangeMsg);
        Toast.success("Marker: " + preset.label + " (" + rangeMsg + ")");
      },
      [createMarker, resolveTagId, scene.id, Toast]
    );

    const onInstant = React.useCallback(
      async function (preset) {
        const t = getPlayerTime();
        if (t == null) {
          Toast.error("No video player active.");
          return;
        }
        try {
          await createAt(preset, t, null);
        } catch (e) {
          Toast.error(e.message || String(e));
        }
      },
      [createAt, Toast]
    );

    const onRangeIn = React.useCallback(
      function (preset) {
        const t = getPlayerTime();
        if (t == null) {
          Toast.error("No video player active.");
          return;
        }
        inPointByScene.set(scene.id, t);
        setInPoint(t);
        setStatus("In @ " + formatTime(t) + " (" + preset.label + ")");
        Toast.success("In point: " + formatTime(t));
      },
      [scene.id, Toast]
    );

    const onRangeOut = React.useCallback(
      async function (preset) {
        const t = getPlayerTime();
        if (t == null) {
          Toast.error("No video player active.");
          return;
        }
        const start = inPointByScene.get(scene.id);
        if (start == null) {
          Toast.error("Set In first (default preset: " + preset.rangeInKey + ")");
          return;
        }
        const end = t;
        const from = Math.min(start, end);
        const to = Math.max(start, end);
        try {
          await createAt(preset, from, to);
          inPointByScene.delete(scene.id);
          setInPoint(null);
        } catch (e) {
          Toast.error(e.message || String(e));
        }
      },
      [createAt, scene.id, Toast]
    );

    React.useEffect(
      function () {
        if (!config || !scene) return;

        const keysToUnbind = [];

        function bind(key, fn) {
          if (!key) return;
          keysToUnbind.push(key);
          if (MousetrapPause && MousetrapPause.bind) {
            MousetrapPause.bind(key, fn);
          } else {
            Mousetrap.bind(key, fn);
          }
        }

        config.presets.forEach(function (preset, index) {
          if (preset.instantKey) {
            bind(preset.instantKey, function (e) {
              if (e && e.preventDefault) e.preventDefault();
              onInstant(preset);
            });
          }
        });

        if (activePreset) {
          if (activePreset.rangeInKey) {
            bind(activePreset.rangeInKey, function (e) {
              if (e && e.preventDefault) e.preventDefault();
              onRangeIn(activePreset);
            });
          }
          if (activePreset.rangeOutKey) {
            bind(activePreset.rangeOutKey, function (e) {
              if (e && e.preventDefault) e.preventDefault();
              onRangeOut(activePreset);
            });
          }
        }

        bind("shift+]", function (e) {
          if (e && e.preventDefault) e.preventDefault();
          setActiveIndex(function (i) {
            return (i + 1) % config.presets.length;
          });
        });
        bind("shift+[", function (e) {
          if (e && e.preventDefault) e.preventDefault();
          setActiveIndex(function (i) {
            return (i - 1 + config.presets.length) % config.presets.length;
          });
        });

        return function () {
          keysToUnbind.forEach(function (key) {
            if (MousetrapPause && MousetrapPause.unbind) {
              MousetrapPause.unbind(key);
            } else {
              Mousetrap.unbind(key);
            }
          });
        };
      },
      [config, scene, activePreset, onInstant, onRangeIn, onRangeOut]
    );

    if (configError || !config || !activePreset) return null;

    return React.createElement(
      "div",
      {
        className:
          "quick-markers-panel" +
          (panelOpen ? "" : " quick-markers-panel-collapsed"),
      },
      React.createElement(
        "div",
        { className: "quick-markers-panel-header" },
        React.createElement(
          "button",
          {
            type: "button",
            className: "quick-markers-toggle",
            onClick: function () {
              setPanelOpen(!panelOpen);
            },
            title: panelOpen ? "Collapse" : "Expand",
          },
          panelOpen ? "▼" : "▶"
        ),
        React.createElement("strong", null, "Quick Markers"),
        React.createElement(
          "span",
          { className: "quick-markers-active" },
          activePreset.label
        )
      ),
      panelOpen
        ? React.createElement(
            React.Fragment,
            null,
            React.createElement(
              "p",
              { className: "quick-markers-hint text-muted" },
              "Range (active preset): ",
              React.createElement("kbd", null, activePreset.rangeInKey || "—"),
              " In, ",
              React.createElement("kbd", null, activePreset.rangeOutKey || "—"),
              " Out · ",
              React.createElement("kbd", null, "shift+["),
              " / ",
              React.createElement("kbd", null, "shift+]"),
              " switch preset"
            ),
            inPoint != null
              ? React.createElement(
                  "p",
                  { className: "quick-markers-in-point" },
                  "In: ",
                  formatTime(inPoint),
                  " — press ",
                  React.createElement("kbd", null, activePreset.rangeOutKey || "Out"),
                  " to save"
                )
              : null,
            status
              ? React.createElement(
                  "p",
                  { className: "quick-markers-status text-muted" },
                  status
                )
              : null,
            React.createElement(
              "div",
              { className: "quick-markers-presets" },
              config.presets.map(function (preset, index) {
                const isActive = index === activeIndex;
                return React.createElement(
                  "button",
                  {
                    key: preset.id,
                    type: "button",
                    className:
                      "quick-markers-preset-btn" +
                      (isActive ? " active" : ""),
                    title: preset.instantKey
                      ? "Click or " + preset.instantKey
                      : "Select for range keys",
                    onClick: function () {
                      setActiveIndex(index);
                      if (preset.instantKey) onInstant(preset);
                    },
                  },
                  preset.label,
                  preset.instantKey
                    ? React.createElement(
                        "span",
                        { className: "quick-markers-key" },
                        preset.instantKey
                      )
                    : null
                );
              })
            ),
            configError
              ? React.createElement(
                  "p",
                  { className: "text-danger" },
                  configError
                )
              : null
          )
        : null
    );
  }

  PluginApi.patch.after("ScenePage", function (props, result) {
    if (!props.scene) return result;
    return React.createElement(
      React.Fragment,
      null,
      result,
      React.createElement(QuickMarkersSceneHook, { scene: props.scene })
    );
  });

  function QuickMarkersSettings() {
    const { plugins, savePluginSettings, loading } = PluginApi.hooks.useSettings();
    const Toast = PluginApi.hooks.useToast();
    const { Button, Modal } = PluginApi.libraries.Bootstrap;

    const [config, setConfig] = React.useState({
      defaultPresetIndex: 0,
      presets: [],
    });
    const [usingFile, setUsingFile] = React.useState(false);
    const [loadError, setLoadError] = React.useState(null);
    const [showPresetList, setShowPresetList] = React.useState(false);
    const [showAddForm, setShowAddForm] = React.useState(false);
    const [showJsonModal, setShowJsonModal] = React.useState(false);
    const [jsonModalDraft, setJsonModalDraft] = React.useState("");

    const [newLabel, setNewLabel] = React.useState("");
    const [newPrimaryTag, setNewPrimaryTag] = React.useState("");
    const [newRangeIn, setNewRangeIn] = React.useState("shift+i");
    const [newRangeOut, setNewRangeOut] = React.useState("shift+o");
    const [newInstant, setNewInstant] = React.useState("");

    React.useEffect(
      function () {
        if (loading) return;
        let cancelled = false;
        async function load() {
          setLoadError(null);
          try {
            const fromSettings = getPresetsFromSettings(plugins);
            if (fromSettings) {
              if (!cancelled) {
                setConfig(fromSettings);
                setUsingFile(false);
              }
              return;
            }
            const fromFile = await loadPresetsFromFile();
            if (!cancelled) {
              setConfig(fromFile);
              setUsingFile(true);
            }
          } catch (e) {
            if (!cancelled) {
              setLoadError(e.message || String(e));
              setConfig({
                defaultPresetIndex: 0,
                presets: [
                  {
                    id: "compilation",
                    label: "Compilation",
                    primaryTag: "Compilation",
                    title: "Compilation",
                    rangeInKey: "shift+i",
                    rangeOutKey: "shift+o",
                    instantKey: "shift+1",
                  },
                ],
              });
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

    function persistConfig(nextConfig) {
      savePluginSettings(PLUGIN_ID, {
        presetsJson: presetsToJson(nextConfig),
      });
      setConfig(nextConfig);
      setUsingFile(false);
      tagIdCache.clear();
    }

    function openJsonModal() {
      setJsonModalDraft(presetsToJson(config));
      setShowJsonModal(true);
    }

    function closeJsonModal() {
      setShowJsonModal(false);
    }

    function onSaveJsonModal() {
      try {
        const parsed = parsePresetsJson(jsonModalDraft);
        persistConfig(parsed);
        setShowJsonModal(false);
        Toast.success("JSON saved.");
      } catch (e) {
        Toast.error(e.message || String(e));
      }
    }

    function onAddPreset() {
      const label = newLabel.trim();
      const primaryTag = (newPrimaryTag || newLabel).trim();
      if (!label || !primaryTag) {
        Toast.error("Label and primary tag are required.");
        return;
      }
      const id = label.toLowerCase().replace(/\s+/g, "-");
      const next = {
        defaultPresetIndex: config.defaultPresetIndex,
        presets: config.presets.concat([
          {
            id: id,
            label: label,
            primaryTag: primaryTag,
            title: label,
            rangeInKey: newRangeIn.trim().toLowerCase(),
            rangeOutKey: newRangeOut.trim().toLowerCase(),
            instantKey: newInstant.trim().toLowerCase(),
          },
        ]),
      };
      persistConfig(next);
      setNewLabel("");
      setNewPrimaryTag("");
      setNewRangeIn("shift+i");
      setNewRangeOut("shift+o");
      setNewInstant("");
      setShowAddForm(false);
      Toast.success("Preset added.");
    }

    function onRemovePreset(preset) {
      const message = 'Remove preset "' + preset.label + '"?';
      if (!window.confirm(message)) return;
      const presets = config.presets.filter(function (p) {
        return p.id !== preset.id;
      });
      let defaultPresetIndex = config.defaultPresetIndex;
      if (defaultPresetIndex >= presets.length) {
        defaultPresetIndex = Math.max(0, presets.length - 1);
      }
      persistConfig({ defaultPresetIndex: defaultPresetIndex, presets: presets });
      Toast.success("Preset removed.");
    }

    function onDefaultIndexChange(index) {
      persistConfig({
        defaultPresetIndex: index,
        presets: config.presets,
      });
    }

    return React.createElement(
      "div",
      { className: "plugin-settings quick-markers-settings" },
      React.createElement(
        "p",
        { className: "quick-markers-settings-intro text-muted" },
        "Hotkeys on the scene page. Active preset uses ",
        React.createElement("kbd", null, "shift+i"),
        " / ",
        React.createElement("kbd", null, "shift+o"),
        " for range markers. Avoid plain ",
        React.createElement("kbd", null, "i"),
        " / ",
        React.createElement("kbd", null, "o"),
        " (Stash shortcuts)."
      ),
      usingFile
        ? React.createElement(
            "p",
            { className: "quick-markers-settings-note text-muted" },
            "Loaded from ",
            React.createElement("code", null, "presets.json"),
            ". Saving here overrides the file."
          )
        : null,
      loadError
        ? React.createElement("p", { className: "text-warning" }, loadError)
        : null,
      config.presets.length > 0
        ? React.createElement(
            "div",
            { className: "form-group quick-markers-default-preset" },
            React.createElement(
              "label",
              { htmlFor: "qm-default-preset" },
              "Default preset (for Shift+I/O)"
            ),
            React.createElement(
              "select",
              {
                id: "qm-default-preset",
                className: "form-control",
                value: String(config.defaultPresetIndex),
                onChange: function (e) {
                  onDefaultIndexChange(Number(e.target.value));
                },
              },
              config.presets.map(function (p, index) {
                return React.createElement(
                  "option",
                  { key: p.id, value: String(index) },
                  p.label
                );
              })
            )
          )
        : null,
      React.createElement(
        "div",
        { className: "quick-markers-settings-list-section" },
        React.createElement(
          Button,
          {
            variant: "secondary",
            size: "sm",
            className:
              "quick-markers-settings-toggle mb-2" +
              (showPresetList ? " quick-markers-settings-toggle-open" : ""),
            onClick: function () {
              setShowPresetList(!showPresetList);
            },
            "aria-expanded": showPresetList,
          },
          (showPresetList ? "▼ " : "▶ ") +
            "Presets (" +
            config.presets.length +
            ")"
        ),
        showPresetList
          ? config.presets.length > 0
            ? React.createElement(
                "div",
                { className: "quick-markers-settings-list" },
                React.createElement(
                  "div",
                  { className: "quick-markers-settings-list-header" },
                  React.createElement("span", null, "Label"),
                  React.createElement("span", null, "Tag"),
                  React.createElement("span", null, "Keys"),
                  React.createElement("span", {
                    className: "quick-markers-settings-list-actions-hdr",
                    "aria-hidden": true,
                  })
                ),
                config.presets.map(function (preset) {
                  const keys = [
                    preset.rangeInKey && "In: " + preset.rangeInKey,
                    preset.rangeOutKey && "Out: " + preset.rangeOutKey,
                    preset.instantKey && preset.instantKey,
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return React.createElement(
                    "div",
                    {
                      key: preset.id,
                      className: "quick-markers-settings-list-row",
                    },
                    React.createElement("span", null, preset.label),
                    React.createElement("code", null, preset.primaryTag),
                    React.createElement(
                      "span",
                      { className: "quick-markers-settings-keys text-muted" },
                      keys || "—"
                    ),
                    React.createElement(
                      Button,
                      {
                        variant: "danger",
                        size: "sm",
                        onClick: function () {
                          onRemovePreset(preset);
                        },
                      },
                      "Delete"
                    )
                  );
                })
              )
            : React.createElement(
                "p",
                { className: "quick-markers-empty text-muted" },
                "No presets yet."
              )
          : null
      ),
      React.createElement(
        "div",
        { className: "quick-markers-settings-add" },
        React.createElement(
          Button,
          {
            variant: "secondary",
            size: "sm",
            className:
              "quick-markers-settings-toggle mb-2" +
              (showAddForm ? " quick-markers-settings-toggle-open" : ""),
            onClick: function () {
              setShowAddForm(!showAddForm);
            },
            "aria-expanded": showAddForm,
          },
          showAddForm ? "▼ Add preset" : "▶ Add preset"
        ),
        showAddForm
          ? React.createElement(
              "div",
              { className: "quick-markers-settings-add-body" },
              React.createElement(
                "div",
                { className: "form-group" },
                React.createElement("label", { htmlFor: "qm-new-label" }, "Label"),
                React.createElement("input", {
                  id: "qm-new-label",
                  type: "text",
                  className: "form-control",
                  value: newLabel,
                  placeholder: "Compilation",
                  onChange: function (e) {
                    setNewLabel(e.target.value);
                  },
                })
              ),
              React.createElement(
                "div",
                { className: "form-group" },
                React.createElement(
                  "label",
                  { htmlFor: "qm-new-tag" },
                  "Primary tag (must exist in Stash)"
                ),
                React.createElement("input", {
                  id: "qm-new-tag",
                  type: "text",
                  className: "form-control",
                  value: newPrimaryTag,
                  placeholder: "Compilation",
                  onChange: function (e) {
                    setNewPrimaryTag(e.target.value);
                  },
                })
              ),
              React.createElement(
                "div",
                { className: "quick-markers-settings-key-row" },
                React.createElement(
                  "div",
                  { className: "form-group" },
                  React.createElement("label", { htmlFor: "qm-new-in" }, "Range In key"),
                  React.createElement("input", {
                    id: "qm-new-in",
                    type: "text",
                    className: "form-control",
                    value: newRangeIn,
                    onChange: function (e) {
                      setNewRangeIn(e.target.value);
                    },
                  })
                ),
                React.createElement(
                  "div",
                  { className: "form-group" },
                  React.createElement("label", { htmlFor: "qm-new-out" }, "Range Out key"),
                  React.createElement("input", {
                    id: "qm-new-out",
                    type: "text",
                    className: "form-control",
                    value: newRangeOut,
                    onChange: function (e) {
                      setNewRangeOut(e.target.value);
                    },
                  })
                )
              ),
              React.createElement(
                "div",
                { className: "form-group" },
                React.createElement(
                  "label",
                  { htmlFor: "qm-new-instant" },
                  "Instant key (optional)"
                ),
                React.createElement("input", {
                  id: "qm-new-instant",
                  type: "text",
                  className: "form-control",
                  value: newInstant,
                  placeholder: "shift+1",
                  onChange: function (e) {
                    setNewInstant(e.target.value);
                  },
                })
              ),
              React.createElement(
                Button,
                { variant: "primary", onClick: onAddPreset },
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
          className: "mt-2",
          onClick: openJsonModal,
        },
        "Edit JSON (advanced)…"
      ),
      React.createElement(
        Modal,
        {
          show: showJsonModal,
          onHide: closeJsonModal,
          size: "lg",
          className: "quick-markers-json-modal",
        },
        React.createElement(
          Modal.Header,
          { closeButton: true },
          React.createElement(Modal.Title, null, "Edit presets (JSON)")
        ),
        React.createElement(
          Modal.Body,
          null,
          React.createElement(
            "p",
            { className: "text-muted small mb-2" },
            "Full config: defaultPresetIndex and presets array. Tag names must match Stash."
          ),
          React.createElement("textarea", {
            className: "form-control quick-markers-json",
            rows: 16,
            value: jsonModalDraft,
            onChange: function (e) {
              setJsonModalDraft(e.target.value);
            },
          })
        ),
        React.createElement(
          Modal.Footer,
          null,
          React.createElement(
            Button,
            { variant: "secondary", onClick: closeJsonModal },
            "Cancel"
          ),
          React.createElement(
            Button,
            { variant: "primary", onClick: onSaveJsonModal },
            "Save"
          )
        )
      )
    );
  }

  PluginApi.patch.after("PluginSettings", function (props, result) {
    if (props.pluginID !== PLUGIN_ID) {
      return result;
    }
    return React.createElement(QuickMarkersSettings, null);
  });
})();
