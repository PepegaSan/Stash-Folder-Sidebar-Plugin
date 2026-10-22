# Changelog

## 0.7.1 (2026-10-22)

- **✎ Edit source** / **← Back to the PMV (Esc)** moved to the middle of the bar above the timeline – between the player and the clips, the same spot for both.
- **⇄ Use it in all N clips of that scene**: with a clip selected and another scene in the player, every clip of the clip's scene gets the new scene in one undo step – places and lengths on the timeline stay, each clip takes the same relative spot in the new scene (moved past excluded ranges). The other clips of the selected clip's scene are outlined on the timeline; the inspector shows how many there are.

## 0.7.0 (2026-10-22)

- **Preview from this PC**: while the render helper runs, the preview (PMV and scene player) plays the videos of its mapped folders from the PC instead of the NAS. The helper streams them with the PC's FFmpeg as H.264 from the exact spot – HEVC, MPEG-4 and other codecs the browser can't play no longer need the NAS's live conversion. **💻 from PC** / **🗄 from Stash** next to the player switches; whatever the helper can't serve comes from Stash. Needs the helper 0.7 (download it again under Render → On my PC).
- Technically: Stash's Content-Security-Policy allows media only from Stash itself, so the editor fetches the helper's stream (plugin CSP `connect-src http://*:9978-9981`) and plays it through Media Source Extensions; the helper only serves files inside the mapped folders and only with its token.

## 0.6.1 (2026-10-22)

- "✎ Edit source" and the way back share one spot at the top of the inspector: while a scene is in the main player, the button reads **← Back to the PMV (Esc)** – also without a selected clip.
- **Transitions** are in the inspector right away (no longer behind "More…"), with readable names (Crossfade, Fade through black, Wipe to the left, …) and their length on a row of their own. **⇉ Transition for all clips** gives every clip the selected clip's transition in one undo step (the first clip of a track keeps its own).
- The preview shows wipes, slides, circle, clock wipe, zoom and blur/pixelate like the render does (before: a plain crossfade); Quick record records them the same way.
- Help: the shortcuts are split into *Timeline and PMV preview* and *Scene in the big player*; key names follow the language (Leertaste, Entf, Strg, Pos1); the I/O buttons name their keys.

## 0.6.0 (2026-10-22)

- **Scenes open in the main player**: picking the part of a scene no longer happens in the small sidebar player. The scene takes over the big player area (tabs *PMV preview* / *Scene* above it) with a large scrub bar, filmstrip, I/O, *Start clip here* and *Fit range*; the sidebar keeps facts and markers. Inspector: **✎ Edit source** (or double-click the clip) opens the clip's scene there; **Other scene…** puts another scene into the same slot. Keys while the scene is shown: Space, I / O, ← → (frame, Shift = 1 s), Esc back to the PMV.

## 0.5.0 (2026-10-21)

- **Render on your PC** (optional): Render → *Render on: My PC*. A render helper on the PC (one Python file, downloaded from the dialog with the Stash address filled in) takes the job from Stash, renders with the PC's FFmpeg and saves the video in a folder on the PC. The output folder and optional path mappings (`/data/` → `Y:\`) are set once in the dialog; videos and music come over Stash otherwise. Progress and *Cancel* work as for server renders; the Stash task only hands the job over.

## 0.4.1 (2026-10-21)

- "Motion on the beat" (generator checkbox): 32 clips per backend call instead of 8 – far fewer plugin processes on slow servers.
- "Motion on the beat" now matches the motion period on the timeline, so clips with a speed other than 1× (speed ramps, style speed) are put on the beat correctly.

## 0.4.0 (2026-10-21)

- **Simple mode** (default): the editor shows what a PMV needs – music, "Generate PMV", clip start/duration/speed/framing, format – everything else sits behind **Advanced** (toolbar) or in "More…" blocks. The generator dialog shrinks to mood, clip source, tags, performers and count.
- **Start panel** while the timeline is empty: a PMV in three steps (upload song → generate → fine-tune & render), with the song upload right there; BPM is detected automatically when a song is added.
- Plain words: "My clips" instead of "Selection"/snippets, "Start clip here" / "Use this scene here" in the scene view, mood descriptions in the generator, a hint on how to pick a range.

## 0.3.3 (2026-10-21)

- Framing "Fit (blurred edges)": the whole picture over a blurred, filled copy of itself – like the PMV Generator; portrait clips stay complete in a 16:9 video. Default for new projects; per project and per clip. Preview, quick record and the FFmpeg render all do it (segment cache invalidated).

## 0.3.2 (2026-10-21)

- Clicking a clip shows it in the player: the playhead jumps to the clip unless it is already inside it.
- Music upload: the server's file length (ffprobe) is used when the browser decodes less, with a notice; a truncated upload is reported instead of silently shortening the song.

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
