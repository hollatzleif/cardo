//! Sync wiring: key in the OS keychain, transport config as a local file
//! (NEVER in the synced database), a background interval loop, and the
//! Tauri commands the settings UI + assistant talk to.
//!
//! Zero-knowledge principle: whatever backend is configured only ever sees
//! encrypted `EncryptedOp` blobs produced by cardo-core's SyncEngine.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use cardo_core::sync::SyncTransport;
use cardo_core::{FolderTransport, SqliteStorage, StorageAdapter, SyncEngine, SyncKey, SyncReport};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, Manager, State};

use crate::AppState;

const KEYCHAIN_SERVICE: &str = "de.cardo.sync";
const KEYCHAIN_KEY_ENTRY: &str = "sync-key";
const KEYCHAIN_WEBDAV_ENTRY: &str = "webdav-password";
const CONFIG_FILE: &str = "sync-config.json";
/// Spec: a key ships with 10 device slots by default.
const DEVICE_SLOTS: usize = 10;
/// Device registry doc – lives in the DB on purpose: it syncs itself.
const DEVICES_NS: &str = "core";
const DEVICES_DOC: &str = "sync-devices";
/// Namespaces that never leave the device unless opted in.
const LAYOUT_NS: &str = "core.layout";

pub struct SyncState {
    inner: Mutex<Option<SyncConfig>>,
    /// Set once the background loop is running (one per app run).
    loop_started: Mutex<bool>,
}

