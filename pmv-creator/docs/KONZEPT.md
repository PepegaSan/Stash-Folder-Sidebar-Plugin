# PMV Creator – Konzept & Architektur

Ein Stash-Plugin, das als **deterministischer Editor** arbeitet: Szenen, Marker und frei geschnipselte Segmente werden gezielt vorausgewählt, auf ein Beat-Raster arrangiert, feinjustiert und anschließend frame-genau gerendert oder an ein NLE übergeben.

## 1. Abgrenzung

| Bestehende PMV-Plugins | PMV Creator |
|---|---|
| Zufällige Clips in festen Intervallen | Jeder Clip ist bewusst gewählt (Marker, Bereich, Szene) |
| Ergebnis ist ein fertiges Video, nicht editierbar | Projektdatei mit editierbarer Timeline (verschieben, trimmen, slippen, ersetzen, Undo) |
| Zufall bei jedem Lauf | Gleiches Projekt ⇒ gleiches Video, Frame für Frame. Auch „Mischen“ nutzt einen festen Seed |
| Nur Rendern | Rendern **oder** Export als EDL / OTIO / FFmpeg-Skript für DaVinci Resolve & Co. |

## 2. Architektur

```
 Browser (Stash-UI)                                          Stash-Server
┌────────────────────────────────────────────────┐        ┌─────────────────────────────────┐
│ PMV Creator  (React über window.PluginApi)      │        │ GraphQL                          │
│                                                │  GQL   │  findScenes / findSceneMarkers   │
│  Sidebar  ── Culling ──► Bin / Ausschlüsse     │◄──────►│  runPluginOperation ─┐           │
│  Timeline ── EditAction ─► Reducer ─► Projekt  │        │  runPluginTask ──────┼─► Job-Queue│
│  Preview  ◄─ flattenTimeline(Projekt)          │        │  /scene/{id}/stream, Sprites/VTT │
│  Export   ── buildRenderPlan / EDL / OTIO      │        │  /plugin/pmv-creator/assets/media│
└────────────────────────────────────────────────┘        └──────────────────────┬──────────┘
                                                                                 ▼
                                             plugin/backend/pmv_backend.py ──► FFmpeg
                                             (Projekte, Upload, Keyframes, Render)
```

* **Zwei Hosts, ein Editor.** Der Editor weiß über einen `Host` ([src/host.ts](../src/host.ts)) nur, wo er läuft: wer die Adresszeile besitzt (`?project=`, Deep-Links `?scenes=`/`?t=`), wo eine Szene aufgeht und wie viel Platz oben frei bleibt. *Klassisches Stash*: Route `/pmv-creator` + Navbar-Button über `PluginApi`. *Stash UI*: ein Erweiterungsmodul ([src/stashui.tsx](../src/stashui.tsx), Extension-API v2) registriert einen Menüeintrag unter „Watch“, den Editor als Overlay-Seite (`#/p/pmv-creator/editor`) und Slots in der Player-Infoleiste, im Zahnrad-Menü und in der Auswahlleiste der Szenenliste. Stash UI hat kein Bootstrap und kein `PluginApi`, deshalb bringt dieses Bundle sein eigenes React mit, und [styles.css](../src/styles.css) zeichnet unter `.pmv-root[data-host="stashui"]` die wenigen Bootstrap-Klassen mit Stash UIs Farbvariablen nach.
* **Frontend**: TypeScript und React, mit esbuild gebündelt: `pmv-creator.js` (IIFE für klassisches Stash, `react` auf `PluginApi.React` umgebogen über [src/shims/react.ts](../src/shims/react.ts), denn eine zweite React-Instanz würde Hooks im Stash-Baum zerstören) und `assets/stashui.js` (ESM mit eigenem React für Stash UI). Die Seite hängt als Route `/pmv-creator` in Stash (bewusst nicht unter `/plugin/…`: diesen Präfix beantwortet der Stash-Server selbst und liefert für alles außer Assets/JS/CSS ein 404, ein Reload der Seite würde sonst scheitern), dazu kommt ein Navbar-Button ([src/index.tsx](../src/index.tsx)).
* **Daten aus Stash**: ein schlanker `fetch`-GraphQL-Client (gleiche Origin, Session-Cookie). Szenen, Dateipfade, Marker inkl. Tags, Stream-URLs und Sprite-VTTs kommen aus [src/stash/queries.ts](../src/stash/queries.ts).
* **Backend**: ein Python-Skript ohne Abhängigkeiten, `interface: raw`. Kurze Aufgaben laufen synchron über `runPluginOperation`, der Render als Stash-Task über `runPluginTask`. Der Task hat Fortschrittsbalken und ist abbrechbar.
* **Reine Logik ohne React** (`model/`, `timeline/`, `culling/`, `export/`, `state/reducer.ts`): Sie ist vollständig unit-getestet und wird von UI, Preview und Export gemeinsam genutzt.

