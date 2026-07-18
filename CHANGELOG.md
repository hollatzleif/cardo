# Changelog

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
