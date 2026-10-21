# Testbericht: Erstnutzer-Durchlauf in echtem Stash

**Stand:** 21.10.2026 · **Stash:** v0.31.1 (Windows, isolierte Zweitinstanz auf Port 9977, eigene Datenbank) · **Browser:** Edge 155 · **Material:** 26 Testvideos (22 Szenen, 15 s bis 2 h 24 min, H.264 und HEVC, 360p bis 1080p60), 17 angelegte Marker, 5 Tags, 2 Performer, ein synthetischer 128-BPM-Track.

Die Umgebung lässt sich nachstellen mit [tests/e2e-stash/start-stash.ps1](../tests/e2e-stash/start-stash.ps1) (isolierte Instanz) und [tests/e2e-stash/sync-plugin.ps1](../tests/e2e-stash/sync-plugin.ps1) (Build → Plugin-Ordner → „Plugins neu laden“). Die Oberfläche wurde über Edge mit Remote-Debugging bedient; jeder Schritt wurde per Screenshot und DOM-Abfrage geprüft.

## Was funktioniert (verifiziert)

| Bereich | Ergebnis |
|---|---|
| Installation | Plugin wird erkannt, JS/CSS ausgeliefert, Einstellungen und Task „Render PMV“ erscheinen unter *Settings → Plugins* (deutsche Labels, Schalter, Pfadfelder) |
| Navbar / Seite | Button in der Navbar, Seite unter `/pmv-creator`, harter Reload und Deep-Link funktionieren, Backend-Status „gespeichert“ (online) |
| Szenen | Suche (Text, Tag, Performer, „nur mit Markern“, Sortierung inkl. Seed-Zufall) mit echten Vorschaubildern; „+“; Szenen-ID/Link-Eingabe mit Rückmeldung |
| Drill-Down | Echter Stream spielt (H.264 direkt, HEVC hier direkt da Edge es dekodiert), Filmstreifen und Hover-Thumbs aus echten Stash-Sprites, Marker mit Endzeiten und Marker-Screenshots, Auswählen/Ausschließen, I/O-Bereich per Shift+Ziehen, Keyframes per ffprobe (0,3 s) |
| Musik | Chunk-Upload über `runPluginOperation` (2,2 MB MP3), Auslieferung über `ui.assets` mit Range-Requests (206), Waveform, **128 BPM erkannt** (Offset 6 ms), Musik als Master-Clock |
| Generator | Quelle Filter/Oft angesehen/Projekt/Auswahl, Szenen und Marker, Tag-Stufen, alle Stash-Filterformen (Tags alle/eines/ohne, Performer, Bewertung, Auflösung, Format, Pfad, Länge) · 108 Clips aus 22 Szenen in 0,4 s |
| Experimentell | *Clip-Tempo folgt der Musik*: Tempokarten aus 13 echten Scene-Previews (fehlende Previews werden pro Szene übersprungen) · *Bewegung auf den Beat*: 43 von 108 Clips synchronisiert · zusammen 14 s |
| Editieren | Verschieben, Trimmen (Einrasten stoppt am Nachbarn; Ripple verschiebt Folgeclips exakt um 2 Beats), Teilen (S), Ersetzen (R), Slip (Alt+Ziehen), Inspector, Undo/Redo; Tasten lösen keine Stash-Hotkeys aus |
| Preview | A/B-Player schneiden hörbar durch die Sequenz, Clock läuft mit der Musik |
| Render | Als Stash-Task mit Fortschrittsanzeige: 111 Segmente aus bis zu 1,8 GB großen HEVC-Dateien in 33 s; Ausgabe 2700 Frames, exakt auf dem Frame-Raster, Musik gemischt; Segment-Cache |
| Scan | Mit Ausgabeordner in einer Library erscheint das PMV als Szene; zwei Renders desselben Projekts ergaben dieselbe Datei (Stash fasste sie per OSHash zu einer Szene zusammen) |
| Export | Projekt, EDL, OTIO, Render-Plan, FFmpeg-Skripte (bash/cmd) werden unter Stashs CSP heruntergeladen |
| Projekte | Autosave, Duplizieren, Öffnen-Liste, Löschen, Neu, Import, Reload stellt den Stand wieder her |

