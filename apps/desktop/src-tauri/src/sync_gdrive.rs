//! Google Drive transport: the user's own Drive carries the encrypted op
//! batches inside the hidden per-app `appDataFolder` space. Google never
//! sees plaintext – the blobs are sealed by cardo-core before they get here.
//!
//! OAuth 2.0 for desktop apps with PKCE: system browser + loopback redirect.
//! Only the `drive.appdata` scope is requested (no access to the user's
//! real files). The refresh token lives in the OS keychain.
//!
//! The OAuth client id ships in the app (public by design for installed
//! apps); override with the CARDO_GDRIVE_CLIENT_ID env var during testing.

use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use cardo_core::sync::{Cursor, EncryptedOp, PullBatch, PushAck, SyncTransport};
use cardo_core::CoreError;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const KEYCHAIN_SERVICE: &str = "de.cardo.sync";
const KEYCHAIN_REFRESH_ENTRY: &str = "gdrive-refresh-token";

/// Leif's registered OAuth app (Google Cloud project "Cardo").
/// Installed-app client ids are not secrets (PKCE carries the proof).
const DEFAULT_CLIENT_ID: &str =
    "1057427798264-f5fs57rfp4i870rbp9pak96dup6at8sm.apps.googleusercontent.com";
/// Desktop-type clients MAY carry a client secret that Google's token
/// endpoint expects alongside PKCE (it is explicitly not confidential for
/// installed apps). Empty = omitted from token requests.
/// Injected at BUILD time (CI secret / local env) so the PUBLIC repo never
/// carries the literal: GitHub push protection blocks it and Google may
/// auto-revoke secrets found in public sources. The packaged binary still
/// contains it — Google's installed-app model explicitly allows that.
const DEFAULT_CLIENT_SECRET: &str = match option_env!("CARDO_GDRIVE_CLIENT_SECRET") {
    Some(secret) => secret,
    None => "",
};

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SCOPE: &str = "https://www.googleapis.com/auth/drive.appdata";
const FILES_URL: &str = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL: &str = "https://www.googleapis.com/upload/drive/v3/files";

fn client_id() -> String {
    std::env::var("CARDO_GDRIVE_CLIENT_ID").unwrap_or_else(|_| DEFAULT_CLIENT_ID.to_string())
}

fn client_secret() -> String {
    std::env::var("CARDO_GDRIVE_CLIENT_SECRET")
        .unwrap_or_else(|_| DEFAULT_CLIENT_SECRET.to_string())
}

fn refresh_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_REFRESH_ENTRY).map_err(|e| e.to_string())
}

/// A build without an OAuth client id cannot start the consent flow.
pub fn is_configured() -> bool {
    !client_id().is_empty()
}

pub fn is_connected() -> bool {
    matches!(refresh_entry().map(|e| e.get_password()), Ok(Ok(_)))
}

pub fn disconnect() -> Result<(), String> {
    match refresh_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/* ── OAuth (PKCE + loopback) ──────────────────────────────────────────── */

fn random_urlsafe(len: usize) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut bytes = vec![0u8; len];
    getrandom::getrandom(&mut bytes).expect("OS randomness");
    bytes.iter().map(|b| T[(b & 63) as usize] as char).collect()
}

fn b64url_no_pad(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(T[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(T[n as usize & 63] as char);
        }
    }
    out
}

fn open_in_browser(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd").args(["/C", "start", "", url]).spawn();
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let result = std::process::Command::new("xdg-open").arg(url).spawn();
    result.map(|_| ()).map_err(|e| format!("could not open browser: {e}"))
}

