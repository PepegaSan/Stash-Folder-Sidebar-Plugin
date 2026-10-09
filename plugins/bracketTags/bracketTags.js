(function () {
  var PLUGIN_ID = "bracketTags";
  // Innermost brackets only: in "Clip [1 [Solo].mp4" (unclosed "[" in the name) the tag is "Solo", not "1 [Solo"
  var BRACKET_RE = /\[([^\[\]]+)\]/g;
  // Parent tag that marks every tag this plugin sets. Only the sync task removes tags, and only these.
  var PARENT_TAG = "Bracket Tags";

  // Per-run caches: one Stash lookup per tag name instead of one per scene
  var tagCache = {}; // lower-case name -> tag id (or null if missing and not created)
  var parentChecked = {}; // tag id -> true once it is a child of PARENT_TAG

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

  function createTag(name, parentId) {
    var mutation =
      "mutation TagCreate($input: TagCreateInput!) {\
        tagCreate(input: $input) { id name }\
      }";
    var input = { name: name };
    if (parentId) input.parent_ids = [String(parentId)];
    var result = gql.Do(mutation, { input: input });
    return result.tagCreate;
  }

  function ensureParentTag() {
    var existing = findTagByName(PARENT_TAG);
    if (existing) return existing.id;
    var created = createTag(PARENT_TAG, null);
    log.Info('Created tag "' + PARENT_TAG + '"');
    return created.id;
  }

  function addParent(tagId, parentId) {
    if (parentChecked[tagId] || String(tagId) === String(parentId)) return;
    var result = gql.Do(
      "query FindTagParents($id: ID!) { findTag(id: $id) { parents { id } } }",
      { id: String(tagId) }
    );
    var parents = [];
    var found = result.findTag && result.findTag.parents ? result.findTag.parents : [];
    for (var i = 0; i < found.length; i++) parents.push(String(found[i].id));
    if (!includesId(parents, parentId)) {
      // parent_ids replaces all parents, so keep the existing ones
      gql.Do(
        "mutation TagUpdate($input: TagUpdateInput!) { tagUpdate(input: $input) { id } }",
        { input: { id: String(tagId), parent_ids: parents.concat([String(parentId)]) } }
      );
    }
    parentChecked[tagId] = true;
  }

  function getManagedTagIds(parentId) {
    var result = gql.Do(
      "query FindTagChildren($id: ID!) { findTag(id: $id) { children { id } } }",
      { id: String(parentId) }
    );
    var ids = [];
    var children = result.findTag && result.findTag.children ? result.findTag.children : [];
    for (var i = 0; i < children.length; i++) ids.push(String(children[i].id));
    return ids;
  }

  function resolveTagId(name, settings, parentId) {
    var key = name.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(tagCache, key)) return tagCache[key];
    var id = null;
    var existing = findTagByName(name);
    if (existing) {
      id = existing.id;
    } else if (settings.createMissingTags) {
      id = createTag(name, parentId).id;
      log.Info('Created tag "' + name + '"');
      if (parentId) parentChecked[id] = true;
    } else {
      log.Warn('Tag "' + name + '" not found; skipped.');
    }
    if (id && parentId) addParent(id, parentId);
    tagCache[key] = id;
    return id;
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

  // Scenes the plugin works on: not organized and with at least one [bracket] in the filename.
  // Scenes without brackets are never touched, also not by the stale-tag removal.
  function bracketNames(scene) {
    if (!scene) return { skipped: "missing scene" };
    if (scene.organized) return { skipped: "organized" };
    var filename = getSceneFilename(scene);
    if (!filename) return { skipped: "no file" };
    var names = extractBracketTags(filename);
    if (!names.length) return { skipped: "no brackets" };
    return { filename: filename, names: names };
  }

  // ctx.managed (tags allowed to be removed) is set only by the sync task
  function processScene(scene, settings, ctx) {
    var info = bracketNames(scene);
    if (info.skipped) return { added: 0, removed: 0, skipped: info.skipped };

    var wanted = [];
    for (var j = 0; j < info.names.length; j++) {
      var tagId = resolveTagId(info.names[j], settings, ctx.parentId);
      if (tagId && !includesId(wanted, tagId)) wanted.push(tagId);
    }

    var keep = [];
    var removed = [];
    var tags = scene.tags || [];
    for (var i = 0; i < tags.length; i++) {
      var id = tags[i].id;
      // A managed tag whose bracket is no longer in the filename is stale
      if (ctx.managed && includesId(ctx.managed, id) && !includesId(wanted, id)) {
        removed.push(id);
      } else {
        keep.push(id);
      }
    }
    var added = [];
    for (var k = 0; k < wanted.length; k++) {
      if (!includesId(keep, wanted[k])) added.push(wanted[k]);
    }

    if (!added.length && !removed.length) return { added: 0, removed: 0, skipped: "already tagged" };

    setSceneTags(scene.id, keep.concat(added));
    log.Info(
      "Scene " + scene.id + ' ("' + info.filename + '"): ' +
        (added.length ? "added " + added.length + " tag(s)" : "") +
        (added.length && removed.length ? ", " : "") +
        (removed.length ? "removed " + removed.length + " stale tag(s)" : "") +
        " [" + info.names.join(", ") + "]"
    );
    return { added: added.length, removed: removed.length };
  }

  // Every tag the plugin sets goes under the parent tag, also when only adding. Otherwise a tag whose
  // [bracket] was renamed away before the next sync would never count as managed and could not be removed.
  // Tags with "[" or "]" in the name come from the old parser (before 1.2.1) and are never valid bracket tags
  var BROKEN_QUERY =
    "query FindBrokenTags($tag_filter: TagFilterType) {\
      findTags(filter: { per_page: -1 }, tag_filter: $tag_filter) {\
        tags { id name scene_count scene_marker_count image_count gallery_count performer_count }\
      }\
    }";

  function findBrokenTags() {
    var found = {};
    var chars = ["[", "]"];
    for (var i = 0; i < chars.length; i++) {
      var result = gql.Do(BROKEN_QUERY, { tag_filter: { name: { value: chars[i], modifier: "INCLUDES" } } });
      var tags = result.findTags && result.findTags.tags ? result.findTags.tags : [];
      for (var j = 0; j < tags.length; j++) found[tags[j].id] = tags[j];
    }
    var list = [];
    for (var id in found) list.push(found[id]);
    return list;
  }

  // After sync: delete broken tags that are no longer used anywhere
  function destroyUnusedBrokenTags() {
    var deleted = [];
    var kept = [];
    var tags = findBrokenTags();
    for (var i = 0; i < tags.length; i++) {
      var t = tags[i];
      var used = (t.scene_count || 0) + (t.scene_marker_count || 0) + (t.image_count || 0) +
        (t.gallery_count || 0) + (t.performer_count || 0);
      if (used) {
        kept.push(t.name);
        continue;
      }
      gql.Do("mutation TagDestroy($input: TagDestroyInput!) { tagDestroy(input: $input) }", { input: { id: String(t.id) } });
      deleted.push(t.name);
    }
    if (deleted.length) log.Info("Deleted " + deleted.length + ' broken tag(s): "' + deleted.join('", "') + '"');
    if (kept.length) log.Warn('Broken tag(s) still in use (organized scenes, images, ...), not deleted: "' + kept.join('", "') + '"');
    return deleted.length;
  }

  function makeContext() {
    return { parentId: ensureParentTag(), managed: null };
  }

  function main() {
    var settings = getSettings();
    var mode = input.Args && input.Args.mode ? input.Args.mode : "allScenes";
    var ctx;

    if (mode === "hook") {
      if (!settings.autoOnScan) {
        log.Debug("autoOnScan disabled; hook skipped");
        return ok("hook skipped");
      }
      var hookContext = input.Args.hookContext;
      if (!hookContext || !hookContext.id) {
        return ok("no scene id");
      }
      // new scenes: only add, never remove
      processScene(getScene(hookContext.id), settings, makeContext());
      return ok("hook done");
    }

    // allScenes = add only, existing tags stay. syncScenes = add and remove stale bracket tags.
    if (mode === "allScenes" || mode === "syncScenes") {
      var scenes = getAllScenes();
      var sync = mode === "syncScenes";
      ctx = makeContext();
      log.Info("Processing " + scenes.length + " scenes" + (sync ? " (removing stale bracket tags)" : " (add only, nothing is removed)"));
      if (sync) {
        // Pass 1: resolve every bracket name once, so all current bracket tags carry the parent tag
        for (var a = 0; a < scenes.length; a++) {
          var names = bracketNames(scenes[a]).names || [];
          for (var b = 0; b < names.length; b++) resolveTagId(names[b], settings, ctx.parentId);
        }
        ctx.managed = getManagedTagIds(ctx.parentId);
        var broken = findBrokenTags();
        for (var c = 0; c < broken.length; c++) ctx.managed.push(String(broken[c].id));
        if (broken.length) log.Info("Removing " + broken.length + ' broken tag(s) from scenes, e.g. "' + broken[0].name + '"');
      }
      var updated = 0;
      var removedTotal = 0;
      for (var i = 0; i < scenes.length; i++) {
        var result = processScene(scenes[i], settings, ctx);
        if (result.added > 0 || result.removed > 0) updated += 1;
        removedTotal += result.removed || 0;
        if (scenes.length > 0) {
          log.Progress((i + 1) / scenes.length);
        }
      }
      if (sync) destroyUnusedBrokenTags();
      log.Info("Done. Updated " + updated + " scene(s)" + (sync ? ", removed " + removedTotal + " stale tag(s)." : "."));
      return ok("updated " + updated);
    }

    log.Error("Unknown mode: " + mode);
    return { error: "Unknown mode: " + mode };
  }

  return main();
})();
