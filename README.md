# Stash plugins (PepegaSan)

Community plugins for [Stash](https://github.com/stashapp/stash), installable via [source URL](#installation-from-stash-plugin-source-url) or manual copy from `plugins/<id>/`.

**Jump to:** [Folder Sidebar](#folder-sidebar) · [Quick Markers](#quick-markers) · [Bracket Tags](#bracket-tags) · [Tag Categories](#tag-categories)

| Plugin | Description |
|--------|-------------|
| [Folder Sidebar](#folder-sidebar) | Browse scenes by filesystem folder |
| [Quick Markers](#quick-markers) | Hotkey scene markers with presets |
| [Bracket Tags](#bracket-tags) | Tags from `[brackets]` in filenames |
| [Tag Categories](#tag-categories) | Browse scenes by named categories (any matching tag) |

---

# Folder Sidebar

Fixed sidebar with your own root folders, drill into subfolders, and list scenes in the current directory only — no filter UI.

![Stash](https://img.shields.io/badge/Stash-UI%20plugin-blue)
![Version](https://img.shields.io/badge/version-1.4.6-informational)

## Features

- **Folder** entry in the main navigation (with icon)
- Configurable **root folders** (sidebar + settings UI)
- **Subfolders** per root, breadcrumb navigation, **up one level**
- **Files in this folder** only (not recursive into subfolders)
- **Browse cache** — reopening a folder or using the browser **Back** button after opening a scene shows the last list immediately (background refresh optional)
- Settings UI: add folders (label + path), **Delete** per row, collapsible sections, optional JSON editor

## Requirements

- Stash with UI plugin support (recent stable builds)
- Scenes indexed under the paths you configure

## Installation

### From Stash (plugin source URL) {#installation-from-stash-plugin-source-url}

1. In Stash: **Settings → Plugins → Available Plugins**
2. Add this **source URL** (after [GitHub Pages](#github-pages-one-time) is enabled on the repo):

   ```
   https://pepegasan.github.io/Stash-Folder-Sidebar-Plugin/main/index.yml
   ```

3. Install **Folder Sidebar**, **Quick Markers**, **Bracket Tags**, and/or **Tag Categories** from the list, then reload plugins if prompted.

### Manual

1. Download or clone this repository.
2. Copy everything from **`plugins/folderSidebar/`** into your Stash plugins directory as **`folderSidebar`**:

   | OS | Path |
   |----|------|
   | Windows | `%USERPROFILE%\.stash\plugins\folderSidebar\` |
   | Linux / macOS | `~/.stash/plugins/folderSidebar/` |

   Required files in that folder:

   - `folderSidebar.yml`
   - `folderSidebar.js`
   - `folderSidebar.css`
   - `folders.json` (copy from `folders.json.example`)

3. In Stash: **Settings → Plugins → Reload plugins**
4. Enable **Folder Sidebar** if needed
5. Configure folders (see below)

### Git clone (example)

```bash
git clone https://github.com/PepegaSan/Stash-Folder-Sidebar-Plugin.git
cp -r Stash-Folder-Sidebar-Plugin/plugins/folderSidebar ~/.stash/plugins/folderSidebar
cp ~/.stash/plugins/folderSidebar/folders.json.example ~/.stash/plugins/folderSidebar/folders.json
```

Then reload plugins in Stash.

## GitHub Pages (one-time)

For the source URL above to work, enable Pages on this repository:

1. GitHub repo → **Settings → Pages**
2. **Build and deployment → Source:** GitHub Actions
3. Push to `main` (or run the **Deploy repository to GitHub Pages** workflow manually)

The workflow builds `index.yml` and plugin zips from `plugins/` using `build_site.sh` (same pattern as [stashapp/plugins-repo-template](https://github.com/stashapp/plugins-repo-template)).

## Configuration

### Settings UI (recommended)

**Settings → Plugins → Folder Sidebar**

- **Root folders** — list of configured entries (collapsible)
- **Add folder** — **Label** + **Path**, then **Add** (use normal paths: `D:\Media\AMV`, not JSON escaping)
- **Delete** — removes a row (with confirmation)
- **Edit JSON (advanced)** — bulk edit; in JSON files use `\\` for backslashes

After you add a folder in the UI, settings are stored in Stash and override `folders.json`.

### `folders.json` (optional file)

Copy `folders.json.example` to `folders.json` and edit:

```json
[
  { "label": "Project A", "path": "/data/Special/ProjectA" },
  { "label": "NAS PMV", "path": "\\\\NAS\\Videos\\PMV" }
]
```

- **`label`**: Name in the sidebar  
- **`path`**: Exact path as shown in Stash **File info** for a scene in that tree  
- In **JSON only**: double backslashes on Windows (`D:\\Media\\...`)

## Usage

- Click **Folder** in the top navigation  
- Left: root folders from config  
- Pick a subfolder or view files in the current folder  
- Direct link (same Stash session): `http://localhost:9999/plugin/folder-sidebar`  
  - Opening in a **new tab** or refresh may show **404** — [known Stash plugin route limitation](https://github.com/stashapp/stash/issues/4510)

## Performance and cache

- The first time you open a folder, Stash loads all scenes under that path (can take a while on large trees).
- **v1.4.1+** keeps results in memory for **30 minutes** per folder path. After you open a scene and go **Back**, the folder view appears right away from cache; Stash may still refresh in the background (**Updating…** next to **Refresh**).
- Use **Refresh** to force a reload (clears cache for the current folder).
- For faster first loads, use **smaller root folders** in settings instead of one huge library path.

## Notes

- **Scenes only** (not images/galleries)  
- Paths must match Stash’s indexed paths (Docker: often `/data/...`, not `D:\...`)  
- Very large folders load all scenes at once on first visit; split roots if needed  

---

# Quick Markers

Create **scene markers** from the scene player with **presets** (e.g. tag `Compilation`) — no marker dialog.

![Stash](https://img.shields.io/badge/Stash-UI%20plugin-blue)
![Version](https://img.shields.io/badge/version-1.3.3-informational)

## Requirements

- Stash UI plugins enabled
- **Tags must exist** in Stash before use (e.g. create tag `Compilation` under **Tags**)
- Copy `presets.json.example` → `presets.json` in the plugin folder, or configure under **Settings → Plugins → Quick Markers**

## Hotkeys (defaults)

| Key | Action |
|-----|--------|
| `shift+1` … `shift+9` | **Select** the preset assigned to that slot (`selectSlot` in settings — not always list order) |
| `shift+i` | **In** point (active preset) |
| `shift+o` | **Out** + create range marker (active preset) |
| `shift+m` | Instant marker at playhead (**active** preset; Shift+M, not Ctrl+M) |
| `shift+[` / `shift+]` | Previous / next active preset |

**Note:** Plain `i` / `o` / `m` are used by Stash. `shift+m` is free in Stash and browsers. Assign up to nine presets to Shift+1–9 via **Select hotkey** when editing a preset (useful if you have more than nine).

## Usage

1. Open a **scene** and start playback.
2. Press **Shift+3** (etc.) to select the preset assigned to that slot, **or** click it in the panel.
3. Use **Shift+I** at start, **Shift+O** at end → range marker with that preset’s tag.
4. Or press **Shift+M** for an instant marker at the current time (active preset).
5. Optional: floating **Quick Markers** panel (corner in settings; collapsed by default) — **drag the header** to move it, double-click header to reset; `Shift+[` / `Shift+]` also cycle presets.
6. **Android / tablet:** touch bar (**IN** / **OUT** / **INSTANT** + presets) aligned to the player — sits under the player, or just above the seek/control bar if space is tight (theme-friendly). Use **Hide** / **▲ Quick Markers** to collapse or expand; remembered across scenes. Auto-enabled on touch devices; override in settings.

Markers are saved via GraphQL; open the **Markers** tab or refresh if the list does not update immediately.

## Configuration

**Settings → Plugins → Quick Markers**

- **Scene panel position** — starting corner (top-left default), or hidden (hotkeys only); drag the panel header on the scene page to place it freely
- **Start scene panel collapsed** — small header until expanded
- **Touch controls (Android / tablet)** — auto-detect, always on, or off (bar follows player width/position; avoids covering the timeline)
- **Presets** list (collapsible) — view/edit/delete presets; **Select hotkey** assigns Shift+1–9 to any preset
- **Add / Edit preset** — label, primary tag, optional tags, range keys, instant key (`shift+m`), select slot
- **Edit JSON (advanced)…** — full config in a popup
- **Help: tags in JSON** — how to add `tags` to a preset (German or English by browser locale)

JSON example (same as in the modal):

```json
{
  "defaultPresetIndex": 0,
  "panelPosition": "top-left",
  "panelCollapsed": true,
  "touchControls": "auto",
  "presets": [
    {
      "id": "compilation",
      "label": "Compilation",
      "primaryTag": "Compilation",
      "tags": ["Favorite"],
      "title": "Compilation",
      "rangeInKey": "shift+i",
      "rangeOutKey": "shift+o",
      "instantKey": "shift+m",
      "selectSlot": 1
    }
  ]
}
```

- `primaryTag` — exact tag **name** in Stash (required); becomes the marker **primary tag**
- `tags` — optional array of extra tag names on the marker (must exist in Stash)
- `rangeInKey` / `rangeOutKey` — range workflow for that preset when it is **active** (defaults to `shift+i` / `shift+o` if omitted)
- `instantKey` — instant marker for the **active** preset (defaults to `shift+m`)
- `selectSlot` — `1`–`9` maps this preset to `shift+1`–`shift+9`; `null` = no select hotkey (defaults: first nine presets get slots 1–9)
- `panelPosition`, `panelCollapsed`, `touchControls` — optional UI settings

Presets are stored in **Stash plugin settings** (`presetsJson`) after you save in the UI. The optional `presets.json` file in the plugin folder is only used until settings are saved once.

## Manual install

Copy `plugins/quickMarkers/` to `~/.stash/plugins/quickMarkers/`, add `presets.json` from the example, then reload (see below).

### Reload plugins in Stash (important)

`Ctrl+F5` alone is **not** enough — Stash loads plugin JavaScript separately from the main UI bundle.

1. Replace files under `~/.stash/plugins/quickMarkers/` (all of them).
2. **Settings → Plugins → Reload plugins** (wait until it finishes).
3. Click **Reload UI** on the plugin row (or fully close the browser tab and open Stash again).
4. Optional (Docker): restart the Stash container.
5. Verify: open browser **F12 → Console** — you should see `[Quick Markers] loaded v1.3.3`.
6. Open **Settings → Plugins → Quick Markers** — top line must say **Quick Markers v1.3.3**.

If the version line is missing or an old version number appears, the old `quickMarkers.js` is still active.

---

# Bracket Tags

Adds **scene tags** from text in **square brackets** in the filename — e.g. `[Joi]` and `[Talk]` in `My Clip [Joi] [Talk].mp4`. Simpler than generic filename parsers: no regex config, just run a task or enable auto-tagging on scan.

![Stash](https://img.shields.io/badge/Stash-task%20plugin-blue)
![Version](https://img.shields.io/badge/version-1.0.0-informational)

## Features

- Reads every `[...]` block from the scene filename (first file on the scene)
- **Multiple brackets** — `[Tag A] [Tag B]` or comma-separated inside one bracket: `[Tag A, Tag B]`
- **Create missing tags** — optional; on by default (no manual tag setup required)
- **Manual task** — process the whole library once from **Tasks**
- **Auto on new scenes** — optional hook after library scan (new scenes only)
- Skips **organized** scenes; only **adds** tags, never removes existing ones

## Requirements

- Stash with plugin task support (recent stable builds)
- **Scenes only** (not images/galleries)

## Installation

Install from the [plugin source URL](#installation-from-stash-plugin-source-url) (**Bracket Tags** in the list), or copy manually:

| OS | Path |
|----|------|
| Windows | `%USERPROFILE%\.stash\plugins\bracketTags\` |
| Linux / macOS | `~/.stash/plugins/bracketTags/` |

Required files: `bracketTags.yml`, `bracketTags.js`

Then **Settings → Plugins → Reload plugins**.

## Configuration

**Settings → Plugins → Bracket Tags**

| Setting | Default | Description |
|---------|---------|-------------|
| **Create missing tags** | on | Create tags in Stash when the bracket name does not exist yet |
| **Auto on new scenes** | off | Apply bracket tags automatically when a scene is created (e.g. after scan) |

## Usage

### Existing library (one-time)

1. **Tasks → Apply bracket tags to all scenes**
2. Watch progress in the task log; updated scenes are logged with filename and tags added

### New files after scan

Enable **Auto on new scenes** in plugin settings, then run a normal library scan. Each new scene gets bracket tags from its filename without running the task again.

### Examples

| Filename | Tags added |
|----------|------------|
| `My Clip [Joi] [Talk].mp4` | `Joi`, `Talk` |
| `Clip [Joi, Talk].mp4` | `Joi`, `Talk` |
| `No brackets here.mp4` | *(skipped)* |

## Notes

- Matching is **case-insensitive** when checking if a tag already exists on the scene
- Tag **names** in brackets are used as-is (trimmed); create-missing uses the exact bracket text
- Re-running the task is safe — already-applied tags are not duplicated
- For complex filename layouts (studio/date/performer patterns), use Stash’s built-in **Scene Filename Parser** instead

## Manual install

```bash
git clone https://github.com/PepegaSan/Stash-Folder-Sidebar-Plugin.git
cp -r Stash-Folder-Sidebar-Plugin/plugins/bracketTags ~/.stash/plugins/bracketTags
```

Reload plugins in Stash, then run the task or enable **Auto on new scenes**.

---

# Tag Categories

Named **categories**, each with a list of Stash **tags**. Open **Categories** in the main menu, pick a category, and browse every scene that has **any** of those tags (OR filter). Categories live in plugin settings — they are not a native Stash entity.

The same tag can appear in multiple categories; categories do not block or claim tags from each other.

![Stash](https://img.shields.io/badge/Stash-UI%20plugin-blue)
![Version](https://img.shields.io/badge/version-1.4.0-informational)

## Features

- **Categories** item in the main navigation
- Click a category → scenes matching **any** of its tags
- **Search within a category** — filters the already loaded list (title, file, performers, studio, tags); no extra server request while typing
- **Sort** — title, duration (long/short), date (newest/oldest); client-side, preference kept in the browser
- **List / Preview** view toggle (thumbnails in Preview; preference kept in the browser)
- Settings UI: name + comma-separated tags, edit/delete, collapsible sections
- **Edit JSON (advanced)** modal with short help
- UI language follows Stash (**English** / **German**; otherwise English)

## Requirements

- Stash with UI plugin support (recent stable builds)

## Installation

Install **Tag Categories** from the [plugin source URL](#installation-from-stash-plugin-source-url), or copy manually:

| OS | Path |
|----|------|
| Windows | `%USERPROFILE%\.stash\plugins\tagCategories\` |
| Linux / macOS | `~/.stash/plugins/tagCategories/` |

Required files: `tagCategories.yml`, `tagCategories.js`, `tagCategories.css`  
Optional: `categories.json` (copy from `categories.json.example`)

Then **Settings → Plugins → Reload plugins**.

## Configuration

**Settings → Plugins → Tag Categories**

| Section | Description |
|---------|-------------|
| **Categories** | List, edit, or delete categories |
| **Add category** | Name + tags (`Action, Comedy, Drama`) |
| **Edit JSON** | Full config editor + help button |

### JSON shape

```json
{
  "categories": [
    {
      "id": "genre",
      "name": "Genre",
      "tags": ["Action", "Comedy", "Drama"]
    }
  ]
}
```

| Field | Role |
|-------|------|
| `name` | Label in the UI |
| `tags` | Tag names to filter by (any match) |
| `id` | Fixed browser URL (optional; otherwise from `name`) |

Saved in plugin settings (`categoriesJson`) after you save in the UI. An optional `categories.json` in the plugin folder is used only until settings are saved once.

## Usage

1. Add categories under **Settings → Plugins → Tag Categories**
2. Open **Categories** in the main menu
3. Select a category in the left sidebar — matching scenes appear on the right
4. Switch **List** / **Preview** above the results
5. Use the search box to narrow the current category (words are AND; no extra load)
6. Use **Sort** for title, duration, or date

## Manual install

```bash
git clone https://github.com/PepegaSan/Stash-Folder-Sidebar-Plugin.git
cp -r Stash-Folder-Sidebar-Plugin/plugins/tagCategories ~/.stash/plugins/tagCategories
```

Reload plugins in Stash. Console should show `[Tag Categories] loaded v1.4.0`.

---

## Changelog

### Tag Categories 1.4.0

- **Sort** loaded category scenes by title, duration (long/short), or date — client-side, no extra request

### Tag Categories 1.3.0

- **Search within a category** — client-side filter of loaded scenes (debounced); matches title, path, performers, studio, and tags

### Tag Categories 1.2.0

- **List / Preview** toggle for category results (thumbnails in preview; preference stored in the browser)
- Shorter JSON help text for `id`

### Tag Categories 1.1.0

- **Browse mode** — main menu **Categories** tab; click a category to list scenes matching any of its tags (replaces scene apply panel)

### Tag Categories 1.0.0

- Initial release: category list, comma-separated tags, JSON editor + help, DE/EN from Stash language

### Bracket Tags 1.0.0

- Initial release: bracket parsing, optional tag creation, manual task + optional scan hook

### Quick Markers 1.3.1

- **Editable select slots** — assign any preset to Shift+1–9 (`selectSlot`); extras beyond nine can stay unassigned or steal a slot from another preset

### Quick Markers 1.3.0

- **Shift+1–9 select presets** — activate preset 1–9 without creating a marker; then use Shift+I/O as usual
- **Instant default is Shift+M** — old `instantKey` values of `shift+1`–`9` are migrated to `shift+m`

### Quick Markers 1.2.9

- **Theme-friendly touch bar** — docks below the player, or above the seek/control bar when space is tight, so timelines stay usable across themes

### Quick Markers 1.2.8

- **Draggable scene panel** — drag the header to move; double-click header to reset to the configured corner; position saved in the browser
- **Touch bar width** — IN/OUT/INSTANT bar matches the video player width instead of full screen

### Quick Markers 1.2.7

- **Settings UI** — clearer **Edit** button next to Delete; wider actions column so Edit is not clipped

### Quick Markers 1.2.6

- **Default instant hotkey** — omitted `instantKey` defaults to `shift+1` for every preset (same shared model as Shift+I/O on the **active** preset); unique keys like `shift+2` still work as direct shortcuts

### Quick Markers 1.2.5

- **Edit preset in settings** — **Edit** opens the same form as Add, prefilled; **Save changes** updates that preset (JSON still available for advanced edits)

### Quick Markers 1.2.4

- **Default range hotkeys** — if a preset omits `rangeInKey` / `rangeOutKey`, they default to `shift+i` / `shift+o` (still overridable per preset)

### Quick Markers 1.2.x (1.2.0–1.2.3)

- **Additional tags per preset** — optional `tags` array in JSON; applied as extra marker tags (`tag_ids`) alongside `primaryTag`
- **Help: tags in JSON** — modal explaining how to add `tags` to presets via **Edit JSON** (German or English from browser locale)
- Settings: optional **Additional tags** field when adding a preset; preset list shows primary tag + extras

### Quick Markers 1.1.0

- **Touch controls** for Android / tablet — fixed bottom bar with **IN** / **OUT** / **INSTANT** and preset buttons (does not overlay the video player)
- **Touch controls** setting: auto-detect (`pointer: coarse`), always on, or off

### Quick Markers 1.0.7–1.0.9

- Fix marker create API (400) and **PluginApi** initialization (settings + scene panel missing)
- **Scene panel position** (top-left default, hidden, etc.) and **collapsed by default**; browser remembers expand/collapse

### Quick Markers 1.0.6

- Built-in default presets when `presets.json` is missing (no 404 error)

### Quick Markers 1.0.5

- Safer `patch.instead` for settings; native HTML buttons; version line in settings for cache check

### Quick Markers 1.0.4

- Replace Bootstrap Modal with custom popup (fixes React error #31 in settings)

### Quick Markers 1.0.3

- Use `patch.after` for plugin settings (fixes `next is not a function` with multiple UI plugins)
- Fix `ScenePage` patch argument order

### Quick Markers 1.0.2

- Fix plugin settings patch signature (superseded by 1.0.3)

### Quick Markers 1.0.1

- Plugin settings UI: preset list, add form, JSON editor in modal popup

### Quick Markers 1.0.0

- Initial release: presets, Shift+I/O range, Shift+1–9 instant, on-scene panel

### Quick Markers 1.3.3

- **Collapsible touch bar** — Hide / expand on Android & tablet; open/closed state stored in the browser and shared across scenes

### Folder Sidebar 1.4.6 / Tag Categories 1.2.2 / Quick Markers 1.3.2

- **Critical UI crash hardening** — MainNav items wrapped in error boundaries; no GQL in the navbar; Rules-of-Hooks safe
- **Quick Markers** — ScenePage patch isolated; touch bar only mounts after player geometry is known (theme seek bars stay usable); safer PluginApi guards

### Folder Sidebar 1.4.5

- **Hardened MainNav patch** — missing icons/router/Bootstrap APIs no longer crash the whole Stash UI (blank page / stacked nav icons)

### Tag Categories 1.2.1

- Same MainNav hardening as Folder Sidebar (prevent global UI crash)

### Folder Sidebar 1.4.4

- Safer `patch.instead` for plugin settings (works with Quick Markers)

### Folder Sidebar 1.4.3

- Use `patch.after` for plugin settings (compatible with Quick Markers)

### Folder Sidebar 1.4.2

- Fix plugin settings patch signature (superseded by 1.4.3)

### Folder Sidebar 1.4.1

- In-memory browse cache (30 min) for instant return after opening a scene or navigating back
- GraphQL `cache-first` for folder queries; **Refresh** clears cache and refetches

### 1.4.0

- Delete button per root folder in plugin settings

## License

MIT — see [LICENSE](LICENSE).

## Author

[PepegaSan](https://github.com/PepegaSan) — issues and PRs welcome on this repository.