/// Runs the full interactive consent flow. Blocks (call from async via
/// spawn_blocking); returns once Google redirected to the loopback.
pub fn connect_interactive() -> Result<(), String> {
    let id = client_id();
    if id.is_empty() {
        return Err("Google Drive is not configured in this build (missing OAuth client id)".into());
    }

    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let verifier = random_urlsafe(64);
    let challenge = b64url_no_pad(&Sha256::digest(verifier.as_bytes()));
    let state = random_urlsafe(24);

    let auth_url = format!(
        "{AUTH_URL}?client_id={id}&redirect_uri={redirect_uri}&response_type=code&scope={scope}\
         &code_challenge={challenge}&code_challenge_method=S256&state={state}\
         &access_type=offline&prompt=consent",
        scope = SCOPE.replace(':', "%3A").replace('/', "%2F"),
    );
    open_in_browser(&auth_url)?;

    listener
        .set_nonblocking(false)
        .map_err(|e| e.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(300);
    let code = loop {
        if Instant::now() > deadline {
            return Err("Google sign-in timed out (5 minutes)".into());
        }
        let (mut stream, _) = listener.accept().map_err(|e| e.to_string())?;
        let mut line = String::new();
        BufReader::new(&stream).read_line(&mut line).map_err(|e| e.to_string())?;
        // "GET /?state=…&code=… HTTP/1.1"
        let query = line.split_whitespace().nth(1).unwrap_or("");
        let params: Vec<(&str, &str)> = query
            .trim_start_matches('/')
            .trim_start_matches('?')
            .split('&')
            .filter_map(|kv| kv.split_once('='))
            .collect();
        let got_state = params.iter().find(|(k, _)| *k == "state").map(|(_, v)| *v);
        let got_code = params.iter().find(|(k, _)| *k == "code").map(|(_, v)| *v);

        let body = "<html><body style=\"font-family:sans-serif\"><h2>Cardo</h2>\
                    <p>Du kannst dieses Fenster schlie\u{df}en. / You can close this window.</p></body></html>";
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        );

        if got_state == Some(state.as_str()) {
            if let Some(code) = got_code {
                break code.to_string();
            }
            return Err("Google reported no authorization code".into());
        }
        // Unrelated request (favicon etc.) – keep listening.
    };

    // Exchange the code synchronously (we are inside spawn_blocking).
    let secret = client_secret();
    let mut form: Vec<(&str, &str)> = vec![
        ("client_id", id.as_str()),
        ("code", code.as_str()),
        ("code_verifier", verifier.as_str()),
        ("grant_type", "authorization_code"),
        ("redirect_uri", redirect_uri.as_str()),
    ];
    if !secret.is_empty() {
        form.push(("client_secret", secret.as_str()));
    }
    let response = reqwest::blocking::Client::new()
        .post(TOKEN_URL)
        .form(&form)
        .send()
        .map_err(|e| e.to_string())?;
    let tokens: Value = response.json().map_err(|e| e.to_string())?;
    let refresh = tokens["refresh_token"]
        .as_str()
        .ok_or_else(|| format!("no refresh token in Google's reply: {tokens}"))?;
    refresh_entry()?.set_password(refresh).map_err(|e| e.to_string())
}

/* ── Transport ────────────────────────────────────────────────────────── */

pub struct GoogleDriveTransport {
    client: reqwest::Client,
    /// Cached access token + its expiry.
    access: Mutex<Option<(String, Instant)>>,
}

pub fn build_transport() -> Result<Box<dyn SyncTransport>, String> {
    if !is_connected() {
        return Err("Google Drive is not connected on this device".into());
    }
    Ok(Box::new(GoogleDriveTransport {
        client: reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?,
        access: Mutex::new(None),
    }))
}

impl GoogleDriveTransport {
    async fn access_token(&self) -> Result<String, String> {
        if let Some((token, expiry)) = self.access.lock().expect("token lock").clone() {
            if Instant::now() < expiry {
                return Ok(token);
            }
        }
        let refresh = refresh_entry()?.get_password().map_err(|e| e.to_string())?;
        let mut form: Vec<(String, String)> = vec![
            ("client_id".into(), client_id()),
            ("refresh_token".into(), refresh),
            ("grant_type".into(), "refresh_token".into()),
        ];
        let secret = client_secret();
        if !secret.is_empty() {
            form.push(("client_secret".into(), secret));
        }
        let response = self
            .client
            .post(TOKEN_URL)
            .form(&form)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let tokens: Value = response.json().await.map_err(|e| e.to_string())?;
        let token = tokens["access_token"]
            .as_str()
            .ok_or_else(|| format!("token refresh failed: {tokens}"))?
            .to_string();
        let ttl = tokens["expires_in"].as_u64().unwrap_or(3600).saturating_sub(60);
        *self.access.lock().expect("token lock") =
            Some((token.clone(), Instant::now() + Duration::from_secs(ttl)));
        Ok(token)
    }
}

