# Changelog

## 0.9.6 (2026-10-24)

- **Split screens** like in the PMV Generator: *2-way*, *3-way mirrored* (the same clip left and right, mirrored, another one in the middle), *3-way*, *4-way* and *Kaleidoscope* (one clip, mirrored four times); 2- and 3-way side by side or stacked. Each field shows a track – V1 (the bottom one) the first field, V2 the second and so on – and a field's clip goes on while the others cut. The new lane **⊞ Split screens** above the tracks: **+** adds one at the playhead, drag moves it, its edges change its length, **Del** takes it away (the clips stay); selected, the inspector sets its layout, its fields, start and length. On the tracks you see which one a field shows and which is hidden there. Outside the split screens nothing changes – the top track wins as before.
- **Generator**: split screens like the PMV Generator's – calm parts full screen, louder parts more fields, drops the fullest; they change on a drop or at the start of a phrase, the fields cut in turn, and clips whose shape fits a field come first (*Advanced*: the clip shape per layout, e.g. landscape only in full screen). Choose the layouts in the dialog (also in the simple view); the moods set them like the PMV Generator's: *PMV classic* full screen, 3-way mirrored, 3-way · *Maximal* all · *Hypno* full screen, kaleidoscope, 3-way mirrored · *Clean* full screen, 2-way, 3-way mirrored. With split screens the generator fills V1 and the tracks above it (and adds tracks when there are too few); generating again replaces the split screens of its range together with their fields' clips. A locked or hidden track above V1 limits the fields – layouts with more are left out, the dialog says so. Settings and presets from before get their mood's split screens.
- New effects for split screens: **Flash** (where a split screen begins or ends – pink on a drop – and a lighter one when a field cuts in a loud part) and **Glowing dividers** (pink on every beat). *PMV classic* and *Maximal* switch them on.
- Preview, Quick record and the FFmpeg render show the same split screens (checked frame against frame). 🎲 Another clip also avoids the scenes that play in the other fields.
- **Render on my PC**: split screens need the helper 0.9.6 – the render dialog says so when an older one is connected and offers the new file.
- *Fit (blurred edges)*: the render darkens the blurred copy behind the clip the way the preview does, and the preview blurs it as much as the render – also in a narrow field. Segments with blurred edges are rendered once more instead of coming from the cache.
- Fixes for the effects of 0.9.5: *Colour rush* in the render now has the preview's colours; a new word replaces the one before instead of overlapping it; words also appear when the plugin's path contains an apostrophe; a render without the words' font says so, and its segments are not reused once the font is there; long clips with effects near the end of their file no longer end in empty segments.

## 0.9.5 (2026-10-24)

- **Beat and drop effects** like in the PMV Generator, for the whole PMV: on the beat *Zoom pulse* (every beat, beats 1 and 3 or every bar, with a strength), *Shake*, *Stutter* (in loud parts the clip jumps back on every other half beat) and *Strobe*; on drops *RGB split*, *Glitch*, *Tunnel*, *Negative*, *Echo* and *Text* (your words slam in, drawn with the font Anton that comes with the plugin); through the song *Colour rush*. Switch them in the inspector under *Output* or in the generator, whose moods set them like the PMV Generator's (*PMV classic*: zoom pulse, shake, stutter, RGB split, glitch · *Maximal*: all but the strobe · *Hypno*: zoom pulse, tunnel, echo, colour rush · *Clean*: zoom pulse); *Generate* puts them into the PMV with the clips. When they fire comes from the beat grid and the music's loudness (drops) – no dice involved: the same song and cut always look the same, and preview, Quick record and render show the same.
- **Colour looks** like in the PMV Generator: *Warm*, *Pink*, *Cold*, *Vivid*, *Black & white*, *Noir* (with dark corners) or *Own color*, with a strength, plus smooth extra *Brightness*. Set them in the inspector under *Output* (nothing selected) or in the generator dialog; they count for the whole PMV – the preview, Quick record and the FFmpeg render look the same (checked frame against frame).
- The PMV preview draws on a canvas now (the players decode invisibly behind it): the same drawing as Quick record, and the ground for the effects (and the split screens to come). Quick record no longer starts with a black first clip.
- **Render on my PC**: the colour look and the effects need the helper 0.9.5 – the render dialog says so when an older one is connected and offers the new file (close the old window, start the new one).

## 0.9.4 (2026-10-24)

- Generator: **when to cut** right in the simple view, like the PMV Generator – *Automatic* (with its pace slow/normal/fast), *Every beat*, *Every 2 beats*, *Every 4 beats* (one cut per bar, on its “one”) or *Like another PMV*. A mood keeps its name while its own cutting stays.
- Generator: **transitions** – any of the 13 transitions of the timeline (flash, crossfade, fade through black, dissolve, wipes, slides, circle, zoom, blur, pixelate, clock wipe) or **Mix** (a different one each time, the same for the same seed), on every cut, on every bar or per phrase (4 bars); also in the simple view. Settings and presets saved before keep their transitions.

## 0.9.3 (2026-10-24)

- **Preview without black clips and frozen pictures**: some videos showed only one still frame in the PMV preview, or the picture went black for a moment – mostly long files over a NAS or Wi-Fi (their index sits at the end of the file and takes a second or more to load) and short clips. The preview now loads the next clips ahead in four players (up to 12 s, the nearest first), starts a waiting clip a moment before its cut so it is already moving, and keeps the last picture instead of black while a file still opens. A slow seek is no longer restarted on every frame (that left the picture frozen for the whole clip); seeks aim where the music will be once they are through, small drift is evened out with the playback speed. Both sides of a transition play. Edits and the scene list on the left no longer reload the players. Quick record uses the same preview and gains the same.
- Scene player: scrubbing shows the frames along the way – a new seek waits for the one on its way instead of cancelling it.