impl Default for SyncState {
    fn default() -> Self {
        Self { inner: Mutex::new(None), loop_started: Mutex::new(false) }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncConfig {
    /// Per-device master switch – spec: default OFF.
    #[serde(default)]
    pub enabled: bool,
    /// "folder" | "webdav" | "gdrive"
    #[serde(default)]
    pub transport: String,
    #[serde(default)]
    pub folder_path: Option<String>,
    #[serde(default)]
    pub webdav_url: Option<String>,
    #[serde(default)]
    pub webdav_user: Option<String>,
    /// Opt-in: dashboard layouts differ per device size (spec default off).
    #[serde(default)]
    pub sync_layouts: bool,
    /// Unix ms of the last successful round (display only).
    #[serde(default)]
    pub last_sync_ms: Option<i64>,
    /// The user confirmed the mandatory trust warning.
    #[serde(default)]
    pub trust_confirmed: bool,
    /// Joining is allowed: the key may be revealed (QR/copy) so NEW devices
    /// can enter it. Devices that already joined are unaffected by turning
    /// this off. Default ON – the freshly generated key must be shareable.
    #[serde(default = "default_true")]
    pub key_joinable: bool,
    /// This device generated the key (it manages the device list / kicks).
    #[serde(default)]
    pub key_origin: bool,
    /// This device was kicked via a revocation record (UI shows a banner).
    #[serde(default)]
    pub kicked: bool,
    /// Joining was denied by the group's join policy (banner + retry hint).
    #[serde(default)]
    pub join_denied: bool,
}

fn default_true() -> bool {
    true
}

fn config_path(app_data_dir: &std::path::Path) -> PathBuf {
    app_data_dir.join(CONFIG_FILE)
}

fn load_config(app_data_dir: &std::path::Path) -> SyncConfig {
    std::fs::read(config_path(app_data_dir))
        .ok()
        .and_then(|raw| serde_json::from_slice(&raw).ok())
        .unwrap_or_default()
}

fn save_config(app_data_dir: &std::path::Path, config: &SyncConfig) -> Result<(), String> {
    let raw = serde_json::to_vec_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(config_path(app_data_dir), raw).map_err(|e| e.to_string())
}

fn config_of(state: &State<'_, SyncState>, app_data_dir: &std::path::Path) -> SyncConfig {
    let mut guard = state.inner.lock().expect("sync config lock");
    if guard.is_none() {
        *guard = Some(load_config(app_data_dir));
    }
    guard.clone().expect("just initialised")
}

fn store_config(
    state: &State<'_, SyncState>,
    app_data_dir: &std::path::Path,
    config: SyncConfig,
) -> Result<(), String> {
    save_config(app_data_dir, &config)?;
    *state.inner.lock().expect("sync config lock") = Some(config);
    Ok(())
}

/* ── Keychain ─────────────────────────────────────────────────────────── */

fn keychain_entry(name: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, name).map_err(|e| e.to_string())
}

fn stored_key() -> Result<Option<SyncKey>, String> {
    match keychain_entry(KEYCHAIN_KEY_ENTRY)?.get_password() {
        Ok(secret) => SyncKey::parse(&secret).map(Some).map_err(|e| e.to_string()),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

fn store_key(display: &str) -> Result<(), String> {
    keychain_entry(KEYCHAIN_KEY_ENTRY)?.set_password(display).map_err(|e| e.to_string())
}

fn forget_key() -> Result<(), String> {
    match keychain_entry(KEYCHAIN_KEY_ENTRY)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/* ── WebDAV transport ─────────────────────────────────────────────────── */

/// Minimal WebDAV carrier mirroring the folder transport's batch-file shape:
/// one JSON file per pushed batch under `<base>/cardo-sync/ops/`, cursor =
/// last processed filename (they sort chronologically).
pub struct WebDavTransport {
    client: reqwest::Client,
    base: String,
    user: String,
    password: String,
}

impl WebDavTransport {
    pub fn new(base: &str, user: &str, password: &str) -> Result<Self, String> {
        let base = base.trim_end_matches('/').to_string();
        if !base.starts_with("https://") && !base.starts_with("http://") {
            return Err("WebDAV URL must start with http(s)://".into());
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .build()
                .map_err(|e| e.to_string())?,
            base,
            user: user.to_string(),
            password: password.to_string(),
        })
    }

    fn ops_url(&self, name: &str) -> String {
        format!("{}/cardo-sync/ops/{name}", self.base)
    }

    async fn ensure_dirs(&self) -> Result<(), String> {
        for dir in ["cardo-sync", "cardo-sync/ops"] {
            let _ = self
                .client
                .request(
                    reqwest::Method::from_bytes(b"MKCOL").expect("MKCOL is a valid method"),
                    format!("{}/{dir}", self.base),
                )
                .basic_auth(&self.user, Some(&self.password))
                .send()
                .await; // 405 when it already exists – fine.
        }
        Ok(())
    }

    async fn list_names(&self) -> Result<Vec<String>, String> {
        let response = self
            .client
            .request(
                reqwest::Method::from_bytes(b"PROPFIND").expect("PROPFIND is a valid method"),
                format!("{}/cardo-sync/ops/", self.base),
            )
            .header("Depth", "1")
            .basic_auth(&self.user, Some(&self.password))
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() && response.status().as_u16() != 207 {
            return Err(format!("WebDAV list failed: HTTP {}", response.status()));
        }
        let body = response.text().await.map_err(|e| e.to_string())?;
        // Tolerant href scan instead of a full XML parser: we only need the
        // filenames of our own `.cardo-ops` batch files.
        let mut names: Vec<String> = body
            .split("<D:href>")
            .chain(body.split("<d:href>"))
            .filter_map(|part| part.split('<').next())
            .filter_map(|href| href.rsplit('/').next().map(str::to_string))
            .filter(|name| name.ends_with(".cardo-ops"))
            .collect();
        names.sort();
        names.dedup();
        Ok(names)
    }
}

#[async_trait::async_trait]
impl SyncTransport for WebDavTransport {
    async fn push(
        &self,
        ops: Vec<cardo_core::sync::EncryptedOp>,
    ) -> cardo_core::Result<cardo_core::sync::PushAck> {
        if ops.is_empty() {
            return Ok(cardo_core::sync::PushAck { accepted: 0 });
        }
        self.ensure_dirs().await.map_err(cardo_core::CoreError::Other)?;
        let batch = json!({
            "version": 1,
            "ops": ops.iter().map(|op| json!({
                "op_id": op.op_id,
                "blob_b64": b64_public(&op.blob),
            })).collect::<Vec<_>>(),
        });
        let name = format!(
            "{:013}-{}.cardo-ops",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0),
            uuid::Uuid::new_v4()
        );
        let response = self
            .client
            .put(self.ops_url(&name))
            .basic_auth(&self.user, Some(&self.password))
            .body(batch.to_string())
            .send()
            .await
            .map_err(|e| cardo_core::CoreError::Other(e.to_string()))?;
        if !response.status().is_success() {
            return Err(cardo_core::CoreError::Other(format!(
                "WebDAV push failed: HTTP {}",
                response.status()
            )));
        }
        Ok(cardo_core::sync::PushAck { accepted: ops.len() })
    }

    async fn pull(
        &self,
        since: cardo_core::sync::Cursor,
    ) -> cardo_core::Result<cardo_core::sync::PullBatch> {
        self.ensure_dirs().await.map_err(cardo_core::CoreError::Other)?;
        let names = self.list_names().await.map_err(cardo_core::CoreError::Other)?;
        let mut ops = Vec::new();
        let mut cursor = since.clone();
        for name in names.into_iter().filter(|n| n.as_str() > since.as_str()).take(50) {
            let response = self
                .client
                .get(self.ops_url(&name))
                .basic_auth(&self.user, Some(&self.password))
                .send()
                .await
                .map_err(|e| cardo_core::CoreError::Other(e.to_string()))?;
            if !response.status().is_success() {
                return Err(cardo_core::CoreError::Other(format!(
                    "WebDAV pull failed: HTTP {}",
                    response.status()
                )));
            }
            let body: Value = response
                .json()
                .await
                .map_err(|e| cardo_core::CoreError::Other(e.to_string()))?;
            for op in body["ops"].as_array().into_iter().flatten() {
                let (Some(op_id), Some(blob_b64)) = (op["op_id"].as_str(), op["blob_b64"].as_str())
                else {
                    continue;
                };
                let Some(blob) = b64_decode_public(blob_b64) else { continue };
                ops.push(cardo_core::sync::EncryptedOp { op_id: op_id.to_string(), blob });
            }
            cursor = name;
        }
        Ok(cardo_core::sync::PullBatch { ops, next_cursor: cursor })
    }
}

pub(crate) fn b64_public(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

pub(crate) fn b64_decode_public(text: &str) -> Option<Vec<u8>> {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let cleaned: Vec<u8> = text.bytes().filter(|&b| b != b'=').collect();
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    for chunk in cleaned.chunks(4) {
        let mut n: u32 = 0;
        for &c in chunk {
            n = (n << 6) | T.iter().position(|&a| a == c)? as u32;
        }
        match chunk.len() {
            4 => out.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8, n as u8]),
            3 => out.extend_from_slice(&[(n >> 10) as u8, (n >> 2) as u8]),
            2 => out.push((n >> 4) as u8),
            _ => return None,
        }
    }
    Some(out)
}

/* ── Engine plumbing ──────────────────────────────────────────────────── */

fn build_transport(config: &SyncConfig) -> Result<Box<dyn SyncTransport>, String> {
    // Configs written before a transport was ever picked carry "" – treat it
    // as the folder default exactly like the UI does.
    match config.transport.as_str() {
        "" | "folder" => {
            let path = config.folder_path.as_deref().ok_or("no sync folder configured")?;
            Ok(Box::new(FolderTransport::new(path).map_err(|e| e.to_string())?))
        }
        "webdav" => {
            let url = config.webdav_url.as_deref().ok_or("no WebDAV URL configured")?;
            let user = config.webdav_user.as_deref().unwrap_or_default();
            let password = match keychain_entry(KEYCHAIN_WEBDAV_ENTRY)?.get_password() {
                Ok(p) => p,
                Err(keyring::Error::NoEntry) => String::new(),
                Err(e) => return Err(e.to_string()),
            };
            Ok(Box::new(WebDavTransport::new(url, user, &password)?))
        }
        "gdrive" => crate::sync_gdrive::build_transport(),
        other => Err(format!("unknown sync transport \"{other}\"")),
    }
}

fn transport_cursor_id(config: &SyncConfig) -> String {
    match config.transport.as_str() {
        "" | "folder" => format!("folder:{}", config.folder_path.as_deref().unwrap_or_default()),
        "webdav" => format!("webdav:{}", config.webdav_url.as_deref().unwrap_or_default()),
        other => other.to_string(),
    }
}

async fn upsert_own_device(storage: &SqliteStorage, device_name: &str) -> Result<(), String> {
    let device_id = storage.device_id().to_string();
    let mut doc = storage
        .get(DEVICES_NS, DEVICES_DOC)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| json!({ "devices": [] }));
    let devices = doc["devices"].as_array().cloned().unwrap_or_default();
    let mut devices: Vec<Value> =
        devices.into_iter().filter(|d| d["deviceId"].as_str() != Some(&device_id)).collect();
    if devices.len() >= DEVICE_SLOTS {
        return Err(format!("all {DEVICE_SLOTS} device slots are in use"));
    }
    devices.push(json!({
        "deviceId": device_id,
        "name": device_name,
        "lastSeenMs": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    }));
    doc["devices"] = Value::Array(devices);
    storage.set(DEVICES_NS, DEVICES_DOC, doc).await.map_err(|e| e.to_string())?;
    Ok(())
}

