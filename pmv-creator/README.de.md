# PMV Creator – Stash-Plugin

Deterministischer PMV-Editor direkt in [Stash](https://github.com/stashapp/stash): Szenen und Marker vorauswählen (Culling), auf ein Beat-Raster arrangieren, jeden Clip feinjustieren und frame-genau per FFmpeg rendern. Alternativ als OTIO/EDL an DaVinci Resolve & Co. übergeben. Läuft im klassischen Stash und in [Stash UI](https://github.com/anonym88312/stash-pmv-plugins).

*English: [README.md](README.md)*

Architektur, Datenmodell und Render-Pipeline: **[docs/KONZEPT.md](docs/KONZEPT.md)** · Projektformat: [schema/pmv-project.schema.json](schema/pmv-project.schema.json) · Erstnutzer-Test in echtem Stash 0.31: [docs/TESTBERICHT.md](docs/TESTBERICHT.md) · Änderungen: [CHANGELOG.md](CHANGELOG.md)

## Installation

Voraussetzungen: Stash mit Plugin-UI-API (`PluginApi.register.route`, `runPluginOperation`; aktuelle Versionen, getestet mit 0.31). Auf dem Stash-Server Python ≥ 3.8 (*Einstellungen → System → Python-Pfad*) und FFmpeg ≥ 4.4 – das von Stash mitgelieferte FFmpeg wird automatisch gefunden. Marker-Endzeiten nutzt das Plugin, wenn der Server `end_seconds` kennt, sonst eine einstellbare Standardlänge.

**Aus Stash (Plugin-Quelle)** – unter *Einstellungen → Plugins → Verfügbare Plugins → Quellen* diese URL eintragen

```
https://pepegasan.github.io/Stash-Folder-Sidebar-Plugin/main/index.yml
```

und **PMV Creator** aus der Liste installieren (Updates kommen auf demselben Weg).

**Manuell** – den Ordner [`plugins/pmv-creator/`](https://github.com/PepegaSan/Stash-Folder-Sidebar-Plugin/tree/main/plugins/pmv-creator) des Repositories nach `<stash-config>/plugins/pmv-creator/` kopieren.

**Aus dem Quelltext**

```bash
npm install
npm run build          # → dist/pmv-creator/
```

Den Ordner `dist/pmv-creator/` nach `<stash-config>/plugins/pmv-creator/` **kopieren** (keine Junction/Symlink: Stashs Plugin-Scanner folgt ihr unter Windows nicht, das Plugin erscheint dann gar nicht). Danach in Stash unter *Einstellungen → Plugins* „Plugins neu laden“ ausführen und die Seite neu laden. In der Navbar erscheint ein Button, die Seite liegt unter `/pmv-creator`.

> Laufzeitdaten liegen in der Installation: Projekte, Segment-Cache und Renders in `pmv-creator/data/`, hochgeladene Musik in `pmv-creator/assets/media/` (von dort liefert Stash sie an den Browser aus). Zum Aktualisieren den Ordner erneut kopieren und beide stehen lassen; `tests/e2e-stash/sync-plugin.ps1 -PluginsDir <stash>/plugins` erledigt Build, Kopie und „Plugins neu laden“ in einem Schritt.

### Stash UI

Ist das Plugin [Stash UI](https://github.com/anonym88312/stash-pmv-plugins) installiert, bringt PMV Creator ein Erweiterungsmodul mit (`assets/stashui.js`, Stash-UI-Extension-API v2) und erscheint dort ohne weitere Einrichtung:

- im Menü unter **Watch → PMV Creator**: der Editor öffnet als Vollbild-Seite im Look von Stash UI (Farben, Schrift), × oben rechts schließt ihn;
- in der **Infoleiste des Players** (Taste I): „Im PMV Creator öffnen“ nimmt die Szene an der aktuellen Stelle mit;
- in der **Auswahlleiste der Szenenliste**: „PMV Creator“ legt alle markierten Szenen ins Projekt.

Projekte sind dieselben wie in der klassischen Oberfläche (gleiches Backend, gleicher Browser-Speicher). Der klassische Weg (`/pmv-creator`, Navbar-Button) bleibt daneben erhalten, auch mit Stash UIs Theme für klassisches Stash. Getestet mit Stash UI 3.95.1.

### Einstellungen

*Einstellungen → Plugins → PMV Creator*: FFmpeg-/FFprobe-Pfad, Ausgabeordner (liegt er in einer Library, „Nach dem Rendern scannen“ aktivieren), Projektordner, parallele Jobs, Cache leeren.

### Sprache

Die Oberfläche ist englisch und wechselt auf Deutsch, wenn Stashs Oberflächensprache Deutsch ist (*Einstellungen → Oberfläche → Sprache*) oder – in Stash UI – wenn dort Deutsch gewählt ist; sagt keines von beiden etwas, entscheidet die Browsersprache. Die Übersetzungen liegen in `src/locales/`; `npm run i18n:check` listet fehlende Schlüssel, eine weitere Sprache ist eine Datei mehr.

## Arbeitsablauf

1. **Musik**: Im Inspector (nichts ausgewählt) die Datei hochladen oder einen Server-Pfad angeben. Danach *BPM erkennen*, bei Bedarf ×2/÷2 oder *Tap*, *Versatz = Playhead*.
2. **Culling** in der Seitenleiste
   * *Szenen*: suchen und mit **+** in den Projekt-Pool, oder direkt per **Szenen-ID / Stash-Link** (`123, 456` bzw. `http://stash:9999/scenes/123`, Button **+ ID**). Anklicken öffnet den Drill-Down. Marker **+** (auswählen), **⊘** (ausschließen), **✂** (als Bereich übernehmen). Bereiche per **I/O** oder Shift+Ziehen auf der Scrub-Bar. *Keyframes laden* zeigt die I-Frames.
   * *Marker*: bibliotheksweit nach Marker-Tags suchen und gesammelt übernehmen.
   * *Auswahl*: die Bin. Schnipsel per Drag & Drop auf eine Spur, **→** am Playhead einfügen, **⇄** gewählten Clip ersetzen, Reihenfolge ändern.
3. **Arrangieren**: von Hand oder mit dem **⚡ Generator** (Toolbar; in der *Auswahl* mit den Schnipseln als Quelle). Er funktioniert wie ein PMV-Generator, angelehnt an den Pepega PMV Generator: Clips nach Tags (alle/eines/ohne, Haupt-Tags), Performern, Bewertung, Länge, Auflösung, Format, Pfad, Favoriten oder „Meistgesehen“, wahlweise als Marker. Dazu Tag-Stufen über den Song, Abwechslung, „Dem Verlauf der Szenen folgen“, Schnitt automatisch nach Musikenergie (Tempo Langsam/Normal/Schnell), Drops mit Blitz und Tempo-Rampen. Experimentell: *Clip-Tempo folgt der Musik* und *Bewegung auf den Beat* (siehe [KONZEPT](docs/KONZEPT.md#generator)). Das Ergebnis landet als normale Clips auf der Spur (ein Undo-Schritt). Gleicher Seed ergibt dasselbe PMV, 🎲 würfelt neu.

   ![Generator](docs/screenshots/generator.png)
4. **Feinjustieren**: Clip anklicken, dann im Inspector Start, Dauer (s/Beats), Quell-In/-Out, Geschwindigkeit, Übergang, Clip-Ton, Bildausschnitt.
   Grundregel: **Ein anderer Bereich der Szene ändert nie den Platz auf der Timeline.** Der Clip läuft weiter von A nach B, nur mit anderem Material. Das gilt für Quell-In/-Out im Inspector, Alt+Ziehen und ⇄ Ersetzen. Es gilt auch für die Szenen-Ansicht (Doppelklick auf den Clip oder „Quelle öffnen“): Dort erscheint der Clip als oranger Bereich auf der Leiste und lässt sich verschieben. Dazu gibt es „Clip-In = Player“, pro Marker „↦“ (Clip auf diesen Marker legen) und mit einer I/O-Auswahl „Bereich übernehmen“ (Geschwindigkeit bleibt) oder „Bereich einpassen“ (genau dieser Bereich, Geschwindigkeit passt sich an). Ist gerade eine andere Szene geöffnet, setzt „Ab Player einfügen“ deren Material in denselben Slot. Länge und Position ändert man nur auf der Timeline selbst (Ränder ziehen, Verschieben, „Dauer“).

   ![Clip in der Szene verschieben](docs/screenshots/clip-link.png)
5. **Rendern** (Stash-Task mit Fortschritt) oder **Export** → OTIO / EDL / FFmpeg-Skript / Renderplan / Projektdatei.
   Der Render-Dialog bietet zusätzlich **Schnellaufnahme (Browser)**: Die Sequenz läuft einmal im Browser und wird als WebM aufgenommen (MediaRecorder), dann in den Ausgabeordner gelegt und gescannt. Dauert genau so lang wie der Song und braucht kein FFmpeg auf dem Server – praktisch auf einer schwachen NAS –, ist aber Echtzeit und nicht frame-genau: ein Ruckler oder ein langsamer Stream landet im Video. Der FFmpeg-Render ist der exakte Weg.

Bearbeitungsmodi (Toolbar): **An Nachbarn stoppen** (Standard) · **Ripple** (Folgeclips rücken mit) · **Überschreiben** (überlappte Clips werden getrimmt/geteilt).

### Maus & Tastatur

| Aktion | Eingabe |
|---|---|
| Clip verschieben / trimmen / slippen | Ziehen · Ränder ziehen · Alt+Ziehen |
| Ohne Einrasten | Shift beim Ziehen |
| Quelle eines Clips öffnen | Doppelklick auf den Clip |
| Abspielen / Pause | Leertaste |
| Frame ± / Beat ± | ← → / Shift+← → |
| Gewählten Clip um Frame/Beat schieben | Alt+← → / Alt+Shift+← → |
| Teilen am Playhead · Ersetzen durch gewählten Schnipsel | S · R |
| Löschen · Ripple-Löschen | Entf · Shift+Entf |
| Timeline-Marker | M (Doppelklick im Lineal entfernt ihn) |
| Undo / Redo | Strg+Z / Strg+Y (Strg+Shift+Z) |
| Zoom | Strg+Mausrad, + / − · Mausrad = horizontal scrollen |

Deep-Link: `/pmv-creator?scenes=12,34,56` legt Szenen direkt in den Projekt-Pool, `?project=<id>` öffnet ein Projekt.

## Rendern ohne Stash (CLI)

Der Export *Renderplan (.json)* enthält alles, was der Renderer braucht:

```bash
python plugin/backend/pmv_backend.py render mein-pmv.render-plan.json -o mein-pmv.mp4 --jobs 4
python plugin/backend/pmv_backend.py script mein-pmv.render-plan.json --shell sh > render.sh
```

## Entwicklung

```bash
npm run watch          # Bundles bei Änderungen neu bauen (inkl. Manifest/Backend)
npm run typecheck
npm test               # Vitest: Timeline-Ops, Flatten/Übergänge, Renderplan, EDL/OTIO,
                       #         Generator, BPM-Erkennung, UI-Smoke-Test gegen gemocktes Stash
npm run test:backend   # Python-E2E mit echtem FFmpeg: alle Segmenttypen, 30/29.97 fps (CFR),
                       #         Cache, generiertes Skript, Plugin-Interface, TS-erzeugter Plan
npm run i18n:check     # fehlende Schlüssel einer Sprache
npm run release        # Build + release/pmv-creator-<version>.zip + index.yml (Plugin-Quelle)
```

`tests/e2e-stash/` enthält die Skripte für eine isolierte Stash-Testinstanz (`start-stash.ps1`, `sync-plugin.ps1`).

## Fehlersuche

* **Kein Navbar-Button**: Plugins neu laden *und* die Browserseite neu laden. Beim ersten Start deckt Stashs „Release Notes“-Dialog die Navbar ab. Ist der Plugin-Ordner eine Junction/ein Symlink, lädt Stash ihn nicht – kopieren.
* **PMV erscheint nach dem Render nicht in Stash**: Stash scannt nur Ordner innerhalb einer Library. Der Render-Dialog warnt, wenn der Ausgabeordner außerhalb liegt; dann den Ordner als Library hinzufügen oder einen Ordner in einer Library wählen.
* **„Backend nicht erreichbar“ / Speichern nur lokal**: Python fehlt oder ist in Stash nicht konfiguriert (*Einstellungen → System → Python-Pfad*). Details stehen im Stash-Log.
* **Waveform lädt nicht**: Die Musik wird über `ui.assets` ausgeliefert. Prüfen, ob `/plugin/pmv-creator/assets/media/<datei>` im Browser abrufbar ist.
* **Vorschau ruckelt / bleibt schwarz**: Nicht browserfähige Codecs (z. B. HEVC in Firefox, WMV) laufen über Stash-Transcodes, die beim Spulen neu starten. Der Render ist davon nicht betroffen.

## Lizenz

[MIT](LICENSE)
