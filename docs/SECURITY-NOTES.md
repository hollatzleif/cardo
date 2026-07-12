# Cardo – Sicherheitsnotizen

Stand: Cardo v0.4.1 · Sprache: Deutsch · Zielgruppe: Wartung & Review

Dieses Dokument ist ein **ehrliches Inventar** der schützenswerten Werte
(Secrets, Passwörter, Hashes, personenbezogene Daten) und ihres tatsächlichen
Schutzstatus. Kein Marketing: Wo eine Grenze bewusst gezogen wurde, steht das
hier so drin – inklusive der Spalte **„Was ein Angreifer bräuchte"**.

Der Grundsatz von Cardo ist *local-first*: Daten gehören dem Gerät, nicht der
Cloud. Das prägt fast jede Entscheidung unten.

## Geltende Testabsicherung

Die Aussagen hier sind nicht nur behauptet, sondern durch adversariale Tests
abgesichert:

- **Worker:** `server/polls-worker/test/worker.test.mjs` (node:test, keine
  Abhängigkeiten) – 49 Tests gegen eine Fake-D1: Login/Rate-Limit,
  Session-Token-Fälschung, Vote-Validierung, SQL-Injection-Strings,
  Body-Limits, CORS/Header, Secret-Leak-Scan.
- **Rust:** `#[cfg(test)]` in `assistant.rs`, `notes.rs`, `lib.rs` – Modell-ID-,
  Doc-Scope-, Notiz-Namen- und Download-URL-Validierung inkl. Spoofing-Fälle.
- **Secret-Scan:** `scripts/check-secrets.mjs` (in `pnpm lint` verdrahtet) –
  bricht den Build ab, sobald ein privater Schlüssel, ein Provider-Token oder
  ein hartkodiertes Credential in einer git-verfolgten Datei auftaucht.

## Inventar & Schutzstatus