async fn run_sync_round(
    app: &tauri::AppHandle,
    device_name: &str,
) -> Result<SyncReport, String> {
    let app_state: State<'_, AppState> = app.state();
    let sync_state: State<'_, SyncState> = app.state();
    let config = config_of(&sync_state, &app_state.app_data_dir);
    if !config.enabled {
        return Err("sync is disabled on this device".into());
    }
    if !config.trust_confirmed {
        return Err("trust warning not confirmed yet".into());
    }
    let key = stored_key()?.ok_or("no sync key stored")?;
    let derived = key.derive();

    let transport = build_transport(&config)?;
    let mut excluded = Vec::new();
    if !config.sync_layouts {
        excluded.push(LAYOUT_NS.to_string());
    }
    let engine = SyncEngine::new(&app_state.storage, &derived.data_key, transport_cursor_id(&config))
        .with_excluded_namespaces(excluded);

    // Pull FIRST: brings the group's join policy + device registry + any
    // revocations onto this device before it writes anything to the hub.
    let mut report = engine.pull_once(transport.as_ref()).await.map_err(|e| e.to_string())?;

    // Join gate: a device that is not yet part of the group may only enter
    // while the join policy is open. Having the key alone is NOT enough –
    // the origin device can close the group at any time. Already-registered
    // devices pass regardless (they keep syncing when joining is off).
    let own_id = app_state.storage.device_id().to_string();
    let is_member = app_state
        .storage
        .get(DEVICES_NS, DEVICES_DOC)
        .await
        .map_err(|e| e.to_string())?
        .and_then(|doc| doc["devices"].as_array().cloned())
        .map(|devices| devices.iter().any(|d| d["deviceId"].as_str() == Some(own_id.as_str())))
        .unwrap_or(false);
    if !is_member && !config.key_origin {
        let join_open = app_state
            .storage
            .get(CONTROL_NS, "join-policy")
            .await
            .map_err(|e| e.to_string())?
            .map(|doc| doc["open"].as_bool().unwrap_or(true))
            .unwrap_or(true); // no policy record yet = open group
        if !join_open {
            let mut updated = config;
            updated.enabled = false;
            updated.join_denied = true;
            store_config(&sync_state, &app_state.app_data_dir, updated)?;
            let _ = app.emit("sync:join-denied", ());
            return Err("joining this sync group is currently disabled".into());
        }
    }

    if !config.key_origin {
        let join_open = app_state
            .storage
            .get(CONTROL_NS, "join-policy")
            .await
            .map_err(|e| e.to_string())?
            .map(|doc| doc["open"].as_bool().unwrap_or(true))
            .unwrap_or(true);
        if config.key_joinable != join_open {
            let mut mirrored = config_of(&sync_state, &app_state.app_data_dir);
            mirrored.key_joinable = join_open;
            store_config(&sync_state, &app_state.app_data_dir, mirrored)?;
        }
    }

    upsert_own_device(&app_state.storage, device_name).await?;
    let push_report = engine.push_once(transport.as_ref()).await.map_err(|e| e.to_string())?;
    report.pushed = push_report.pushed;

    // Refresh the UI exactly like local writes do.
    for notice in &report.notices {
        let _ = app.emit("storage:changed", notice);
    }
    let _ = app.emit("sync:done", &report);

    // Honor revocation records: kicked devices (or a dissolved group) stop
    // syncing on their next round.
    let own_id = app_state.storage.device_id().to_string();
    let revoked_all = app_state
        .storage
        .get(CONTROL_NS, "revoke-all")
        .await
        .map_err(|e| e.to_string())?
        .map(|doc| doc["issuedBy"].as_str().map(str::to_string))
        .is_some();
    let revoked_me = app_state
        .storage
        .get(CONTROL_NS, &format!("revoke-{own_id}"))
        .await
        .map_err(|e| e.to_string())?
        .is_some();
    if revoked_all || revoked_me {
        let mut updated = config_of(&sync_state, &app_state.app_data_dir);
        // The origin that dissolved the group already handled itself.
        if !updated.key_origin {
            updated.enabled = false;
            updated.kicked = true;
            store_config(&sync_state, &app_state.app_data_dir, updated)?;
            let _ = app.emit("sync:revoked", revoked_all);
            return Ok(report);
        }
    }

    let mut updated = config;
    updated.join_denied = false;
    updated.last_sync_ms = Some(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0),
    );
    store_config(&sync_state, &app_state.app_data_dir, updated)?;
    Ok(report)
}

