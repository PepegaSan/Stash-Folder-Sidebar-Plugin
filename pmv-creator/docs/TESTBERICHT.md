# Testbericht: Erstnutzer-Durchlauf in echtem Stash

**Aktuelle Ergänzung:** [Varianz-Laufzeitkorrektur 0.9.13](#varianz-laufzeitkorrektur-0913), [Generator-Varianz vom 01.11.2026](#generator-varianz-am-01112026) und [Audio-Nachprüfung vom 31.10.2026](#nachprüfung-am-31102026-arbeitsstand-nach-0911). Der ursprüngliche Bericht unten bleibt als historischer Nachweis für den Stand vom 21.10. erhalten.

**Stand:** 21.10.2026 · **Stash:** v0.31.1 (Windows, isolierte Zweitinstanz auf Port 9977, eigene Datenbank) · **Browser:** Edge 155 · **Material:** 26 Testvideos (22 Szenen, 15 s bis 2 h 24 min, H.264 und HEVC, 360p bis 1080p60), 17 angelegte Marker, 5 Tags, 2 Performer, ein synthetischer 128-BPM-Track.

Die Umgebung lässt sich nachstellen mit [tests/e2e-stash/start-stash.ps1](../tests/e2e-stash/start-stash.ps1) (isolierte Instanz) und [tests/e2e-stash/sync-plugin.ps1](../tests/e2e-stash/sync-plugin.ps1) (Build → Plugin-Ordner → „Plugins neu laden“). Die Oberfläche wurde über Edge mit Remote-Debugging bedient; jeder Schritt wurde per Screenshot und DOM-Abfrage geprüft.

## Erneuter Render-Helfer-Download 0.9.16

Der Nutzer bestätigte die Meldung im PMV-Creator. Im bisherigen Code verschwand der Download für verbundene, ausreichend neue Helfer; bei bekannten Offline-PCs lag er in eingeklappten Einrichtungsschritten. Zudem behauptete „Heruntergeladen“ nur aufgrund eines programmgesteuerten Linkklicks, die Datei sei gespeichert. Eine dauerhafte technische Sperre durch diesen Status ließ sich im Code nicht nachweisen.

Der Download steht jetzt unabhängig von Verbindungsstatus und Helper-Listenfehlern offen. Er lädt das aktuelle Template ohne Browsercache und lässt sich beliebig wiederholen. Nach der Anforderung bleibt ein echter Speicherlink bestehen. Die Meldung bestätigt nur „Download angefordert“. Wechsel des API-Schlüssels, neuer Download und Schließen räumen den vorherigen Blob-Link auf; nach dem Schließen wird keine verspätete Anfrage mehr als Download gestartet.

**Unabhängige GPT-Astra-Prüfung vor Deployment:** keine funktionalen Deployment-Blocker; 46 gezielte Tests, Typprüfung und Übersetzungen erfolgreich. Gesamtprüfung: **279 Tests in 29 Dateien**, Typprüfung, Übersetzungsprüfung (0 fehlende/0 leere Einträge) und beide Builds erfolgreich. Neun zusätzliche Download-Regressionsfälle prüfen insbesondere Wiederholung, aktuelle/alte/Offline-Helfer, Listenfehler, API-Schlüsselwechsel, beide Dateivarianten und verspätete Antworten.

Echte Dateidownloads in isoliertem Chrome 156.0.8078.76: produktive `PcRender`-Komponente, simulierter verbundener PC, echtes Helper-Template. Erstdownload, erneuter Download, direkter Speicherlink und `.py`-Variante erzeugten jeweils die erwartete Datei mit Version 0.9.16 und ausgefüllter Testadresse. Drei Template-Anfragen für vier Downloads (der Speicherlink verwendet die vorbereitete Datei), keine JavaScript-Seitenfehler. [Messwerte](verification/2026-11-01-helper-download.json). Die zuvor versuchte isolierte Edge-Instanz brach beim Start ab; sie lieferte keinen Download-Nachweis. Die konkrete Browserkonfiguration des Nutzers wurde nicht verändert oder geprüft, und kein heruntergeladener Helfer wurde ausgeführt.

## Explizite Materialwahl 0.9.15 und unabhängiger Astra-Review

Nach erneutem Bericht über einen kleinen Ausschnitt und unerwünschten Markerfokus wurden zwei nachweisbare Begrenzungen entfernt: übernommene alte Markerflags sowie die automatische Beschränkung der Quelle „Meine Clips“ auf bereits gespeicherte Schnipsel. Die Materialwahl ist jetzt offen in Einfach/Erweitert sichtbar. Fehlt `materialMode` in alten Einstellungen oder Presets, gilt „Ganze Videos“; nur bewusst gewählte Marker-/Bereichsmodi schränken darauf ein. Die Quelle „Meine Clips“ lädt im Ganzvideo-Modus deduplizierte Szenen-IDs aus der Bin mit aktueller voller Dateidauer. Intro-/Outroabzug ist sichtbar und abschaltbar.

Der Generator zeigt nach dem Lauf die wirksame Materialwahl und verfügbare Quellzeit nach Ausschlüssen, ohne doppelte Stufen mehrfach zu zählen. Ein Test mit einem fünfsekündigen Marker in einer 1800-s-Quelle erzeugt Ganzvideo-Picks mit Starts unter 400 und über 1400 s und meldet 1512 s verfügbares Material (je 8 % Intro/Outro abgezogen). Explizite Marker-/Bereichswahl und Markerszenen ohne Marker sind separat geprüft. Vorhandene Generator-Memos behalten beim Reroll ihren gefilterten Pool verbindlich bei, auch wenn er leer ist.

Read-only-Prüfung mit echten Stash-Metadaten: 1202,7-s-Quelle, für den Test auf fünf Sekunden gekürzter Bin-Bereich an einem vorhandenen Marker, übernommene alte Markerflags. Ergebnis: wirksam „Ganze Videos“, 1010,268 s verfügbar, 90 Clips ohne Marker-ID, Starts etwa 99–1101 s. Expliziter Bereichsmodus behält die fünf Sekunden. Keine Medien dekodiert oder Projekte in Stash gespeichert; die konkreten Einstellungen des Nutzerlaufs wurden nicht eingesehen. [Nachweis](verification/2026-11-01-material-scope.json).

**Vor dem Deployment unabhängig durch GPT Astra gegengeprüft:** finale Freigabe ohne neue Deployment-Blocker; Typprüfung und 96 Tests aus sechs relevanten Suiten unabhängig grün. Gesamtprüfung: 270 Tests, Typprüfung, Übersetzungsprüfung und Build grün. Astra bestätigt die beiden konkreten Begrenzungen; die individuelle Vorschau-Ursache bleibt ohne die ursprünglichen Laufdaten unbestätigt.

Vorbestandene Grenzen außerhalb dieses Patches: `reroll.ts` kann bei einem zu kurzen Marker-/Bin-Bereich über dessen Ende hinausgehen, weil sein Speed-Fit die Datei statt des Bereichs begrenzt. Die standardmäßig deaktivierte experimentelle BeatSync-Nachbearbeitung prüft Bereichs-/Exclusion-Grenzen nach Tempo-/Startänderungen nicht erneut. Der ebenfalls gefundene ungefilterte Reroll-Rückfall wurde in diesem Patch dagegen beseitigt.

## Verteilung langer Quellen 0.9.14

Auf die Rückmeldung „zufällig, bisher nur in der Vorschau geprüft“ wurde die tatsächliche Wiedergabe untersucht. Ein allgemeiner Seek-Fehler ließ sich lokal nicht nachstellen: Die produktive PreviewEngine spielte zwölf weit entfernte Stellen eines neutralen 30-Minuten-Videos mit sichtbarer Quellzeit korrekt, direkt und über neu gestartete FFmpeg-Transcode-Streams. Verglichen wurden per `requestVideoFrameCallback` dekodierte Frames mit den erwarteten Quellzeiten, nicht nur die angeforderten `currentTime`-Werte. Dies ist kein Nachweis für das konkrete Video oder Netzwerk des Nutzers.

Die Auswahl wurde unabhängig davon verstärkt: Hohe Varianz bevorzugt zwölf wenig verwendete Zeitabschnitte und große Abstände zum letzten Pick derselben Quelle. Bei 18 kurzen Picks aus einer zweistündigen Quelle (Seed 7) wurden alle zwölf Abschnitte benutzt; der kleinste Sprung betrug rund 1108 s. Bei der vorherigen Auswahl waren es zehn Abschnitte und rund 145 s. Auch die neu generierten Picks wurden im echten Browser mit der 30-Minuten-Quelle geprüft: alle zwölf Bilder kamen aus den erwarteten Bereichen, direkt und transcodiert. Details: [Nachweis](verification/2026-11-01-long-source-variance.json).

Die Berechnung von 2400 Schnitten aus einem erschöpften 30-s-Bereich dauerte weiterhin nur rund 73 ms im lokalen Node-Test. 251 Tests, Typprüfung, Übersetzungsprüfung und Build erfolgreich; Testinstallation `E:\Stash` aktualisiert. Marker-/Bin-Grenzen, Ausschlüsse und „Dem Verlauf folgen“ bleiben Einschränkungen, auf die die Verteilung Rücksicht nimmt. Unterschiedliche visuelle Motive werden nicht automatisch erkannt.

## Varianz-Laufzeitkorrektur 0.9.13

Nach der Meldung „Chrome: Seite reagiert nicht“ wurde die erschöpfte Einzelquelle als eigener Lastfall gemessen. In 0.9.12 verglich die Ausweichsuche jeden Kandidaten mit sämtlichen vorherigen Clips. Der neue Intervall-Index und ein einzelner Durchlauf der Grenzen ersetzen diese verschachtelte Suche. Die Oberfläche nutzt zusätzlich die kooperative Berechnung mit etwa 8-ms-Zeitabschnitten und Fortschrittsanzeige.

Direkter Vergleich unter Node.js mit identischen 1.000 Auswahlen aus einer 30-s-Quelle: **1686 ms vorher, 14,5 ms danach**. 2.400 Auswahlen: 31 ms; 10.000: 102 ms. Eine vollständige kooperative Generierung mit echten Stash-Metadaten, 30-s-Quellbereich und 2.400 Schnitten dauerte rund 45 ms; der Timer lief währenddessen weiter, alle Picks blieben im Quellbereich und entsprachen exakt der synchronen Berechnung. Details: [Laufzeitbericht](verification/2026-11-01-variance-performance.json). Diese Zahlen messen Auswahl und Generierung, kein Medien-Decoding oder Rendern; sie sind keine gemessenen Chrome-Endzeiten.

248 Tests erfolgreich, darunter ein exakter Vergleich des gewichteten Index mit unabhängigen Überlappungssummen, ein Lasttest mit einer erschöpften Quelle, Sync/Async-Gleichheit und ein Timer-Test zwischen Rechenabschnitten. Typprüfung, Übersetzungen und Build erfolgreich. Testinstallation `E:\Stash` aktualisiert.

## Generator-Varianz am 01.11.2026

Arbeitsstand nach 0.9.11, installiert in der vom Nutzer freigegebenen separaten Installation `E:\Stash`, Stash v0.31.1 auf `127.0.0.1:9978`. Backend-Ping, Plugin-Reload und Auswahl mit echten Szenendaten erfolgreich. Ergebnisse: [maschinenlesbarer Bericht](verification/2026-11-01-variance.json).

- Eine Quelle mit 1704,37 s: 75 Ausschnitte von 5/10/20 s, **keine überlappenden Quellbereiche**, verteilt von etwa 138 bis 1552 s.
- Nachgestellte dünne Tempokarte mit vier Messpunkten: bei 0 % vier Startpunkte, bei 100 % **75 unterschiedliche Ausschnitte ohne Überlappung**. Die Messpunkte sind synthetisch; Szenendauern und Kandidaten stammen aus Stash.
- Vollständige 240-s-Timelines mit Vollbild und Split-Screens: bis exakt 240 s gefüllt, keine wiederholten Quellbereiche. Timeline-Ergebnis im Reducer angewendet; kein Testprojekt in Stash gespeichert.
- 244 Tests erfolgreich, einschließlich 9 neuer Auswahl-Regressionen für lange Quellen, Tag-Stufen, Felder, zukünftige Pins, überlappende Marker, Kandidaten nach Position 24, erschöpftes Material und Speed-Rampen. UI-Smoke-Test bedient den Regler und wechselt zwischen Einfach/Erweitert. Ältere Einstellungen und Presets geprüft; Typprüfung, Übersetzungsprüfung und Build erfolgreich.

Diese Nachprüfung betrifft Quellauswahl und UI-Logik; die Medien wurden dafür nicht dekodiert oder gerendert.

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

## Nachprüfung am 31.10.2026 (Arbeitsstand nach 0.9.11)

**Geltungsbereich:** lokale, noch nicht veröffentlichte Änderungen auf Basis von 0.9.11. Paket- und Manifestversion bleiben 0.9.11; der Changelog führt die Änderungen unter *Unreleased*. Keine neue Installation in einer produktiven Stash-Instanz. Die Browserprüfung verwendet synthetisches Material und gemockte Stash-Antworten. Der ursprüngliche Erstnutzerbericht ist keine vollständige Abnahme der heutigen Funktionen.

### Ziele und Ergebnisse

| Ziel | Ergebnis und Nachweis |
|---|---|
| Clip-Ton über 100 % wie im FFmpeg-Render | Vorschau und Schnellaufnahme verwenden einen Web-Audio-GainNode für den Clip-Pegel 0–200 %. Die Browser-Hörlautstärke multipliziert den vollen Clip-Pegel erst danach; sie geht nicht in den Clip-Ton der Aufnahme ein. [Routing](../src/ui/preview/audio.ts), [Engine](../src/ui/preview/engine.ts), [Regressionen](../tests/previewAudio.test.ts) |
| Gesperrte Clips verständlich behandeln | Der Clip-Ton-Regler ist deaktiviert und erklärt das Entsperren. Die Sammelaktion zählt nur entsperrte Clips, nennt gesperrte separat und meldet tatsächlich geänderte Clips. Ohne Änderung bzw. mit vollständig gesperrten Spuren ist sie deaktiviert. Ein Undo-Schritt stellt die vorherigen Pegel wieder her. [UI-Test](../tests/ui.smoke.test.tsx), [Sammelaktion](../src/ui/ClipAudioApply.tsx) |
| Standard neuer Clips von vorhandenen Pegeln trennen | Der Projektblock erklärt, dass sein Regler nur den Startpegel neuer Clips ändert. „Auch für neue Clips verwenden“ übernimmt einen gewählten Clip-Pegel als Projektstandard. Der Generator erklärt seine sofortige Wirkung auch beim Schließen. Tests prüfen Generator- und Stapelübernahme; vorhandene Migration-/Einfügetests bleiben grün. [Generator-Test](../tests/generator.test.ts), [Einfügen/Migration](../tests/editing.test.ts), [UI-Test](../tests/ui.smoke.test.tsx) |
| Bestehende Funktionen erhalten | 234 Tests in 25 Dateien erfolgreich (vor den Änderungen: 228 in 24). Typprüfung ohne Fehler, Übersetzungsprüfung ohne fehlende Schlüssel, beide Frontend-Bundles gebaut. Backend-E2E mit echtem FFmpeg vollständig erfolgreich. |

### Tatsächliche Browsermessung

Edge **156.0.4314.50**, unsichtbare Testinstanz, synthetischer 440-Hz-Ton. Die RMS-Messung erfolgt hinter der Clip-Audioausgabe; der Lautsprecherausgang der Messung ist stumm. Verhältnisse beziehen sich auf den gemessenen Pegel bei 100 %.

| Einstellung | Gemessener RMS-Faktor |
|---|---:|
| 50 % | 0,499905 |
| 100 % | 1,000000 |
| 150 % | 1,499883 |
| 200 % | 1,999734 |
| Stumm | 0,000000 |
| 75 % nach Aufräumen und erneutem Verbinden desselben Elements | 0,749937 |

Zusätzlich wurde `recordSequence` mit einem synthetischen H.264/AAC-Clip tatsächlich ausgeführt und das erzeugte WebM wieder dekodiert: **2 Sekunden Aufnahme, Clip-Ton 200 %, Browser-Hörlautstärke 20 % und stumm**. Der RMS-Faktor im mittleren Aufnahmebereich beträgt **2,002472** gegenüber der dekodierten Quelle (kleine Codec-Abweichung). Keine JavaScript-Seitenfehler. [Messwerte](verification/2026-10-31-audio.json)

Oberfläche im Browser geprüft: [Projektstandard](screenshots/clip-audio-project.png), [gesperrter Clip](screenshots/clip-audio-locked.png). Diese Aufnahmen verwenden die gemockte Testoberfläche, keine produktive Stash-Bibliothek.

### Prüfungen und verbleibende Grenzen

- `npm test -- --no-cache`: **234/234 Tests erfolgreich**. Neue Fälle betreffen Verstärkung, Hörlautstärke/Stumm, getrennten Aufnahmeausgang, Wiederverwendung und Aufräumen von Audioquellen, Browser ohne Audioverstärkung, Sperren, Ergebnisrückmeldung und Generator-/Stapelstandard.
- `npm run typecheck`: erfolgreich.
- `npm run i18n:check`: 875 deutsche Einträge, **0 fehlende**, 0 leere; 4 ungenutzte Bestandsschlüssel.
- `npm run build`: klassisches Stash und Stash UI erfolgreich; lokales `dist/pmv-creator` aktualisiert.
- `npm run test:backend`: alle Prüfungen erfolgreich, einschließlich B-Frames, NTSC/CFR, Cache, Plugin-Operationen, PC-Helfer mit API-Key-Anfragen, Helper-Streams, TS-Renderplan, Effekten, Split-Screens und exportierten Windows-Skripten. Das aktualisiert die Nachweislage gegenüber dem historischen Hinweis „API-Key nicht getestet“ für diesen Testumfang; es ersetzt keine Prüfung jeder produktiven Anmeldekonfiguration.
- Unter Windows wurde der tatsächliche Projektpfad verwendet. Das Mischen eines umgeleiteten C:-Pfads mit dem aufgelösten E:-Pfad führte zunächst zu Modul-Ladefehlern in Vitest; im tatsächlichen Ordner liefen Ausgangs- und Änderungsstand erfolgreich.
- Kein neuer Live-Test mit einer NAS, einer produktiven Bibliothek, Firefox oder macOS. Bei fehlender Web-Audio-Verstärkung bleibt native Wiedergabe mit sichtbarer Begrenzungsanzeige möglich; der Fallback ist automatisiert geprüft.
- Clip-Pegel sind absolute Werte. Mehrfachauswahl, relative Gruppenänderung, automatisches Ducking und Pegelanzeige/Limiter bleiben gesonderte Produktentscheidungen. Hohe Summenpegel mehrerer Clips plus Musik können übersteuern. Diese Erweiterungen waren keine offene Implementierungszusage aus 0.9.7.
- Die gemessene Gleichheit betrifft den **Clip-Pegel**. Stream-Ladezeit, Frame-Timing, Übergangsverhalten und die bisherige Musikvorschau bleiben im bestehenden Rahmen; der Backend-Render bleibt die frame-genaue Ausgabe.