## 3. Ordnerstruktur & Manifest

```
pmv-creator/
├─ plugin/                         → Inhalt des Stash-Plugin-Ordners (vom Build kopiert)
│  ├─ pmv-creator.yml              Manifest: UI, Backend, Settings, Task
│  ├─ assets/                      icon.svg; zur Laufzeit stashui.js (Build) und media/ (Uploads)
│  └─ backend/pmv_backend.py       Projekte, Audio-Upload, Keyframes, Bewegungsanalyse, FFmpeg-Render, CLI
├─ schema/pmv-project.schema.json  JSON-Schema (Draft 2020-12) des Projektfiles
├─ src/
│  ├─ index.tsx                    klassisches Stash: Route + Navbar-Button
│  ├─ stashui.tsx                  Stash UI: Erweiterungsmodul (Menü, Overlay-Seite, Slots)
│  ├─ host.ts                      Host-Abstraktion (Adresszeile, Deep-Links, Szenen-Links)
│  ├─ shims/react.ts               "react" → PluginApi.React (nur im klassischen Bundle)
│  ├─ model/                       Projekt-Typen (= Schema), Defaults, Migration
│  ├─ timeline/                    Edit-Operationen, Flatten, Übergänge, Zeit/Raster
│  ├─ culling/                     Marker/Bereiche → Snippets/Ausschlüsse
│  ├─ generator/                   PMV-Generator: Material, Rhythmus/Drops, Auswahl, Bewegungsanalyse
│  ├─ state/                       Reducer (Actions, Undo/Redo), Store/Autosave, Transport
│  ├─ stash/                       GraphQL, Queries, Backend-Calls, Streams, Sprites, Cache
│  ├─ audio/                       Waveform-Peaks, BPM- und Phasenerkennung
│  ├─ export/                      Render-Plan, EDL (CMX3600), OpenTimelineIO
│  └─ ui/                          Sidebar, Timeline, Preview, Inspector, Toolbar
├─ tests/                          Vitest (Logik + UI-Smoke) · Python-E2E mit echtem FFmpeg
├─ build.mjs                       esbuild → dist/pmv-creator/
└─ dist/pmv-creator/               installierbares Plugin
     pmv-creator.yml · pmv-creator.js · pmv-creator.css · backend/ · schema/ · data/ (Laufzeit)
```

[plugin/pmv-creator.yml](../plugin/pmv-creator.yml), das Wichtigste:

| Schlüssel | Zweck |
|---|---|
| `ui.javascript` / `ui.css` | Bundle aus `build.mjs` |
| `ui.assets: {/: assets}` | `/plugin/pmv-creator/assets/…`: `stashui.js` (Erweiterungsmodul für Stash UI, das Stash UI genau dort erwartet), `icon.svg`, `media/` (hochgeladene Musik für Waveform und Vorschau) |
| `exec: [python, {pluginDir}/backend/pmv_backend.py]`, `interface: raw` | Backend. Stash ersetzt `python` durch den konfigurierten Interpreter |
| `settings` | FFmpeg-/FFprobe-Pfad, Ausgabe- und Projektordner, parallele Jobs, Scan nach Render, Cache leeren |
| `tasks: Render PMV` | Render-Job in der Stash-Queue (Fortschritt, Abbrechen) |

## 4. UI & Workflow

```
┌ Toolbar: Projekt · Undo/Redo · Modus (Einrasten/Ripple/Überschreiben) · Snap+Raster · Export · Rendern ┐
├──────────────────────┬───────────────────────────────────────────────┬──────────────────────────────┤
│ Sidebar              │ Preview (A/B-Video, Musik als Master-Clock)    │ Inspector                    │
│ [Szenen|Marker|Ausw.]│                                               │ Clip: Start, Dauer (s/Beats),│
│ Suche → Szene →      │                                               │ In/Out, Speed, Übergang, Ton │
│ Drill-Down:          │                                               │ sonst: Musik, Raster, Ausgabe│
│  Player, Filmstreifen│                                               │                              │
│  Scrub-Bar: Marker,  ├───────────────────────────────────────────────┴──────────────────────────────┤
│  Ausschlüsse, Snippets│ Lineal (Zeit + Takte) · Musik (Waveform, Beat-Raster) · V2 · V1 · Playhead   │
│  Keyframes, I/O       │ Clips: ziehen = verschieben · Ränder = trimmen · Alt = slippen · Drop aus Bin │
└──────────────────────┴──────────────────────────────────────────────────────────────────────────────┘
```

