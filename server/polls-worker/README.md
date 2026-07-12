# Cardo Polls Worker

Ein minimaler Cloudflare Worker, der anonyme Abstimmungs-Stimmen zählt – sonst nichts.

- **Fragen und Optionen** leben ausschließlich in `apps/website/src/data/polls.json`
  (Single Source of Truth). Der Worker kennt keine Fragen, er zählt nur.
- **Gespeichert wird pro Stimme nur:** Poll-ID, anonymer Geräte-Hash (SHA-256),
  Options-ID, Datum. Keine IP, kein User-Agent – Privatsphäre ist das Produkt.
- **Eine Stimme pro Installation:** erzwungen durch `PRIMARY KEY (poll_id, device_hash)`
  in D1. Ein zweiter Versuch bekommt `409 { "ok": false, "error": "already-voted" }`.

## Endpunkte

| Methode | Pfad                 | Antwort |
| ------- | -------------------- | ------- |
| GET     | `/results?poll=<id>` | `{ "poll": "<id>", "total": n, "counts": { "<optionId>": n } }` |
| GET     | `/results`           | `{ "polls": { "<pollId>": { "total": n, "counts": {…} } } }` |
| POST    | `/vote`              | Body `{ "poll", "option", "device" }` → `201 { "ok": true }` oder `409` |

Alle Antworten sind JSON mit offenem CORS (`Access-Control-Allow-Origin: *`).

## Deployment (einmalig)

Voraussetzung: ein (kostenloses) Cloudflare-Konto.

1. **Anmelden** – im Verzeichnis `server/polls-worker`:

   ```sh
   npx wrangler login
   ```

2. **D1-Datenbank anlegen:**

   ```sh
   npx wrangler d1 create cardo-polls
   ```

   Der Befehl gibt eine `database_id` aus. Diese in `wrangler.toml` anstelle von
   `REPLACE_AFTER_CREATE` eintragen.

3. **Schema einspielen:**

   ```sh
   npx wrangler d1 execute cardo-polls --remote --file schema.sql
   ```

4. **Worker deployen:**

   ```sh
   npx wrangler deploy
   ```

   Wrangler gibt die Worker-URL aus, z. B. `https://cardo-polls.<account>.workers.dev`.
   Diese URL anschließend in `apps/website/src/pages/polls.astro` in die Konstante
   `WORKER_URL` eintragen (dort steht der Platzhalter
   `https://cardo-polls.REPLACE_ME.workers.dev`).

## Eine neue Umfrage anlegen

1. `apps/website/src/data/polls.json` bearbeiten: neuen Eintrag mit eindeutiger
   `id` (kebab-case), Frage (`en`/`de`), Optionen und `"open": true` hinzufügen.
2. Committen und pushen → die Website wird neu deployt, die App liest dieselbe
   Datei per HTTPS von der deployten Website.
3. Am Worker ist **nichts** zu tun – er zählt jede Poll-ID, die Stimmen bekommt.

## Eine Umfrage schließen

In `polls.json` beim jeweiligen Eintrag `"open": false` setzen und pushen.
Die Website zeigt dann ein „Closed“-Badge, die App bietet keine Abstimmung mehr an.
Die bisherigen Ergebnisse bleiben sichtbar.

## Missbrauchsschutz

- Der Worker lehnt Request-Bodies über 1 KB ab und validiert alle Felder streng
  (Geräte-Hash muss 64 Zeichen Hex sein).
- **Rate-Limiting** wird bewusst nicht im Code implementiert: dafür in den
  Cloudflare-Dashboard-Einstellungen des Workers eine kostenlose WAF-Rate-Limiting-Regel
  anlegen (z. B. max. 5 Requests pro Minute und IP auf `POST /vote`).
  Cloudflare wertet die IP dabei nur transient aus – der Worker selbst speichert sie nie.