#[async_trait::async_trait]
impl SyncTransport for GoogleDriveTransport {
    async fn push(&self, ops: Vec<EncryptedOp>) -> cardo_core::Result<PushAck> {
        if ops.is_empty() {
            return Ok(PushAck { accepted: 0 });
        }
        let token = self.access_token().await.map_err(CoreError::Other)?;
        let batch = json!({
            "version": 1,
            "ops": ops.iter().map(|op| json!({
                "op_id": op.op_id,
                "blob_b64": crate::sync::b64_public(&op.blob),
            })).collect::<Vec<_>>(),
        });
        let name = format!(
            "{:013}-{}.cardo-ops",
            SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0),
            uuid::Uuid::new_v4()
        );
        let metadata = json!({ "name": name, "parents": ["appDataFolder"] });
        let boundary = "cardo-sync-boundary";
        let body = format!(
            "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{metadata}\r\n\
             --{boundary}\r\nContent-Type: application/json\r\n\r\n{batch}\r\n--{boundary}--",
        );
        let response = self
            .client
            .post(format!("{UPLOAD_URL}?uploadType=multipart"))
            .bearer_auth(&token)
            .header("Content-Type", format!("multipart/related; boundary={boundary}"))
            .body(body)
            .send()
            .await
            .map_err(|e| CoreError::Other(e.to_string()))?;
        if !response.status().is_success() {
            return Err(CoreError::Other(format!(
                "Drive upload failed: HTTP {}",
                response.status()
            )));
        }
        Ok(PushAck { accepted: ops.len() })
    }

    async fn pull(&self, since: Cursor) -> cardo_core::Result<PullBatch> {
        let token = self.access_token().await.map_err(CoreError::Other)?;
        // List batch files ordered by name; filenames sort chronologically.
        let mut names: Vec<(String, String)> = Vec::new(); // (name, fileId)
        let mut page_token: Option<String> = None;
        loop {
            let mut url = format!(
                "{FILES_URL}?spaces=appDataFolder&orderBy=name&fields=nextPageToken,files(id,name)&pageSize=100"
            );
            if let Some(t) = &page_token {
                url.push_str(&format!("&pageToken={t}"));
            }
            let response = self
                .client
                .get(&url)
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| CoreError::Other(e.to_string()))?;
            if !response.status().is_success() {
                return Err(CoreError::Other(format!(
                    "Drive list failed: HTTP {}",
                    response.status()
                )));
            }
            let body: Value = response.json().await.map_err(|e| CoreError::Other(e.to_string()))?;
            for file in body["files"].as_array().into_iter().flatten() {
                let (Some(name), Some(id)) = (file["name"].as_str(), file["id"].as_str()) else {
                    continue;
                };
                if name.ends_with(".cardo-ops") && name > since.as_str() {
                    names.push((name.to_string(), id.to_string()));
                }
            }
            page_token = body["nextPageToken"].as_str().map(str::to_string);
            if page_token.is_none() {
                break;
            }
        }
        names.sort();

        let mut ops = Vec::new();
        let mut cursor = since;
        for (name, file_id) in names.into_iter().take(50) {
            let response = self
                .client
                .get(format!("{FILES_URL}/{file_id}?alt=media"))
                .bearer_auth(&token)
                .send()
                .await
                .map_err(|e| CoreError::Other(e.to_string()))?;
            if !response.status().is_success() {
                return Err(CoreError::Other(format!(
                    "Drive download failed: HTTP {}",
                    response.status()
                )));
            }
            let body: Value = response.json().await.map_err(|e| CoreError::Other(e.to_string()))?;
            for op in body["ops"].as_array().into_iter().flatten() {
                let (Some(op_id), Some(blob_b64)) = (op["op_id"].as_str(), op["blob_b64"].as_str())
                else {
                    continue;
                };
                let Some(blob) = crate::sync::b64_decode_public(blob_b64) else { continue };
                ops.push(EncryptedOp { op_id: op_id.to_string(), blob });
            }
            cursor = name;
        }
        Ok(PullBatch { ops, next_cursor: cursor })
    }
}

/* ── Tauri commands ───────────────────────────────────────────────────── */

#[tauri::command]
pub async fn sync_gdrive_connect() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(connect_interactive)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn sync_gdrive_disconnect() -> Result<(), String> {
    disconnect()
}
