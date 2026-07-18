//! Anki `.apkg` / `.colpkg` import & export.
//!
//! An `.apkg` is a ZIP holding a SQLite `collection.anki2` (Anki's legacy
//! schema 11), a `media` JSON map (`{"0":"cat.jpg"}`) and the media files named
//! by number. We read/write that legacy schema – it is what Anki produces with
//! "support older Anki versions" and what it can always import. Newer,
//! zstd-compressed schema-18 collections are detected and rejected with a clear
//! hint rather than mis-parsed.
//!
//! Import maps note types, templates, notes (fields + tags), cards (phase +
//! SM-2 memory: interval, ease, reps, lapses) and media. Due dates are reset to
//! "due now" – memory strength is preserved, exact calendar timing is not.

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::sqlite::SqliteConnectOptions;
use sqlx::{Row, SqlitePool};

use crate::sync_folder::{b64_decode, b64_encode};

const FIELD_SEP: char = '\u{1f}';

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiTemplate {
    pub name: String,
    pub qfmt: String,
    pub afmt: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiNoteType {
    pub id: String,
    pub name: String,
    pub fields: Vec<String>,
    pub templates: Vec<AnkiTemplate>,
    pub css: String,
    pub cloze: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiDeck {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiNote {
    pub id: String,
    pub note_type_id: String,
    pub fields: Vec<String>,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiCard {
    pub id: String,
    pub note_id: String,
    pub ord: i64,
    pub deck_id: String,
    pub phase: String,
    pub interval_days: u32,
    pub ease: f64,
    pub reps: u32,
    pub lapses: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiMedia {
    pub name: String,
    pub data_base64: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnkiImport {
    pub note_types: Vec<AnkiNoteType>,
    pub decks: Vec<AnkiDeck>,
    pub notes: Vec<AnkiNote>,
    pub cards: Vec<AnkiCard>,
    pub media: Vec<AnkiMedia>,
}

fn phase_from_type(t: i64) -> &'static str {
    match t {
        0 => "new",
        1 => "learning",
        3 => "relearning",
        _ => "review", // 2 and anything else
    }
}

fn type_from_phase(phase: &str) -> i64 {
    match phase {
        "new" => 0,
        "learning" => 1,
        "relearning" => 3,
        _ => 2,
    }
}

async fn open_sqlite(path: &std::path::Path, read_only: bool) -> Result<SqlitePool, String> {
    let opts = SqliteConnectOptions::new()
        .filename(path)
        .read_only(read_only)
        .create_if_missing(!read_only);
    SqlitePool::connect_with(opts).await.map_err(|e| e.to_string())
}

/* ── Import ───────────────────────────────────────────────────────────────── */

/// Parse an `.apkg`/`.colpkg` file's bytes into a Cardo-shaped collection.
pub async fn import_apkg(bytes: &[u8]) -> Result<AnkiImport, String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("not a zip: {e}"))?;

    let mut candidates: Vec<(String, Vec<u8>)> = Vec::new();
    let mut media_map_raw: Option<Vec<u8>> = None;
    let mut numbered: HashMap<String, Vec<u8>> = HashMap::new();

    for i in 0..archive.len() {
        let mut file = archive.by_index(i).map_err(|e| e.to_string())?;
        let name = file.name().to_string();
        let mut buf = Vec::new();
        file.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        match name.as_str() {
            "collection.anki21" | "collection.anki2" => candidates.push((name, buf)),
            "collection.anki21b" => {
                return Err(
                    "This deck uses the newest Anki format. Re-export it with \
                     'Support older Anki versions' enabled."
                        .into(),
                )
            }
            "media" => media_map_raw = Some(buf),
            _ => {
                numbered.insert(name, buf);
            }
        }
    }

    // Prefer the newer legacy file (.anki21) but fall back to .anki2.
    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;

    let mut last_err = "no collection database found in the package".to_string();
    for (_, db_bytes) in &candidates {
        let path = dir.path().join("collection.anki2");
        std::fs::write(&path, db_bytes).map_err(|e| e.to_string())?;
        match read_collection(&path).await {
            Ok(mut import) => {
                import.media = decode_media(media_map_raw.as_deref(), &numbered)?;
                return Ok(import);
            }
            Err(e) => last_err = e,
        }
    }
    Err(last_err)
}

fn decode_media(
    media_map_raw: Option<&[u8]>,
    numbered: &HashMap<String, Vec<u8>>,
) -> Result<Vec<AnkiMedia>, String> {
    let Some(raw) = media_map_raw else { return Ok(Vec::new()) };
    let map: HashMap<String, String> =
        serde_json::from_slice(raw).map_err(|e| format!("bad media map: {e}"))?;
    let mut out = Vec::new();
    for (number, name) in map {
        if let Some(data) = numbered.get(&number) {
            out.push(AnkiMedia { name, data_base64: b64_encode(data) });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

async fn read_collection(path: &std::path::Path) -> Result<AnkiImport, String> {
    let pool = open_sqlite(path, true).await?;

    let col = sqlx::query("SELECT models, decks FROM col LIMIT 1")
        .fetch_one(&pool)
        .await
        .map_err(|e| format!("unsupported collection schema: {e}"))?;
    let models: Value = serde_json::from_str(&col.try_get::<String, _>("models").map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let decks: Value = serde_json::from_str(&col.try_get::<String, _>("decks").map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;

    let note_types = parse_models(&models);
    let decks = parse_decks(&decks);

    let mut notes = Vec::new();
    for row in sqlx::query("SELECT id, mid, tags, flds FROM notes")
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?
    {
        let flds: String = row.try_get("flds").map_err(|e| e.to_string())?;
        let tags: String = row.try_get("tags").map_err(|e| e.to_string())?;
        notes.push(AnkiNote {
            id: row.try_get::<i64, _>("id").map_err(|e| e.to_string())?.to_string(),
            note_type_id: row.try_get::<i64, _>("mid").map_err(|e| e.to_string())?.to_string(),
            fields: flds.split(FIELD_SEP).map(str::to_string).collect(),
            tags: tags.split_whitespace().map(str::to_string).collect(),
        });
    }

    let mut cards = Vec::new();
    for row in sqlx::query("SELECT id, nid, ord, did, type, ivl, factor, reps, lapses FROM cards")
        .fetch_all(&pool)
        .await
        .map_err(|e| e.to_string())?
    {
        let ivl: i64 = row.try_get("ivl").map_err(|e| e.to_string())?;
        let factor: i64 = row.try_get("factor").map_err(|e| e.to_string())?;
        cards.push(AnkiCard {
            id: row.try_get::<i64, _>("id").map_err(|e| e.to_string())?.to_string(),
            note_id: row.try_get::<i64, _>("nid").map_err(|e| e.to_string())?.to_string(),
            ord: row.try_get("ord").map_err(|e| e.to_string())?,
            deck_id: row.try_get::<i64, _>("did").map_err(|e| e.to_string())?.to_string(),
            phase: phase_from_type(row.try_get("type").map_err(|e| e.to_string())?).to_string(),
            interval_days: if ivl > 0 { ivl as u32 } else { 0 },
            ease: if factor > 0 { factor as f64 / 1000.0 } else { 2.5 },
            reps: row.try_get::<i64, _>("reps").map_err(|e| e.to_string())?.max(0) as u32,
            lapses: row.try_get::<i64, _>("lapses").map_err(|e| e.to_string())?.max(0) as u32,
        });
    }

    pool.close().await;
    Ok(AnkiImport { note_types, decks, notes, cards, media: Vec::new() })
}

fn parse_models(models: &Value) -> Vec<AnkiNoteType> {
    let Some(map) = models.as_object() else { return Vec::new() };
    let mut out = Vec::new();
    for (id, model) in map {
        let fields = model["flds"]
            .as_array()
            .map(|a| a.iter().filter_map(|f| f["name"].as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        let templates = model["tmpls"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|t| AnkiTemplate {
                        name: t["name"].as_str().unwrap_or("").to_string(),
                        qfmt: t["qfmt"].as_str().unwrap_or("").to_string(),
                        afmt: t["afmt"].as_str().unwrap_or("").to_string(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        out.push(AnkiNoteType {
            id: id.clone(),
            name: model["name"].as_str().unwrap_or("Note Type").to_string(),
            fields,
            templates,
            css: model["css"].as_str().unwrap_or("").to_string(),
            cloze: model["type"].as_i64() == Some(1),
        });
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn parse_decks(decks: &Value) -> Vec<AnkiDeck> {
    let Some(map) = decks.as_object() else { return Vec::new() };
    let mut out: Vec<AnkiDeck> = map
        .iter()
        .filter_map(|(id, deck)| {
            let name = deck["name"].as_str()?.to_string();
            Some(AnkiDeck { id: id.clone(), name })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

/* ── Export ───────────────────────────────────────────────────────────────── */

/// Build an `.apkg` (legacy schema 11) from a Cardo-shaped collection.
pub async fn export_apkg(collection: &AnkiImport) -> Result<Vec<u8>, String> {
    let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
    let db_path = dir.path().join("collection.anki2");
    write_collection(&db_path, collection).await?;
    let db_bytes = std::fs::read(&db_path).map_err(|e| e.to_string())?;

    let mut buf = Vec::new();
    {
        let mut zip = zip::ZipWriter::new(Cursor::new(&mut buf));
        let opts: zip::write::FileOptions<()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);

        zip.start_file("collection.anki2", opts).map_err(|e| e.to_string())?;
        zip.write_all(&db_bytes).map_err(|e| e.to_string())?;

        let mut media_map = serde_json::Map::new();
        for (i, m) in collection.media.iter().enumerate() {
            let number = i.to_string();
            media_map.insert(number.clone(), Value::String(m.name.clone()));
            let data = b64_decode(&m.data_base64).ok_or("bad media base64")?;
            zip.start_file(&number, opts).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
        }
        zip.start_file("media", opts).map_err(|e| e.to_string())?;
        zip.write_all(Value::Object(media_map).to_string().as_bytes()).map_err(|e| e.to_string())?;

        zip.finish().map_err(|e| e.to_string())?;
    }
    Ok(buf)
}

async fn write_collection(path: &std::path::Path, collection: &AnkiImport) -> Result<(), String> {
    let pool = open_sqlite(path, false).await?;

    for stmt in [
        "CREATE TABLE col (id integer primary key, crt integer, mod integer, scm integer, \
         ver integer, dty integer, usn integer, ls integer, conf text, models text, decks text, \
         dconf text, tags text)",
        "CREATE TABLE notes (id integer primary key, guid text, mid integer, mod integer, \
         usn integer, tags text, flds text, sfld text, csum integer, flags integer, data text)",
        "CREATE TABLE cards (id integer primary key, nid integer, did integer, ord integer, \
         mod integer, usn integer, type integer, queue integer, due integer, ivl integer, \
         factor integer, reps integer, lapses integer, left integer, odue integer, odid integer, \
         flags integer, data text)",
        "CREATE TABLE revlog (id integer primary key, cid integer, usn integer, ease integer, \
         ivl integer, lastIvl integer, factor integer, time integer, type integer)",
        "CREATE TABLE graves (usn integer, oid integer, type integer)",
    ] {
        sqlx::query(stmt).execute(&pool).await.map_err(|e| e.to_string())?;
    }

    let models = models_json(&collection.note_types);
    let decks = decks_json(&collection.decks);
    sqlx::query(
        "INSERT INTO col (id, crt, mod, scm, ver, dty, usn, ls, conf, models, decks, dconf, tags) \
         VALUES (1, 0, 0, 0, 11, 0, 0, 0, '{}', ?, ?, '{}', '{}')",
    )
    .bind(models.to_string())
    .bind(decks.to_string())
    .execute(&pool)
    .await
    .map_err(|e| e.to_string())?;

    for note in &collection.notes {
        let flds = note.fields.join(&FIELD_SEP.to_string());
        let sfld = note.fields.first().cloned().unwrap_or_default();
        let tags = format!(" {} ", note.tags.join(" "));
        sqlx::query(
            "INSERT INTO notes (id, guid, mid, mod, usn, tags, flds, sfld, csum, flags, data) \
             VALUES (?, ?, ?, 0, -1, ?, ?, ?, 0, 0, '')",
        )
        .bind(note.id.parse::<i64>().unwrap_or_default())
        .bind(&note.id)
        .bind(note.note_type_id.parse::<i64>().unwrap_or_default())
        .bind(tags)
        .bind(flds)
        .bind(sfld)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    for card in &collection.cards {
        sqlx::query(
            "INSERT INTO cards (id, nid, did, ord, mod, usn, type, queue, due, ivl, factor, \
             reps, lapses, left, odue, odid, flags, data) \
             VALUES (?, ?, ?, ?, 0, -1, ?, ?, 0, ?, ?, ?, ?, 0, 0, 0, 0, '')",
        )
        .bind(card.id.parse::<i64>().unwrap_or_default())
        .bind(card.note_id.parse::<i64>().unwrap_or_default())
        .bind(card.deck_id.parse::<i64>().unwrap_or_default())
        .bind(card.ord)
        .bind(type_from_phase(&card.phase))
        .bind(type_from_phase(&card.phase)) // queue mirrors type for our purposes
        .bind(card.interval_days as i64)
        .bind((card.ease * 1000.0) as i64)
        .bind(card.reps as i64)
        .bind(card.lapses as i64)
        .execute(&pool)
        .await
        .map_err(|e| e.to_string())?;
    }

    pool.close().await;
    Ok(())
}

fn models_json(note_types: &[AnkiNoteType]) -> Value {
    let mut map = serde_json::Map::new();
    for nt in note_types {
        map.insert(
            nt.id.clone(),
            json!({
                "id": nt.id.parse::<i64>().unwrap_or_default(),
                "name": nt.name,
                "type": if nt.cloze { 1 } else { 0 },
                "css": nt.css,
                "flds": nt.fields.iter().enumerate()
                    .map(|(i, name)| json!({ "name": name, "ord": i }))
                    .collect::<Vec<_>>(),
                "tmpls": nt.templates.iter().enumerate()
                    .map(|(i, t)| json!({ "name": t.name, "ord": i, "qfmt": t.qfmt, "afmt": t.afmt }))
                    .collect::<Vec<_>>(),
            }),
        );
    }
    Value::Object(map)
}

fn decks_json(decks: &[AnkiDeck]) -> Value {
    let mut map = serde_json::Map::new();
    for d in decks {
        map.insert(
            d.id.clone(),
            json!({ "id": d.id.parse::<i64>().unwrap_or_default(), "name": d.name }),
        );
    }
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> AnkiImport {
        AnkiImport {
            note_types: vec![AnkiNoteType {
                id: "1000".into(),
                name: "Basic".into(),
                fields: vec!["Front".into(), "Back".into()],
                templates: vec![AnkiTemplate {
                    name: "Card 1".into(),
                    qfmt: "{{Front}}".into(),
                    afmt: "{{FrontSide}}<hr>{{Back}}".into(),
                }],
                css: ".card{}".into(),
                cloze: false,
            }],
            decks: vec![AnkiDeck { id: "2000".into(), name: "Spanish::Verbs".into() }],
            notes: vec![AnkiNote {
                id: "3000".into(),
                note_type_id: "1000".into(),
                fields: vec!["hola".into(), "hallo".into()],
                tags: vec!["vocab".into(), "greeting".into()],
            }],
            cards: vec![AnkiCard {
                id: "4000".into(),
                note_id: "3000".into(),
                ord: 0,
                deck_id: "2000".into(),
                phase: "review".into(),
                interval_days: 12,
                ease: 2.6,
                reps: 3,
                lapses: 1,
            }],
            media: vec![AnkiMedia { name: "cat.jpg".into(), data_base64: b64_encode(b"\x89PNGdata") }],
        }
    }

    #[tokio::test]
    async fn export_then_import_roundtrips() {
        let original = sample();
        let bytes = export_apkg(&original).await.unwrap();
        let back = import_apkg(&bytes).await.unwrap();

        assert_eq!(back.note_types.len(), 1);
        let nt = &back.note_types[0];
        assert_eq!(nt.name, "Basic");
        assert_eq!(nt.fields, vec!["Front", "Back"]);
        assert_eq!(nt.templates[0].qfmt, "{{Front}}");

        assert_eq!(back.decks[0].name, "Spanish::Verbs");

        assert_eq!(back.notes[0].fields, vec!["hola", "hallo"]);
        assert_eq!(back.notes[0].tags, vec!["vocab", "greeting"]);

        let card = &back.cards[0];
        assert_eq!(card.phase, "review");
        assert_eq!(card.interval_days, 12);
        assert!((card.ease - 2.6).abs() < 1e-9);
        assert_eq!(card.reps, 3);
        assert_eq!(card.lapses, 1);

        assert_eq!(back.media[0].name, "cat.jpg");
        assert_eq!(b64_decode(&back.media[0].data_base64).unwrap(), b"\x89PNGdata");
    }

    #[tokio::test]
    async fn rejects_non_zip() {
        assert!(import_apkg(b"not a zip file").await.is_err());
    }

    #[tokio::test]
    async fn cloze_note_type_flag_survives() {
        let mut c = sample();
        c.note_types[0].cloze = true;
        let bytes = export_apkg(&c).await.unwrap();
        let back = import_apkg(&bytes).await.unwrap();
        assert!(back.note_types[0].cloze);
    }
}
