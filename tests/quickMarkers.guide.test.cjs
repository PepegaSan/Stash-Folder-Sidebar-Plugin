const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStore } = require('../plugins/quickMarkers/guide.js');
const preset = { id: 'a', label: 'Compilation', primaryTag: 'Compilation', title: 'Compilation', tags: [] };
function storage() {
  const values = new Map();
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
}

test('a draft, its exact preset and subsecond start survive a new session', () => {
  const disk = storage();
  const first = createStore(disk);
  first.begin('scene-a', preset, 12.345);
  const restored = createStore(disk).draft('scene-a');
  assert.equal(restored.start, 12.345);
  assert.deepEqual(restored.preset, preset);
  assert.equal(restored.persisted, true);
  assert.equal(first.draft('scene-b'), null);
});

test('only an explicitly chosen preset overrides the configured default', () => {
  const disk = storage();
  const config = { defaultPresetIndex: 1, presets: [preset, { ...preset, id: 'b' }] };
  const guide = createStore(disk);
  assert.equal(guide.selected(config, 'scene'), 1);
  guide.choose(preset);
  assert.equal(createStore(disk).selected(config, 'scene'), 0);
});

test('instant history survives reload without changing a draft or the normal selection', () => {
  const disk = storage(), guide = createStore(disk);
  const other = {...preset,id:'b',label:'Favourite'};
  const config = {presets:[preset,other],defaultPresetIndex:0};
  guide.choose(preset);
  const pending = guide.begin('scene',preset,12.345);
  guide.rememberInstant(other);
  const restored = createStore(disk);
  assert.equal(restored.instantPreset(config).id,'b');
  assert.equal(restored.selected(config),0);
  assert.deepEqual(restored.draft('scene'),pending);
  assert.equal(restored.instantPreset({presets:[preset,{...other,primaryTag:'Edited'}]}).primaryTag,'Edited');
  assert.equal(restored.instantPreset({presets:[preset]}).id,'a');
});

test('instant repeat falls back to the chosen/default preset and works without storage', () => {
  const guide = createStore(null), other = {...preset,id:'b'};
  const config = {presets:[preset,other],defaultPresetIndex:1};
  assert.equal(guide.instantPreset(config).id,'b');
  guide.choose(preset);
  assert.equal(guide.instantPreset(config).id,'a');
  guide.rememberInstant(other);
  assert.equal(guide.instantPreset(config).id,'b');
});

test('changing a pending preset keeps its start, and restoring selects that preset', () => {
  const guide = createStore(storage());
  guide.begin('scene', preset, 0);
  guide.choose({ ...preset, id: 'b', label: 'Other' }, 'scene');
  assert.equal(guide.draft('scene').start, 0);
  assert.equal(guide.draft('scene').preset.id, 'b');
  assert.equal(guide.selected({ presets: [preset, { ...preset, id: 'b' }] }, 'scene'), 1);
});

test('a late save cannot clear a newer in point', () => {
  const guide = createStore(storage());
  const old = guide.begin('scene', preset, 10);
  const current = guide.begin('scene', preset, 20);
  assert.equal(guide.clear('scene', old.id), false);
  assert.equal(guide.draft('scene').id, current.id);
  assert.equal(guide.clear('scene', current.id), true);
  assert.equal(guide.draft('scene'), null);
});

test('a late save from another tab cannot remove the replacement draft', () => {
  const disk = storage(), first = createStore(disk), second = createStore(disk);
  const old = first.begin('scene', preset, 3);
  const newer = second.begin('scene', preset, 16);
  assert.equal(first.clear('scene', old.id), false);
  assert.equal(first.draft('scene').id, newer.id);
  second.clear('scene', newer.id);
  assert.equal(first.draft('scene'), null);
});

test('discard is persistent and affects only the requested scene', () => {
  const disk = storage(), guide = createStore(disk);
  guide.begin('a', preset, 1);
  guide.begin('b', preset, 2);
  guide.clear('a');
  assert.equal(createStore(disk).draft('a'), null);
  assert.equal(createStore(disk).draft('b').start, 2);
});

test('unavailable or full storage preserves the current draft without claiming persistence', () => {
  const disk = storage(), guide = createStore(disk);
  guide.begin('scene', preset, 1);
  disk.setItem = () => { throw new Error('quota'); };
  assert.equal(guide.begin('scene', preset, 2).persisted, false);
  assert.equal(guide.draft('scene').start, 2);
  guide.clear('scene');
  assert.equal(guide.draft('scene'), null);
  assert.equal(createStore(null).begin('scene', preset, 0).persisted, false);
});

test('corrupt persisted input is ignored', () => {
  const disk = storage();
  for (const bad of ['not json', '{}', '{"id":"x","start":-1}', '{"id":"x","start":1,"preset":{}}']) {
    disk.setItem('quickMarkers.guide.draft.scene', bad);
    assert.equal(createStore(disk).draft('scene'), null);
  }
});

test('guided ranges require a real end after the start', () => {
  const guide = createStore(storage());
  assert.equal(guide.canFinish(0, .1), true);
  for (const end of [0, .02, -1, null, Infinity, NaN]) assert.equal(guide.canFinish(0, end), false);
  assert.equal(guide.canFinish(10, 9), false);
});

test('a scene save lock prevents duplicate requests and notifies a remounted view', () => {
  const guide = createStore(storage()), events = [];
  const unsubscribe = guide.subscribe(id => events.push([id, guide.busy(id)]));
  assert.equal(guide.lock(1), true);
  assert.equal(guide.lock('1'), false);
  assert.equal(guide.lock(2), true);
  guide.unlock(1);
  assert.equal(guide.lock('1'), true);
  unsubscribe();
  assert.deepEqual(events, [['1', true], ['2', true], ['1', false], ['1', true]]);
});