/// Interval loop: every 5 minutes while enabled. Started once at setup.
pub fn start_background_loop(app: tauri::AppHandle) {
    let state: State<'_, SyncState> = app.state();
    {
        let mut started = state.loop_started.lock().expect("loop flag");
        if *started {
            return;
        }
        *started = true;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_secs(300)).await;
            let enabled = {
                let app_state: State<'_, AppState> = app.state();
                let sync_state: State<'_, SyncState> = app.state();
                config_of(&sync_state, &app_state.app_data_dir).enabled
            };
            if enabled {
                if let Err(err) = run_sync_round(&app, &device_label()).await {
                    let _ = app.emit("sync:error", err);
                }
            }
        }
    });
}

fn device_label() -> String {
    sysinfo::System::host_name().unwrap_or_else(|| "Cardo device".into())
}

/* ── Tauri commands ───────────────────────────────────────────────────── */

type CmdResult<T> = Result<T, String>;

#[tauri::command]
pub fn sync_generate_key(
    app_state: State<'_, AppState>,
    sync_state: State<'_, SyncState>,
) -> CmdResult<String> {
    if stored_key()?.is_some() {
        return Err("a sync key already exists on this device".into());
    }
    let key = SyncKey::generate().map_err(|e| e.to_string())?;
    let display = key.display();
    store_key(&display)?;
    // The generating device manages the sync group (device list, kicks).
    let mut config = config_of(&sync_state, &app_state.app_data_dir);
    config.key_origin = true;
    config.key_joinable = true;
    config.kicked = false;
    store_config(&sync_state, &app_state.app_data_dir, config)?;
    Ok(display)
}