## Gefundene Fehler und was geändert wurde

| # | Befund | Schwere | Änderung |
|---|---|---|---|
| 1 | **Render mit B-Frames war kaputt.** Beim Standard-Preset „medium“ kamen die Frames in falscher Reihenfolge (PTS 0,033 → 0,100 → 0,067 …) und zwei fehlten. Ursache: `setts=ts=…` setzte PTS und DTS gleich. Der E2E-Test rendert mit „ultrafast“ (keine B-Frames) und sah es nicht. | kritisch | PTS und DTS getrennt gerundet ([pmv_backend.py](../plugin/backend/pmv_backend.py)); E2E-Test prüft jetzt einen B-Frame-Render und streng steigende Frame-Zeiten |
| 2 | **Seite unter `/plugin/pmv-creator` überlebt keinen Reload** (Stash beantwortet diesen Präfix serverseitig mit 404). Nur der Klick in der Navbar funktionierte. | kritisch | Route nach `/pmv-creator` verlegt ([index.tsx](../src/index.tsx)) |
| 3 | **Eine unbekannte Szenen-ID bricht die ganze Abfrage ab.** Stash lehnt `findScenes(ids: …)` komplett ab, wenn eine ID fehlt. Folge: „+ ID“ mit einem Tippfehler fügt nichts hinzu, und ein Projekt mit einer in Stash gelöschten Szene lud für *alle* Szenen keine Thumbnails, Marker oder Streams. | hoch | Einzelabfrage als Fallback, unbekannte IDs werden gemerkt ([queries.ts](../src/stash/queries.ts), [sceneCache.ts](../src/stash/sceneCache.ts)); verifiziert durch Löschen einer Szene im laufenden Betrieb |
| 4 | **Installation per Junction/Symlink funktioniert nicht** (Stashs Plugin-Scanner folgt ihr unter Windows nicht); das README empfahl sie. | mittel | README korrigiert, `sync-plugin.ps1` kopiert |
| 5 | **Frisches Projekt bekam bei jedem Reload eine neue ID**, und Stash loggte dafür jedes Mal einen ERROR („Projekt nicht gefunden“). | mittel | Frisches Projekt wird sofort gespeichert; `load_project` liefert `null` statt eines Fehlers ([store.tsx](../src/state/store.tsx)) |
| 6 | **„Nach dem Rendern scannen“ tat still nichts**, wenn der Ausgabeordner außerhalb jeder Library liegt (Standardordner im Plugin-Verzeichnis). | mittel | Backend prüft die Libraries und meldet eine Warnung im Render-Dialog |
| 7 | Shift+Ziehen auf der Scrub-Leiste markierte Text in der Seitenleiste. | gering | `preventDefault` + `user-select: none` |
| 8 | Speed-Badge auf Clips zeigte vier Nachkommastellen („0.9201×“). | gering | auf zwei gerundet |

## Beobachtungen ohne Änderung

* **Stashs „Release Notes“-Dialog** beim ersten Start überdeckt die Navbar; nach „Close“ ist der Plugin-Button sichtbar (Stash-Verhalten).
* **404 in der Browser-Konsole** für `…_thumbs.vtt`: Für Szenen ohne generierte Sprites fragt das Plugin die Sprite-VTT ab und fällt auf das Cover zurück. Funktional korrekt, aber sichtbar in den DevTools.
* **Volle Spur im Modus „Einrasten“**: Ein gezogener Clip springt stumm zurück, ein abgelehnter Startwert im Inspector bleibt ohne Rückmeldung. Umsortieren geht über Ripple/Überschreiben oder ⇄; ein „Tauschen“ beim Ablegen wäre eine sinnvolle Ergänzung.
* **Marker-Tab**: Marker, die schon in der Auswahl sind, sind korrekt nicht mehr wählbar – „Gewählte +“ bleibt dann deaktiviert, was auf den ersten Blick wie ein Fehler wirkt.
* **Bewertungsfilter** arbeitet mit Stashs `rating100`; „★3“ entspricht ≥ 60.

## Stash UI (3.95.1), gleiche Instanz

