# Changelog

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
