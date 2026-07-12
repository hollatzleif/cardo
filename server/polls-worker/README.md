# Cardo Polls Worker

Ein Cloudflare Worker, der den Feed der App (Umfragen + Ankündigungen) ausliefert,
anonyme Stimmen zählt und eine abgesicherte Admin-API bereitstellt – sonst nichts.

- **Fragen, Optionen und Ankündigungen** leben jetzt in der D1-Tabelle `items`
  und werden über die Admin-API gepflegt (Website: `/admin`).
  **`apps/website/public/polls.json` ist deprecated** – die Datei bleibt vorerst
  liegen, wird aber weder von der Website noch vom Worker gelesen.
- **Gespeichert wird pro Stimme nur:** Poll-ID, anonymer Geräte-Hash (SHA-256),
  Options-ID, Datum. Keine IP, kein User-Agent – Privatsphäre ist das Produkt.
  Auch das Login-Rate-Limit kommt ohne IP aus (globaler Zähler pro Zeitfenster).
- **Eine Stimme pro Installation:** erzwungen durch `PRIMARY KEY (poll_id, device_hash)`
  in D1. Ein zweiter Versuch bekommt `409 { "ok": false, "error": "already-voted" }`.

## Öffentliche Endpunkte

| Methode | Pfad                 | Antwort |
| ------- | -------------------- | ------- |
| GET     | `/feed`              | `{ "items": [ { "id", "kind", "open", "createdAt", "payload", "results?" } ] }` – neueste zuerst, max. 50; Poll-Items enthalten Live-Ergebnisse (`{ "total", "counts" }`) |
| GET     | `/results?poll=<id>` | `{ "poll": "<id>", "total": n, "counts": { "<optionId>": n } }` |
| GET     | `/results`           | `{ "polls": { "<pollId>": { "total", "counts" } } }` |
| POST    | `/vote`              | Body `{ "poll", "option", "device" }` → `201 { "ok": true }`; `404` Poll/Option unbekannt, `403` Poll geschlossen, `409` bereits abgestimmt |

`payload` je nach `kind`:

- `poll` → `{ "question": { "en", "de" }, "options": [ { "id", "label": { "en", "de" } } ] }` (2–6 Optionen, IDs kebab-case)
- `announcement` → `{ "title": { "en", "de" }, "body": { "en", "de" } }`

## Admin-Endpunkte

Alle Admin-Endpunkte außer Login erwarten `Authorization: Bearer <session token>`.
Tokens sind 24 h gültig (HMAC-SHA256-signiert mit `SESSION_SECRET`).

| Methode | Pfad                | Beschreibung |
| ------- | ------------------- | ------------ |
| POST    | `/admin/login`      | Body `{ "password" }` → `{ "ok", "token", "expiresAt" }`; `401` falsches Passwort, `429` zu viele Versuche (max. 10 pro 10 Minuten, global) |
| POST    | `/admin/items`      | Body `{ "kind", "payload", "id?" }` → `201 { "ok", "item" }`; ohne `id` wird ein Kebab-Slug aus dem EN-Titel + Zufalls-Suffix generiert |
| PATCH   | `/admin/items/<id>` | Body `{ "open": true\|false }` – Umfrage/Ankündigung öffnen/schließen |
| DELETE  | `/admin/items/<id>` | Item löschen (vorhandene Stimmen bleiben in `votes`, das ist harmlos) |

Alle Antworten sind JSON mit offenem CORS (`Access-Control-Allow-Origin: *`).
Request-Bodies sind auf 8 KB begrenzt (`/vote`: 1 KB). Das Passwort wird nie
geloggt oder zurückgegeben.

## Secrets einrichten (einmalig, vor dem ersten Login)

Der Worker braucht zwei Secrets:

1. **`ADMIN_PASSWORD_HASH`** – PBKDF2-HMAC-SHA256-Hash des Admin-Passworts im
   Format `pbkdf2$<iterationen>$<salt_base64>$<hash_base64>`. So erzeugen
   (fragt das Passwort unsichtbar ab, 600 000 Iterationen):

   ```sh
   python3 -c 'import hashlib,os,base64,getpass; pw=getpass.getpass("Admin password: ").encode(); salt=os.urandom(16); it=100000; dk=hashlib.pbkdf2_hmac("sha256",pw,salt,it); print("pbkdf2$%d$%s$%s" % (it, base64.b64encode(salt).decode(), base64.b64encode(dk).decode()))'
   ```

   Die Ausgabe dann als Secret setzen (im Verzeichnis `server/polls-worker`):

   ```sh
   npx wrangler secret put ADMIN_PASSWORD_HASH
   ```

2. **`SESSION_SECRET`** – ein zufälliger String, mit dem Session-Tokens
   signiert werden:

   ```sh
   python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
   npx wrangler secret put SESSION_SECRET
   ```

Beide Befehle fragen den Wert interaktiv ab – nichts landet in Dateien oder Logs.
Nach dem Setzen der Secrets einmal `npx wrangler deploy` ausführen.

## Schema-Migration

Das Schema ist idempotent (`CREATE TABLE IF NOT EXISTS`); die bestehende
`votes`-Tabelle bleibt unverändert, es kommen nur `items` und `login_attempts`
dazu. Auf der deployten Datenbank einspielen mit:

```sh
npx wrangler d1 execute cardo-polls --remote --file schema.sql -y
```

**Wichtig:** `/vote` prüft jetzt, dass der Poll als offenes Item in `items`
existiert und die Option dazugehört. Bestehende Umfragen aus `polls.json`
(z. B. `example-poll`) müssen daher einmalig über `POST /admin/items` (mit
explizitem `id`-Feld gleich der alten Poll-ID!) neu angelegt werden, damit
alte Stimmen weiter zu ihrem Poll gehören und weiter abgestimmt werden kann.

## Deployment (einmalig)

Voraussetzung: ein (kostenloses) Cloudflare-Konto.

1. **Anmelden** – im Verzeichnis `server/polls-worker`:

   ```sh
   npx wrangler login
   ```

2. **D1-Datenbank anlegen** (entfällt, wenn sie schon existiert):

   ```sh
   npx wrangler d1 create cardo-polls
   ```

   Der Befehl gibt eine `database_id` aus – in `wrangler.toml` eintragen.

3. **Schema einspielen** (siehe oben), **Secrets setzen** (siehe oben).

4. **Worker deployen:**

   ```sh
   npx wrangler deploy
   ```

   Wrangler gibt die Worker-URL aus (aktuell
   `https://cardo-polls.hollatzleif.workers.dev`); sie steht in
   `apps/website/src/pages/polls.astro` und `admin.astro` als `WORKER_URL`.

## Inhalte pflegen

Alles läuft über die Admin-Seite der Website (`/cardo-app/admin`, nicht in der
Navigation verlinkt): einloggen, Ankündigungen und Umfragen anlegen, Items
öffnen/schließen/löschen. Änderungen sind sofort im Feed sichtbar – kein
Commit, kein Redeploy. `polls.json` nicht mehr pflegen (deprecated).

## Missbrauchsschutz

- Request-Bodies sind begrenzt (1 KB für `/vote`, 8 KB für Admin), alle Felder
  werden streng validiert (Geräte-Hash muss 64 Zeichen Hex sein, IDs kebab-case).
- Login: max. 10 Versuche pro 10-Minuten-Fenster (Tabelle `login_attempts`,
  globaler Zähler ohne IP), danach `429`.
- Für `POST /vote` zusätzlich empfohlen: eine kostenlose WAF-Rate-Limiting-Regel
  im Cloudflare-Dashboard (z. B. max. 5 Requests pro Minute und IP).
  Cloudflare wertet die IP dabei nur transient aus – der Worker selbst speichert sie nie.