Stash UI wurde zusätzlich in die Test-Instanz installiert und PMV Creator um ein Erweiterungsmodul ergänzt. Geprüft im Browser:

| Was | Ergebnis |
|---|---|
| Erkennung | Stash UI lädt `assets/stashui.js`, die Plugins-Seite zeigt den Block „Stash UI extension“ ohne Fehler |
| Menü | Eintrag **Watch → PMV Creator** (Scheren-Symbol), Link `#/p/pmv-creator/editor` |
| Editor | öffnet als Vollbild-Overlay, lädt dasselbe Projekt wie in klassischem Stash (108 Clips), Backend online, Waveform, Vorschau spielt; Stash UIs Farben und Schrift (Bahnschrift) greifen; × schließt, der Editor räumt auf (kein `.pmv-root`, keine Tastatur-Handler mehr) |
| Player | Infoleiste (Taste I) → „In PMV Creator öffnen“ → Editor mit der Szene im Drill-Down bei 0:20 (`?scenes=6&t=20`) |
| Szenenliste | drei Szenen markiert → Auswahlleiste „PMV Creator“ → alle drei im Projekt-Pool |
| Klassisch daneben | `/pmv-creator` funktioniert weiter, auch mit Stash UIs Theme für klassisches Stash |

Dabei gefunden und behoben: Die handgezeichneten Bootstrap-Ersatzklassen hatten zu hohe Spezifität, die Toolbar zerfiel in Zeilen (jedes Feld volle Breite). Mit `:where()` auf Klassen-Spezifität gesenkt, die Breiten aus `.pmv-name`/`.pmv-select` gelten wieder.

## Vorbereitung der Veröffentlichung (0.3.0)

Nach der Umstellung auf eine englische Oberfläche mit Deutsch als zweiter Sprache erneut geprüft:

| Was | Ergebnis |
|---|---|
| Sprache, klassisches Stash | Stash-Sprache `en-US` → Englisch; `de-DE` (configureInterface) → Deutsch nach Neuladen; Reiter, Toolbar, Inspector, Seitenleiste geprüft |
| Sprache, Stash UI | ohne Einstellung (`auto`) → Englisch; `stashui.lang = "de"` → Deutsch im Overlay-Editor |
| Linux/Docker | `stashapp/stash:latest` (0.31.1, Alpine, Python 3.12, FFmpeg aus dem Image): Setup per GraphQL, Plugin geladen (0.3.0), Ping findet `/usr/bin/ffmpeg`, Scan von 22 Szenen, `keyframes` über ffprobe, Render-Task (clip + xfade + clip, 25 fps) → `/renders/…mp4`, Scan des Ausgabeordners legt die Szene an (22 → 23), `ffmpeg_script` liefert ein bash-Skript |
| Stash mit Passwort | Login-Seite mit `returnURL=/pmv-creator`, nach dem Login öffnet der Editor; Backend „saved“ (Session-Cookie reicht für `runPluginOperation`), Szenen-Stream spielt (`readyState 4`), „Keyframes laden“ liefert 992 Keyframes; Zugangsdaten danach entfernt, anonymer Zugriff wieder 200 |
| Tests | 83 Vitest-Tests (Smoke-Test jetzt mit englischen Texten), Python-E2E mit echtem FFmpeg, `i18n:check` ohne fehlende Schlüssel, `tsc` sauber |
| Release | `npm run release` → `release/pmv-creator-0.3.0.zip` (Inhalt auf Archiv-Ebene, 7 Dateien) + `index.yml` mit sha256 für eine Stash-Plugin-Quelle |

Beobachtung ohne Änderung: Beim Öffnen des Editors fordert der Browser für jede Projekt-Szene `…_thumbs.vtt` an; ohne generierte Sprites antwortet Stash 404 (einmal pro Szene, keine Folgen).

## Nicht getestet

* API-Key statt Login (das Backend ruft Previews mit dem Session-Cookie ab; mit API-Key wurde das nicht ausgelöst).
* Browser ohne HEVC-Decoder (Firefox): der Transcode-Fallback greift laut Code, wurde aber hier nicht ausgelöst, weil Edge HEVC direkt abspielt.
* macOS.
