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
- in der **Auswahlleiste der Szenenliste**: „PMV Creator“ legt alle markierten Szenen ins Projekt;
- im **Kopf von Performer- und Tag-Seiten**: „PMV mit diesem Performer/Tag“ legt ein neues Projekt an, und der Generator wählt Clips mit genau diesem Performer bzw. Tag.

Im klassischen Stash steht dasselbe auf der Performer-Seite als **⚡ PMV: <Name>**.

Projekte sind dieselben wie in der klassischen Oberfläche (gleiches Backend, gleicher Browser-Speicher). Der klassische Weg (`/pmv-creator`, Navbar-Button) bleibt daneben erhalten, auch mit Stash UIs Theme für klassisches Stash. Getestet mit Stash UI 3.95.1.

### Einstellungen

*Einstellungen → Plugins → PMV Creator*: FFmpeg-/FFprobe-Pfad, Ausgabeordner (liegt er in einer Library, „Nach dem Rendern scannen“ aktivieren), Projektordner, parallele Jobs, Cache leeren.

### Sprache

Die Oberfläche ist englisch und wechselt auf Deutsch, wenn Stashs Oberflächensprache Deutsch ist (*Einstellungen → Oberfläche → Sprache*) oder – in Stash UI – wenn dort Deutsch gewählt ist; sagt keines von beiden etwas, entscheidet die Browsersprache. Die Übersetzungen liegen in `src/locales/`; `npm run i18n:check` listet fehlende Schlüssel, eine weitere Sprache ist eine Datei mehr.

## Arbeitsablauf

Der Editor startet im **Einfach-Modus**: Solange die Timeline leer ist, zeigt die Vorschau die drei Schritte (Song hochladen → PMV erzeugen → Nachjustieren & rendern), und die Panels zeigen nur, was ein PMV braucht. **Erweitert** (Toolbar, oben rechts) blendet den Rest ein – Bearbeitungsmodi, Einrasten, die Marker-Suche, alle Generator-Optionen, Keyframes, Ausschlüsse und die „Mehr…“-Blöcke im Inspector. Die Wahl wird pro Browser gemerkt.

1. **Musik**: Im Inspector (nichts ausgewählt) die Datei hochladen oder einen Server-Pfad angeben – oder **🎵 Aus der Bibliothek…**: Jeder einmal hochgeladene Song liegt auf dem Server und lässt sich ohne neuen Upload wieder wählen. Die BPM werden automatisch erkannt, bei Bedarf ×2/÷2 oder *Tap*, *Versatz = Playhead*. Der Regler an der Musikspur (♪, links an der Timeline) bestimmt, wie laut die Musik im PMV ist; **🔊** über der Timeline stellt nur ein, wie laut die Vorschau in diesem Browser spielt.
2. **Culling** in der Seitenleiste
   * *Szenen*: suchen; **+ Projekt** legt eine Szene in den Projekt-Pool (daraus wählt der Generator), **→ Timeline** legt die **ganze Szene** an den Playhead auf die Timeline – der Playhead springt an ihr Ende, bei der nächsten Szene gedrückt folgt diese direkt dahinter: eine Compilation in wenigen Klicks (eine Zeile auf eine Spur ziehen tut dasselbe, und die Szenenansicht hat **→ Ganze Szene auf die Timeline**). Oder Szenen direkt per **Szenen-ID / Stash-Link** (`123, 456` bzw. `http://stash:9999/scenes/123`, Button **+ ID**). Anklicken öffnet die Szene im **Hauptplayer** (Reiter *PMV-Vorschau* / *Szene* darüber; **Esc** oder **← Zurück zum PMV** mittig in der Leiste über der Timeline führt zurück); die Seitenleiste behält Infos und Marker. **↗ Stash** (in jeder Zeile unter *Projekt-Szenen*, in der Szenenansicht und neben *✎ Quelle bearbeiten*, solange ein Clip gewählt ist) öffnet die Seite der Szene in Stash in einem neuen Tab, an der Stelle, die der Player zeigt – etwa um einen beim Schneiden gefundenen Marker zu setzen; kommst du zurück, holt sich der Editor die Szene neu (**↻ Neu laden** tut es von Hand). Eine Szenenzeile nimmt die Stelle des Clips dieser Szene im PMV-Player (gewählt oder unter dem Playhead); ohne einen solchen startet Stash dort, wo es zuletzt aufgehört hat. Marker **+** (auswählen), **⊘** (ausschließen), **✂** (als Bereich übernehmen). Bereiche per **I/O** (Buttons oder Tasten) oder Shift+Ziehen auf der Scrub-Bar unter dem Player. *Keyframes laden* zeigt die I-Frames. **〰 Wellenform laden** zeigt den Ton der Szene unter der Leiste – einmal auf dem Server berechnet (er liest die ganze Datei), dann aufgehoben.
   * *Marker*: bibliotheksweit nach Marker-Tags suchen und gesammelt übernehmen.
   * *Auswahl*: die Bin. Schnipsel per Drag & Drop auf eine Spur, **→** am Playhead einfügen, **⇄** gewählten Clip ersetzen, Reihenfolge ändern.