| Wert / Asset | Schutz | Was ein Angreifer bräuchte |
| --- | --- | --- |
| **minisign-Updater-Schlüssel** (signiert die Release-Artefakte) | Privater Schlüssel liegt **ausschließlich lokal** beim Maintainer und als **CI-Secret** – nie im Repo. `check-secrets.mjs` erzwingt das (Regex `untrusted comment: rsign encrypted secret key`, PEM-Private-Keys) und bricht `pnpm lint`/CI ab, falls doch etwas eincheckt. Nur der **öffentliche** Schlüssel ist im Repo/Bundle. | Zugriff auf den lokalen Keystore des Maintainers **oder** das CI-Secret. **Verlust-Szenario:** Wird der private Schlüssel kompromittiert, kann ein Angreifer signierte Fake-Updates ausliefern → Schlüssel rotieren, neuen Public Key mit einem außerbandigen Zwangs-Update ausrollen; ältere Clients ohne Update sind bis dahin gefährdet. Deshalb: Schlüssel niemals synchronisieren, nur offline sichern. |
| **Poll-Admin-Passwort** | Server kennt **nur den Hash**: `pbkdf2$100000$<salt>$<hash>` (PBKDF2-HMAC-SHA256, 100k Iterationen) im Worker-Env-Secret, gesetzt via `wrangler secret put` – nie in Code/Logs. Login ist rate-limitiert (**max. 10 Versuche / 10-Min-Fenster**, globaler Zähler ohne IP). Session danach als **HMAC-SHA256-Token, 24 h gültig**, mit konstant-zeitlichem Vergleich. Passwort wird **nie** im Response-Body zurückgegeben (getestet). | Das Klartext-Passwort erraten (Brute-Force durch PBKDF2 + Rate-Limit stark gebremst) **oder** das `SESSION_SECRET` aus dem Worker-Env stehlen, um Tokens zu fälschen. Beides erfordert Zugriff auf die Cloudflare-Secrets. |
| **`SESSION_SECRET`** (HMAC-Schlüssel) | Nur als Worker-Env-Secret. Manipuliertes Payload, gefälschte Signatur, abgelaufenes oder mit falschem Secret signiertes Token werden alle mit 401 abgewiesen (getestet). | Auslesen des Cloudflare-Worker-Secrets. |
| **Geräte-ID / Abstimmungs-Identität** | Verlässt das Gerät **ausschließlich als SHA-256-Hash** und nur beim **freiwilligen** Abstimmen. Der Worker speichert pro Stimme nur `poll_id`, `device_hash`, `option_id`, Datum – **keine IP, kein User-Agent**. Eine Stimme pro Gerät via `PRIMARY KEY (poll_id, device_hash)`. | Die Vorbild-Rohdaten der Geräte-ID **und** das genaue Hash-Verfahren, um eine ID zu deanonymisieren – und selbst dann fehlen IP/Metadaten für eine Zuordnung zu einer Person. |
| **App-CSP** | Strikte `connect-src`-Allowlist in `tauri.conf.json` (self, IPC, der Poll-Worker, GitHub-Release-Hosts, Wetter-API, `huggingface.co`). Eine **Laufzeit-Probe** in der Diagnose (`securityChecks.ts` / `networkChecks.ts`) prüft, dass die Policy greift. | Eine RCE/Webview-Lücke, um trotz CSP zu exfiltrieren – die Allowlist verhindert stille Datenabflüsse zu Fremd-Hosts. |
| **Rust-Input-Validierung** (Webview → Host) | Jeder Host-Command validiert streng: Modell-IDs (`a-z0-9.-`, kein führender Punkt), Doc-Scopes/-IDs (`^[a-z0-9-]{1,64}$`, feste Kind-Allowlist je Scope), Notiz-Namen (kein `/`, `\`, `..`, kein führender Punkt, `.md`-Endung), Export-Dateinamen (kein Separator/Traversal), und der **Download-URL-Host** wird jetzt **exakt geparst** (`is_allowed_model_url`: nur `https`, Host exakt `huggingface.co`, kein Userinfo, kein Port) statt per `starts_with`. | Eine kompromittierte Webview, die trotzdem gültige Eingaben liefern muss – Traversal/Host-Spoofing (`huggingface.co@evil.com`, `huggingface.co.evil.com`, Port-Tricks) werden abgewiesen (getestet). |
| **Lokale SQLite-DB** (`cardo.db`) | **Unverschlüsselt – bewusste Entscheidung.** Local-first heißt: Wer physischen/Account-Zugriff auf das Gerät hat, hat ohnehin Datenzugriff (OS-Nutzerkonto ist die Schutzgrenze). Alle Schreibzugriffe laufen über den Rust-`StorageAdapter` (Change-Log), die Webview berührt SQLite nie direkt. | Zugriff auf das entsperrte Benutzerkonto bzw. das Dateisystem des Geräts. Verschlüsselung würde hier nur Scheinsicherheit vorgaukeln (Schlüssel müsste lokal liegen). |
| **`backup_import`** | Liest eine **vom Nutzer aktiv gewählte** Datei und akzeptiert sie nur mit gültigem Marker (`"cardoBackup": 1`); ungültiges JSON oder fehlender/falscher Marker → Fehler (getestet). Restore läuft durch die normale Storage-Schicht. | Eine **kompromittierte Webview** *und* eine präparierte Datei mit gültigem Marker, die der Nutzer selbst auswählt. Bewusste Grenze: kein automatischer Import, kein Netzwerk-Trigger. |
| **Website-Admin-Token** | Nach dem Login im `sessionStorage` – **nur für diesen Tab, nur diese Session**. Die Admin-Seite ist statisch (Astro, keine Fremdinhalte, keine Drittskripte), zusätzlich `meta http-equiv="Content-Security-Policy"` in `Base.astro`. | Ein XSS auf der eigenen statischen Seite (durch fehlende Fremdinhalte praktisch ausgeschlossen) oder physischen Zugriff auf den offenen Tab. |

## Bekannte, bewusst akzeptierte Grenzen

- **Rate-Limit ohne IP:** Der globale Login-Zähler ist absichtlich nicht
  IP-gebunden (Privacy), d. h. viele Nutzer teilen sich ein Fenster. Für
  `/vote` wird zusätzlich eine Cloudflare-WAF-Regel empfohlen; die IP wertet
  Cloudflare nur transient aus, der Worker speichert sie nie.
- **NUL-Byte in Notiznamen:** `validate_name` lässt einen NUL-Byte-Namen
  formal passieren (kein Separator, kein `..`), aber das Betriebssystem lehnt
  jeden Pfad mit internem NUL ab – es entsteht keine Datei und kein Ausbruch
  aus dem Notizordner (Defence-in-Depth, per Test abgesichert).
- **CSP erlaubt `*.huggingface.co`**, der Rust-Download-Check ist strenger
  (nur `huggingface.co`). Die engere Prüfung im Host ist die maßgebliche
  Grenze für Modell-Downloads.

## Regeln für Beitragende

1. **Niemals** ein echtes Secret in eine git-verfolgte Datei schreiben.
   Secrets gehören in Wrangler-Secrets (Worker), CI-Secrets (Releases) oder den
   lokalen minisign-Keystore.
2. Der Secret-Scan (`node scripts/check-secrets.mjs`, Teil von `pnpm lint`)
   muss grün bleiben. Ein Fund wird nur dann per Allowlist entschärft, wenn er
   **nachweislich kein Secret** ist (Format-Doku, CSS-Custom-Property,
   Prompt-String) – die Allowlist trägt Datei + Regel + Zeilen-Teilstring und
   niemals einen echten Schlüsselwert.
3. Änderungen an Auth, Validierung oder Download-Allowlist immer mit einem
   adversarialen Test begleiten (siehe oben).
