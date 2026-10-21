# Changelog

## 0.3.1 (2026-10-21)

- Help dialog (? in the toolbar): workflow in five steps and all shortcuts.
- "Motion on the beat": measured spots are remembered per browser, so a re-run or the same seed does not measure them again.

## 0.3.0 – first public beta (2026-10-21)

- English interface, German as second language (follows Stash's interface language, or Stash UI's); backend messages, log lines and CLI help in English.
- Verified on Linux (official `stashapp/stash` Docker image): setup, plugin load, scan, render task, scan of the output folder.
- Stash UI support: extension module with a **Watch → PMV Creator** entry, the editor as a full-screen page, entry points in the player's info bar and in the selection bar of scene lists.
- Generator: clip sources (filter, most watched, project scenes, selection), scenes or markers, tag stages, auto/fixed/pattern cutting on the beat grid, drops, variety, "follow the scenes' timeline", speed ramps, transitions; experimental "clip speed follows the music" (speed maps from Stash's scene previews) and "motion on the beat" (motion rhythm measured with FFmpeg).
- Render: deterministic FFmpeg pipeline (per-segment filtergraphs, concat, content-addressed segment cache), run as a Stash task with progress; exact constant frame rate incl. 29.97; B-frame presets render in order.
- Quick record (browser): real-time WebM recording of the preview via MediaRecorder, saved to the output folder (remuxed by FFmpeg when available) and scanned – no server-side rendering needed.
- Exports: project JSON, CMX3600 EDL, OpenTimelineIO, render plan, FFmpeg scripts (bash/cmd).
- Fixes from the first-time-user test in a real Stash 0.31: page route outside `/plugin/`, batch scene lookup with unknown ids, fresh projects persisted at once, scan warning when the output folder lies outside every library.
- Release packaging: `npm run release` builds the zip and an `index.yml` for a Stash plugin source.

## 0.2.0

- Stash UI extension module; uploaded music moves to `assets/media/`.

## 0.1.0

- Initial version: culling sidebar, beat-grid timeline, preview player, render backend, EDL/OTIO export.
