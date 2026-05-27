(function () {
  "use strict";

  const PLUGIN_ID = "quickMarkers";
  const PLUGIN_VERSION = "1.2.3";
  const PANEL_OPEN_STORAGE_KEY = "quickMarkers.panelOpen";
  const VALID_PANEL_POSITIONS = [
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
    "hidden",
  ];
  const VALID_TOUCH_CONTROLS = ["auto", "on", "off"];
  const ASSETS_PRESETS = "/plugin/" + PLUGIN_ID + "/assets/presets.json";

  const PluginApi = window.PluginApi;
  if (!PluginApi) {
    console.error("[Quick Markers] PluginApi not available");
    return;
  }

  const StashService = PluginApi.utils.StashService;
  const useFlatMarkerCreateVars = !!(
    StashService && typeof StashService.useSceneMarkerCreate === "function"
  );
  const React = PluginApi.React;
  const GQL = PluginApi.GQL;
  const Mousetrap = PluginApi.libraries.Mousetrap;

  const DEFAULT_PRESETS_CONFIG = {
    defaultPresetIndex: 0,
    panelPosition: "top-left",
    panelCollapsed: true,
    touchControls: "auto",
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
  };

  console.info("[Quick Markers] loaded v" + PLUGIN_VERSION);

  function normalizePanelPosition(value) {
    const pos = String(value || "top-left")
      .trim()
      .toLowerCase();
    return VALID_PANEL_POSITIONS.indexOf(pos) >= 0 ? pos : "top-left";
  }

  function normalizeTouchControls(value) {
    const v = String(value || "auto").trim().toLowerCase();
    return VALID_TOUCH_CONTROLS.indexOf(v) >= 0 ? v : "auto";
  }

  function isTouchActive(setting) {
    if (setting === "on") return true;
    if (setting === "off") return false;
    try {
      return (
        window.matchMedia("(pointer: coarse)").matches ||
        navigator.maxTouchPoints > 0
      );
    } catch (e) {
      return false;
    }
  }

  function readStoredPanelOpen(fallbackOpen) {
    try {
      const stored = localStorage.getItem(PANEL_OPEN_STORAGE_KEY);
      if (stored === "1") return true;
      if (stored === "0") return false;
    } catch (e) {
      /* ignore */
    }
    return fallbackOpen;
  }

  function storePanelOpen(open) {
    try {
      localStorage.setItem(PANEL_OPEN_STORAGE_KEY, open ? "1" : "0");
    } catch (e) {
      /* ignore */
    }
  }

  function getDefaultPresetsConfig() {
    return {
      defaultPresetIndex: DEFAULT_PRESETS_CONFIG.defaultPresetIndex,
      panelPosition: DEFAULT_PRESETS_CONFIG.panelPosition,
      panelCollapsed: DEFAULT_PRESETS_CONFIG.panelCollapsed,
      touchControls: DEFAULT_PRESETS_CONFIG.touchControls,
      presets: DEFAULT_PRESETS_CONFIG.presets.map(function (p) {
        return {
          id: p.id,
          label: p.label,
          primaryTag: p.primaryTag,
          tags: p.tags || [],
          title: p.title,
          rangeInKey: p.rangeInKey,
          rangeOutKey: p.rangeOutKey,
          instantKey: p.instantKey,
        };
      }),
    };
  }

  const tagIdCache = new Map();
  const inPointByScene = new Map();

  function getPlayerTime() {
    const player = PluginApi.utils.InteractiveUtils.getPlayer();
    if (!player || typeof player.currentTime !== "function") return null;
    const t = player.currentTime();
    return typeof t === "number" && !isNaN(t) ? t : null;
  }

  function formatError(err) {
    if (!err) return "Unknown error";
    if (err.graphQLErrors && err.graphQLErrors.length) {
      return err.graphQLErrors.map(function (e) {
        return e.message;
      }).join("; ");
    }
    return err.message || String(err);
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return m + ":" + String(sec).padStart(2, "0");
  }

  function normalizePresetTags(value, primaryTag) {
    let list = [];
    if (Array.isArray(value)) {
      list = value.map(function (t) {
        return String(t).trim();
      });
    } else if (typeof value === "string" && value.trim()) {
      list = value.split(",").map(function (t) {
        return t.trim();
      });
    }
    const primaryKey = String(primaryTag || "")
      .trim()
      .toLowerCase();
    const seen = new Set();
    return list
      .filter(function (name) {
        return !!name;
      })
      .filter(function (name) {
        const key = name.toLowerCase();
        if (primaryKey && key === primaryKey) return false;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
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
        tags: normalizePresetTags(p.tags, primaryTag),
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
    const panelPosition = normalizePanelPosition(parsed.panelPosition);
    const panelCollapsed =
      parsed.panelCollapsed === undefined || parsed.panelCollapsed === null
        ? true
        : !!parsed.panelCollapsed;
    const touchControls = normalizeTouchControls(parsed.touchControls);
    return {
      presets: normalized,
      defaultPresetIndex: defaultIndex,
      panelPosition: panelPosition,
      panelCollapsed: panelCollapsed,
      touchControls: touchControls,
    };
  }

  function presetsToJson(config) {
    const root = {
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
          if (p.tags && p.tags.length) o.tags = p.tags;
          return o;
        }),
    };
    if (config.panelPosition && config.panelPosition !== "top-left") {
      root.panelPosition = config.panelPosition;
    }
    if (config.panelCollapsed === false) {
      root.panelCollapsed = false;
    }
    if (config.touchControls && config.touchControls !== "auto") {
      root.touchControls = config.touchControls;
    }
    return JSON.stringify(root, null, 2);
  }

  function getPresetsFromSettings(plugins) {
    if (!plugins || typeof plugins !== "object") return null;
    const raw = plugins[PLUGIN_ID] && plugins[PLUGIN_ID].presetsJson;
    if (!raw || !String(raw).trim()) return null;
    return parsePresetsJson(raw);
  }

  async function loadPresetsFromFile() {
    const res = await fetch(ASSETS_PRESETS, { credentials: "same-origin" });
    if (!res.ok) return null;
    return parsePresetsJson(await res.text());
  }

  function usePresetsConfig() {
    const [config, setConfig] = React.useState(getDefaultPresetsConfig);
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
          if (!cfg) cfg = getDefaultPresetsConfig();
          if (!cancelled) setConfig(cfg);
        } catch (e) {
          if (!cancelled) {
            setError(e.message || String(e));
            setConfig(getDefaultPresetsConfig());
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
    const equalsModifier =
      GQL.CriterionModifier && GQL.CriterionModifier.Equals
        ? GQL.CriterionModifier.Equals
        : "EQUALS";
    const includesModifier =
      GQL.CriterionModifier && GQL.CriterionModifier.Includes
        ? GQL.CriterionModifier.Includes
        : "INCLUDES";

    return React.useCallback(
      async function resolveTagId(tagName) {
        const key = tagName.toLowerCase();
        if (tagIdCache.has(key)) return tagIdCache.get(key);

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

        if (!tags || !tags.length) {
          throw new Error(
            'Tag "' +
              tagName +
              '" not found. Create it under Tags (exact name as primaryTag).'
          );
        }

        const exact =
          tags.find(function (t) {
            return t.name.toLowerCase() === key;
          }) || tags[0];

        tagIdCache.set(key, exact.id);
        return exact.id;
      },
      [findTags, equalsModifier, includesModifier]
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
    const [panelOpen, setPanelOpen] = React.useState(false);
    const panelInitRef = React.useRef(false);

    React.useEffect(
      function () {
        if (!config || panelInitRef.current) return;
        panelInitRef.current = true;
        const defaultOpen = config.panelCollapsed === false;
        setPanelOpen(readStoredPanelOpen(defaultOpen));
      },
      [config]
    );

    function togglePanelOpen() {
      setPanelOpen(function (open) {
        const next = !open;
        storePanelOpen(next);
        return next;
      });
    }

    const useCreateMarker =
      StashService && StashService.useSceneMarkerCreate
        ? StashService.useSceneMarkerCreate
        : GQL.useSceneMarkerCreateMutation;
    const [createMarker] = useCreateMarker();

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
        const extraTagIds = [];
        const extraTags = preset.tags || [];
        for (let i = 0; i < extraTags.length; i++) {
          const extraId = await resolveTagId(extraTags[i]);
          if (extraId !== tagId && extraTagIds.indexOf(extraId) < 0) {
            extraTagIds.push(extraId);
          }
        }
        const from = Math.min(startSeconds, endSeconds ?? startSeconds);
        const to =
          typeof endSeconds === "number" && endSeconds > from + 0.05
            ? Math.max(startSeconds, endSeconds)
            : null;

        const markerVars = {
          scene_id: scene.id,
          title: preset.title,
          seconds: from,
          end_seconds: to,
          primary_tag_id: tagId,
          tag_ids: extraTagIds,
        };
        await createMarker({
          variables: useFlatMarkerCreateVars
            ? markerVars
            : { input: markerVars },
        });

        const rangeMsg =
          to != null
            ? formatTime(from) + " – " + formatTime(to)
            : formatTime(from);
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
          Toast.error(formatError(e));
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
          Toast.error(formatError(e));
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
          Mousetrap.bind(key, function (e) {
            if (e && e.preventDefault) e.preventDefault();
            fn(e);
            return false;
          });
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
            Mousetrap.unbind(key);
          });
        };
      },
      [config, scene, activePreset, onInstant, onRangeIn, onRangeOut]
    );

    if (!config || !activePreset) return null;

    const panelPosition = normalizePanelPosition(
      config.panelPosition || "top-left"
    );
    const showTouchBar = isTouchActive(
      normalizeTouchControls(config.touchControls)
    );

    var floatingPanel =
      panelPosition !== "hidden"
        ? React.createElement(
            "div",
            {
              className:
                "quick-markers-panel quick-markers-panel-pos-" +
                panelPosition +
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
                  onClick: togglePanelOpen,
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
                            ? "Click = active for Shift+I/O. Double-click or " +
                              preset.instantKey +
                              " = instant marker"
                            : "Click to use with Shift+I/O",
                          onClick: function () {
                            setActiveIndex(index);
                          },
                          onDoubleClick: function () {
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
          )
        : null;

    var touchBar = showTouchBar
      ? React.createElement(
          "div",
          { className: "quick-markers-touch-bar" },
          React.createElement(
            "div",
            { className: "quick-markers-touch-actions" },
            React.createElement(
              "button",
              {
                type: "button",
                className:
                  "quick-markers-touch-btn quick-markers-touch-in" +
                  (inPoint != null ? " active" : ""),
                onClick: function () {
                  onRangeIn(activePreset);
                },
              },
              inPoint != null ? "IN " + formatTime(inPoint) : "IN"
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: "quick-markers-touch-btn quick-markers-touch-out",
                disabled: inPoint == null,
                onClick: function () {
                  onRangeOut(activePreset);
                },
              },
              "OUT"
            ),
            React.createElement(
              "button",
              {
                type: "button",
                className: "quick-markers-touch-btn quick-markers-touch-instant",
                onClick: function () {
                  onInstant(activePreset);
                },
              },
              "INSTANT"
            )
          ),
          React.createElement(
            "div",
            { className: "quick-markers-touch-presets" },
            config.presets.map(function (preset, index) {
              const isActive = index === activeIndex;
              return React.createElement(
                "button",
                {
                  key: preset.id,
                  type: "button",
                  className:
                    "quick-markers-touch-preset" +
                    (isActive ? " active" : ""),
                  onClick: function () {
                    setActiveIndex(index);
                  },
                },
                preset.label
              );
            })
          ),
          status
            ? React.createElement(
                "div",
                { className: "quick-markers-touch-status" },
                status
              )
            : null
        )
      : null;

    return React.createElement(React.Fragment, null, floatingPanel, touchBar);
  }

  PluginApi.patch.after("ScenePage", function () {
    var args = Array.prototype.slice.call(arguments);
    var result = args[args.length - 1];
    var props = args[0];
    if (!props || !props.scene) return result;
    return React.createElement(
      React.Fragment,
      null,
      result,
      React.createElement(QuickMarkersSceneHook, { scene: props.scene })
    );
  });

  const TAGS_HELP_I18N = {
    de: {
      title: "Zusatz-Tags im Preset-JSON (tags)",
      button: "Hilfe: tags in JSON",
      intro:
        "So fügst du weitere Tags (nicht den Primärtag) nachträglich in die Preset-Konfiguration ein. Gespeichert wird in der Stash-Datenbank, nicht in einer Datei auf der Festplatte.",
      step1: "Hier in den Plugin-Settings auf Edit JSON (advanced) klicken (Button unten auf dieser Seite).",
      step2:
        "Im Array presets das gewünschte Preset suchen (z. B. an id oder label).",
      step3:
        "Zeile tags einfügen oder anpassen — Array aus Tag-Namen, exakt wie in Stash unter Tags.",
      primaryNote:
        "primaryTag = Primärtag am Marker. tags = zusätzliche normale Tags. Den Primärtag nicht nochmal in tags eintragen.",
      saveNote:
        "Save im JSON-Dialog — danach Reload plugins und Reload UI in Stash.",
      warning:
        "Wichtig: Das gilt für neue Marker, die du danach mit Quick Markers anlegst. Bereits existierende Marker auf Szenen werden durch JSON-Änderungen nicht automatisch aktualisiert — dafür Marker in Stash bearbeiten (Tab Markers → Edit → Feld Tags).",
      ok: "OK",
    },
    en: {
      title: "Additional tags in preset JSON (tags)",
      button: "Help: tags in JSON",
      intro:
        "How to add extra tags (not the primary tag) to a preset later. Saved in the Stash database (plugin settings), not as a file on disk.",
      step1:
        'In these plugin settings, click Edit JSON (advanced) (button at the bottom of this page).',
      step2: "In the presets array, find the preset (e.g. by id or label).",
      step3:
        'Add or edit the tags line — array of tag names, exactly as in Stash under Tags.',
      primaryNote:
        "primaryTag = primary tag on the marker. tags = additional tags. Do not duplicate the primary tag in tags.",
      saveNote: "Click Save in the JSON dialog, then Reload plugins and Reload UI in Stash.",
      warning:
        "Important: This applies to new markers you create with Quick Markers after saving. Existing markers on scenes are not updated by JSON changes — edit them in Stash (Markers tab → Edit → Tags field).",
      ok: "OK",
    },
  };

  function getTagsHelpLang() {
    try {
      const lang = String(navigator.language || "en").toLowerCase();
      if (lang.startsWith("de")) return "de";
    } catch (e) {
      /* ignore */
    }
    return "en";
  }

  function TagsHelpModal(props) {
    if (!props.open) return null;
    const t = TAGS_HELP_I18N[getTagsHelpLang()];
    return React.createElement(
      "div",
      {
        className: "quick-markers-modal-backdrop",
        role: "presentation",
        onClick: props.onClose,
      },
      React.createElement(
        "div",
        {
          className: "quick-markers-modal quick-markers-tags-help-modal",
          role: "dialog",
          "aria-modal": true,
          "aria-labelledby": "qm-tags-help-title",
          onClick: function (e) {
            e.stopPropagation();
          },
        },
        React.createElement(
          "div",
          { className: "quick-markers-modal-header" },
          React.createElement(
            "h3",
            { id: "qm-tags-help-title", className: "quick-markers-modal-title" },
            t.title
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "quick-markers-modal-close",
              "aria-label": "Close",
              onClick: props.onClose,
            },
            "×"
          )
        ),
        React.createElement(
          "div",
          { className: "quick-markers-modal-body quick-markers-tags-help-body" },
          React.createElement("p", null, t.intro),
          React.createElement(
            "ol",
            { className: "quick-markers-tags-help-steps" },
            React.createElement("li", null, t.step1),
            React.createElement("li", null, t.step2),
            React.createElement("li", null, t.step3)
          ),
          React.createElement(
            "pre",
            { className: "quick-markers-tags-help-code" },
            '{\n  "id": "com-joi",\n  "label": "Com Joi",\n  "primaryTag": "Compilation",\n  "tags": ["Joi", "Talk"],\n  "title": "Com Joi",\n  "rangeInKey": "shift+i",\n  "rangeOutKey": "shift+o"\n}'
          ),
          React.createElement("p", null, t.primaryNote),
          React.createElement("p", null, t.saveNote),
          React.createElement(
            "p",
            { className: "text-muted small mb-0" },
            t.warning
          )
        ),
        React.createElement(
          "div",
          { className: "quick-markers-modal-footer" },
          React.createElement(
            "button",
            {
              type: "button",
              className: "btn btn-primary",
              onClick: props.onClose,
            },
            t.ok
          )
        )
      )
    );
  }

  function QuickMarkersSettings() {
    const { plugins, savePluginSettings, loading } = PluginApi.hooks.useSettings();
    const Toast = PluginApi.hooks.useToast();
    const tagsHelpT = TAGS_HELP_I18N[getTagsHelpLang()];

    const [config, setConfig] = React.useState({
      defaultPresetIndex: 0,
      presets: [],
    });
    const [usingFile, setUsingFile] = React.useState(false);
    const [usingDefaults, setUsingDefaults] = React.useState(false);
    const [loadError, setLoadError] = React.useState(null);
    const [showPresetList, setShowPresetList] = React.useState(false);
    const [showAddForm, setShowAddForm] = React.useState(false);
    const [showJsonModal, setShowJsonModal] = React.useState(false);
    const [showTagsHelpModal, setShowTagsHelpModal] = React.useState(false);
    const [jsonModalDraft, setJsonModalDraft] = React.useState("");

    const [newLabel, setNewLabel] = React.useState("");
    const [newPrimaryTag, setNewPrimaryTag] = React.useState("");
    const [newTags, setNewTags] = React.useState("");
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
                setUsingDefaults(false);
              }
              return;
            }
            const fromFile = await loadPresetsFromFile();
            if (!cancelled) {
              if (fromFile) {
                setConfig(fromFile);
                setUsingFile(true);
                setUsingDefaults(false);
              } else {
                setConfig(getDefaultPresetsConfig());
                setUsingFile(false);
                setUsingDefaults(true);
              }
            }
          } catch (e) {
            if (!cancelled) {
              setLoadError(e.message || String(e));
              setConfig(getDefaultPresetsConfig());
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
        {
          defaultPresetIndex: config.defaultPresetIndex,
          panelPosition: config.panelPosition || "top-left",
          panelCollapsed: config.panelCollapsed !== false,
          touchControls: config.touchControls || "auto",
          presets: config.presets,
        },
        updates
      );
      savePluginSettings(PLUGIN_ID, {
        presetsJson: presetsToJson(nextConfig),
      });
      setConfig(nextConfig);
      setUsingFile(false);
      setUsingDefaults(false);
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
            tags: normalizePresetTags(newTags, primaryTag),
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
      setNewTags("");
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
        { className: "quick-markers-settings-version text-muted" },
        "Quick Markers v" + PLUGIN_VERSION + " — if you do not see this version, Stash is still using old plugin files."
      ),
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
      React.createElement(TagsHelpModal, {
        open: showTagsHelpModal,
        onClose: function () {
          setShowTagsHelpModal(false);
        },
      }),
      usingFile
        ? React.createElement(
            "p",
            { className: "quick-markers-settings-note text-muted" },
            "Loaded from ",
            React.createElement("code", null, "presets.json"),
            ". Saving here overrides the file."
          )
        : usingDefaults
          ? React.createElement(
              "p",
              { className: "quick-markers-settings-note text-muted" },
              "Using built-in defaults (no ",
              React.createElement("code", null, "presets.json"),
              " yet). Add a preset or click Save in JSON to store settings in Stash. Optional: copy ",
              React.createElement("code", null, "presets.json.example"),
              " → ",
              React.createElement("code", null, "presets.json"),
              " in the plugin folder."
            )
          : null,
      loadError
        ? React.createElement("p", { className: "text-warning" }, loadError)
        : null,
      React.createElement(
        "div",
        { className: "form-group quick-markers-panel-ui" },
        React.createElement(
          "label",
          { htmlFor: "qm-panel-position" },
          "Scene panel position"
        ),
        React.createElement(
          "select",
          {
            id: "qm-panel-position",
            className: "form-control",
            value: normalizePanelPosition(config.panelPosition),
            onChange: function (e) {
              persistConfig({
                panelPosition: normalizePanelPosition(e.target.value),
              });
            },
          },
          React.createElement(
            "option",
            { value: "top-left" },
            "Top left (default)"
          ),
          React.createElement("option", { value: "top-right" }, "Top right"),
          React.createElement(
            "option",
            { value: "bottom-left" },
            "Bottom left"
          ),
          React.createElement(
            "option",
            { value: "bottom-right" },
            "Bottom right (old)"
          ),
          React.createElement(
            "option",
            { value: "hidden" },
            "Hidden (hotkeys only)"
          )
        ),
        React.createElement(
          "p",
          { className: "text-muted small mb-2" },
          "Collapsed by default on the scene page. Click ▶ on the panel to expand; Stash remembers that per browser."
        ),
        React.createElement(
          "div",
          { className: "form-check" },
          React.createElement("input", {
            id: "qm-panel-collapsed",
            className: "form-check-input",
            type: "checkbox",
            checked: config.panelCollapsed !== false,
            onChange: function (e) {
              persistConfig({ panelCollapsed: e.target.checked });
            },
          }),
          React.createElement(
            "label",
            { className: "form-check-label", htmlFor: "qm-panel-collapsed" },
            "Start scene panel collapsed"
          )
        )
      ),
      React.createElement(
        "div",
        { className: "form-group quick-markers-panel-ui" },
        React.createElement(
          "label",
          { htmlFor: "qm-touch-controls" },
          "Touch controls (Android / tablet)"
        ),
        React.createElement(
          "select",
          {
            id: "qm-touch-controls",
            className: "form-control",
            value: normalizeTouchControls(config.touchControls),
            onChange: function (e) {
              persistConfig({
                touchControls: normalizeTouchControls(e.target.value),
              });
            },
          },
          React.createElement(
            "option",
            { value: "auto" },
            "Auto-detect (default)"
          ),
          React.createElement("option", { value: "on" }, "Always on"),
          React.createElement("option", { value: "off" }, "Always off")
        ),
        React.createElement(
          "p",
          { className: "text-muted small mb-0" },
          "Shows IN / OUT / INSTANT buttons below the video player. Auto-detect enables them on touch devices (phones, tablets) and hides them on desktop."
        )
      ),
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
          "button",
          {
            type: "button",
            className:
              "btn btn-secondary btn-sm quick-markers-settings-toggle mb-2" +
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
                  React.createElement("span", null, "Tags"),
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
                    React.createElement(
                      "span",
                      { className: "quick-markers-settings-tags" },
                      React.createElement("code", null, preset.primaryTag),
                      preset.tags && preset.tags.length
                        ? React.createElement(
                            "span",
                            { className: "text-muted" },
                            " + " + preset.tags.join(", ")
                          )
                        : null
                    ),
                    React.createElement(
                      "span",
                      { className: "quick-markers-settings-keys text-muted" },
                      keys || "—"
                    ),
                    React.createElement(
                      "button",
                      {
                        type: "button",
                        className: "btn btn-danger btn-sm",
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
          "button",
          {
            type: "button",
            className:
              "btn btn-secondary btn-sm quick-markers-settings-toggle mb-2" +
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
                { className: "form-group" },
                React.createElement(
                  "label",
                  { htmlFor: "qm-new-tags" },
                  "Additional tags (optional)"
                ),
                React.createElement("input", {
                  id: "qm-new-tags",
                  type: "text",
                  className: "form-control",
                  value: newTags,
                  placeholder: "Favorite, Outdoor",
                  onChange: function (e) {
                    setNewTags(e.target.value);
                  },
                }),
                React.createElement(
                  "p",
                  { className: "text-muted small mb-0" },
                  "Comma-separated. Must exist in Stash Tags. Not the same as primary tag."
                )
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
                "button",
                { type: "button", className: "btn btn-primary", onClick: onAddPreset },
                "Add"
              )
            )
          : null
      ),
      React.createElement(
        "div",
        { className: "quick-markers-settings-json-actions mt-2" },
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-secondary btn-sm",
            onClick: openJsonModal,
          },
          "Edit JSON (advanced)…"
        ),
        React.createElement(
          "button",
          {
            type: "button",
            className: "btn btn-outline-info btn-sm",
            onClick: function () {
              setShowTagsHelpModal(true);
            },
          },
          tagsHelpT.button
        )
      ),
      showJsonModal
        ? React.createElement(
            "div",
            {
              className: "quick-markers-modal-backdrop",
              role: "presentation",
              onClick: closeJsonModal,
            },
            React.createElement(
              "div",
              {
                className: "quick-markers-modal",
                role: "dialog",
                "aria-modal": true,
                "aria-labelledby": "qm-json-modal-title",
                onClick: function (e) {
                  e.stopPropagation();
                },
              },
              React.createElement(
                "div",
                { className: "quick-markers-modal-header" },
                React.createElement(
                  "h3",
                  { id: "qm-json-modal-title", className: "quick-markers-modal-title" },
                  "Edit presets (JSON)"
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "quick-markers-modal-close",
                    "aria-label": "Close",
                    onClick: closeJsonModal,
                  },
                  "×"
                )
              ),
              React.createElement(
                "div",
                { className: "quick-markers-modal-body" },
                React.createElement(
                  "p",
                  { className: "text-muted small mb-2" },
                  "Full config: defaultPresetIndex and presets array. Each preset: primaryTag (required), optional tags array for extra marker tags. Names must exist in Stash."
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
                "div",
                { className: "quick-markers-modal-footer" },
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-secondary",
                    onClick: closeJsonModal,
                  },
                  "Cancel"
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-primary",
                    onClick: onSaveJsonModal,
                  },
                  "Save"
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
    return React.createElement(QuickMarkersSettings, null);
  });
})();
