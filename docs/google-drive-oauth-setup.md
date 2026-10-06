# Google Drive Sync: OAuth-App einrichten (Leif-Aktion)

Der Drive-Transport ist fertig implementiert (`apps/desktop/src-tauri/src/sync_gdrive.rs`),
braucht aber eine **OAuth-Client-ID** aus deiner Google Cloud Console. Ohne sie zeigt
Cardo beim Verbinden: „Google Drive is not configured in this build".

## Schritte (einmalig, ~15 Minuten)

1. https://console.cloud.google.com → neues Projekt „Cardo" anlegen.
2. **APIs & Dienste → Bibliothek** → „Google Drive API" aktivieren.
3. **APIs & Dienste → OAuth-Zustimmungsbildschirm**:
   - User Type: **Extern** · App-Name „Cardo" · deine E-Mail.
   - Scope hinzufügen: `https://www.googleapis.com/auth/drive.appdata`
     (NUR der versteckte App-Ordner — Cardo sieht keine Nutzerdateien).
   - Testnutzer: deine Google-Konten eintragen (im Testing-Modus dürfen bis zu
     100 Testnutzer die App nutzen — reicht für deine Geräte, bis die
     Verification durch ist).
4. **Anmeldedaten → Anmeldedaten erstellen → OAuth-Client-ID**:
   - Anwendungstyp: **Desktop-App** (Loopback-Redirects sind da automatisch erlaubt).
   - Die erzeugte Client-ID kopieren (`…apps.googleusercontent.com`).
5. Client-ID eintragen in `apps/desktop/src-tauri/src/sync_gdrive.rs`:
   `const DEFAULT_CLIENT_ID: &str = "<deine-client-id>";`
   (Zum lokalen Testen vorab: `export CARDO_GDRIVE_CLIENT_ID=…` reicht.)
6. **Verification einreichen** (Publishing status → „In Produktion"), damit auch
   Nicht-Testnutzer sich verbinden können. Google prüft das — Wochen einplanen.
   Bis dahin: Testing-Modus funktioniert für deine eingetragenen Konten voll.

## Sicherheitsmodell (zur Einordnung)

- Die Client-ID ist bei Desktop-Apps **kein Geheimnis** (PKCE liefert den Beweis).
- Refresh-Token landet im OS-Schlüsselbund, nie auf der Platte.
- Alles, was in Drive liegt, ist vorher mit dem Data-Key verschlüsselt
  (XChaCha20-Poly1305) — Google sieht nur unlesbare `.cardo-ops`-Dateien
  im appDataFolder.

## Zusätzlich für die iPhone-Web-App (einmalig, ~5 Minuten)

Die Web-App (https://hollatzleif.github.io/cardo-app/app/) braucht einen
eigenen OAuth-Client vom Typ **Webanwendung** im SELBEN Projekt „Cardo" –
nur dann sieht sie denselben versteckten App-Ordner wie der Desktop.

1. **Anmeldedaten → Anmeldedaten erstellen → OAuth-Client-ID**
   - Anwendungstyp: **Webanwendung**, Name „Cardo Web (iPhone)".
   - **Autorisierte JavaScript-Quellen:**
     `https://hollatzleif.github.io` und `http://localhost:1430`
   - **Autorisierte Weiterleitungs-URIs:**
     `https://hollatzleif.github.io/cardo-app/app/oauth-callback.html`
     und `http://localhost:1430/cardo-app/app/oauth-callback.html`
2. Die Client-ID kopieren. Ein Client-**Secret** wird NICHT gebraucht – und
   darf auch nirgends eingetragen werden (die Web-App ist öffentlich).
3. Client-ID hinterlegen: im GitHub-Repo `hollatzleif/cardo` unter
   **Settings → Secrets and variables → Actions → Variables** eine
   Variable `GDRIVE_WEB_CLIENT_ID` anlegen. Der Website-Deploy baut sie in die
   Web-App ein. (Lokal: `VITE_GDRIVE_WEB_CLIENT_ID=… pnpm --filter @cardo/desktop dev:web`.)
4. Im Testing-Modus: das Google-Konto des iPhones muss als Testnutzer
   eingetragen sein.

Sicherheitsmodell der Web-App: Anmeldung über den OAuth-Token-Flow im
Popup, ohne Google-Skript und ohne Secret. Das Zugriffstoken gilt etwa eine
Stunde; danach zeigt die App „Sync pausiert · Weiter mit Google" – ein Tipp
erneuert es. Es gibt kein Refresh-Token auf dem Telefon.