#[tauri::command]
pub fn sync_set_key(
    app_state: State<'_, AppState>,
    sync_state: State<'_, SyncState>,
    key: String,
) -> CmdResult<()> {
    let parsed = SyncKey::parse(&key).map_err(|e| e.to_string())?;
    store_key(&parsed.display())?;
    let mut config = config_of(&sync_state, &app_state.app_data_dir);
    config.key_origin = false;
    config.kicked = false;
    store_config(&sync_state, &app_state.app_data_dir, config)
}

/// The key leaves the keychain ONLY for explicit user display (QR/copy) –
/// and only while joining is enabled (the join toggle gates sharing).
#[tauri::command]
pub fn sync_reveal_key(
    app_state: State<'_, AppState>,
    sync_state: State<'_, SyncState>,
) -> CmdResult<Option<String>> {
    let config = config_of(&sync_state, &app_state.app_data_dir);
    if !config.key_joinable {
        return Err("joining is disabled – enable it to share the key".into());
    }
    Ok(stored_key()?.map(|k| k.display()))
}

/// Join toggle: ON = new devices may join the group (and the key may be
/// revealed). OFF = the KEY ITSELF stops admitting new devices – even
/// someone who already knows the key string cannot join; the policy record
/// syncs encrypted through the hub and every honest client checks it before
/// registering. Devices that already joined keep syncing either way.
#[tauri::command]
pub async fn sync_set_joinable(
    app_state: State<'_, AppState>,
    sync_state: State<'_, SyncState>,
    joinable: bool,
) -> CmdResult<()> {
    let mut config = config_of(&sync_state, &app_state.app_data_dir);
    config.key_joinable = joinable;
    store_config(&sync_state, &app_state.app_data_dir, config)?;
    // The enforced group policy (synced, encrypted like everything else).
    app_state
        .storage
        .set(CONTROL_NS, "join-policy", json!({ "type": "join-policy", "open": joinable }))
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn sync_status(
    app_state: State<'_, AppState>,
    sync_state: State<'_, SyncState>,
) -> CmdResult<Value> {
    let config = config_of(&sync_state, &app_state.app_data_dir);
    let key = stored_key()?;
    let devices = app_state
        .storage
        .get(DEVICES_NS, DEVICES_DOC)
        .await
        .map_err(|e| e.to_string())?
        .and_then(|doc| doc["devices"].as_array().cloned())
        .unwrap_or_default();
    let unsynced = app_state.storage.unsynced_op_count().await.map_err(|e| e.to_string())?;
    Ok(json!({
        "hasKey": key.is_some(),
        "licenseId": key.map(|k| k.derive().license_id),
        "deviceId": app_state.storage.device_id(),
        "deviceName": device_label(),
        "enabled": config.enabled,
        "trustConfirmed": config.trust_confirmed,
        "transport": config.transport,
        "folderPath": config.folder_path,
        "webdavUrl": config.webdav_url,
        "webdavUser": config.webdav_user,
        "syncLayouts": config.sync_layouts,
        "keyJoinable": config.key_joinable,
        "keyOrigin": config.key_origin,
        "kicked": config.kicked,
        "joinDenied": config.join_denied,
        "lastSyncMs": config.last_sync_ms,
        "unsyncedOps": unsynced,
        "devices": devices,
        "deviceSlots": DEVICE_SLOTS,
        "gdriveConnected": crate::sync_gdrive::is_connected(),
    }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigureArgs {
    pub enabled: bool,
    pub transport: String,
    pub folder_path: Option<String>,
    pub webdav_url: Option<String>,
    pub webdav_user: Option<String>,
    pub webdav_password: Option<String>,
    pub sync_layouts: bool,
    pub trust_confirmed: bool,
}

#[tauri::command]
pub fn sync_configure(
    app_state: State<'_, AppState>,
    sync_state: State<'_, SyncState>,
    args: ConfigureArgs,
) -> CmdResult<()> {
    if args.enabled && !args.trust_confirmed {
        return Err("the trust warning must be confirmed before enabling sync".into());
    }
    if let Some(password) = &args.webdav_password {
        if !password.is_empty() {
            keychain_entry(KEYCHAIN_WEBDAV_ENTRY)?
                .set_password(password)
                .map_err(|e| e.to_string())?;
        }
    }
    let previous = config_of(&sync_state, &app_state.app_data_dir);
    store_config(
        &sync_state,
        &app_state.app_data_dir,
        SyncConfig {
            enabled: args.enabled,
            transport: args.transport,
            folder_path: args.folder_path,
            webdav_url: args.webdav_url,
            webdav_user: args.webdav_user,
            sync_layouts: args.sync_layouts,
            last_sync_ms: previous.last_sync_ms,
            trust_confirmed: args.trust_confirmed,
            key_joinable: previous.key_joinable,
            key_origin: previous.key_origin,
            kicked: previous.kicked,
            join_denied: previous.join_denied,
        },
    )
}

#[tauri::command]
pub async fn sync_now(app: tauri::AppHandle) -> CmdResult<SyncReport> {
    run_sync_round(&app, &device_label()).await
}

/// Forgetting the key: on the ORIGIN device this ends the whole sync group –
/// a revoke-all record is pushed first (best effort) so every connected
/// device disables itself on its next pull. On joined devices it only takes
/// this device out. Data stays local either way.
#[tauri::command]
pub async fn sync_forget_key(app: tauri::AppHandle) -> CmdResult<()> {
    let app_state: State<'_, AppState> = app.state();
    let sync_state: State<'_, SyncState> = app.state();
    let config = config_of(&sync_state, &app_state.app_data_dir);
    if config.key_origin {
        let own = app_state.storage.device_id().to_string();
        app_state
            .storage
            .set(
                CONTROL_NS,
                "revoke-all",
                json!({
                    "type": "revocation",
                    "all": true,
                    "issuedBy": own,
                    "atMs": std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0),
                }),
            )
            .await
            .map_err(|e| e.to_string())?;
        // Best effort: carry the revocation out before the key disappears.
        let _ = run_sync_round(&app, &device_label()).await;
    }
    forget_key()?;
    let mut config = config_of(&sync_state, &app_state.app_data_dir);
    config.enabled = false;
    config.key_origin = false;
    store_config(&sync_state, &app_state.app_data_dir, config)
}

const CONTROL_NS: &str = "core.sync-control";

/// Removes a device from the shared registry AND writes a revocation record
/// that syncs to every device; the kicked device disables its own sync on
/// the next pull. Honest limitation (documented in the UI): a device that
/// keeps the key and ignores the record could still read the hub – real
/// cryptographic lockout means rotating the key.
#[tauri::command]
pub async fn sync_remove_device(
    app_state: State<'_, AppState>,
    device_id: String,
) -> CmdResult<()> {
    let own = app_state.storage.device_id().to_string();
    app_state
        .storage
        .set(
            CONTROL_NS,
            &format!("revoke-{device_id}"),
            json!({
                "type": "revocation",
                "deviceId": device_id,
                "issuedBy": own,
                "atMs": std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0),
            }),
        )
        .await
        .map_err(|e| e.to_string())?;
    let Some(mut doc) =
        app_state.storage.get(DEVICES_NS, DEVICES_DOC).await.map_err(|e| e.to_string())?
    else {
        return Ok(());
    };
    let devices: Vec<Value> = doc["devices"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|d| d["deviceId"].as_str() != Some(device_id.as_str()))
        .collect();
    doc["devices"] = Value::Array(devices);
    app_state.storage.set(DEVICES_NS, DEVICES_DOC, doc).await.map_err(|e| e.to_string())?;
    Ok(())
}
