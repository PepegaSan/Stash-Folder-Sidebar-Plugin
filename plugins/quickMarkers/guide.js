// Shared by classic Stash and Stash UI. Drafts stay in this browser, per scene.
(function (root) {
  "use strict";
  function createStore(storage) {
    const prefix = "quickMarkers.guide.";
    const memory = new Map();
    const unsaved = new Set();
    const saving = new Set();
    const listeners = new Set();
    const notify = (sceneId, external = false) => listeners.forEach((fn) => fn(sceneId == null ? null : String(sceneId), external));
    function read(key) {
      if (unsaved.has(key)) return memory.get(key);
      try {
        const value = storage && storage.getItem(prefix + key);
        const parsed = value == null ? null : JSON.parse(value);
        memory.set(key, parsed);
        return parsed;
      } catch (_) { /* Local storage may be unavailable. Keep the current draft in memory. */ }
      return memory.get(key) || null;
    }
    function write(key, value) {
      memory.set(key, value);
      if (value && typeof value === "object") value.persisted = true;
      try {
        if (!storage) throw new Error("No storage");
        if (value === null && storage.removeItem) storage.removeItem(prefix + key);
        else storage.setItem(prefix + key, JSON.stringify(value));
        unsaved.delete(key);
        return true;
      } catch (_) {
        unsaved.add(key);
        if (value && typeof value === "object") value.persisted = false;
        return false;
      }
    }
    function draft(sceneId) {
      const value = read("draft." + sceneId);
      return value && Number.isFinite(value.start) && value.start >= 0 && value.preset &&
        typeof value.preset.primaryTag === "string" && typeof value.preset.label === "string" &&
        typeof value.preset.id === "string" && typeof value.id === "string" ? value : null;
    }
    function begin(sceneId, preset, seconds) {
      if (!preset || !Number.isFinite(seconds) || seconds < 0) return null;
      const value = { id: Date.now() + ":" + Math.random().toString(36).slice(2),
        start: seconds, preset: JSON.parse(JSON.stringify(preset)) };
      write("draft." + sceneId, value);
      notify(sceneId);
      return value;
    }
    function clear(sceneId, expectedId) {
      if (expectedId && draft(sceneId)?.id !== expectedId) return false;
      write("draft." + sceneId, null);
      notify(sceneId);
      return true;
    }
    function choose(preset, sceneId) {
      if (!preset) return;
      write("preset", preset.id);
      const pending = sceneId != null && draft(sceneId);
      if (pending) { begin(sceneId, preset, pending.start); return; }
      if (sceneId != null) notify(sceneId);
    }
    function selected(config, sceneId) {
      const pending = sceneId != null && draft(sceneId);
      const id = pending ? pending.preset.id : read("preset");
      const index = config.presets.findIndex((p) => p.id === id);
      return index >= 0 ? index : Math.min(config.defaultPresetIndex || 0, config.presets.length - 1);
    }
    // Keep instant history separate from the selection and any pending range.
    // Resolve the ID against current settings so edits/deletions cannot replay stale tags.
    function rememberInstant(preset) {
      if (preset) write("instantPreset", preset.id);
    }
    function instantPreset(config) {
      const id = read("instantPreset");
      return config.presets.find((p) => p.id === id) || config.presets[selected(config)] || null;
    }
    function storageChanged(event) {
      if (event.storageArea !== storage || (event.key !== null && !event.key.startsWith(prefix))) return;
      const key = event.key?.slice(prefix.length);
      if (key == null) { memory.clear(); unsaved.clear(); }
      else { memory.delete(key); unsaved.delete(key); }
      notify(key?.startsWith("draft.") ? key.slice(6) : null, true);
    }
    function withDraft(sceneId, id, action) {
      if (!id) return false;
      const saveCurrent = () => draft(sceneId)?.id === id && action();
      // Only one tab may submit this draft. Drop extra clicks while the first save is pending.
      return root.navigator?.locks
        ? root.navigator.locks.request(prefix + "save." + sceneId, { ifAvailable: true }, (lock) => lock && saveCurrent())
        : saveCurrent();
    }
    return { draft, begin, clear, choose, selected, rememberInstant, instantPreset, storageChanged, withDraft,
      subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
      canFinish: (start, end) => Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start + .05,
      lock: (sceneId) => { if (saving.has(String(sceneId))) return false; saving.add(String(sceneId)); notify(sceneId); return true; },
      unlock: (sceneId) => { saving.delete(String(sceneId)); notify(sceneId); },
      busy: (sceneId) => saving.has(String(sceneId)) };
  }
  let storage;
  try { storage = root.localStorage; } catch (_) { /* Browser policy */ }
  if (!root.QuickMarkersGuide) {
    root.QuickMarkersGuide = createStore(storage);
    root.addEventListener?.("storage", root.QuickMarkersGuide.storageChanged);
  }
  if (typeof module !== "undefined" && module.exports) module.exports = { createStore };
})(typeof window !== "undefined" ? window : globalThis);
