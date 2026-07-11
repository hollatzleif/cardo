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
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Cardo");
}
