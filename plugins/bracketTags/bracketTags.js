(function () {
  var PLUGIN_ID = "bracketTags";
  var BRACKET_RE = /\[([^\]]+)\]/g;

  function ok(output) {
    return { output: output || "ok" };
  }

  function getSettings() {
    var query =
      "query Configuration { configuration { plugins } }";
    var result = gql.Do(query);
    var plugins =
      result.configuration && result.configuration.plugins
        ? result.configuration.plugins
        : {};
    var cfg = plugins[PLUGIN_ID] || {};
    return {
      createMissingTags: cfg.createMissingTags !== false,
      autoOnScan: !!cfg.autoOnScan,
    };
  }

  function basename(path) {
    if (!path) return "";
    var p = String(path).replace(/\\/g, "/");
    var i = p.lastIndexOf("/");
    return i >= 0 ? p.slice(i + 1) : p;
  }

  function stripExtension(filename) {
    var name = basename(filename);
    var dot = name.lastIndexOf(".");
    return dot > 0 ? name.slice(0, dot) : name;
  }

  function extractBracketTags(filename) {
    var tags = [];
    var seen = {};
    var source = stripExtension(filename);
    var match;
    BRACKET_RE.lastIndex = 0;
    while ((match = BRACKET_RE.exec(source)) !== null) {
      var raw = match[1].trim();
      if (!raw) continue;
      var parts = raw.split(",");
      for (var i = 0; i < parts.length; i++) {
        var name = parts[i].trim();
        if (!name) continue;
        var key = name.toLowerCase();
        if (!seen[key]) {
          seen[key] = true;
          tags.push(name);
        }
      }
    }
    return tags;
  }

  function includesId(ids, id) {
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i]) === String(id)) return true;
    }
    return false;
  }

  function findTagByName(name) {
    var query =
      "query FindTags($filter: FindFilterType, $tag_filter: TagFilterType) {\
        findTags(filter: $filter, tag_filter: $tag_filter) {\
          tags { id name }\
        }\
      }";
    var variables = {
      filter: { per_page: 25, q: name },
      tag_filter: {
        name: { value: name, modifier: "EQUALS" },
      },
    };
    var result = gql.Do(query, variables);
    var tags =
      result.findTags && result.findTags.tags ? result.findTags.tags : [];
    for (var i = 0; i < tags.length; i++) {
      if (String(tags[i].name).toLowerCase() === name.toLowerCase()) {
        return tags[i];
      }
    }
    return null;
  }

  function createTag(name) {
    var mutation =
      "mutation TagCreate($input: TagCreateInput!) {\
        tagCreate(input: $input) { id name }\
      }";
    var result = gql.Do(mutation, { input: { name: name } });
    return result.tagCreate;
  }

  function resolveTagId(name, createMissingTags) {
    var existing = findTagByName(name);
    if (existing) return existing.id;
    if (!createMissingTags) {
      log.Warn('Tag "' + name + '" not found; skipped.');
      return null;
    }
    var created = createTag(name);
    log.Info('Created tag "' + name + '"');
    return created.id;
  }

  function getScene(sceneId) {
    var query =
      "query FindScene($id: ID) {\
        findScene(id: $id) {\
          id\
          organized\
          tags { id }\
          files { path basename }\
        }\
      }";
    var result = gql.Do(query, { id: String(sceneId) });
    return result.findScene || null;
  }

  function getSceneFilename(scene) {
    if (!scene || !scene.files || !scene.files.length) return "";
    var file = scene.files[0];
    return file.basename || file.path || "";
  }

  function getAllScenes() {
    var query =
      "query FindScenes($filter: FindFilterType) {\
        findScenes(filter: $filter) {\
          count\
          scenes {\
            id\
            organized\
            tags { id }\
            files { path basename }\
          }\
        }\
      }";
    var page = 1;
    var perPage = 1000;
    var all = [];
    while (true) {
      var result = gql.Do(query, {
        filter: { per_page: perPage, page: page },
      });
      var findScenes = result.findScenes;
      if (!findScenes || !findScenes.scenes || !findScenes.scenes.length) break;
      all = all.concat(findScenes.scenes);
      if (all.length >= findScenes.count) break;
      page += 1;
    }
    return all;
  }

  function setSceneTags(sceneId, tagIds) {
    var mutation =
      "mutation SceneUpdate($input: SceneUpdateInput!) {\
        sceneUpdate(input: $input) { id }\
      }";
    gql.Do(mutation, {
      input: {
        id: String(sceneId),
        tag_ids: tagIds,
      },
    });
  }

  function processScene(scene, settings) {
    if (!scene) return { added: 0, skipped: "missing scene" };
    if (scene.organized) return { added: 0, skipped: "organized" };

    var filename = getSceneFilename(scene);
    if (!filename) return { added: 0, skipped: "no file" };

    var names = extractBracketTags(filename);
    if (!names.length) return { added: 0, skipped: "no brackets" };

    var existingIds = [];
    if (scene.tags) {
      for (var i = 0; i < scene.tags.length; i++) {
        existingIds.push(scene.tags[i].id);
      }
    }

    var newIds = [];
    for (var j = 0; j < names.length; j++) {
      var tagId = resolveTagId(names[j], settings.createMissingTags);
      if (!tagId) continue;
      if (!includesId(existingIds, tagId) && !includesId(newIds, tagId)) {
        newIds.push(tagId);
      }
    }

    if (!newIds.length) return { added: 0, skipped: "already tagged" };

    setSceneTags(scene.id, existingIds.concat(newIds));
    log.Info(
      "Scene " +
        scene.id +
        ' ("' +
        filename +
        '"): added tags ' +
        names.join(", ")
    );
    return { added: newIds.length };
  }

  function processSceneById(sceneId, settings) {
    return processScene(getScene(sceneId), settings);
  }

  function main() {
    var settings = getSettings();
    var mode = input.Args && input.Args.mode ? input.Args.mode : "allScenes";

    if (mode === "hook") {
      if (!settings.autoOnScan) {
        log.Debug("autoOnScan disabled; hook skipped");
        return ok("hook skipped");
      }
      var hookContext = input.Args.hookContext;
      if (!hookContext || !hookContext.id) {
        return ok("no scene id");
      }
      processSceneById(hookContext.id, settings);
      return ok("hook done");
    }

    if (mode === "allScenes") {
      var scenes = getAllScenes();
      var updated = 0;
      log.Info("Processing " + scenes.length + " scenes");
      for (var i = 0; i < scenes.length; i++) {
        var result = processScene(scenes[i], settings);
        if (result.added > 0) updated += 1;
        if (scenes.length > 0) {
          log.Progress((i + 1) / scenes.length);
        }
      }
      log.Info("Done. Updated " + updated + " scene(s).");
      return ok("updated " + updated);
    }

    log.Error("Unknown mode: " + mode);
    return { error: "Unknown mode: " + mode };
  }

  return main();
})();
