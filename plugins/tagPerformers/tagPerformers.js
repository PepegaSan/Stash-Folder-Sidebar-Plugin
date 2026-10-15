(function () {
  var PLUGIN_ID = "tagPerformers";
  // Scene ids per bulk update, so one huge tag does not end up in a single giant mutation
  var BULK_SIZE = 500;

  function ok(output) {
    return { output: output || "ok" };
  }

  function getSettings() {
    var result = gql.Do("query Configuration { configuration { plugins } }");
    var plugins =
      result.configuration && result.configuration.plugins
        ? result.configuration.plugins
        : {};
    var cfg = plugins[PLUGIN_ID] || {};
    return {
      autoOnCreate: !!cfg.autoOnCreate,
      removeTag: !!cfg.removeTag,
    };
  }

  function includesId(ids, id) {
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i]) === String(id)) return true;
    }
    return false;
  }

  function performerNames(performer) {
    var names = [performer.name].concat(performer.alias_list || []);
    var out = [];
    for (var i = 0; i < names.length; i++) {
      var name = String(names[i] || "").trim();
      if (name) out.push(name);
    }
    return out;
  }

  // Lower-case tag name or alias -> tags. Exact matches only (case-insensitive), never partial.
  function buildTagIndex() {
    var result = gql.Do(
      "query AllTags { findTags(filter: { per_page: -1 }) { tags { id name aliases } } }"
    );
    var tags = result.findTags && result.findTags.tags ? result.findTags.tags : [];
    var index = {};
    for (var i = 0; i < tags.length; i++) {
      var tag = { id: String(tags[i].id), name: tags[i].name };
      var keys = [tags[i].name].concat(tags[i].aliases || []);
      var seen = {};
      for (var j = 0; j < keys.length; j++) {
        var key = String(keys[j] || "").trim().toLowerCase();
        if (!key || seen[key]) continue;
        seen[key] = true;
        if (!index[key]) index[key] = [];
        index[key].push(tag);
      }
    }
    return index;
  }

  function matchingTags(performer, tagIndex) {
    var found = [];
    var seen = {};
    var names = performerNames(performer);
    for (var i = 0; i < names.length; i++) {
      var tags = tagIndex[names[i].toLowerCase()] || [];
      for (var j = 0; j < tags.length; j++) {
        if (seen[tags[j].id]) continue;
        seen[tags[j].id] = true;
        found.push(tags[j]);
      }
    }
    return found;
  }

  function getPerformer(id) {
    var result = gql.Do(
      "query FindPerformer($id: ID!) { findPerformer(id: $id) { id name alias_list } }",
      { id: String(id) }
    );
    return result.findPerformer || null;
  }

  function getAllPerformers() {
    var result = gql.Do(
      "query AllPerformers { findPerformers(filter: { per_page: -1 }) { performers { id name alias_list } } }"
    );
    return result.findPerformers && result.findPerformers.performers
      ? result.findPerformers.performers
      : [];
  }

  // Scenes with any of the tags (only the tags themselves, not their sub-tags)
  function getTaggedScenes(tagIds) {
    var query =
      "query FindScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {\
        findScenes(filter: $filter, scene_filter: $scene_filter) {\
          count\
          scenes { id performers { id } tags { id } }\
        }\
      }";
    var page = 1;
    var perPage = 1000;
    var all = [];
    while (true) {
      var result = gql.Do(query, {
        filter: { per_page: perPage, page: page },
        scene_filter: { tags: { value: tagIds, modifier: "INCLUDES", depth: 0 } },
      });
      var findScenes = result.findScenes;
      if (!findScenes || !findScenes.scenes || !findScenes.scenes.length) break;
      all = all.concat(findScenes.scenes);
      if (all.length >= findScenes.count) break;
      page += 1;
    }
    return all;
  }

  function bulkUpdate(sceneIds, input) {
    for (var i = 0; i < sceneIds.length; i += BULK_SIZE) {
      var chunk = sceneIds.slice(i, i + BULK_SIZE);
      var payload = { ids: chunk };
      for (var key in input) payload[key] = input[key];
      gql.Do(
        "mutation BulkSceneUpdate($input: BulkSceneUpdateInput!) { bulkSceneUpdate(input: $input) { id } }",
        { input: payload }
      );
    }
  }

  function processPerformer(performer, tagIndex, settings) {
    if (!performer) return { added: 0, untagged: 0 };
    var tags = matchingTags(performer, tagIndex);
    if (!tags.length) return { added: 0, untagged: 0 };

    var tagIds = tags.map(function (t) { return t.id; });
    var scenes = getTaggedScenes(tagIds);
    var addTo = [];
    var untag = [];
    for (var i = 0; i < scenes.length; i++) {
      var performerIds = (scenes[i].performers || []).map(function (p) { return p.id; });
      if (!includesId(performerIds, performer.id)) addTo.push(String(scenes[i].id));
      untag.push(String(scenes[i].id));
    }

    // ADD / REMOVE leave every other performer and tag on the scene as it is
    if (addTo.length) {
      bulkUpdate(addTo, { performer_ids: { ids: [String(performer.id)], mode: "ADD" } });
    }
    if (settings.removeTag && untag.length) {
      bulkUpdate(untag, { tag_ids: { ids: tagIds, mode: "REMOVE" } });
    }

    var tagNames = tags.map(function (t) { return t.name; }).join('", "');
    if (addTo.length || (settings.removeTag && untag.length)) {
      log.Info(
        'Performer "' + performer.name + '" (tag "' + tagNames + '"): added to ' + addTo.length + " scene(s)" +
          (settings.removeTag ? ", removed the tag from " + untag.length + " scene(s)" : "")
      );
    }
    return { added: addTo.length, untagged: settings.removeTag ? untag.length : 0 };
  }

  function main() {
    var settings = getSettings();
    var mode = input.Args && input.Args.mode ? input.Args.mode : "allPerformers";

    if (mode === "hook") {
      if (!settings.autoOnCreate) {
        log.Debug("autoOnCreate disabled; hook skipped");
        return ok("hook skipped");
      }
      var hookContext = input.Args.hookContext;
      if (!hookContext || !hookContext.id) return ok("no performer id");
      processPerformer(getPerformer(hookContext.id), buildTagIndex(), settings);
      return ok("hook done");
    }

    if (mode === "allPerformers") {
      var performers = getAllPerformers();
      var tagIndex = buildTagIndex();
      log.Info(
        "Checking " + performers.length + " performer(s)" +
          (settings.removeTag ? " (matching tags are removed from the scenes)" : " (tags stay)")
      );
      var matched = 0;
      var addedTotal = 0;
      var untaggedTotal = 0;
      for (var i = 0; i < performers.length; i++) {
        var result = processPerformer(performers[i], tagIndex, settings);
        if (result.added || result.untagged) matched += 1;
        addedTotal += result.added;
        untaggedTotal += result.untagged;
        log.Progress((i + 1) / performers.length);
      }
      log.Info(
        "Done. " + matched + " performer(s) changed, added to " + addedTotal + " scene(s)" +
          (settings.removeTag ? ", removed the tag from " + untaggedTotal + " scene(s)." : ".")
      );
      return ok("added " + addedTotal);
    }

    log.Error("Unknown mode: " + mode);
    return { error: "Unknown mode: " + mode };
  }

  return main();
})();
