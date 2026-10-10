(function () {
  "use strict";

  const PLUGIN_ID = "quickMarkers";
  const PLUGIN_VERSION = "1.5.0";
  const PANEL_OPEN_STORAGE_KEY = "quickMarkers.panelOpen";
  const PANEL_POS_STORAGE_KEY = "quickMarkers.panelPos";
  const TOUCH_BAR_OPEN_STORAGE_KEY = "quickMarkers.touchBarOpen";
  const TOUCH_HOST_CLASS = "quick-markers-touch-host";
  const DEFAULT_INSTANT_KEY = "shift+m";
  const PRESET_SELECT_KEY_RE = /^shift\+[1-9]$/;
  const VALID_PANEL_POSITIONS = [
    "top-left",
    "top-right",
    "bottom-left",
    "bottom-right",
    "hidden",
  ];
  const VALID_TOUCH_CONTROLS = ["auto", "on", "off"];
  const ASSETS_PRESETS = "/plugin/" + PLUGIN_ID + "/assets/presets.json";
  const MARKER_COPY_URL =
    "/plugin/" + PLUGIN_ID + "/assets/markerCopy.js?v=" + PLUGIN_VERSION;
  const MARKER_CLIPBOARD_EVENT = "quickMarkers:clipboard";

  const PluginApi = window.PluginApi;
  if (!PluginApi || !PluginApi.React || !PluginApi.GQL) {
    console.error("[Quick Markers] PluginApi not available");
    return;
  }

  const React = PluginApi.React;
  const ReactDOM = PluginApi.ReactDOM || window.ReactDOM;
  const createPortal =
    ReactDOM && typeof ReactDOM.createPortal === "function"
      ? ReactDOM.createPortal
      : null;
  const GQL = PluginApi.GQL;
  const utils = PluginApi.utils || {};
  const libraries = PluginApi.libraries || {};
  const hooks = PluginApi.hooks || {};
  const StashService = utils.StashService;
  const useFlatMarkerCreateVars = !!(
    StashService && typeof StashService.useSceneMarkerCreate === "function"
  );
  const Mousetrap = libraries.Mousetrap;

  const useCreateMarkerHook =
    StashService && typeof StashService.useSceneMarkerCreate === "function"
      ? StashService.useSceneMarkerCreate
      : typeof GQL.useSceneMarkerCreateMutation === "function"
        ? GQL.useSceneMarkerCreateMutation
        : function useUnavailableCreateMarker() {
            return [
              function () {
                return Promise.reject(
                  new Error("Scene marker create API unavailable")
                );
              },
            ];
          };

  var ScenePatchErrorBoundary = (function () {
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
      console.error("[Quick Markers] ScenePage UI render failed", err, info);
    };
    Boundary.prototype.render = function () {
      if (this.state.hasError) return null;
      return this.props.children;
    };
    return Boundary;
  })();

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
        instantKey: "shift+m",
        selectSlot: 1,
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

  function readStoredTouchBarOpen(fallbackOpen) {
    try {
      const stored = localStorage.getItem(TOUCH_BAR_OPEN_STORAGE_KEY);
      if (stored === "1") return true;
      if (stored === "0") return false;
    } catch (e) {
      /* ignore */
    }
    return fallbackOpen;
  }

  function storeTouchBarOpen(open) {
    try {
      localStorage.setItem(TOUCH_BAR_OPEN_STORAGE_KEY, open ? "1" : "0");
    } catch (e) {
      /* ignore */
    }
  }

  function readStoredPanelPos() {
    try {
      const raw = localStorage.getItem(PANEL_POS_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (
        parsed &&
        typeof parsed.left === "number" &&
        typeof parsed.top === "number" &&
        !isNaN(parsed.left) &&
        !isNaN(parsed.top)
      ) {
        return { left: parsed.left, top: parsed.top };
      }
    } catch (e) {
      /* ignore */
    }
    return null;
  }

  function storePanelPos(pos) {
    try {
      if (!pos) {
        localStorage.removeItem(PANEL_POS_STORAGE_KEY);
        return;
      }
      localStorage.setItem(
        PANEL_POS_STORAGE_KEY,
        JSON.stringify({ left: pos.left, top: pos.top })
      );
    } catch (e) {
      /* ignore */
    }
  }

  function clampPanelPos(left, top, width, height) {
    const maxLeft = Math.max(0, window.innerWidth - width);
    const maxTop = Math.max(0, window.innerHeight - height);
    return {
      left: Math.min(Math.max(0, left), maxLeft),
      top: Math.min(Math.max(0, top), maxTop),
    };
  }

  /**
   * Where the touch bar sits: in the page flow right under the video, inside
   * Stash's .VideoPlayer (a height-capped flex column), so the video gets a
   * little smaller instead of being covered. Nothing is positioned over the
   * player, so its seek bar and settings stay reachable in every theme.
   */
  function findTouchBarAnchor() {
    const wrapper = document.querySelector(".VideoPlayer > .video-wrapper");
    if (wrapper) return wrapper;
    const player = document.querySelector(".video-js, #VideoJsPlayer");
    if (player && player.parentElement) {
      return player.closest(".video-wrapper") || player;
    }
    return null;
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
          selectSlot: p.selectSlot != null ? p.selectSlot : 1,
        };
      }),
    };
  }

  const tagIdCache = new Map();
  const inPointByScene = new Map();

  function getPlayerTime() {
    try {
      const interactive = utils.InteractiveUtils;
      if (!interactive || typeof interactive.getPlayer !== "function") {
        return null;
      }
      const player = interactive.getPlayer();
      if (!player || typeof player.currentTime !== "function") return null;
      const t = player.currentTime();
      return typeof t === "number" && !isNaN(t) ? t : null;
    } catch (e) {
      return null;
    }
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

  function normalizeSelectSlot(value, index) {
    if (value === null || value === "" || value === false || value === 0) {
      return null;
    }
    if (value === undefined) {
      return index < 9 ? index + 1 : null;
    }
    if (typeof value === "string") {
      const trimmed = value.trim().toLowerCase();
      if (!trimmed || trimmed === "none" || trimmed === "off") return null;
      const fromKey = trimmed.match(/^shift\+([1-9])$/);
      if (fromKey) return Number(fromKey[1]);
      const asNum = Number(trimmed);
      if (asNum >= 1 && asNum <= 9) return asNum;
      return null;
    }
    const n = Number(value);
    if (n >= 1 && n <= 9) return n;
    return null;
  }

  function selectSlotToKey(slot) {
    return slot ? "shift+" + slot : "";
  }

  function nextFreeSelectSlot(presets) {
    const used = {};
    (presets || []).forEach(function (p) {
      if (p && p.selectSlot) used[p.selectSlot] = true;
    });
    for (let n = 1; n <= 9; n++) {
      if (!used[n]) return n;
    }
    return null;
  }

  function normalizeInstantKey(value) {
    const key = String(value == null ? "" : value)
      .trim()
      .toLowerCase();
    // Shift+1–9 are reserved for selecting the active preset.
    if (!key || PRESET_SELECT_KEY_RE.test(key)) return DEFAULT_INSTANT_KEY;
    return key;
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
        // Default shared hotkeys; Shift+1–9 select presets (not instant).
        rangeInKey: (p.rangeInKey || "shift+i").trim().toLowerCase(),
        rangeOutKey: (p.rangeOutKey || "shift+o").trim().toLowerCase(),
        instantKey: normalizeInstantKey(p.instantKey),
        selectSlot: normalizeSelectSlot(p.selectSlot, index),
      };
    });
    // Ensure select slots are unique (first preset wins).
    const claimed = {};
    normalized.forEach(function (preset) {
      if (!preset.selectSlot) return;
      if (claimed[preset.selectSlot]) {
        preset.selectSlot = null;
      } else {
        claimed[preset.selectSlot] = true;
      }
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
          if (p.selectSlot) o.selectSlot = p.selectSlot;
          else o.selectSlot = null;
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

  function useSafeToast() {
    if (typeof hooks.useToast === "function") {
      return hooks.useToast();
    }
    return {
      success: function (m) {
        console.info("[Quick Markers]", m);
      },
      error: function (m) {
        console.error("[Quick Markers]", m);
      },
    };
  }

  // ---------- Copying markers between scenes ----------
  // markerCopy.js is shared with Stash UI (stashui.js); loaded with import() on first use.

  let markerCopyPromise = null;

  function loadMarkerCopy() {
    if (!markerCopyPromise) {
      markerCopyPromise = import(MARKER_COPY_URL);
      markerCopyPromise.catch(function () {
        markerCopyPromise = null;
      });
    }
    return markerCopyPromise;
  }

  /** Copied markers; follows copies made in other tabs and in Stash UI (same localStorage). */
  function useMarkerClipboard() {
    const [clip, setClip] = React.useState(null);
    React.useEffect(function () {
      let cancelled = false;
      function read() {
        loadMarkerCopy()
          .then(function (mc) {
            if (!cancelled) setClip(mc.readClipboard());
          })
          .catch(function (e) {
            console.error("[Quick Markers] markerCopy.js not loaded", e);
          });
      }
      read();
      window.addEventListener("storage", read);
      window.addEventListener(MARKER_CLIPBOARD_EVENT, read);
      return function () {
        cancelled = true;
        window.removeEventListener("storage", read);
        window.removeEventListener(MARKER_CLIPBOARD_EVENT, read);
      };
    }, []);
    return clip;
  }

  const PLAN_STATUS_NOTE = { exists: "already there", outside: "outside the video" };

  function PlanList(props) {
    const mc = props.mc;
    return React.createElement(
      "ul",
      { className: "quick-markers-plan" },
      props.plan.map(function (p, index) {
        const m = p.marker;
        const time =
          mc.formatTime(p.seconds) +
          (p.end_seconds != null ? " – " + mc.formatTime(p.end_seconds) : "");
        const chips = (m.primaryTag && m.title ? [m.primaryTag] : []).concat(
          m.tags.filter(function (tag) {
            return !m.primaryTag || tag.id !== m.primaryTag.id;
          })
        );
        return React.createElement(
          "li",
          { key: index, className: "is-" + p.status },
          React.createElement("b", null, time),
          React.createElement(
            "span",
            null,
            mc.markerLabel(m),
            chips.map(function (tag) {
              return React.createElement(
                "i",
                { key: tag.id, className: "quick-markers-chip" },
                tag.name
              );
            })
          ),
          p.status !== "new"
            ? React.createElement("small", null, PLAN_STATUS_NOTE[p.status])
            : null
        );
      })
    );
  }

  /**
   * mode "paste": paste the copied markers into this scene (with an optional shift).
   * mode "same":  copy this scene's markers to scenes with the same video (phash),
   *               or take the markers of one of them.
   * createInScene(input, isLast) creates a marker in *this* scene (refreshes Stash's views).
   */
  function MarkerTransferModal(props) {
    const sceneId = String(props.sceneId);
    const Toast = props.Toast;
    const [data, setData] = React.useState(null); // { mc, clip?, scene, list? }
    const [error, setError] = React.useState(null);
    const [offset, setOffset] = React.useState("0");
    const [picked, setPicked] = React.useState({});
    const [busy, setBusy] = React.useState("");
    const [coverage, setCoverage] = React.useState("");

    React.useEffect(
      function () {
        let cancelled = false;
        (async function () {
          try {
            const mc = await loadMarkerCopy();
            const scene = await mc.loadScene(mc.gqlFetch, sceneId);
            if (props.mode === "paste") {
              const clip = mc.readClipboard();
              if (!clip) throw new Error("Nothing copied yet.");
              if (clip.sceneId === sceneId) {
                throw new Error("These markers were copied from this scene.");
              }
              if (!cancelled) setData({ mc: mc, clip: clip, scene: scene });
              return;
            }
            const list = scene.phashes.length
              ? await mc.findSameVideos(mc.gqlFetch, scene)
              : [];
            const pre = {};
            list.forEach(function (x) {
              if (x.sure && x.add > 0) pre[x.scene.id] = true;
            });
            if (!cancelled) {
              setPicked(pre);
              setData({ mc: mc, scene: scene, list: list });
            }
            if (!list.length) {
              const c = await mc.phashCoverage(mc.gqlFetch);
              if (!cancelled) {
                setCoverage(
                  c.withPhash + " of " + c.total + " scenes have a fingerprint so far."
                );
              }
            }
          } catch (e) {
            if (!cancelled) setError(formatError(e));
          }
        })();
        return function () {
          cancelled = true;
        };
      },
      [props.mode, sceneId]
    );

    React.useEffect(
      function () {
        function onKey(e) {
          if (e.key === "Escape" && !busy) props.onClose();
        }
        window.addEventListener("keydown", onKey);
        return function () {
          window.removeEventListener("keydown", onKey);
        };
      },
      [busy, props.onClose]
    );

    // A failure part-way leaves some markers created: close, so opening again plans from the real state.
    function fail(e) {
      Toast.error(formatError(e));
      props.onClose();
    }

    async function runPaste(plan) {
      setBusy("…");
      try {
        const n = await data.mc.applyPlan(props.createInScene, sceneId, plan, function (i, total) {
          setBusy(i + " / " + total);
        });
        Toast.success(n + " markers pasted");
        props.onClose();
      } catch (e) {
        fail(e);
      }
    }

    async function runCopyToScenes() {
      const mc = data.mc;
      const targets = data.list.filter(function (x) {
        return picked[x.scene.id];
      });
      let total = 0;
      try {
        for (let i = 0; i < targets.length; i++) {
          setBusy(i + 1 + " / " + targets.length);
          total += await mc.applyPlan(mc.createWithGql(mc.gqlFetch), targets[i].scene.id, targets[i].plan);
        }
        Toast.success(total + " markers copied to " + targets.length + " scenes");
        props.onClose();
      } catch (e) {
        fail(e);
      }
    }

    async function generatePhashes() {
      const ok = window.confirm(
        "Start a Stash task that creates the video fingerprint (phash) for all scenes without one? It runs in the background (see Tasks) and can take a while."
      );
      if (!ok) return;
      try {
        await data.mc.generatePhashes(data.mc.gqlFetch);
        Toast.success("Phash task started — see Tasks");
      } catch (e) {
        Toast.error(formatError(e));
      }
    }

    const title = props.mode === "paste" ? "Paste markers" : "Same videos";
    let body = null;
    let action = null;

    if (error) {
      body = React.createElement("p", { className: "quick-markers-transfer-error" }, error);
    } else if (!data) {
      body = React.createElement("p", { className: "text-muted" }, "Loading…");
    } else if (props.mode === "paste") {
      const mc = data.mc;
      const plan = mc.planCopy(data.clip.markers, data.scene, Number(offset) || 0);
      const n = mc.countNew(plan);
      body = React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "p",
          { className: "quick-markers-transfer-from" },
          "From ",
          React.createElement("strong", null, data.clip.sceneTitle),
          " (" + mc.formatTime(data.clip.duration) + ") → ",
          React.createElement("strong", null, data.scene.title),
          " (" + mc.formatTime(data.scene.duration) + ")"
        ),
        React.createElement(
          "div",
          { className: "form-group quick-markers-transfer-offset" },
          React.createElement("label", { htmlFor: "qm-copy-offset" }, "Shift (seconds)"),
          React.createElement("input", {
            id: "qm-copy-offset",
            type: "number",
            step: "0.5",
            className: "form-control",
            value: offset,
            onChange: function (e) {
              setOffset(e.target.value);
            },
          }),
          React.createElement(
            "p",
            { className: "text-muted small mb-0" },
            "Only needed when this video starts earlier or later than the copied one (e.g. -12.5)."
          )
        ),
        React.createElement(PlanList, { mc: mc, plan: plan })
      );
      action = React.createElement(
        "button",
        {
          type: "button",
          className: "btn btn-primary",
          disabled: !n || !!busy,
          onClick: function () {
            runPaste(plan);
          },
        },
        busy || (n ? "Paste " + n + " markers" : "Nothing new to paste")
      );
    } else if (!data.list.length) {
      body = React.createElement(
        "div",
        { className: "quick-markers-transfer-empty" },
        React.createElement(
          "p",
          null,
          data.scene.phashes.length
            ? "No other scene with the same video was found."
            : "This scene has no video fingerprint (phash) yet, so same videos can't be found."
        ),
        React.createElement(
          "p",
          { className: "text-muted small" },
          "Only scenes with a fingerprint are found. Stash creates them with Tasks → Generate → Phashes. ",
          coverage
        ),
        React.createElement(
          "button",
          { type: "button", className: "btn btn-secondary btn-sm", onClick: generatePhashes },
          "Generate missing phashes now"
        ),
        React.createElement(
          "p",
          { className: "text-muted small mb-0" },
          "Copy & paste works without fingerprints."
        )
      );
    } else {
      const mc = data.mc;
      const scene = data.scene;
      const count = data.list.filter(function (x) {
        return picked[x.scene.id];
      }).length;
      body = React.createElement(
        React.Fragment,
        null,
        React.createElement(
          "p",
          { className: "text-muted" },
          scene.markers.length
            ? "This scene has " + scene.markers.length + " markers. Pick the scenes that should get them:"
            : "This scene has no markers yet — take them from one of the videos below."
        ),
        React.createElement(
          "div",
          { className: "quick-markers-same" },
          data.list.map(function (x) {
            const pull = mc.countNew(mc.planCopy(x.scene.markers, scene, 0));
            const diff = x.durationDiff < 0.05 ? "same length" : "± " + x.durationDiff.toFixed(1) + " s";
            return React.createElement(
              "div",
              {
                key: x.scene.id,
                className: "quick-markers-same-row" + (x.sure ? "" : " is-unsure"),
              },
              React.createElement("input", {
                type: "checkbox",
                checked: !!picked[x.scene.id],
                disabled: !x.add || !!busy,
                "aria-label": "Copy markers to " + x.scene.title,
                onChange: function (e) {
                  const next = Object.assign({}, picked);
                  if (e.target.checked) next[x.scene.id] = true;
                  else delete next[x.scene.id];
                  setPicked(next);
                },
              }),
              React.createElement(
                "div",
                { className: "quick-markers-same-info" },
                React.createElement(
                  "a",
                  { href: "/scenes/" + x.scene.id, target: "_blank", rel: "noreferrer" },
                  x.scene.title
                ),
                React.createElement("small", null, x.scene.path),
                React.createElement(
                  "small",
                  null,
                  mc.formatTime(x.scene.duration) +
                    " (" + diff + ") · " +
                    x.scene.markers.length + (x.scene.markers.length === 1 ? " marker · " : " markers · ") +
                    (x.add ? "+" + x.add + " new" : "has all markers")
                )
              ),
              pull
                ? React.createElement(
                    "button",
                    {
                      type: "button",
                      className: "btn btn-secondary btn-sm",
                      disabled: !!busy,
                      title: "Copy its markers into this scene",
                      onClick: function () {
                        runPaste(mc.planCopy(x.scene.markers, scene, 0));
                      },
                    },
                    "Take " + pull
                  )
                : null
            );
          })
        ),
        data.list.some(function (x) {
          return !x.sure;
        })
          ? React.createElement(
              "p",
              { className: "text-muted small mb-0" },
              "Scenes whose length differs by more than a second are not ticked — check them before copying."
            )
          : null
      );
      action = scene.markers.length
        ? React.createElement(
            "button",
            {
              type: "button",
              className: "btn btn-primary",
              disabled: !count || !!busy,
              onClick: runCopyToScenes,
            },
            busy || "Copy markers to " + count + " scenes"
          )
        : null;
    }

    return React.createElement(
      "div",
      {
        className: "quick-markers-modal-backdrop",
        role: "presentation",
        onClick: function () {
          if (!busy) props.onClose();
        },
      },
      React.createElement(
        "div",
        {
          className: "quick-markers-modal quick-markers-transfer-modal",
          role: "dialog",
          "aria-modal": true,
          "aria-labelledby": "qm-transfer-title",
          onClick: function (e) {
            e.stopPropagation();
          },
        },
        React.createElement(
          "div",
          { className: "quick-markers-modal-header" },
          React.createElement(
            "h3",
            { id: "qm-transfer-title", className: "quick-markers-modal-title" },
            title
          ),
          React.createElement(
            "button",
            {
              type: "button",
              className: "quick-markers-modal-close",
              "aria-label": "Close",
              disabled: !!busy,
              onClick: function () {
                props.onClose();
              },
            },
            "×"
          )
        ),
        React.createElement("div", { className: "quick-markers-modal-body" }, body),
        React.createElement(
          "div",
          { className: "quick-markers-modal-footer" },
          React.createElement(
            "button",
            {
              type: "button",
              className: "btn btn-secondary",
              disabled: !!busy,
              onClick: function () {
                props.onClose();
              },
            },
            action ? "Cancel" : "Close"
          ),
          action
        )
      )
    );
  }

  function QuickMarkersSceneHook(props) {
    const scene = props.scene;
    const Toast = useSafeToast();
    const { config, error: configError } = usePresetsConfig();
    const resolveTagId = useResolveTagId();
    const [activeIndex, setActiveIndex] = React.useState(0);
    const [inPoint, setInPoint] = React.useState(null);
    const [status, setStatus] = React.useState("");
    const [panelOpen, setPanelOpen] = React.useState(false);
    const [touchBarOpen, setTouchBarOpen] = React.useState(function () {
      return readStoredTouchBarOpen(true);
    });
    const [panelPos, setPanelPos] = React.useState(readStoredPanelPos);
    const [panelDragging, setPanelDragging] = React.useState(false);
    const [touchHost, setTouchHost] = React.useState(null);
    const [transferMode, setTransferMode] = React.useState(null); // "paste" | "same"
    const clip = useMarkerClipboard();
    const panelInitRef = React.useRef(false);
    const panelRef = React.useRef(null);
    const dragRef = React.useRef(null);
    const panelPosRef = React.useRef(panelPos);

    React.useEffect(
      function () {
        panelPosRef.current = panelPos;
      },
      [panelPos]
    );

    React.useEffect(
      function () {
        if (!config || panelInitRef.current) return;
        panelInitRef.current = true;
        const defaultOpen = config.panelCollapsed === false;
        setPanelOpen(readStoredPanelOpen(defaultOpen));
      },
      [config]
    );

    const touchEnabled =
      !!config && isTouchActive(normalizeTouchControls(config.touchControls));

    React.useEffect(
      function () {
        if (!touchEnabled) return;
        const host = document.createElement("div");
        host.className = TOUCH_HOST_CLASS;

        // The player can re-mount (scene change, theme, quality switch): put the host back under it.
        function place() {
          const anchor = findTouchBarAnchor();
          if (!anchor || !anchor.parentElement) return;
          if (host.parentElement !== anchor.parentElement || host.previousElementSibling !== anchor) {
            anchor.parentElement.insertBefore(host, anchor.nextSibling);
          }
          setTouchHost(host);
        }

        place();
        const intervalId = setInterval(place, 1000);
        return function () {
          clearInterval(intervalId);
          if (host.parentElement) host.parentElement.removeChild(host);
          setTouchHost(null);
        };
      },
      [scene.id, touchEnabled]
    );

    function togglePanelOpen() {
      setPanelOpen(function (open) {
        const next = !open;
        storePanelOpen(next);
        return next;
      });
    }

    function toggleTouchBarOpen() {
      setTouchBarOpen(function (open) {
        const next = !open;
        storeTouchBarOpen(next);
        return next;
      });
    }

    function onPanelDragStart(e) {
      if (e.button != null && e.button !== 0) return;
      if (e.target && e.target.closest && e.target.closest(".quick-markers-toggle")) {
        return;
      }
      const el = panelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      dragRef.current = {
        pointerId: e.pointerId,
        offsetX: e.clientX - rect.left,
        offsetY: e.clientY - rect.top,
        width: rect.width,
        height: rect.height,
      };
      if (el.setPointerCapture && e.pointerId != null) {
        try {
          el.setPointerCapture(e.pointerId);
        } catch (err) {
          /* ignore */
        }
      }
      setPanelDragging(true);
      e.preventDefault();
    }

    function onPanelDragMove(e) {
      const drag = dragRef.current;
      if (!drag) return;
      const next = clampPanelPos(
        e.clientX - drag.offsetX,
        e.clientY - drag.offsetY,
        drag.width,
        drag.height
      );
      panelPosRef.current = next;
      setPanelPos(next);
    }

    function onPanelDragEnd() {
      if (!dragRef.current) return;
      dragRef.current = null;
      setPanelDragging(false);
      storePanelPos(panelPosRef.current);
    }

    function onPanelDragReset(e) {
      e.preventDefault();
      dragRef.current = null;
      setPanelDragging(false);
      setPanelPos(null);
      storePanelPos(null);
    }

      const [createMarker] = useCreateMarkerHook();

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

    const onClearIn = React.useCallback(
      function () {
        inPointByScene.delete(scene.id);
        setInPoint(null);
        setStatus("");
      },
      [scene.id]
    );

    const onCopyMarkers = React.useCallback(
      async function () {
        try {
          const mc = await loadMarkerCopy();
          const data = await mc.copySceneMarkers(mc.gqlFetch, scene.id);
          Toast.success(
            data.markers.length + " markers copied — open the other scene and paste them"
          );
        } catch (e) {
          Toast.error(formatError(e));
        }
      },
      [scene.id, Toast]
    );

    // Markers for this scene: plain GraphQL, except the last one, which goes through
    // Stash's own mutation so the Markers tab and the timeline refresh once.
    const createInScene = React.useCallback(
      async function (input, isLast) {
        if (isLast) {
          return createMarker({
            variables: useFlatMarkerCreateVars ? input : { input: input },
          });
        }
        const mc = await loadMarkerCopy();
        return mc.createWithGql(mc.gqlFetch)(input);
      },
      [createMarker]
    );

    const closeTransfer = React.useCallback(function () {
      setTransferMode(null);
    }, []);

    React.useEffect(
      function () {
        if (!config || !scene) return;

        const keysToUnbind = [];

        if (!Mousetrap || typeof Mousetrap.bind !== "function") {
          return function () {};
        }

        function bind(key, fn) {
          if (!key) return;
          keysToUnbind.push(key);
          Mousetrap.bind(key, function (e) {
            if (e && e.preventDefault) e.preventDefault();
            fn(e);
            return false;
          });
        }

        if (activePreset) {
          // Shared In/Out + Instant apply to the active preset.
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
          if (
            activePreset.instantKey &&
            !PRESET_SELECT_KEY_RE.test(activePreset.instantKey)
          ) {
            bind(activePreset.instantKey, function (e) {
              if (e && e.preventDefault) e.preventDefault();
              onInstant(activePreset);
            });
          }
        }

        // Shift+1–9 select whichever preset owns that slot.
        const slotToIndex = {};
        config.presets.forEach(function (preset, index) {
          const slot = normalizeSelectSlot(preset.selectSlot, index);
          if (!slot || slotToIndex[slot] != null) return;
          slotToIndex[slot] = index;
        });
        for (let n = 1; n <= 9; n++) {
          (function (slot) {
            const presetIndex = slotToIndex[slot];
            if (presetIndex == null) return;
            bind("shift+" + slot, function (e) {
              if (e && e.preventDefault) e.preventDefault();
              setActiveIndex(presetIndex);
            });
          })(n);
        }

        // Optional custom instant keys on other presets (must not be Shift+1–9).
        config.presets.forEach(function (preset) {
          if (!preset.instantKey) return;
          if (PRESET_SELECT_KEY_RE.test(preset.instantKey)) return;
          if (activePreset && preset.id === activePreset.id) return;
          if (
            activePreset &&
            preset.instantKey === activePreset.instantKey
          ) {
            return;
          }
          bind(preset.instantKey, function (e) {
            if (e && e.preventDefault) e.preventDefault();
            onInstant(preset);
          });
        });

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
          if (!Mousetrap || typeof Mousetrap.unbind !== "function") return;
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
    var panelStyle = panelPos
      ? {
          left: panelPos.left + "px",
          top: panelPos.top + "px",
          right: "auto",
          bottom: "auto",
        }
      : undefined;

    var floatingPanel =
      panelPosition !== "hidden"
        ? React.createElement(
            "div",
            {
              ref: panelRef,
              className:
                "quick-markers-panel quick-markers-panel-pos-" +
                panelPosition +
                (panelPos ? " quick-markers-panel-custom" : "") +
                (panelOpen ? "" : " quick-markers-panel-collapsed") +
                (panelDragging ? " quick-markers-panel-dragging" : ""),
              style: panelStyle,
              onPointerMove: onPanelDragMove,
              onPointerUp: onPanelDragEnd,
              onPointerCancel: onPanelDragEnd,
            },
            React.createElement(
              "div",
              {
                className: "quick-markers-panel-header",
                onPointerDown: onPanelDragStart,
                onDoubleClick: onPanelDragReset,
                title: "Drag to move · double-click to reset position",
              },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "quick-markers-toggle",
                  onClick: togglePanelOpen,
                  title: panelOpen ? "Collapse" : "Expand",
                  "aria-expanded": panelOpen,
                },
                React.createElement("span", {
                  className: "quick-markers-chevron",
                  "aria-hidden": true,
                })
              ),
              React.createElement(
                "strong",
                { className: "quick-markers-title" },
                "Quick Markers"
              ),
              React.createElement(
                "span",
                { className: "quick-markers-active" },
                activePreset.label
              ),
              inPoint != null
                ? React.createElement(
                    "span",
                    {
                      className: "quick-markers-rec",
                      title: "Recording — press " + (activePreset.rangeOutKey || "Out") + " to save",
                    },
                    formatTime(inPoint)
                  )
                : null
            ),
            panelOpen
              ? React.createElement(
                  React.Fragment,
                  null,
                  React.createElement(
                    "div",
                    { className: "quick-markers-actions" },
                    React.createElement(
                      "button",
                      {
                        type: "button",
                        className:
                          "quick-markers-action quick-markers-action-in" +
                          (inPoint != null ? " active" : ""),
                        title: "In point (" + (activePreset.rangeInKey || "—") + ")",
                        onClick: function () {
                          onRangeIn(activePreset);
                        },
                      },
                      React.createElement("span", {
                        className: "quick-markers-dot",
                        "aria-hidden": true,
                      }),
                      inPoint != null ? "In " + formatTime(inPoint) : "In"
                    ),
                    React.createElement(
                      "button",
                      {
                        type: "button",
                        className: "quick-markers-action",
                        disabled: inPoint == null,
                        title: "Out point + save range (" + (activePreset.rangeOutKey || "—") + ")",
                        onClick: function () {
                          onRangeOut(activePreset);
                        },
                      },
                      "Out"
                    ),
                    React.createElement(
                      "button",
                      {
                        type: "button",
                        className: "quick-markers-action quick-markers-action-instant",
                        title: "Instant marker (" + (activePreset.instantKey || "—") + ")",
                        onClick: function () {
                          onInstant(activePreset);
                        },
                      },
                      "+ Instant"
                    ),
                    inPoint != null
                      ? React.createElement(
                          "button",
                          {
                            type: "button",
                            className: "quick-markers-action quick-markers-action-clear",
                            title: "Discard in point",
                            "aria-label": "Discard in point",
                            onClick: onClearIn,
                          },
                          "×"
                        )
                      : null
                  ),
                  React.createElement(
                    "div",
                    { className: "quick-markers-presets" },
                    config.presets.map(function (preset, index) {
                      const isActive = index === activeIndex;
                      const slot = normalizeSelectSlot(preset.selectSlot, index);
                      const selectKey = selectSlotToKey(slot);
                      return React.createElement(
                        "button",
                        {
                          key: preset.id,
                          type: "button",
                          className:
                            "quick-markers-preset-btn" +
                            (isActive ? " active" : ""),
                          "aria-pressed": isActive,
                          title: selectKey
                            ? "Click or " +
                              selectKey +
                              " = select. Double-click = instant marker"
                            : "Click = select for In/Out. Double-click = instant marker",
                          onClick: function () {
                            setActiveIndex(index);
                          },
                          onDoubleClick: function () {
                            if (preset.instantKey) onInstant(preset);
                          },
                        },
                        preset.label,
                        slot
                          ? React.createElement(
                              "kbd",
                              { className: "quick-markers-key" },
                              "⇧" + slot
                            )
                          : null
                      );
                    })
                  ),
                  React.createElement(
                    "div",
                    { className: "quick-markers-tools" },
                    React.createElement(
                      "button",
                      {
                        type: "button",
                        className: "quick-markers-tool",
                        title: "Copy all markers of this scene (times, titles, tags)",
                        onClick: onCopyMarkers,
                      },
                      "⧉ Copy"
                    ),
                    React.createElement(
                      "button",
                      {
                        type: "button",
                        className: "quick-markers-tool",
                        disabled: !clip,
                        title: clip
                          ? "Paste " + clip.markers.length + " markers from " + clip.sceneTitle
                          : "Copy the markers of another scene first",
                        onClick: function () {
                          setTransferMode("paste");
                        },
                      },
                      "Paste",
                      clip
                        ? React.createElement(
                            "span",
                            { className: "quick-markers-tool-count" },
                            clip.markers.length
                          )
                        : null
                    ),
                    React.createElement(
                      "button",
                      {
                        type: "button",
                        className: "quick-markers-tool",
                        title: "Copy markers to scenes with the same video (phash)",
                        onClick: function () {
                          setTransferMode("same");
                        },
                      },
                      "Same videos…"
                    )
                  ),
                  status
                    ? React.createElement(
                        "p",
                        { className: "quick-markers-status" },
                        status
                      )
                    : null,
                  React.createElement(
                    "p",
                    { className: "quick-markers-hint" },
                    React.createElement("kbd", null, activePreset.rangeInKey || "—"),
                    " In · ",
                    React.createElement("kbd", null, activePreset.rangeOutKey || "—"),
                    " Out · ",
                    React.createElement("kbd", null, activePreset.instantKey || "—"),
                    " Instant · ",
                    React.createElement("kbd", null, "shift+1–9"),
                    " Preset"
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

    var touchBar =
      touchEnabled && touchHost && createPortal
        ? createPortal(React.createElement(
            "div",
            {
              className:
                "quick-markers-touch-bar" +
                (touchBarOpen ? "" : " quick-markers-touch-bar-collapsed"),
            },
            React.createElement(
              "div",
              { className: "quick-markers-touch-bar-header" },
              React.createElement(
                "button",
                {
                  type: "button",
                  className: "quick-markers-touch-bar-toggle",
                  onClick: toggleTouchBarOpen,
                  title: touchBarOpen
                    ? "Hide touch controls"
                    : "Show touch controls",
                  "aria-expanded": touchBarOpen,
                },
                touchBarOpen ? "▼ Hide" : "▲ Quick Markers"
              ),
              // Status sits in the header row, so a new message never changes the bar height (no video jump).
              touchBarOpen
                ? React.createElement(
                    "span",
                    { className: "quick-markers-touch-status" },
                    status
                  )
                : React.createElement(
                    "span",
                    { className: "quick-markers-touch-bar-active" },
                    activePreset.label
                  )
            ),
            touchBarOpen
              ? React.createElement(
                  React.Fragment,
                  null,
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
                        className:
                          "quick-markers-touch-btn quick-markers-touch-out",
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
                        className:
                          "quick-markers-touch-btn quick-markers-touch-instant",
                        onClick: function () {
                          onInstant(activePreset);
                        },
                      },
                      "INSTANT"
                    ),
                    inPoint != null
                      ? React.createElement(
                          "button",
                          {
                            type: "button",
                            className:
                              "quick-markers-touch-btn quick-markers-touch-clear",
                            "aria-label": "Discard in point",
                            onClick: onClearIn,
                          },
                          "×"
                        )
                      : null
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
                  )
                )
              : null
          ), touchHost)
        : null;

    var transferModal = transferMode
      ? React.createElement(MarkerTransferModal, {
          mode: transferMode,
          sceneId: scene.id,
          Toast: Toast,
          createInScene: createInScene,
          onClose: closeTransfer,
        })
      : null;

    return React.createElement(
      React.Fragment,
      null,
      floatingPanel,
      touchBar,
      transferModal
    );
  }

  PluginApi.patch.after("ScenePage", function () {
    var args = Array.prototype.slice.call(arguments);
    var result = args[args.length - 1];
    var props = args[0];
    try {
      if (!props || !props.scene) return result;
      return React.createElement(
        React.Fragment,
        null,
        result,
        React.createElement(
          ScenePatchErrorBoundary,
          null,
          React.createElement(QuickMarkersSceneHook, { scene: props.scene })
        )
      );
    } catch (e) {
      console.error("[Quick Markers] ScenePage patch failed", e);
      return result;
    }
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
    const settingsApi =
      typeof hooks.useSettings === "function"
        ? hooks.useSettings()
        : { plugins: {}, savePluginSettings: function () {}, loading: false };
    const { plugins, savePluginSettings, loading } = settingsApi;
    const Toast = useSafeToast();
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
    const [editingPresetId, setEditingPresetId] = React.useState(null);
    const [showJsonModal, setShowJsonModal] = React.useState(false);
    const [showTagsHelpModal, setShowTagsHelpModal] = React.useState(false);
    const [jsonModalDraft, setJsonModalDraft] = React.useState("");

    const [newLabel, setNewLabel] = React.useState("");
    const [newPrimaryTag, setNewPrimaryTag] = React.useState("");
    const [newTags, setNewTags] = React.useState("");
    const [newRangeIn, setNewRangeIn] = React.useState("shift+i");
    const [newRangeOut, setNewRangeOut] = React.useState("shift+o");
    const [newInstant, setNewInstant] = React.useState(DEFAULT_INSTANT_KEY);
    const [newSelectSlot, setNewSelectSlot] = React.useState("");

    function resetPresetForm() {
      setNewLabel("");
      setNewPrimaryTag("");
      setNewTags("");
      setNewRangeIn("shift+i");
      setNewRangeOut("shift+o");
      setNewInstant(DEFAULT_INSTANT_KEY);
      setNewSelectSlot("");
      setEditingPresetId(null);
    }

    function fillPresetForm(preset) {
      setNewLabel(preset.label || "");
      setNewPrimaryTag(preset.primaryTag || "");
      setNewTags(
        preset.tags && preset.tags.length ? preset.tags.join(", ") : ""
      );
      setNewRangeIn(preset.rangeInKey || "shift+i");
      setNewRangeOut(preset.rangeOutKey || "shift+o");
      setNewInstant(normalizeInstantKey(preset.instantKey));
      setNewSelectSlot(
        preset.selectSlot ? String(preset.selectSlot) : ""
      );
      setEditingPresetId(preset.id);
    }

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

    function onSavePreset() {
      const label = newLabel.trim();
      const primaryTag = (newPrimaryTag || newLabel).trim();
      if (!label || !primaryTag) {
        Toast.error("Label and primary tag are required.");
        return;
      }
      const fields = {
        label: label,
        primaryTag: primaryTag,
        tags: normalizePresetTags(newTags, primaryTag),
        title: label,
        rangeInKey: (newRangeIn.trim() || "shift+i").toLowerCase(),
        rangeOutKey: (newRangeOut.trim() || "shift+o").toLowerCase(),
        instantKey: normalizeInstantKey(newInstant),
        selectSlot: normalizeSelectSlot(
          newSelectSlot === "" ? null : newSelectSlot,
          99
        ),
      };

      if (editingPresetId != null) {
        const idx = config.presets.findIndex(function (p) {
          return p.id === editingPresetId;
        });
        if (idx < 0) {
          Toast.error("Preset not found.");
          resetPresetForm();
          setShowAddForm(false);
          return;
        }
        const presets = config.presets.map(function (p, i) {
          if (i === idx) return Object.assign({}, p, fields);
          if (
            fields.selectSlot &&
            p.selectSlot === fields.selectSlot
          ) {
            return Object.assign({}, p, { selectSlot: null });
          }
          return p;
        });
        persistConfig({
          defaultPresetIndex: config.defaultPresetIndex,
          presets: presets,
        });
        resetPresetForm();
        setShowAddForm(false);
        Toast.success("Preset updated.");
        return;
      }

      const id = label.toLowerCase().replace(/\s+/g, "-");
      if (!fields.selectSlot) {
        fields.selectSlot = nextFreeSelectSlot(config.presets);
      }
      const presets = config.presets
        .map(function (p) {
          if (
            fields.selectSlot &&
            p.selectSlot === fields.selectSlot
          ) {
            return Object.assign({}, p, { selectSlot: null });
          }
          return p;
        })
        .concat([Object.assign({ id: id }, fields)]);
      persistConfig({
        defaultPresetIndex: config.defaultPresetIndex,
        presets: presets,
      });
      resetPresetForm();
      setShowAddForm(false);
      Toast.success("Preset added.");
    }

    function onEditPreset(preset) {
      fillPresetForm(preset);
      setShowAddForm(true);
      setShowPresetList(true);
    }

    function onCancelPresetForm() {
      resetPresetForm();
      setShowAddForm(false);
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
      if (editingPresetId === preset.id) {
        resetPresetForm();
        setShowAddForm(false);
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
        "Hotkeys on the scene page: ",
        React.createElement("kbd", null, "shift+1"),
        "–",
        React.createElement("kbd", null, "9"),
        " select a preset (assign slots in Edit), ",
        React.createElement("kbd", null, "shift+i"),
        " / ",
        React.createElement("kbd", null, "shift+o"),
        " range, ",
        React.createElement("kbd", null, DEFAULT_INSTANT_KEY),
        " instant (active preset). Not Ctrl/Strg — plain Shift. Panel header is draggable. Avoid plain ",
        React.createElement("kbd", null, "i"),
        " / ",
        React.createElement("kbd", null, "o"),
        " / ",
        React.createElement("kbd", null, "m"),
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
          "Collapsed by default on the scene page. Click ▶ to expand. Drag the panel header to move it; double-click the header to reset. Position is remembered per browser."
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
          "Shows IN / OUT / INSTANT directly under the video, in the page (never on top of the player), so the seek bar and player settings stay reachable. One compact row when the screen is low (phone in landscape). Auto-detect: touch devices on, desktop off."
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
                config.presets.map(function (preset, index) {
                  const selectKey = selectSlotToKey(
                    normalizeSelectSlot(preset.selectSlot, index)
                  );
                  const keys = [
                    selectKey && "Select: " + selectKey,
                    preset.rangeInKey && "In: " + preset.rangeInKey,
                    preset.rangeOutKey && "Out: " + preset.rangeOutKey,
                    preset.instantKey && "Instant: " + preset.instantKey,
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
                      "div",
                      { className: "quick-markers-settings-list-actions" },
                      React.createElement(
                        "button",
                        {
                          type: "button",
                          className:
                            "btn btn-primary btn-sm" +
                            (editingPresetId === preset.id
                              ? " active"
                              : ""),
                          onClick: function () {
                            onEditPreset(preset);
                          },
                        },
                        "Edit"
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
              if (showAddForm) {
                onCancelPresetForm();
                return;
              }
              resetPresetForm();
              setShowAddForm(true);
            },
            "aria-expanded": showAddForm,
          },
          showAddForm
            ? editingPresetId != null
              ? "▼ Edit preset"
              : "▼ Add preset"
            : "▶ Add preset"
        ),
        showAddForm
          ? React.createElement(
              "div",
              { className: "quick-markers-settings-add-body" },
              editingPresetId != null
                ? React.createElement(
                    "p",
                    { className: "text-muted small" },
                    "Editing: ",
                    React.createElement("strong", null, newLabel || editingPresetId)
                  )
                : null,
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
                  { htmlFor: "qm-new-select" },
                  "Select hotkey (Shift+1–9)"
                ),
                React.createElement(
                  "select",
                  {
                    id: "qm-new-select",
                    className: "form-control",
                    value: newSelectSlot,
                    onChange: function (e) {
                      setNewSelectSlot(e.target.value);
                    },
                  },
                  React.createElement("option", { value: "" }, "None"),
                  [1, 2, 3, 4, 5, 6, 7, 8, 9].map(function (n) {
                    return React.createElement(
                      "option",
                      { key: n, value: String(n) },
                      "Shift+" + n
                    );
                  })
                ),
                React.createElement(
                  "p",
                  { className: "text-muted small mb-0" },
                  "Which Shift+number activates this preset. With 10+ presets, assign only the ones you need on the macropad. Duplicate slots are cleared from other presets."
                )
              ),
              React.createElement(
                "div",
                { className: "form-group" },
                React.createElement(
                  "label",
                  { htmlFor: "qm-new-instant" },
                  "Instant key"
                ),
                React.createElement("input", {
                  id: "qm-new-instant",
                  type: "text",
                  className: "form-control",
                  value: newInstant,
                  placeholder: DEFAULT_INSTANT_KEY,
                  onChange: function (e) {
                    setNewInstant(e.target.value);
                  },
                }),
                React.createElement(
                  "p",
                  { className: "text-muted small mb-0" },
                  "Instant marker for the ",
                  React.createElement("strong", null, "active"),
                  " preset. Default ",
                  React.createElement("kbd", null, DEFAULT_INSTANT_KEY),
                  " (Shift+M — not Ctrl). ",
                  React.createElement("kbd", null, "shift+1"),
                  "–",
                  React.createElement("kbd", null, "9"),
                  " are for select slots only."
                )
              ),
              React.createElement(
                "div",
                { className: "quick-markers-settings-form-actions" },
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-primary",
                    onClick: onSavePreset,
                  },
                  editingPresetId != null ? "Save changes" : "Add"
                ),
                React.createElement(
                  "button",
                  {
                    type: "button",
                    className: "btn btn-secondary",
                    onClick: onCancelPresetForm,
                  },
                  "Cancel"
                )
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
    try {
      if (!props || props.pluginID !== PLUGIN_ID) {
        return next.apply(null, args);
      }
      if (typeof hooks.useSettings !== "function") {
        return next.apply(null, args);
      }
      return React.createElement(
        ScenePatchErrorBoundary,
        null,
        React.createElement(QuickMarkersSettings, null)
      );
    } catch (e) {
      console.error("[Quick Markers] PluginSettings patch failed", e);
      return next.apply(null, args);
    }
  });
})();
