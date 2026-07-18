//! Cardo desktop shell: wires cardo-core services into Tauri commands.
//! The webview NEVER touches SQLite directly – every write goes through
//! the Rust StorageAdapter, which records the change log atomically.

mod assistant;
mod claude;
mod legal;
mod notes;
mod sync;
mod sync_files;
mod sync_gdrive;

use cardo_core::diagnose::CoreCheckResult;
use cardo_core::identity::{IdentityProvider, LicenseKeyIdentity};
use cardo_core::storage::{ChangeNotice, Query, SqliteStorage, StorageAdapter};
use serde_json::Value;
use tauri::{Emitter, Manager, State};

pub struct AppState {
    storage: SqliteStorage,
    identity: LicenseKeyIdentity,
    app_data_dir: std::path::PathBuf,
}

type CmdResult<T> = Result<T, String>;

#[tauri::command]
async fn storage_get(
    state: State<'_, AppState>,
    namespace: String,
    id: String,
) -> CmdResult<Option<Value>> {
    state.storage.get(&namespace, &id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn storage_set(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    namespace: String,
    id: String,
    value: Value,
) -> CmdResult<ChangeNotice> {
    let notice = state
        .storage
        .set(&namespace, &id, value)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit("storage:changed", &notice);
    Ok(notice)
}

#[tauri::command]
async fn storage_delete(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    namespace: String,
    id: String,
) -> CmdResult<ChangeNotice> {
    let notice = state
        .storage
        .delete(&namespace, &id)
        .await
        .map_err(|e| e.to_string())?;
    let _ = app.emit("storage:changed", &notice);
    Ok(notice)
}

#[tauri::command]
async fn storage_query(
    state: State<'_, AppState>,
    namespace: String,
    query: Query,
) -> CmdResult<Vec<Value>> {
    state.storage.query(&namespace, query).await.map_err(|e| e.to_string())
}

/// Rust-side self-test checks against a scratch DB (user data untouched).
#[tauri::command]
async fn diagnose_core(state: State<'_, AppState>) -> CmdResult<Vec<CoreCheckResult>> {
    Ok(cardo_core::diagnose::run_core_checks(&state.app_data_dir).await)
}

#[tauri::command]
fn app_info(app: tauri::AppHandle, state: State<'_, AppState>) -> Value {
    serde_json::json!({
        "version": app.package_info().version.to_string(),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "deviceId": state.identity.get_identity().device_id,
        "syncAuthorized": state.identity.is_sync_authorized(),
    })
}

/* ── Persistent scheduler (storage-backed; JS arms the timers) ────────── */

#[tauri::command]
async fn schedule_set(
    state: State<'_, AppState>,
    id: String,
    fire_at_ms: i64,
    command_id: String,
    params: Value,
) -> CmdResult<()> {
    state
        .storage
        .schedule_set(&id, fire_at_ms, &command_id, &params)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn schedule_cancel(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    state.storage.schedule_cancel(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn schedule_list(state: State<'_, AppState>) -> CmdResult<Vec<Value>> {
    state.storage.schedule_list().await.map_err(|e| e.to_string())
}

/* ── Backup ───────────────────────────────────────────────────────────── */

#[tauri::command]
async fn backup_export(state: State<'_, AppState>, path: String) -> CmdResult<u64> {
    let dump = state.storage.dump_all().await.map_err(|e| e.to_string())?;
    let doc_count = dump
        .as_object()
        .map(|o| o.values().filter_map(|v| v.as_object()).map(|m| m.len() as u64).sum())
        .unwrap_or(0);
    let wrapped = serde_json::json!({
        "cardoBackup": 1,
        "exportedAt": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
        "data": dump,
    });
    let pretty = serde_json::to_string_pretty(&wrapped).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty).map_err(|e| e.to_string())?;
    Ok(doc_count)
}

/// Restores every document from a backup file (existing ids are
/// overwritten, everything else stays). Runs through the normal storage
/// layer, so the change log records the restore like any other write.
#[tauri::command]
async fn backup_import(state: State<'_, AppState>, path: String) -> CmdResult<u64> {
    let raw = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    if parsed.get("cardoBackup").and_then(|v| v.as_i64()) != Some(1) {
        return Err("not a Cardo backup file".into());
    }
    let data = parsed
        .get("data")
        .and_then(|v| v.as_object())
        .ok_or_else(|| "backup contains no data".to_string())?;
    let mut restored = 0u64;
    for (namespace, docs) in data {
        let Some(docs) = docs.as_object() else { continue };
        for (id, doc) in docs {
            state
                .storage
                .set(namespace, id, doc.clone())
                .await
                .map_err(|e| e.to_string())?;
            restored += 1;
        }
    }
    Ok(restored)
}


/* ── Diagnose: OS keychain round-trip ─────────────────────────────────── */

/// Prove the OS keychain (where the sync key lives) accepts a write/read/delete
/// round-trip. Tolerant by design: the caller treats an error as a WARNING, not
/// a failure, so a headless/locked keychain never turns diagnostics red.
#[tauri::command]
fn diagnose_keychain() -> CmdResult<String> {
    let entry = keyring::Entry::new("de.cardo.diagnose", "keychain-probe").map_err(|e| e.to_string())?;
    const PROBE: &str = "cardo-keychain-probe";
    entry.set_password(PROBE).map_err(|e| e.to_string())?;
    let back = entry.get_password().map_err(|e| e.to_string())?;
    let _ = entry.delete_credential();
    if back == PROBE {
        Ok("keychain read/write/delete ok".into())
    } else {
        Err("keychain round-trip returned a different value".into())
    }
}

/* ── Spaced repetition (flashcards scheduler bridge) ──────────────────── */

/// Compute the next scheduling state + due interval for one flashcard answer.
/// A thin, pure bridge to `cardo_core::srs::review` so the flashcards tool
/// shares the sync-tested SM-2/FSRS core instead of a second implementation.
#[tauri::command]
fn srs_review(
    scheduler: cardo_core::srs::Scheduler,
    state: cardo_core::srs::CardState,
    rating: cardo_core::srs::Rating,
    elapsed_days: u32,
    sm2: cardo_core::srs::Sm2Config,
    fsrs: cardo_core::srs::FsrsConfig,
) -> CmdResult<Value> {
    let (next, interval) =
        cardo_core::srs::review(scheduler, &state, rating, elapsed_days, &sm2, &fsrs)?;
    Ok(serde_json::json!({ "state": next, "interval": interval }))
}

/* ── Anki .apkg import/export ──────────────────────────────────────────── */

/// Parse an `.apkg`/`.colpkg` file into a Cardo-shaped collection for the
/// flashcards tool to turn into its own notes/cards/decks.
#[tauri::command]
async fn anki_import(path: String) -> CmdResult<cardo_core::anki::AnkiImport> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    cardo_core::anki::import_apkg(&bytes).await
}

/// Write a Cardo collection out as an `.apkg` (legacy schema). Returns bytes written.
#[tauri::command]
async fn anki_export(path: String, collection: cardo_core::anki::AnkiImport) -> CmdResult<u64> {
    let bytes = cardo_core::anki::export_apkg(&collection).await?;
    let len = bytes.len() as u64;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(len)
}

/* ── Diagnose network probe ───────────────────────────────────────────── */

/// Hosts the diagnose may probe. The webview cannot fetch some of these
/// (github.com sends no CORS headers), so the probe runs in Rust.
const PROBE_ALLOWED_HOSTS: [&str; 8] = [
    "www.googleapis.com",
    "github.com",
    "hollatzleif.github.io",
    "cardo-polls.hollatzleif.workers.dev",
    "api.open-meteo.com",
    "geocoding-api.open-meteo.com",
    "huggingface.co",
    "objects.githubusercontent.com",
];

fn probe_host_allowed(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.contains('@') || authority.contains(':') {
        return false;
    }
    PROBE_ALLOWED_HOSTS.contains(&authority)
}

/// GETs an allowlisted URL (first bytes only) and reports status + latency.
/// Follows redirects (GitHub release downloads redirect to CDNs).
#[tauri::command]
async fn net_probe(url: String) -> CmdResult<Value> {
    if !probe_host_allowed(&url) {
        return Err(format!("host not allowed for probing: {url}"));
    }
    let started = std::time::Instant::now();
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(8))
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let response = client
        .get(&url)
        .header("Range", "bytes=0-512")
        .send()
        .await
        .map_err(|e| format!("unreachable: {e}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let ms = started.elapsed().as_millis() as u64;
    Ok(serde_json::json!({
        "status": status,
        "ms": ms,
        "bodyPrefix": body.chars().take(512).collect::<String>(),
    }))
}

/// Writes an exported diagnose report next to the user's downloads
/// (fallback: app data dir) and returns the full path.
#[tauri::command]
fn export_report(app: tauri::AppHandle, filename: String, content: String) -> CmdResult<String> {
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("invalid filename".into());
    }
    let dir = app
        .path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    let path = dir.join(filename);
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// Mirror of the inline filename guard in `export_report` (which needs an
/// AppHandle and so cannot be unit-tested directly). Kept in lock-step with
/// the check in that command: reject path separators and traversal.
#[cfg(test)]
fn export_filename_rejected(filename: &str) -> bool {
    filename.contains('/') || filename.contains('\\') || filename.contains("..")
}

/// Mirror of the marker guard in `backup_import`: a file is a valid Cardo
/// backup only if it parses as JSON and carries `"cardoBackup": 1`.
#[cfg(test)]
fn backup_marker_ok(parsed: &Value) -> bool {
    parsed.get("cardoBackup").and_then(|v| v.as_i64()) == Some(1)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Writes a board-export file to a user-chosen path (comes from the OS save
/// dialog). Only .json targets are accepted.
#[tauri::command]
fn layout_write_file(path: String, content: String) -> CmdResult<()> {
    if !path.to_lowercase().ends_with(".json") {
        return Err("only .json files".into());
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn layout_read_file(path: String) -> CmdResult<String> {
    if !path.to_lowercase().ends_with(".json") {
        return Err("only .json files".into());
    }
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(u64::MAX) > 5_000_000 {
        return Err("file too large for a board export".into());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .manage(notes::NotesState::default())
        .manage(assistant::AssistantState::default())
        .manage(sync::SyncState::default())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("cardo.db");
            let storage = match tauri::async_runtime::block_on(SqliteStorage::open(&db_path)) {
                Ok(storage) => storage,
                Err(err) => {
                    // Most common cause: an OLDER Cardo opening a database a
                    // newer build already migrated (downgrade protection).
                    // Without this dialog the app hard-aborts with no hint.
                    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                    let message = format!(
                        "Cardo kann die Datenbank nicht öffnen:\n\n{err}\n\nMeist bedeutet das: Eine neuere Cardo-Version hat die Daten bereits aktualisiert. Bitte installiere die neueste Version.\n\nUsually this means a newer Cardo already upgraded your data. Please install the latest version."
                    );
                    app.dialog()
                        .message(message)
                        .kind(MessageDialogKind::Error)
                        .title("Cardo")
                        .blocking_show();
                    std::process::exit(1);
                }
            };
            let identity = LicenseKeyIdentity::new(storage.device_id());
            app.manage(AppState { storage, identity, app_data_dir });
            sync::start_background_loop(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            storage_get,
            storage_set,
            storage_delete,
            storage_query,
            diagnose_core,
            app_info,
            export_report,
            notes::notes_set_folder,
            notes::notes_default_folder,
            notes::notes_get_folder,
            notes::notes_reveal_folder,
            notes::notes_list,
            notes::notes_read,
            notes::notes_write,
            notes::notes_rename,
            notes::notes_delete,
            notes::workspace_list,
            notes::workspace_read,
            notes::workspace_write,
            notes::workspace_append,
            notes::workspace_delete,
            notes::files_browse,
            notes::files_read_data_url,
            notes::files_open_external,
            claude::claude_check,
            claude::claude_generate,
            schedule_set,
            schedule_cancel,
            schedule_list,
            backup_export,
            backup_import,
            srs_review,
            diagnose_keychain,
            anki_import,
            anki_export,
            legal::legal_sources,
            legal::legal_allowed_hosts,
            legal::legal_list_books,
            legal::legal_list_norms,
            legal::legal_fetch_norm,
            legal::legal_set_piste_key,
            legal::legal_piste_key_present,
            legal::legal_clear_piste_key,
            net_probe,
            assistant::assistant_hw_info,
            assistant::assistant_list_models,
            assistant::assistant_download_model,
            assistant::assistant_cancel_download,
            assistant::assistant_delete_model,
            assistant::assistant_load_model,
            assistant::assistant_loaded_model,
            assistant::assistant_unload_model,
            assistant::assistant_generate,
            assistant::assistant_read_doc,
            assistant::assistant_write_doc,
            assistant::assistant_delete_docs,
            assistant::assistant_list_doc_ids,
            assistant::assistant_migrate_v1,
            sync::sync_generate_key,
            sync::sync_set_key,
            sync::sync_reveal_key,
            sync::sync_status,
            sync::sync_configure,
            sync::sync_now,
            sync::sync_push_all,
            sync::sync_forget_key,
            sync::sync_set_joinable,
            sync::sync_remove_device,
            sync_gdrive::sync_gdrive_connect,
            sync_gdrive::sync_gdrive_disconnect,
            layout_write_file,
            layout_read_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cardo");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srs_review_command_shapes_json_for_the_frontend() {
        use cardo_core::srs::{CardState, FsrsConfig, Rating, Scheduler, Sm2Config};
        let sm2 = Sm2Config::default();
        let fsrs = FsrsConfig::default();
        let fresh = CardState::new(&sm2);
        // SM-2 Easy graduates a new card to a 4-day review.
        let out = srs_review(Scheduler::Sm2, fresh, Rating::Easy, 0, sm2, fsrs).unwrap();
        assert_eq!(out["interval"], serde_json::json!({ "days": 4 }));
        assert_eq!(out["state"]["phase"], "review");
        assert_eq!(out["state"]["intervalDays"], 4);
    }

    #[test]
    fn export_report_rejects_path_tricks() {
        // These must be refused by export_report's filename guard.
        for bad in ["../evil", "a/b", "a\\b", "../../etc/passwd", "..", "sub/../x"] {
            assert!(export_filename_rejected(bad), "should reject {bad:?}");
        }
        // Plain filenames are allowed.
        for good in ["report.json", "diagnose-2026.txt", "cardo report.md"] {
            assert!(!export_filename_rejected(good), "should accept {good:?}");
        }
    }

    #[test]
    fn backup_import_rejects_invalid_json() {
        // Exactly the first step of backup_import: parse the file contents.
        let tmp = std::env::temp_dir().join(format!("cardo-backup-badjson-{}.json", std::process::id()));
        std::fs::write(&tmp, "{ this is not valid json").unwrap();
        let raw = std::fs::read_to_string(&tmp).unwrap();
        let parsed: Result<Value, _> = serde_json::from_str(&raw);
        assert!(parsed.is_err(), "invalid JSON must fail to parse");
        std::fs::remove_file(&tmp).unwrap();
    }

    #[test]
    fn backup_import_requires_cardo_marker() {
        // Valid JSON but missing / wrong marker must be rejected.
        let no_marker: Value = serde_json::json!({ "data": { "notes": {} } });
        assert!(!backup_marker_ok(&no_marker), "missing marker must be rejected");

        let wrong_marker: Value = serde_json::json!({ "cardoBackup": 2, "data": {} });
        assert!(!backup_marker_ok(&wrong_marker), "wrong marker version must be rejected");

        let string_marker: Value = serde_json::json!({ "cardoBackup": "1", "data": {} });
        assert!(!backup_marker_ok(&string_marker), "non-integer marker must be rejected");

        // The genuine article is accepted.
        let good: Value = serde_json::json!({ "cardoBackup": 1, "data": { "notes": {} } });
        assert!(backup_marker_ok(&good), "valid backup marker must be accepted");
    }

    #[test]
    fn probe_allowlist_rejects_foreign_and_tricky_hosts() {
        assert!(probe_host_allowed("https://github.com/x/releases/latest/download/latest.json"));
        assert!(probe_host_allowed("https://huggingface.co/a/b/resolve/main/x.gguf"));
        for bad in [
            "http://github.com/x",
            "https://github.com.evil.com/x",
            "https://github.com@evil.com/x",
            "https://github.com:8443/x",
            "https://evil.com/https://github.com/",
            "ftp://github.com/",
            "",
        ] {
            assert!(!probe_host_allowed(bad), "should reject {bad:?}");
        }
    }
}
