# Changelog

## 1.1.2 — Bedienbarkeit: Karteikarten, LaTeX, Board & Rechts-Abruf

### Karteikarten
- **Widget ist jetzt bedienbar:** eine sichtbare Leiste mit den drei Ansichten
  **Verwalten · Lernen · Statistik**. Das Widget öffnet auf „Verwalten" (die
  Stapel-Übersicht, wie Ankis Startbildschirm) — dort liegen **.apkg-Import**,
  **Karte hinzufügen** und **Optionen** (Algorithmus/Retention/Lernplan) direkt
  sichtbar; ein Stapel-Klick startet die Lernrunde. Vorher steckten diese Knöpfe
  in einer versteckten Widget-Variante, die kaum jemand fand.
- **Lern-Ansicht endlich gestylt:** die früher zusammengeklebten Zähler (die als
  „200000:05" erschienen), Timer, Karte und die farbigen Antwortknöpfe
  (Nochmal/Schwer/Gut/Leicht) haben jetzt ein sauberes Layout.
- **Tastatur nur im fokussierten Widget:** Leertaste/1–4/u steuern die Karten
  nur, wenn das Karteikarten-Widget den Fokus hat — kein versehentliches
  Umblättern mehr, während man in einem anderen Widget tippt.

### LaTeX / Formeln
- **Anki-Formeln werden gerendert:** Ankis Formel-Marker `[$]…[$]`, `[$]…[/$]`,
  `[$$]…`, `[latex]…[/latex]` sowie MathJax `\(…\)` / `\[…\]` werden erkannt und
  als Formel dargestellt (vorher blieben rohe Klammern oder eine rote Fehlerbox
  stehen). `&nbsp;` und HTML-Reste in Formeln werden bereinigt.
- **Mehr Befehle unterstützt:** Text-Befehle, die KaTeX nicht kennt (z. B.
  `\textbullet`, `\textdegree`, `\texttimes`), werden auf ihr Symbol abgebildet.

### Board (Widgets anordnen)
- **Verschieben & Größe ändern funktionieren wieder** — beides läuft jetzt über
  robuste Pointer-Events statt der Bibliotheks-Variante, die in der Desktop-App
  ein Ziehen als Text-Auswahl missdeutete („markiert alles"). Sauberer Griff zum
  Verschieben (⠿) und eine klare Ecke unten rechts zum Größe-Ändern.

### Rechts-Abruf
- **Deutschland: kein „HTTP 404" mehr.** Das Gesetz-Kürzel wird jetzt korrekt aus
  dem amtlichen Verzeichnis gelesen (die Links zeigen direkt auf die `xml.zip`);
  vorher bekam jedes deutsche Gesetz dieselbe kaputte Kennung und schlug fehl.
- **Kein Länder-/Bücher-Durcheinander:** ein schneller Wechsel der Rechtsordnung
  überschreibt nicht mehr die bereits gewählte Quelle mit einer langsam
  nachladenden Liste — es gewinnt immer die aktuelle Auswahl.
- **Gesetzbuch-Suche statt endloser Liste:** die ~6000 deutschen Gesetze werden
  per Tippfeld durchsucht statt in einem Riesen-Dropdown.

## 1.1.1 — Anki-Import & Rechtsquellen-Fixes

- **Anki-Import versteht das neueste Format:** `.apkg`-Dateien im aktuellen
  zstd-komprimierten Schema (Anki 2.1.50+) werden jetzt importiert (Notiztypen,
  Felder, Decks, Notizen, Karten mit Lernstand). Komplexe/Cloze-Vorlagen fallen
  dabei auf eine einfache Vorder-/Rückseite zurück, der Inhalt bleibt erhalten.
- **Rechts-Adapter live gefixt:** AT (RIS) auf den richtigen Endpunkt umgestellt,
  EU (EUR-Lex) auf HTML-Parsing; CH (SPA) und FR (braucht Nutzer-Schlüssel, noch
  ohne Eingabe-UI) sind vorerst ausgeblendet. Aktive Quellen: DE, EU, UK, AT.
  Klarere Fehlermeldung statt rohem HTTP-Code.

## 1.1.0 — Voll-Anki & Paragrafen-Wörterbuch

### Karteikarten: jetzt Anki-Klasse
- **Notiztypen & Kartenvorlagen** mit `{{Feld}}`, Bedingungen `{{#Feld}}…{{/Feld}}`,
  **Lückentext (Cloze)** und eigenem CSS; LaTeX über KaTeX, sicheres HTML-Sanitizing.
- **FSRS-Scheduler** (Ankis moderner Standard, via `ts-fsrs`) **plus** klassisches SM-2 —
  pro Deck wählbar. Lernschritte, Graduierung, Lapse/Relearning, Ease-Boden.
- **Karten-Browser** mit Anki-Suchsyntax (`deck:`, `tag:`, `is:due`, `is:suspended`,
  `flag:`, `added:`) und Massen-Aktionen (aussetzen, vergraben, flaggen, verschieben,
  umtaggen, löschen).
- **Statistik**: Zählungen, Fälligkeits-Prognose, Retention und Aktivitäts-Heatmap.
- **Medien** (Bild/Audio/Video) eingebettet, E2E-verschlüsselt gesynct.
- **`.apkg`/`.colpkg`-Import & -Export** (Notiztypen, Vorlagen, Medien, Tags, Lernstand).
- Nahtlose Migration bestehender Karten ins neue Modell (ids/Fälligkeiten/Fortschritt bleiben).

### Neu: Paragrafen-Wörterbuch (für Juristinnen und Juristen)
- Paragrafen (§§ / Artikel) mit eigenem Kommentar speichern, durchsuchbar — komplett lokal.
- **Online-Abruf** des amtlichen Textes aus sechs Rechtsquellen: **Deutschland**
  (gesetze-im-internet.de), **EU** (EUR-Lex), **UK** (legislation.gov.uk), **Österreich**
  (RIS), **Schweiz** (Fedlex) und **Frankreich** (Légifrance, mit eigenem PISTE-Schlüssel).
- **„Stand prüfen"**: holt den § neu, meldet Änderungen und aktualisiert den Text.
- Alle Abrufe laufen über eine harte Host-Allowlist; nur amtlicher, gemeinfreier Normtext.

### Unter der Haube
- **Diagnose erweitert**: Zero-Knowledge-Sync runtime-prüfbar (`core:sync-ciphertext`),
  Backup-Roundtrip, Keychain-Roundtrip, Notiz-Pfad-Schutz, Rechtsquellen-Host-Allowlist.
- **Abdeckungs-Wächter**: fehlende Selbsttests brechen jetzt die CI (kein still ungetestetes Tool).
- Neuer JS-Regressionstest gegen den früheren Hydration-Erinnerungs-Spam.

## 1.0.0 — Das große Update

### Sync (neu)
- **Ende-zu-Ende-verschlüsselter Sync** über einen Schlüssel, den nur du hast
  (CRD1-Format, HKDF-Ableitung, XChaCha20-Poly1305; Schlüssel im System-Schlüsselbund).
- Drei Transporte, alle zero-knowledge: **Google Drive** (eigener App-Ordner),
  **Ordner** (iCloud/Dropbox/Syncthing) und **WebDAV** (Nextcloud & Co.).
- Last-Writer-Wins pro Feld über die Hybrid Logical Clock; Geräteliste mit 10 Slots;
  Layouts opt-in; Pflicht-Vertrauenshinweis; standardmäßig AUS.

### 30 neue Tools (jetzt 47)
- **Planen**: Eisenhower-Matrix, Zeitblöcke, Projekte & Meilensteine, Ziele/OKRs
- **Schreiben & Sammeln**: Schmierzettel, Haftnotizen, Entscheidungslog, Leseliste,
  Lesezeichen, Code-Schnipsel
- **Fokus & Zeit**: Weltuhr, Klangkulissen, Atemübungen
- **Gesundheit**: Stimmungstagebuch, Schlaf-Log, Trainingslog, Essensplaner, Medikamente
- **Geld**: Sparziele, Abos & Rechnungen, Gemeinsame Ausgaben, Währungsrechner
- **Lernen & Werkzeuge**: Karteikarten (SM-2), Taschenrechner, Einheiten-Umrechner,
  QR-Codes, Passwort-Generator, Zufallsentscheider, Farben & Paletten, RSS-Leser
- Jedes Tool: Assistenten-Anbindung (Commands + Kontext), Self-Tests in der Diagnose,
  Varianten, DE/EN.

### Design
- **Theme-Editor**: eigene Themes ableiten, bearbeiten, exportieren/importieren
- **20 Themes** (10 neue: Everforest, Kanagawa, One Dark, Solarized Dark, Ayu ×2,
  Night Owl, Flexoki, Catppuccin Frappé, Rosé Pine Dawn)
- **Ansichts-Varianten** für Heute, Statistik (Heatmap!), Wetter, Gewohnheiten, Countdown
- **Boards exportieren/importieren** als Datei

### Assistent
- Versteht jetzt jeden Befehl mit Beschreibung und erlaubten Werten;
  Werkzeuge liefern ihm ihren aktuellen Stand automatisch zu.

### Unter der Haube
- ~150 neue Diagnose-Checks (u. a. Sync-Krypto, Assistenten-Katalog, eigene Themes)
- 1162 Frontend- und 71 Rust-Tests
