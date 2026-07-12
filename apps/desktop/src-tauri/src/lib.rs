//! Cardo desktop shell: wires cardo-core services into Tauri commands.
//! The webview NEVER touches SQLite directly – every write goes through
//! the Rust StorageAdapter, which records the change log atomically.

mod notes;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
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
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_dir)?;
            let db_path = app_data_dir.join("cardo.db");
            let storage = tauri::async_runtime::block_on(SqliteStorage::open(&db_path))?;
            let identity = LicenseKeyIdentity::new(storage.device_id());
            app.manage(AppState { storage, identity, app_data_dir });
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
            notes::notes_list,
            notes::notes_read,
            notes::notes_write,
            notes::notes_rename,
            notes::notes_delete,
            schedule_set,
            schedule_cancel,
            schedule_list,
            backup_export,
            backup_import,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cardo");
}
