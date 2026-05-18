# Folder Sidebar (Stash UI plugin)

Fixed sidebar with configurable root folders. Pick a folder, drill into subfolders, and see a plain list of scenes in the current directory only (no filter UI).

## Installation

1. Copy the `stash-folder-sidebar` folder to `%USERPROFILE%\.stash\plugins\folderSidebar`  
   (or your Stash `plugins` directory next to `config.yml`).
2. In Stash: **Settings → Plugins → Reload plugins**
3. Enable **Folder Sidebar** if it is disabled
4. Edit **`folders.json`** with your real paths

## Configuration

### `folders.json` (recommended)

```json
[
  { "label": "Project A", "path": "D:\\Media\\Special\\ProjectA" },
  { "label": "NAS PMV", "path": "\\\\NAS\\Videos\\PMV" }
]
```

- **`label`**: Name shown in the sidebar  
- **`path`**: Folder path as Stash stores it (double backslashes on Windows: `\\`)  
- **Root folders** on the left → **Subfolders** in the main panel → **Files** lists only the current folder (not recursive)  
- Breadcrumb and **Up one level** for navigation

### Plugin settings UI

Under **Settings → Plugins → Folder Sidebar**:

- **Label** and **Path** fields plus **Add** append a root folder (saved automatically).
- Configured folders are listed above the form.
- **Remove:** click **Delete** on a row (confirmation dialog). Optional: **Edit JSON (advanced)** for bulk edits.

Once you add a folder here, it is stored in plugin settings and overrides `folders.json`.

## Usage

- Main navigation: **Folder**
- Direct URL: `http://localhost:9999/plugin/folder-sidebar` (adjust port)
- Query `?folder=0` selects the first entry in the JSON list

## Notes

- Lists **scenes** only (not images or galleries).  
- Paths must match Stash-indexed file paths (copy from a scene’s **File info** tab).  
- Large folders load all matches at once (`per_page: -1`); split roots if performance suffers.

## Files

| File | Purpose |
|------|---------|
| `folderSidebar.yml` | Plugin manifest |
| `folderSidebar.js` | UI logic |
| `folderSidebar.css` | Layout |
| `folders.json` | Your folder list |