**Culling (Seitenleiste)**
* *Szenen*: Suche nach Text, Tags und Performern, oder direkt per Szenen-ID bzw. Stash-Link (mehrere auf einmal, unbekannte IDs werden gemeldet). Treffer werden zum Projekt-Pool hinzugefügt. Der Drill-Down zeigt Metadaten, Player, einen Filmstreifen aus Stash-Sprites und eine Scrub-Bar mit Markern, Ausschlüssen, Snippets und **I-Frame-Keyframes** (über `ffprobe` im Backend, optional mit Einrasten von I/O).
* *Auswählen*: Ein Marker oder ein I/O-Bereich wird zum **Snippet** in der Bin.
* *Ausschließen*: Ein Marker oder Bereich wird zur **Exclusion**. Auto-Arrange überspringt ihn, Clips darauf werden in der Timeline schraffiert.
* *Schnipseln*: I/O setzen bzw. Shift+Ziehen auf der Scrub-Bar ergibt ein Snippet. „→ Timeline“ fügt direkt am Playhead ein.
* *Marker*: bibliotheksweite Suche nach Marker-Tags, mit Mehrfachauswahl in die Bin.

**Timeline**
* Spuren: `tracks[0]` ist oben. Bei Überlappung gewinnt die obere Spur, wie in jedem NLE.
* Granulare Steuerung pro Clip: Start, Dauer (Sekunden oder Beats), Quell-In/-Out, Speed (wahlweise *Dauer halten* = beat-sicher oder *Bereich halten*), Clip-Ton, Übergang, Bildausschnitt.
* Nachträgliche Editierbarkeit ohne Kollateralschaden: Der Standardmodus **Einrasten** lässt Clips an Nachbarn stoppen, nichts anderes ändert sich. *Ripple* und *Überschreiben* sind bewusst wählbar. **Slip** (Alt+Ziehen) tauscht das Material bei unveränderter Position. **Ersetzen** (R) tauscht die Quelle, Slot, Speed und Übergang bleiben.
* **Material und Slot sind getrennt.** Ein anderer Quell-Bereich ändert nie Start oder Länge auf der Timeline (A → B bleibt). Alle Wege führen über `clip/slip` bzw. `clip/source` ([setClipSource](../src/timeline/ops.ts)): Inspector In/Out, Alt+Ziehen, ⇄, in der Szenen-Ansicht der verschiebbare orange Clip-Bereich, „Clip-In = Player“, „↦“ pro Marker und „Auswahl übernehmen/einpassen“, auch mit einer anderen Szene. *Einpassen* ist der einzige Fall, in dem sich etwas am Clip ändert: der Speed, damit genau der gewählte Bereich in den Slot passt. Position und Länge ändern nur Timeline-Gesten (Ziehen, Trimmen, „Dauer“).
* Snapping auf Beat-Raster (Takt … 1/16), Clip-Kanten, Marker, Playhead. Shift beim Ziehen schaltet es aus.
* Der **⚡ Generator** erzeugt einen kompletten Schnitt als Startpunkt, siehe [Generator](#generator).

**Audio**: Musik hochladen oder per Server-Pfad einbinden. Die Waveform wird aus dekodierten Peaks gezeichnet, nur der sichtbare Ausschnitt. BPM und Beat-Phase werden erkannt (Onset-Hüllkurve → Autokorrelation mit Oktav-Korrektur → Kammfilter-Feinsuche auf 0,01 BPM), alternativ Tap-Tempo oder „Offset = Playhead“.

**Preview**: Zwei `<video>`-Elemente arbeiten im A/B-Wechsel. Das unsichtbare ist bereits auf das nächste Segment vorgespult, ein Schnitt ist damit nur ein Sichtbarkeitswechsel. Die Musik ist die Master-Clock, Bild-Drift über 150 ms wird nachgeführt. Direktstreams werden bevorzugt, sonst Stash-Transcodes mit `?start=`. Übergänge werden per Opacity oder Farb-Overlay angenähert.

## Generator

Der Dialog **⚡ Generator** macht, was ein PMV-Generator macht: Er wählt Clips nach Kriterien und schneidet sie auf die Musik. Das Ergebnis ist aber kein fertiges Video, sondern ein normaler, editierbarer Schnitt auf einer Spur. Er entsteht als **ein** Undo-Schritt, und die verwendeten Segmente landen in der Auswahl, damit jeder Clip per ⇄ tauschbar ist. Alle Zufälle laufen über einen sichtbaren Seed. Gleiche Einstellungen, gleicher Seed und gleiche Bibliothek ergeben dasselbe PMV.

Die Pipeline ist in [src/generator/](../src/generator/) in reine, getestete Stufen gegliedert:

| Stufe | Datei | Inhalt |
|---|---|---|
| Clips | [material.ts](../src/generator/material.ts), [run.ts](../src/ui/generator/run.ts) | Stash-Filter, Szenen/Marker → Kandidaten, Tag-Stufen, Ausschlüsse herausschneiden |
| Schnitt | [rhythm.ts](../src/generator/rhythm.ts) | Energie pro Beat (relativ zum Song), Drop-Erkennung, Schnittraster, Stufen-Zuordnung |
| Auswahl | [assemble.ts](../src/generator/assemble.ts) | Welcher Clip und welche Stelle in welchen Slot: Vielfalt, Zeitleiste, Tempo-Match, Speed-Rampen, Übergänge |
| Bewegung | [motion.ts](../src/generator/motion.ts) | Bewegungsmessung, Rhythmus, Beat-Fit, Tempokarten aus Scene-Previews |
| Ergebnis | [generate.ts](../src/generator/generate.ts) | Presets, Bereich, Beat-Sync-Nachlauf, Anwenden im Reducer (behaltene Clips bleiben, der Lauf wird im Projekt gemerkt) |
| Nachbessern | [reroll.ts](../src/generator/reroll.ts), [clipActions.ts](../src/ui/clipActions.ts) | 🎲 neues Material für einzelne Clips, ⊘ Szene raus |
| Schnitt-Vorlage | [template.ts](../src/generator/template.ts), [cutTemplate.ts](../src/ui/generator/cutTemplate.ts) | Schnitte und Blitze eines anderen PMV messen, als Slots verwenden |

**Nach dem Erzeugen.** Das Projekt merkt sich den letzten Lauf (`generator`: Einstellungen, Seed, Bereich). Darauf bauen drei Werkzeuge in der Leiste über der Timeline auf:
* **🎲 Anderer Clip** (N) holt die Kandidaten desselben Laufs (gleiche Filter und gleicher Seed, also dieselbe Auswahl aus der Bibliothek, pro Sitzung gecacht) und gibt dem Clip neues Material aus seiner Tag-Stufe. Platz, Länge, Speed und Übergang bleiben. Gewählt wird nach den Generator-Regeln: nicht die bisherige Szene, keine Szene der ±6 Nachbarn, wenige Clips pro Szene, eine noch freie Stelle. Wiederholtes Drücken meidet die gerade verworfenen Szenen. Projekte ohne gespeicherten Lauf ziehen aus den eigenen Szenen.
* **📌 Behalten** (P, `clip.pinned`): Erneutes Erzeugen lässt den Clip stehen. Slots, deren Mitte in einem behaltenen Clip liegt, bleiben leer, und der Clip zählt für die Vielfalt mit. Neue Clips weichen ihm aus, auch bei „Spur vorher leeren“.
* **⊘ Szene raus** legt einen Ausschluss über die ganze Szene und würfelt alle ihre Clips neu, beides in einem Undo-Schritt. *Nie wieder verwenden* setzt in Stash den Tag `PMV Creator: skip`, den jeder Generator-Lauf ausfiltert (als `excludes` im Stash-Filter und zusätzlich auf dem Client). In der Szenen-Ansicht nimmt *Wieder erlauben* ihn ab. Genauso fallen die hier gerenderten PMVs (Tag `PMV Creator` aus 🏷) heraus, außer die Tags des Generators verlangen ihn (`skipTags` in `ui/generator/run.ts`; die Quelle *Auswahl* ist davon ausgenommen).

**Abgleich mit dem Pepega PMV Generator** (`stash-pmv-plugins/plugins/pepega-pmvGenerator`):

| Pepega | PMV Creator |
|---|---|
| Clips aus: Filter, Playlist, Versus, Meistgesehen | Filter, Oft angesehen (30 Tage, sonst insgesamt), Projekt-Szenen, Auswahl. Playlists/Versus (Stash UI) fehlen noch |
| Szenen / Bilder / Marker; Tags alle/eines/ausschließen, Haupt-Tags, Performer, Favoriten, Bewertung, Mindestlänge, Auflösung, Format, Ordner | gleiche Filterlogik (`buildFilter` portiert, inkl. „Haupt-Tags + eines“ auf dem Client). Ordner als „Pfad enthält“, keine Bilder |
| Tag-Stufen A → B → C, letzte auf Drops (2 Takte) und im Finale (letztes Zehntel) | gleich (`assignStages`). Eine leere Stufe leiht sich Clips von den anderen |
| Schnitt automatisch nach Energie, Pace 8·4·2 / 4·2·1 / 2·1·1, Schwellen 0,4/0,72; fest alle N Beats; auf dem Taktraster; kürzester/längster Clip | gleich, zusätzlich *Muster* (z. B. `4,2,2`, auch halbe Beats) |
| Drop: Energie +0,35 gegenüber einem Takt davor, > 0,6, höchstens alle 16 Beats | gleich. Am Drop wird immer geschnitten, optional mit Flash |
| Vielfalt: Szene nicht in den letzten 24 Clips, Performer möglichst nicht in den letzten 4 | gleich |
| Szenen-Zeitleiste folgen (±12 %) | gleich |
| Speed-Rampen (ruhig langsamer, laut schneller, Schub auf Drops) | als feste Clip-Geschwindigkeit pro Slot (0,75× / 1,15× / 1,4×) |
| Stimmungen Klassik / Maximal / Hypno / Clean | als Presets für Schnitt und Stil |
| *Experimentell:* Clip-Tempo folgt der Musik | siehe unten |
| *Experimentell:* Bewegung auf den Beat | siehe unten |
| PMV als Vorlage (Schnitte, Layouts, Blitze, Musik eines PMV) | Schnitte, Blitze und Musik (`template.ts`): Schnittregel gleich (größte Regionsdifferenz > max(0,09; 3,2 × Median der letzten 12), ≥ 0,15 s Abstand, auf Beats ±80 ms). Blitz anders: Pepega zählt einen Sprung auf ein helles Bild, was ein Schnitt auf einen hellen Clip auch ist; hier ist ein Blitz ein kurzes (≤ 0,5 s), fast einfarbig helles Bild (Helligkeit ≥ 0,45, Streuung ≤ 0,08). Gemessen wird jedes Frame (30 fps, 64 px) statt Stichproben beim schnellen Abspielen. Layouts nicht |
| Split-Screens, Live-Effekte, Best Moments (Haut/Kontrast), Smart Crop, Match Cuts | **nicht übernommen**. Das Ziel ist ein editierbarer Einspur-Schnitt, Effekte gehören ins NLE |

### Experimentelle Modi

Pepega misst Bewegung live im Browser. Hier passiert dasselbe **reproduzierbar**: Das Backend dekodiert mit FFmpeg kleine Graustufen-Frames (lange Seite 64 px, Op `gray_frames`), und die Messung läuft als reine TypeScript-Funktion. Gleiche Datei ergibt gleiche Zahlen.

* **Clip-Tempo folgt der Musik.** Stashs Scene-Preview (Tasks → Generate → Previews) besteht aus kurzen Stücken über die ganze Szene verteilt. Jedes Stück wird mit Pepegas kamerakompensiertem Blockvergleich (`actionMotion`) gemessen und über die Preview-Einstellungen auf die Szenenzeit zurückgerechnet. So entsteht eine **Tempokarte** pro Szene (im Browser gecacht). Tempi zählen relativ zur Bibliothek (Perzentil). Pro Slot gewinnt die Szene und Stelle, deren Tempo-Perzentil am nächsten an der Musikenergie liegt. Passt nichts in der Warteschlange, kommen schon genutzte Szenen mit Aufschlag erneut infrage.
* **Bewegung auf den Beat.** Nach dem Generieren werden 2 s am Anfang jedes Clips (30 fps) gemessen. `rhythmOf` findet die Bewegungsperiode per Autokorrelation (0,2–0,9 s) und eine Bewegungswende per Phase der Grundschwingung. `beatFit` wählt 1, 2 oder ½ Bewegungen pro Beat mit höchstens ±12 % Tempoänderung. Der Clip bekommt diesen Speed-Faktor und startet auf der ersten Wende. Da Clips auf Beats beginnen, landet die Wende auf dem Beat. Marker-Clips behalten ihren Startpunkt. Gegen echte FFmpeg-Dekodierung geprüft: Eine Pendelbewegung mit 0,50 s Periode ergibt bei 120 BPM den Faktor 1,000, eine mit 0,53 s den Faktor 1,062.

## 5. Datenmodell (`*.pmv.json`)

Schema: [schema/pmv-project.schema.json](../schema/pmv-project.schema.json) · Typen: [src/model/project.ts](../src/model/project.ts)

```jsonc
{
  "schemaVersion": 1,
  "id": "pmv_3f9c1a2b4d5e",
  "name": "Summer PMV",
  "output":   { "width": 1920, "height": 1080, "fps": 30, "fit": "cover",
                "videoCodec": "libx264", "crf": 18, "preset": "medium", "audioBitrate": "320k" },
  "audio":    { "name": "track.mp3", "path": "/music/track.mp3",            // Server-Pfad → Render
                "url": "/plugin/pmv-creator/assets/media/track.mp3",         // Browser → Waveform
                "duration": 213.4, "sourceIn": 0, "start": 0, "gainDb": 0, "fadeIn": 0, "fadeOut": 2 },
  "beatGrid": { "bpm": 128, "offset": 0.118, "beatsPerBar": 4 },
  "sources":  { "1234": { "sceneId": "1234", "fileId": "88", "path": "/media/a.mp4", "title": "…",
                          "duration": 1520.2, "fps": 29.97, "width": 1920, "height": 1080,
                          "hasAudio": true, "videoCodec": "h264" } },
  "bin":        [ { "id": "snip_…", "sceneId": "1234", "markerId": "551", "in": 312.0, "out": 320.0,
                    "label": "Kiss", "tags": ["Kiss"] } ],
  "exclusions": [ { "id": "excl_…", "sceneId": "1234", "markerId": null, "in": 0, "out": 45 } ],
  "tracks": [
    { "id": "trk_…", "name": "V1", "muted": false, "locked": false, "clips": [
      { "id": "clip_…", "sceneId": "1234", "snippetId": "snip_…", "markerId": "551",
        "start": 15.0, "duration": 0.9375, "sourceIn": 312.0, "speed": 1.25, "volume": 0,
        "transitionIn": { "type": "fade", "duration": 0.2 }, "fit": null, "label": "Kiss",
        "pinned": true } ] }                                                   // optional: 📌 behalten
  ],
  "markers": [ { "id": "mrk_…", "time": 30.0, "label": "Drop" } ],
  "generator": { "settings": { "seed": 3, "clips": { … }, … }, "from": 0, "to": 213.4 },  // optional: letzter Lauf
  "cutTemplate": { "sceneId": "23", "title": "Other PMV", "duration": 90, "cuts": [0.53, 1.0, …],   // optional: Schnitte
                   "flashes": [14.97], "music": "Other PMV.m4a" }                                 // eines anderen PMV
}
```

Designentscheidungen:
* **Sekunden als Float, Quantisierung erst beim Export.** Gerundet werden absolute Positionen (`round(t·fps)`), nie Dauern. Dadurch akkumuliert kein Rundungsfehler über ein ganzes Lied.
* **Die Dauer auf der Timeline ist führend, der Out-Point wird abgeleitet** (`sourceIn + duration · speed`). Beat-Sync entsteht aus der Slot-Länge, Speed-Änderungen gefährden ihn nicht.
* `sources` ist ein Snapshot der Dateien (Pfad, Dauer, fps, Audio). Das Projekt bleibt damit ohne Stash renderbar, und es landen **keine Stream-URLs oder API-Keys** in der Datei.
* `transitionIn` gehört zum Clip und ist zentriert auf den Schnitt. Er nutzt Handles (Material vor bzw. nach dem sichtbaren Bereich) und wird automatisch gekürzt, wenn keine vorhanden sind.

## 6. Timeline-State-Verwaltung

[src/state/reducer.ts](../src/state/reducer.ts) · [src/timeline/ops.ts](../src/timeline/ops.ts)

* **Typisierte, serialisierbare `EditAction`s** (`clip/move`, `clip/trim`, `clip/slip`, `clip/speed`, `clip/replace`, `bin/add`, `arrange/auto`, …). Jede bildet 1:1 auf eine **reine Funktion** `(Projekt) → Projekt` ab. Ist eine Aktion nicht möglich (gesperrte Spur, kein Platz), kommt *dieselbe Referenz* zurück, und es entsteht kein History-Eintrag.
* **Undo/Redo** über Snapshots mit Structural Sharing (200 Schritte). Schnelle Feldeingaben (gleiche Aktion, gleicher Clip, < 1 s) werden zu einem Schritt zusammengefasst.
* **WYSIWYG-Drag**: Während des Ziehens entsteht nur eine *pending* Aktion. Die Timeline rendert `applyEdit(projekt, pending)`, Ripple- und Clamp-Effekte sind also exakt sichtbar. Beim Loslassen wird genau diese Aktion dispatcht, eine Geste ergibt einen Undo-Schritt.
* **Invarianten pro Spur**: sortiert, keine Überlappung, Dauer ≥ 1 Frame, Quell-Grenzen eingehalten.
* **Flatten** ([src/timeline/flatten.ts](../src/timeline/flatten.ts)): Mehrspur-Timeline → lückenlose, frame-genaue Segmentliste (die oberste Spur gewinnt, Lücken werden schwarz). Preview, EDL und Render-Plan nutzen *dieselbe* Funktion und stimmen deshalb Frame für Frame überein.
* Transport/Playhead liegt außerhalb des React-States, das ergibt 60 fps ohne Re-Render. Autosave erfolgt gedrosselt über das Backend, mit `localStorage` als Fallback.

## 7. Übergabe an den Render-Prozess

### 7.1 Render-Plan (Frontend)
[src/export/renderPlan.ts](../src/export/renderPlan.ts) legt **alle** Timing-Entscheidungen fest und liefert eine flache Liste frame-genauer Teile:

```ts
type RenderPiece =
  | { kind: "clip";  frames; src: { path, in, speed, volume, hasAudio, fit } }
  | { kind: "black"; frames }
  | { kind: "xfade"; frames; transition; a: Src | null; b: Src | null };   // null = Schwarz
```
Die Summe aller `frames` ist exakt `totalFrames`, das ist getestet.

### 7.2 FFmpeg-Pipeline (Backend)
1. **Pro Teil ein FFmpeg-Aufruf mit eigenem Filtergraph** → einheitliche Zwischendatei (H.264 + PCM, MOV mit exakter Timescale):
   ```
   ffmpeg -ss 1.4 -t 1.97 -i /media/scene-12.mp4 -filter_complex
     "[0:v:0]setpts=(PTS-STARTPTS)/1.0,fps=30,scale=640:360:force_original_aspect_ratio=increase,crop=640:360,
      setsar=1,format=yuv420p,tpad=stop_mode=clone:stop_duration=0.97,trim=end_frame=29,setpts=PTS-STARTPTS[v];
      [0:a:0]asetpts=PTS-STARTPTS,aresample=48000,…,volume=0.7,apad,atrim=0:0.966667[a]"
     -map [v] -map [a] -c:v libx264 … -frames:v 29 -video_track_timescale 90000 -f mov pieces/0001.mov
   ```
   Übergänge sind ein Teil mit zwei Eingängen: `[va][vb]xfade=transition=fade:duration=D:offset=0`. Speed läuft über `setpts` bzw. eine `atempo`-Kette, `-frames:v` und `tpad` garantieren die exakte Frame-Zahl, auch wenn die Quelle zu früh endet.
2. **Concat-Demuxer** (`ffconcat` mit exakten `duration`-Angaben) + Musik-Mix, Video per Stream-Copy:
   ```
   ffmpeg -f concat -safe 0 -i pieces.ffconcat -ss 0.5 -i /music/track.mp3 -filter_complex
     "[1:a:0]…,volume=-2dB,afade=t=in…,adelay=…,apad,atrim=0:19.5,afade=t=out…[music];
      [0:a:0]…[clips];[clips][music]amix=inputs=2:duration=first:normalize=0[aout]"
     -map 0:v:0 -map [aout] -c:v copy -bsf:v "setts=ts=round(TS/3000)*3000" -video_track_timescale 90000
     -c:a aac -movflags +faststart out.mp4
   ```
   `setts` rastet jeden Zeitstempel exakt auf das Frame-Raster ein. Der Concat-Demuxer addiert Offsets in µs, und das würde bei hunderten Segmenten driften. Ergebnis: strikt konstante Framerate, auch bei 29,97 fps.

Eigenschaften:
* **Inhaltsadressierter Segment-Cache**: Der SHA-1 aus Teil und Ausgabeeinstellungen ist der Dateiname. Nach kleinen Edits werden nur geänderte Teile neu gerendert.
* **Parallel** (`parallelJobs`), mit Fortschritt an Stash (`\x01p\x02…`). Abbrechen beendet laufende FFmpeg-Prozesse.
* Danach optional ein Stash-Scan des Ausgabeordners, damit das PMV als Szene erscheint. Das Ergebnis meldet `scanned`; ein PC-Render in einen zugeordneten Ordner (`Y:\PMVs` = `/data/PMVs`) wird über die umgekehrte Zuordnung (`unmap_path`, Ergebnis `stashFile`) ebenfalls gescannt.
* **🏷 Beschriften** ([labels.ts](../src/ui/labels.ts)): Der Scan läuft erst nach dem Render-Task (Stashs Job-Warteschlange arbeitet nacheinander), deshalb beschriftet der Browser. Er sucht die Szene per exaktem Pfad (`EQUALS`; `INCLUDES` zerlegt den Wert in Wörter) und setzt Projektname als Titel, eine kurze Beschreibung, alle Performer der Quellszenen, die Tags, die mindestens ein Viertel davon teilen (mindestens zwei Szenen), und den Tag `PMV Creator`. Vorhandene Werte bleiben. Offene Aufträge liegen im `localStorage` und werden beim nächsten Editor-Start nachgeholt.
* Sicherheit: Projekt- und Upload-IDs werden per Regex geprüft (keine Pfad-Traversal). Übergangsnamen kommen aus einer Whitelist, Pfade werden nur als Argumente übergeben, nie über eine Shell oder den Filtergraph.

### 7.3 Alternative Übergaben
| Format | Inhalt | Zielgruppe |
|---|---|---|
| **OTIO** (`.otio`) | Echte Spurstruktur V1…Vn + Musik, Gaps, `LinearTimeWarp` für Speed, `SMPTE_Dissolve`, Timeline-Marker | DaVinci Resolve (Import Timeline), Premiere/Avid über OTIO-Adapter |
| **EDL** (CMX3600) | Geflachte Sequenz, `M2` für Speed, `D nnn` für Dissolves, `* SOURCE FILE` für das Relinking, Musik als `AA`-Event | Jedes NLE |
| **FFmpeg-Skript** (bash/cmd) | Exakt die Befehle des Renderers, eigenständig lauffähig | Rendern auf anderer Maschine |
| **Render-Plan** (JSON) | Plan für `python pmv_backend.py render plan.json` | CLI / Automatisierung |

## 8. Determinismus – was garantiert ist
* Gleiches Projekt und gleiche Quelldateien ergeben denselben Render-Plan und damit dieselben FFmpeg-Befehle.
* Absolute Positionen werden quantisiert, ohne Drift. Die Frame-Summe wird im Backend vor dem Render geprüft.
* Kein `Math.random()` in der Pipeline. Auto-Arrange „gemischt“ und Stashs `random_<seed>`-Sortierung nutzen Seeds. Einzige Ausnahme ist 🎲 *Anderer Clip* als bewusste Handaktion: Sein Ergebnis steht danach wie jede Bearbeitung im Projekt, der Render bleibt deterministisch.
* Preview, EDL, OTIO und Render teilen sich `flattenTimeline` und `resolveTransitions`.

## 9. Grenzen & Ausbaustufen
* **Preview** ist eine Annäherung: Bei Übergängen steht die Gegenseite als Standbild, und Transcode-Streams (nicht browserfähige Codecs) springen beim Spulen. Abhilfe wäre ein Proxy-Render (Backend-Op, niedrige Auflösung, All-Intra).
* Keine Effekte (Reverse, Freeze, Zoom/Ken-Burns, Farbe), keine Mehrfachauswahl, kein Ducking von Clip-Ton gegen Musik.
* EDL ist einspurig, nicht-dissolve-Übergänge stehen nur als Kommentar. Strikte CMX-Leser erlauben maximal 999 Events.
* Abbrechen eines Renders: Stash beendet den Python-Prozess. Bereits laufende Segment-FFmpegs laufen ggf. noch zu Ende (Sekunden).
* Ideen: „An PMV Creator senden“ aus der Stash-Szenenliste, Beat-Erkennung im Web-Worker, Stream-Copy-Modus auf Keyframes (ohne Re-Encode), FCPXML-Export.