3. **Arrangieren**: von Hand oder mit dem **⚡ Generator** (Toolbar; in der *Auswahl* mit den Schnipseln als Quelle). Er funktioniert wie ein PMV-Generator, angelehnt an den Pepega PMV Generator: Clips nach Tags (alle/eines/ohne, Haupt-Tags), Performern, Bewertung, Länge, Auflösung, Format, Pfad, Favoriten oder „Meistgesehen“, wahlweise als Marker – oder einer deiner **gespeicherten Filter** aus Stashs Szenenliste (bei jedem Lauf frisch gelesen; Kriterien, die er nicht übersetzen kann, nennt der Dialog). Dazu Tag-Stufen über den Song, Abwechslung, „Dem Verlauf der Szenen folgen“, Schnitt automatisch nach Musikenergie (Tempo Langsam/Normal/Schnell) oder auf jedem Beat, alle 2 oder alle 4 Beats, Übergänge nach Wahl auf jedem Schnitt, Takt oder pro Phrase (oder gemischt), Drops mit Blitz und Tempo-Rampen, dazu die Effekte der Stimmung (siehe *Effekte* unten) und ihre **Split-Screens** (siehe *Split-Screens* unten: ruhige Teile Vollbild, laute mehr Felder, Drops die meisten – die Felder füllen V1 und die Spuren darüber). Experimentell: *Clip-Tempo folgt der Musik* und *Bewegung auf den Beat* (siehe [KONZEPT](docs/KONZEPT.md#generator)). Das Ergebnis landet als normale Clips auf der Spur (ein Undo-Schritt). Gleicher Seed ergibt dasselbe PMV, 🎲 würfelt neu.

   ![Generator](docs/screenshots/generator.png)

   **Meine Vorlagen**: **💾 Speichern als…** legt die aktuellen Generator-Einstellungen (Stimmung, Clips mit Tags/Performern, Schnitt, Stil) unter einem Namen ab, etwa „Mia – Hypno“. Sie liegen auf dem Server, jeder Browser dieses Stash sieht sie; die Auswahlliste lädt sie wieder, ✕ löscht.

   **📦 Mehrere PMVs auf einmal** (Menü *Projekt*, oder **Mehrere Songs…** im Generator): Songs wählen (aus der Song-Bibliothek oder hochladen), die Einstellungen (die aktuellen des Generators oder eine Vorlage) und wo gerendert wird. Jeder Song wird ein eigenes Projekt, im Browser nacheinander erzeugt und gespeichert, und sein Render kommt in Stashs Aufgaben-Warteschlange. Stash rendert sie der Reihe nach – auch wenn der Tab zu ist, etwa über Nacht auf dem PC mit dem Render-Helfer. „Schnitte wie ein anderes PMV“ passt nur zu dessen Song, deshalb schneidet ein Stapel jeden Song nach seiner eigenen Musik.

   **Schnitte: Wie ein anderes PMV** (wie „PMV as template“ im PMV Generator): Ein PMV aus der Bibliothek wählen (Szenen mit dem Tag „PMV“ oder „PMV Creator“ zuerst, sonst suchen). Das Plugin misst seine Schnitte und Blitze – das Backend liefert kleine Graustufenbilder, die Erkennung folgt Pepegas Regeln – und der Generator wechselt die Clips genau dort, wo das Original schneidet; Blitze werden zu weißen Blitzen. Mit **Auch seine Musik übernehmen** (Standard) wird sein Ton zum Song des Projekts, dann sitzen die Schnitte exakt auf der Musik; mit eigenem Song beginnen sie mit dem Song. Stimmungen ändern dann nur den Stil. Split-Screens des Originals werden nicht nachgebaut, nur dessen Timing – gewählte Split-Screens wechseln auf seinen Schnitten.

   **Nachbessern** – in der Leiste über der Timeline, sobald ein Clip gewählt ist:
   * **🎲 Anderer Clip** (Taste **N**): Der Clip bekommt neues Material, ausgewählt wie vom Generator (dieselben Tags, Performer und Stufen wie beim letzten Lauf, keine Szene, die gleich daneben läuft). Platz, Länge, Tempo und Übergang bleiben. Nochmal drücken geht zu weiteren Szenen statt zurück.
   * **📌 Behalten** (Taste **P**): „Erneut erzeugen“ und „Andere Variante“ lassen den Clip stehen und füllen drumherum – gute Treffer festhalten, den Rest neu würfeln. Der Generator-Dialog zeigt, wie viele Clips behalten sind (*Alle freigeben* löst sie).
   * **⏮ ⏭ Schnitte durchgehen** (Tasten **[** / **]** oder **↑** / **↓**; neben der Zeit über der Timeline): Der vorherige/nächste Clip wird gewählt und spielt ab einer Sekunde vor seinem Schnitt – nochmal drücken für den danach. Auf deutschen Tastaturen sind [ und ] AltGr+8/9; die Pfeiltasten machen dasselbe.
   * **⊘ Szene raus**: Alle Clips dieser Szene bekommen einen anderen Clip, und der Generator lässt sie in diesem Projekt aus (ein Rückgängig-Schritt). Danach bietet die Leiste **Nie wieder verwenden** an: Die Szene bekommt in Stash den Tag `PMV Creator: skip` und kommt in keinem PMV mehr vor; in der Szenen-Ansicht nimmt *Wieder erlauben* ihn ab.
4. **Feinjustieren**: Clip anklicken, dann im Inspector Start, Dauer (s/Beats), Quell-In/-Out, Geschwindigkeit, Übergang, Clip-Ton, Bildausschnitt. **Clip-Ton** (der eigene Ton der Clips unter der Musik) steht direkt dort: pro Clip, **⇉ Clip-Ton für alle Clips** (ein Rückgängig-Schritt), und ohne Auswahl setzt der Block *Clip-Ton* den Pegel, mit dem **neue Clips starten** (von Hand, aus dem Generator, im Stapel), und gibt ihn allen Clips mit einem Knopf; der Generator-Dialog hat denselben Regler neben dem Look, und 🔊 markiert Clips mit Ton auf der Timeline. **〰 Wellenform** über der Timeline zeichnet den Ton der Clips in ein eigenes Band unten in jedem Clip (die Spuren werden höher, solange er an ist) – um ein Geräusch auf den Beat zu legen; der Ton jeder sichtbaren Szene wird einmal auf dem Server berechnet (er liest die ganze Datei, über ein NAS bei einer großen eine Minute) und aufgehoben, zwei Szenen gleichzeitig, und der Schalter wird pro Browser gemerkt. **⇉ Übergang für alle Clips** gibt allen Clips denselben Übergang (ein Rückgängig-Schritt); die Vorschau zeigt Wischen, Schieben, Kreis und Zoom wie der Render. Bildausschnitt (pro Projekt unter *Ausgabe*, pro Clip im Inspector): **Einpassen (unscharfer Rand)** zeigt das ganze Bild über einer unscharfen, bildfüllenden Kopie (Standard, wie im PMV Generator – Hochkant-Clips bleiben im 16:9-Video komplett), **Füllen (beschneiden)** füllt das Bild und schneidet die Ränder ab, **Einpassen (Balken)** setzt schwarze Balken. **Look** (ebenfalls unter *Ausgabe* und im Generator): eine Farbstimmung für das ganze PMV wie im PMV Generator – Warm, Pink, Kalt, Kräftig, Schwarz-Weiß, Noir oder eine eigene Farbe, mit Stärke und zusätzlicher Helligkeit; Vorschau, Schnellaufnahme und Render sehen gleich aus (ein Render auf dem PC braucht den Helfer 0.9.5). **Effekte** (ebenfalls unter *Ausgabe* und im Generator, dessen Stimmungen sie wie beim PMV Generator setzen): im Beat **Zoom-Puls** (jeder Beat, Beat 1 und 3 oder jeder Takt, mit Stärke), **Wackeln**, **Stottern** (in lauten Teilen springt der Clip auf jedem zweiten halben Beat zurück) und **Stroboskop**; auf Drops **RGB-Split**, **Glitch**, **Tunnel**, **Negativ**, **Echo** und **Text** (deine Wörter knallen ins Bild); durch den Song **Farbrausch**; mit Split-Screens **Blitz** (wo einer beginnt oder endet, rosa auf einem Drop, leichter, wenn ein Feld in einem lauten Teil schneidet) und **Leuchtende Trennlinien** (rosa auf jedem Beat). Wann sie feuern, ergibt sich aus Beat-Raster und Lautheit der Musik – gleicher Song und Schnitt ergeben immer dieselben Effekte, und Vorschau, Schnellaufnahme und Render zeigen dasselbe (ein Render auf dem PC braucht den Helfer 0.9.5). Drops gibt es nur mit Musik.
   **Split-Screens** wie im PMV Generator: **2er**, **3er gespiegelt** (links und rechts derselbe Clip, gespiegelt, ein anderer in der Mitte), **3er**, **4er** und **Kaleidoskop** (ein Clip, vierfach gespiegelt); 2er und 3er nebeneinander oder übereinander. Sie liegen auf der Spur **⊞ Split-Screens** über den Videospuren: **+** fügt einen am Abspielkopf ein (2er, zwei Takte), Ziehen verschiebt ihn, die Ränder ändern seine Länge, **Entf** nimmt ihn weg – die Clips bleiben. Ausgewählt stellt der Inspector Layout, Felder, Start und Länge ein. Jedes Feld zeigt eine Spur: V1 (die unterste) das erste Feld, V2 das zweite, … – so läuft ein Feld-Clip weiter, während die anderen schneiden, und jedes Feld bleibt wie jede Spur editierbar. Rosa Bänder auf einer Spur zeigen, wo ein Feld sie zeigt, schraffierte, wo ein Split-Screen sie verdeckt. Außerhalb der Split-Screens gewinnt wie bisher die oberste Spur; Split-Screens schneiden hart (keine Übergänge). Vorschau, Schnellaufnahme und Render zeigen dasselbe (ein Render auf dem PC braucht den Helfer 0.9.6).
   Grundregel: **Ein anderer Bereich der Szene ändert nie den Platz auf der Timeline.** Der Clip läuft weiter von A nach B, nur mit anderem Material. Das gilt für Quell-In/-Out im Inspector, Alt+Ziehen und ⇄ Ersetzen. Es gilt auch für die Szenen-Ansicht (Doppelklick auf den Clip oder **✎ Quelle bearbeiten** über der Timeline): Die Szene öffnet sich im Hauptplayer, der Clip erscheint als oranger Bereich auf der Leiste und lässt sich verschieben. Dazu gibt es „Clip hier starten“, pro Marker „↦“ (Clip auf diesen Marker legen) und mit einer I/O-Auswahl „Bereich übernehmen“ (Geschwindigkeit bleibt) oder „Bereich einpassen“ (genau dieser Bereich, Geschwindigkeit passt sich an). **Andere Szene…** führt zurück zur Szenenliste; in der danach geöffneten Szene setzt „Diese Szene hier einsetzen“ deren Material in denselben Slot – oder **⇄ In allen N Clips dieser Szene einsetzen** gibt allen Clips der alten Szene auf einmal die neue (schneller: **⇄ Alle N ersetzen…** über der Timeline, dann links die neue Szene anklicken) (jeder an derselben relativen Stelle, Plätze und Längen bleiben, ein Rückgängig-Schritt; die übrigen Clips der Szene des gewählten Clips sind auf der Timeline gestrichelt umrandet). Länge und Position ändert man nur auf der Timeline selbst (Ränder ziehen, Verschieben, „Dauer“).

   ![Clip in der Szene verschieben](docs/screenshots/clip-link.png)
5. **Rendern** (Stash-Task mit Fortschritt) oder **Export** → OTIO / EDL / FFmpeg-Skript / Renderplan / Projektdatei.
   **🏷 In Stash beschriften** (Häkchen im Render-Dialog, an): Sobald Stash das fertige Video gescannt hat, bekommt die Szene den Projektnamen als Titel, eine kurze Beschreibung (Song, Anzahl Clips), alle Performer der verwendeten Szenen, die Tags, die mindestens ein Viertel davon gemeinsam haben, und den Tag `PMV Creator`. Voraussetzung: *Nach dem Rendern scannen* in den Plugin-Einstellungen und ein Ausgabeordner in einer Library (beim Rendern auf dem PC: ein Ordner, der einer Stash-Library zugeordnet ist, z. B. `Y:\PMVs` = `/data/PMVs`). Wird der Editor vorher geschlossen, holt er es beim nächsten Öffnen nach. Der Generator lässt Szenen mit dem Tag `PMV Creator` aus, damit deine eigenen PMVs nie zum Material für das nächste werden – außer seine Tags verlangen ausdrücklich `PMV Creator`.
   **🔔 Melden, wenn es fertig ist** (Häkchen, an): Renders laufen ohne den Dialog weiter – schließen und weiterarbeiten oder den Tab wechseln. **⏳** in der Werkzeugleiste zeigt jeden laufenden Render (Fortschritt, wartet in Stashs Warteschlange, wartet auf den PC) und listet fertige mit **↗ In Stash öffnen**, ✎ (Projekt öffnen) und ■ (abbrechen). Ist ein Render fertig, ertönt ein kurzer Ton und der Tab-Titel sagt es; dazu kommt eine Desktop-Benachrichtigung, wo der Browser sie erlaubt – Browser tun das nur über HTTPS oder localhost, nicht für Stash unter einer LAN-Adresse wie `http://192.168.1.10:9999`.
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
| Anderer Clip für den gewählten · beim erneuten Erzeugen behalten | N · P |
| Vorheriger / nächster Schnitt (wählt den Clip, spielt ab einer Sekunde davor) | [ ] oder ↑ ↓ |
| Löschen · Ripple-Löschen | Entf · Shift+Entf |
| Gewählten Split-Screen entfernen (dort wieder Vollbild) | Entf |
| Timeline-Marke am Playhead – und wieder weg | M oder **◆ Timeline-Marke** über der Timeline (*Erweitert*); auf einer Marke heißen beide **◆ Marke entfernen** (Doppelklick auf das Symbol im Lineal entfernt sie auch). Eine Notiz für dich, die in den OTIO-Export mitgeht, kein Stash-Marker |
| Undo / Redo | Strg+Z / Strg+Y (Strg+Shift+Z) |
| Zoom | Strg+Mausrad, + / − · Mausrad = horizontal scrollen |

Deep-Link: `/pmv-creator?scenes=12,34,56` legt Szenen direkt in den Projekt-Pool, `?project=<id>` öffnet ein Projekt, `?performer=<id>` bzw. `?tag=<id>` beginnt ein neues PMV mit diesem Performer/Tag.

## Auf dem eigenen PC rendern (optional)

Standardmäßig rendert Stash selbst. Mit dem **Render-Helfer** rendert stattdessen ein PC – deutlich schneller als eine NAS, und das Video landet auf diesem PC, auf einem beliebigen Laufwerk.

1. **Rendern** → *Rendern auf*: **Mein PC** → *Auf diesem PC noch nicht eingerichtet?* → **Render-Helfer herunterladen**. Das ist eine einzelne Python-Datei (`.pyw`: sie läuft ohne Fenster), in der deine Stash-Adresse schon eingetragen ist. Der PC braucht Python 3 ([python.org](https://www.python.org/downloads/)) und FFmpeg (z. B. `winget install Gyan.FFmpeg`).
2. Einmal per Doppelklick starten. Es öffnet sich kein Fenster; der PC erscheint nach ein paar Sekunden im Render-Dialog (wenn nicht, sagt `pmv-render-helper.log` neben der Datei, warum). Dieser erste Start registriert `pmvhelper://` für deinen Windows-Benutzer – ab dann startet ihn **▶ Helfer auf diesem PC starten** im Render-Dialog (der Browser fragt einmal, ob er darf), auch nach einem Neustart von Windows, und **⏹ Helfer beenden** stoppt ihn. Ein Eintrag im Autostart-Ordner (Win+R → `shell:startup`) geht weiterhin, ist aber nicht mehr nötig. *Mit Fenster (.py)* ist derselbe Helfer mit Konsole, zur Fehlersuche.
3. Einmal **Speichern in** eintragen (z. B. `I:\PMVs`), dann **Auf <PC> rendern**. Der Fortschritt steht im Dialog und in Stashs Task-Liste; *Abbrechen* stoppt auch den PC.

Der PC holt sich Videos und Musik über Stash, sonst muss nichts eingerichtet werden. Liegen die Videos auch auf einem Laufwerk des PCs (z. B. die NAS als `Y:`), bildet *Videos von einem Laufwerk lesen* Stashs Pfade darauf ab (`/data/` → `Y:\`). Für Stash mit Anmeldung vor dem Herunterladen einen API-Schlüssel eintragen.

**Vorschau vom PC.** Solange der Helfer (ab 0.7) läuft, spielt die Vorschau im Editor die Videos der zugeordneten Ordner vom PC statt von der NAS (**💻 vom PC** neben dem Player; ein Klick schaltet auf Stash und zurück). Der Helfer streamt sie mit dem FFmpeg des PCs als H.264 – auch HEVC, MPEG-4 und andere Codecs, die der Browser nicht abspielt und die sonst die NAS umrechnen müsste. Was der Helfer nicht liefern kann, kommt weiter von Stash. Fragt Windows, ob Python private Netzwerke nutzen darf: erlauben. Nach einem Plugin-Update den Editor einmal mit **Strg+F5** neu laden: Stash lässt den Browser `/pmv-creator` samt alten Sicherheitseinstellungen cachen (das ⚠ neben dem Player sagt es dann).

Kommandozeile: `python pmv_backend.py helper --stash http://nas:9999 [--api-key KEY] [--name PC] [--jobs N] [--stream-only] [--no-preview]`. Der Segment-Cache liegt in `%LOCALAPPDATA%\PMV Creator\cache`; Stücke älter als 14 Tage werden beim Start entfernt.

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
* **Render bricht ab mit `Unrecognized option 'filter_complex_script'`**: FFmpeg 8 kennt diese Option nicht mehr; PMV Creator 0.9.7 erkennt die FFmpeg-Version und nutzt stattdessen `-/filter_complex`. Auf einem PC, der mit dem Helfer rendert, den Helfer neu herunterladen (*Rendern → Mein PC*).
* **Waveform lädt nicht**: Die Musik wird über `ui.assets` ausgeliefert. Prüfen, ob `/plugin/pmv-creator/assets/media/<datei>` im Browser abrufbar ist.
* **Vorschau ruckelt / bleibt schwarz**: Nicht browserfähige Codecs (z. B. HEVC in Firefox, WMV) laufen über Stash-Transcodes, die beim Spulen neu starten. Der Render ist davon nicht betroffen.

## Lizenz

[MIT](LICENSE). Die Wörter des Text-Effekts zeichnet die Schrift [Anton](https://github.com/googlefonts/AntonFont) (SIL Open Font License 1.1, siehe `plugin/assets/fonts/OFL.txt`).