## 0.9.2 (2026-10-24)

- Generator: your own PMVs (scenes with the tag `PMV Creator`, which 🏷 gives every render) are no longer picked as material – from tags/performers, *Most watched*, a saved filter or the project's scenes. Asking for the tag `PMV Creator` in the generator's tags still uses them; *Selection* (your snippets) is not filtered. 🎲 Another clip follows the same rule.

## 0.9.1 (2026-10-24)

- **Volume in the timeline**: the music lane (♪) has a slider for the music's volume in the PMV (0–200 %, the render's level – the same value as *Level* in the inspector, double-click = 100 %; the preview plays up to 100 %). **🔊** above the timeline sets how loud the preview plays in this browser (also the scene in the big player), remembered per browser; a click mutes it. It never changes the render or a Quick record – the recording keeps the PMV's own level while the speakers follow 🔊.
- Generator: a song whose first beat comes a few milliseconds in no longer gets a sliver clip at the very start – less than half a beat before the first full beat joins it. *Pattern* cutting now counts from the first full beat, so its cuts stay on the beat grid when the song (or the range) starts between two beats.

## 0.9.0 (2026-10-23)

- **📦 Several PMVs at once** (*Project* menu, or *Several songs…* in the generator): pick songs from the song library or upload them; every song becomes its own project with the same generator settings (the current ones or a preset, each song with its own seed), generated one after another, saved, and rendered on the server or on the PC. The renders queue up in Stash and go on without the tab – a batch overnight on the PC is the idea. ✎ opens a project to fine-tune it.
- **🔔 Tell me when it is done** (render dialog, on): renders no longer depend on the dialog – close it and work on. **⏳** in the toolbar lists every render on its way and the ones finished lately (progress, waiting in Stash's queue or for the PC, ↗ Open in Stash, ✎ open its project, ■ cancel). Done: a chime, the tab title in a background tab ("⏳ 45 % · …" while it runs, then "✓ … is rendered"), and a desktop notification where the browser allows it (HTTPS or localhost only – on a LAN address over HTTP the chime and the title remain). Its click opens the scene in Stash. Renders started earlier are picked up again when the editor opens; 🏷 labels then wait as long as Stash's queue needs (its scans run after the renders queued before them).
- **Saved filter** as a clip source of the generator: one of the scene filters saved in Stash's scene list, read fresh on every run (tags with depth and excludes, performers, studios, rating, duration, dates, resolution, orientation, flags …). The dialog shows how many scenes it finds right now and names criteria it can't translate. 🎲 Another clip draws from it too.
- **⏮ ⏭ Review the cuts**: [ / ] (or ↑ / ↓, or the buttons next to the time above the timeline) select the previous/next clip and play from a second before its cut. [ and ] also work with AltGr on German keyboards.

## 0.8.0 (2026-10-22)

After generating – in the bar above the timeline (a clip selected):

- **🎲 Another clip** (N): new material for the clip, picked by the rules of the last generator run (same filters, tag stage and candidates, no scene that plays nearby, few clips per scene). Place, length, speed and transition stay; one undo step. Pressing again goes on to other scenes instead of back. The project remembers its last generator run for this; projects generated before 0.8 draw from their own scenes.
- **📌 Keep** (P): "Generate again" and "Another variant" leave kept clips where they are and fill around them (also with "Clear the track first"). Kept clips carry a 📌 on the timeline; the generator dialog shows how many there are and can let them go.
- **⊘ Scene out**: the scene leaves this PMV – every clip of it gets another clip and the generator skips it in this project (one undo step). **Never use it again** then gives the scene the Stash tag `PMV Creator: skip`, which every generator run leaves out; *Allow it again* in the scene view takes it off.
- **🏷 Label it in Stash** (render dialog, on by default): once Stash has scanned the finished video, its scene gets the project name as title, a short description, the performers of the scenes used, the tags at least a quarter of them share and the tag `PMV Creator`. Works for server renders, Quick record and PC renders into a folder that is mapped to a Stash library (such a render is now scanned too). If the editor is closed before the scan is through, it labels the video on its next start.
- The generator's result line points to 🎲 and 📌; the help lists N and P.

Before generating:

- **Cuts: Like another PMV** (Pepega's "PMV as template", without split screens): pick a PMV from the library; its cuts and flashes are measured (gray frames from the backend, Pepega's cut rule; a flash is a short, nearly uniform bright picture, so a cut to a bright clip stays a cut) and the generator changes clips exactly there – flashes become white flashes. *Take over its music too* (default) makes its sound the project's song (extracted on the server, BPM detected), so the cuts land on the music. Checked against a rendered PMV with known cuts: all 33 clip changes found to the frame.
- **My presets**: save the generator settings under a name and load them again – kept on the server for every browser of this Stash.
- **🎵 Song library**: songs uploaded before can be picked again (start panel and inspector) – no new upload over the network.
- **PMV with this performer/tag**: Stash UI shows it in the header of performer and tag pages, classic Stash on the performer page (*⚡ PMV: name*). It starts a new project named after them; the generator opens with that performer/tag as its filter. Deep links `?performer=<id>` / `?tag=<id>`.

## 0.7.2 (2026-10-22)

- **⇄ Replace all N…** in the bar above the timeline, next to *Edit source*: for a clip whose scene is in the PMV more than once. The scene list on the left then picks the new scene – one click replaces every clip of the old one (same relative spots, places and lengths stay, Ctrl+Z undoes it); Esc or ✕ cancels.

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
