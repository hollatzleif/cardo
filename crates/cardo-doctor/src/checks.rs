//! The `env:*` checks — "is this installation healthy?"
//!
//! Policy, following the convention `security:key-in-keychain` already set:
//! an absent *capability* is a warning, never a failure. Only a state that
//! actively breaks the app is a `fail`, because a false red before a demo is
//! as useless as a false green.

use std::path::PathBuf;

use cardo_core::diagnose::CoreCheckResult;
use cardo_core::storage::SCHEMA_VERSION;

use crate::claude::AuthState;
use crate::{claude, db, paths, procs};

/// Keychain service used only by this tool. Deliberately NOT `de.cardo.sync`:
/// that entry's ACL belongs to Cardo.app, and reading it from another binary
/// raises the macOS "wants to access your keychain" dialog.
const DOCTOR_KEYCHAIN_SERVICE: &str = "de.cardo.doctor";

/// A `-wal` file this large with no process holding the database suggests an
/// unclean shutdown rather than normal operation.
const STALE_WAL_BYTES: u64 = 4 * 1024 * 1024;

pub struct EnvContext {
    /// Directory to inspect. Headless: derived by `paths::app_data_dir()`.
    /// In-app: whatever `AppHandle::app_data_dir()` returned.
    pub data_dir: PathBuf,
    /// Set ONLY in-app, to Tauri's own answer. When present it is compared
    /// against our derivation — the only way to catch path drift, which the
    /// headless doctor cannot detect on its own.
    pub tauri_data_dir: Option<PathBuf>,
    /// Version the caller expects to be installed (from package.json).
    pub expect_version: Option<String>,
    /// PID to ignore in the instance scan — the app's own, when run in-app.
    pub self_pid: Option<u32>,
    /// Whether THIS BUILD carries Google Drive OAuth credentials.
    ///
    /// They are baked in at compile time via `option_env!`, so a locally built
    /// Cardo has none and can never refresh a Drive token — every sync round
    /// fails with "client_secret is missing". `None` means the caller cannot
    /// know (the headless doctor is a separate binary from the app).
    pub drive_secret_present: Option<bool>,
    /// Check ids (without the `env:` prefix) the caller wants skipped.
    pub skip: Vec<String>,
    /// Running on a build agent, not a user's machine. Absence of an
    /// installation is then expected and reported as `skip`, not `fail` —
    /// otherwise the smoke run could never be green in CI.
    pub ci: bool,
}

impl EnvContext {
    /// Headless default: derive everything, exclude nothing.
    pub fn derived() -> Result<Self, String> {
        Ok(Self {
            data_dir: paths::app_data_dir()?,
            tauri_data_dir: None,
            expect_version: None,
            self_pid: None,
            drive_secret_present: None,
            skip: Vec::new(),
            ci: false,
        })
    }

    fn wants(&self, short_id: &str) -> bool {
        !self.skip.iter().any(|s| s == short_id)
    }
}

pub async fn run_env_checks(ctx: &EnvContext) -> Vec<CoreCheckResult> {
    let mut results = Vec::new();

    results.push(check_data_dir(ctx));
    // Everything below reads from the data dir; if it is unusable or absent,
    // the rest would only produce noise.
    if results[0].status == "fail" || results[0].skipped {
        return results;
    }

    if ctx.wants("db") {
        results.push(check_db(ctx).await);
    }
    if ctx.wants("single-instance") {
        results.push(check_single_instance(ctx));
    }
    if ctx.wants("claude") {
        let (cli, auth) = check_claude(ctx);
        results.push(cli);
        results.push(auth);
    }
    if ctx.wants("keychain") {
        results.push(check_keychain());
    }
    if ctx.wants("sync") {
        results.push(check_sync_config(ctx));
        results.push(check_drive_credentials(ctx));
    }
    if ctx.wants("installed-app") {
        results.push(check_installed_app(ctx));
    }
    if ctx.wants("disk") {
        results.push(check_disk_space(ctx));
    }

    results
}

/* ── Individual checks ────────────────────────────────────────────────── */

fn check_data_dir(ctx: &EnvContext) -> CoreCheckResult {
    const ID: &str = "env:data-dir";

    // Drift detection: only possible when Tauri told us its answer.
    if let Some(tauri_dir) = &ctx.tauri_data_dir {
        match paths::app_data_dir() {
            Ok(derived) if derived != *tauri_dir => {
                return CoreCheckResult::fail(
                    ID,
                    format!(
                        "path drift: the app uses {}, but cardo-doctor derives {} — \
                         `pnpm preflight` is inspecting the wrong directory",
                        tauri_dir.display(),
                        derived.display()
                    ),
                );
            }
            Err(e) => return CoreCheckResult::warn(ID, format!("cannot derive data dir: {e}")),
            _ => {}
        }
    }

    if !ctx.data_dir.is_dir() {
        return if ctx.ci {
            CoreCheckResult::skip(ID, "no Cardo installation on this build agent (expected)")
        } else {
            CoreCheckResult::fail(
                ID,
                format!("{} does not exist — has Cardo ever run?", ctx.data_dir.display()),
            )
        };
    }
    let probe = ctx.data_dir.join(".cardo-doctor-write-probe");
    match std::fs::write(&probe, b"ok").and_then(|_| std::fs::remove_file(&probe)) {
        Ok(()) => CoreCheckResult::pass_with(ID, ctx.data_dir.display().to_string()),
        Err(e) => CoreCheckResult::fail(ID, format!("{} is not writable: {e}", ctx.data_dir.display())),
    }
}

async fn check_db(ctx: &EnvContext) -> CoreCheckResult {
    const ID: &str = "env:db-live";
    let db_path = paths::db_path(&ctx.data_dir);

    let facts = match db::inspect(&db_path).await {
        Ok(f) => f,
        Err(e) => {
            // A read-only open needs a readable/creatable -shm sidecar; a
            // locked or freshly-created database can legitimately refuse.
            return CoreCheckResult::warn(ID, format!("cannot inspect {}: {e}", db_path.display()));
        }
    };

    if facts.integrity != "ok" {
        return CoreCheckResult::fail(ID, format!("integrity: {}", facts.integrity));
    }
    if facts.schema_version != SCHEMA_VERSION {
        return CoreCheckResult::fail(
            ID,
            format!(
                "schema v{} on disk, this build expects v{SCHEMA_VERSION}",
                facts.schema_version
            ),
        );
    }

    let mb = facts.size_bytes as f64 / (1024.0 * 1024.0);
    let mut detail = format!("v{SCHEMA_VERSION}, {mb:.1} MB, integrity ok");
    if !facts.backups.is_empty() {
        detail.push_str(&format!(", backups: {}", facts.backups.join(", ")));
    }
    CoreCheckResult::pass_with(ID, detail)
}

fn check_single_instance(ctx: &EnvContext) -> CoreCheckResult {
    const ID: &str = "env:single-instance";
    let others = procs::running_instances(ctx.self_pid);

    if !others.is_empty() {
        let pids: Vec<String> = others.iter().map(|i| i.pid.to_string()).collect();
        return CoreCheckResult::fail(
            ID,
            format!(
                "{} further Cardo instance(s) running (PID {}). Two instances share one \
                 SQLite file; sync settings get silently reverted by the stale one. \
                 Quit the extra instance.",
                others.len(),
                pids.join(", ")
            ),
        );
    }

    // Corroboration: a Cardo build we failed to recognise by name would still
    // show up as a holder of the database file.
    let db_path = paths::db_path(&ctx.data_dir);
    if let Some(holders) = procs::holders_of(&db_path) {
        let foreign: Vec<u32> =
            holders.into_iter().filter(|p| Some(*p) != ctx.self_pid).collect();
        if !foreign.is_empty() {
            let pids: Vec<String> = foreign.iter().map(u32::to_string).collect();
            return CoreCheckResult::fail(
                ID,
                format!("cardo.db is held by PID {} — another process has the database open", pids.join(", ")),
            );
        }
        // Nobody holds the DB: a large -wal then means an unclean shutdown.
        if let Ok(meta) = std::fs::metadata(format!("{}-wal", db_path.display())) {
            if meta.len() > STALE_WAL_BYTES {
                return CoreCheckResult::warn(
                    ID,
                    format!(
                        "no second instance, but a {:.1} MB -wal file with no holder \
                         suggests an unclean shutdown",
                        meta.len() as f64 / (1024.0 * 1024.0)
                    ),
                );
            }
        }
        return CoreCheckResult::pass_with(ID, "exactly one instance, database unheld");
    }

    CoreCheckResult::pass_with(ID, "exactly one instance (lsof unavailable, process scan only)")
}

/// Returns `(env:claude-cli, env:claude-auth)`.
fn check_claude(_ctx: &EnvContext) -> (CoreCheckResult, CoreCheckResult) {
    const CLI_ID: &str = "env:claude-cli";
    const AUTH_ID: &str = "env:claude-auth";

    let Some(cli) = claude::find_claude_cli() else {
        return (
            CoreCheckResult::warn(CLI_ID, "Claude CLI not found — the Claude engine is unavailable"),
            CoreCheckResult::skip(AUTH_ID, "no CLI to ask"),
        );
    };

    let cli_result = match claude::version(&cli) {
        Ok(v) => CoreCheckResult::pass_with(CLI_ID, format!("v{v} at {}", cli.display())),
        Err(e) => CoreCheckResult::warn(CLI_ID, format!("{}: {e}", cli.display())),
    };

    // The check that would have caught the dead assistant: `--version`
    // succeeds while logged out, so it proves nothing about usability.
    let auth_result = match claude::auth_status(&cli) {
        AuthState::LoggedIn { method, subscription } => {
            let mut detail = String::from("logged in");
            if let Some(m) = method {
                detail.push_str(&format!(" via {m}"));
            }
            if let Some(s) = subscription {
                detail.push_str(&format!(" ({s})"));
            }
            CoreCheckResult::pass_with(AUTH_ID, detail)
        }
        AuthState::LoggedOut => CoreCheckResult::fail(
            AUTH_ID,
            "Claude CLI is NOT logged in — the assistant will fail on every request. Run `claude login`.",
        ),
        AuthState::Unknown(why) => {
            CoreCheckResult::warn(AUTH_ID, format!("login state undeterminable: {why}"))
        }
    };

    (cli_result, auth_result)
}

fn check_keychain() -> CoreCheckResult {
    const ID: &str = "env:keychain";

    // Round-trips our OWN entry. This proves the keychain subsystem is
    // reachable and unlocked — it does NOT prove Cardo.app can read its sync
    // key, because that entry's ACL belongs to the app bundle. Only the in-app
    // run can establish that, and the detail text says so rather than implying
    // a stronger claim than it has earned.
    const NOTE: &str = "keychain reachable (proves the subsystem is unlocked, \
                        not that Cardo.app can read its own sync key)";

    let entry = match keyring::Entry::new(DOCTOR_KEYCHAIN_SERVICE, "probe") {
        Ok(e) => e,
        Err(e) => return CoreCheckResult::warn(ID, format!("keychain unavailable: {e}")),
    };
    if let Err(e) = entry.set_password("cardo-doctor-probe") {
        return CoreCheckResult::warn(ID, format!("keychain write failed: {e}"));
    }
    let read = entry.get_password();
    let _ = entry.delete_credential();
    match read {
        Ok(v) if v == "cardo-doctor-probe" => CoreCheckResult::pass_with(ID, NOTE),
        Ok(_) => CoreCheckResult::warn(ID, "keychain returned a different value than written"),
        Err(e) => CoreCheckResult::warn(ID, format!("keychain read failed: {e}")),
    }
}

fn check_sync_config(ctx: &EnvContext) -> CoreCheckResult {
    const ID: &str = "env:sync-config";
    let config = ctx.data_dir.join("sync-config.json");

    if !config.is_file() {
        return CoreCheckResult::skip(ID, "sync is not configured on this machine");
    }
    let state = ctx.data_dir.join("sync-filestate.json");
    let Ok(meta) = std::fs::metadata(&state) else {
        return CoreCheckResult::warn(
            ID,
            "sync is configured, but sync-filestate.json is missing — no sync has completed yet",
        );
    };
    let Ok(modified) = meta.modified() else {
        return CoreCheckResult::pass_with(ID, "sync configured (age unknown on this filesystem)");
    };
    match modified.elapsed() {
        Ok(age) => {
            let hours = age.as_secs() / 3600;
            if hours >= 24 {
                CoreCheckResult::warn(
                    ID,
                    format!("last sync activity was {}d {}h ago", hours / 24, hours % 24),
                )
            } else {
                CoreCheckResult::pass_with(ID, format!("last sync activity {hours}h ago"))
            }
        }
        // Clock moved backwards; not worth alarming about.
        Err(_) => CoreCheckResult::pass_with(ID, "sync configured"),
    }
}

/// Which transport `sync-config.json` selects, if sync is configured at all.
fn configured_transport(data_dir: &std::path::Path) -> Option<String> {
    let raw = std::fs::read_to_string(data_dir.join("sync-config.json")).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if parsed.get("enabled")?.as_bool() != Some(true) {
        return None;
    }
    Some(parsed.get("transport")?.as_str()?.to_string())
}

/// Does this build have the Google Drive OAuth credentials it needs?
///
/// The failure this exists for cost five days of silent, broken sync: the app
/// in /Applications had been built locally, so `option_env!` baked in an empty
/// client secret and every token refresh was rejected with "client_secret is
/// missing". Nothing anywhere said so — and the sync settings looked perfect,
/// because they were.
fn check_drive_credentials(ctx: &EnvContext) -> CoreCheckResult {
    const ID: &str = "env:drive-credentials";

    let Some(present) = ctx.drive_secret_present else {
        // The headless doctor is a different binary than the app and cannot
        // inspect what the app was built with.
        return CoreCheckResult::skip(ID, "only checkable from inside the app");
    };
    if present {
        return CoreCheckResult::pass_with(ID, "build carries Google Drive credentials");
    }

    let uses_drive = configured_transport(&ctx.data_dir).as_deref() == Some("gdrive");
    let detail = "this build has NO Google Drive credentials — they are baked in at compile \
                  time, so a locally built Cardo can never refresh its Drive token. Use an \
                  official release, or set CARDO_GDRIVE_CLIENT_SECRET before building.";
    if uses_drive {
        // Sync is on AND set to Drive: this build cannot sync at all.
        CoreCheckResult::fail(ID, detail)
    } else {
        CoreCheckResult::warn(ID, detail)
    }
}

fn check_installed_app(ctx: &EnvContext) -> CoreCheckResult {
    const ID: &str = "env:installed-app";

    let Some(bundle) = paths::installed_bundle() else {
        return CoreCheckResult::skip(ID, "no installed bundle at the canonical location");
    };
    let installed = match paths::bundle_version(&bundle) {
        Ok(v) => v,
        Err(e) => return CoreCheckResult::warn(ID, e),
    };
    let Some(expected) = &ctx.expect_version else {
        return CoreCheckResult::pass_with(ID, format!("{} is v{installed}", bundle.display()));
    };
    if &installed == expected {
        CoreCheckResult::pass_with(ID, format!("v{installed} installed, matches this checkout"))
    } else {
        CoreCheckResult::warn(
            ID,
            format!(
                "installed app is v{installed}, this checkout is v{expected} — \
                 you may be demoing an older build than you just changed"
            ),
        )
    }
}

fn check_disk_space(ctx: &EnvContext) -> CoreCheckResult {
    const ID: &str = "env:disk-space";
    const LOW_BYTES: u64 = 2 * 1024 * 1024 * 1024;

    let disks = sysinfo::Disks::new_with_refreshed_list();
    // Longest matching mount point wins, so `/Users` beats `/`.
    let best = disks
        .list()
        .iter()
        .filter(|d| ctx.data_dir.starts_with(d.mount_point()))
        .max_by_key(|d| d.mount_point().as_os_str().len());

    let Some(disk) = best else {
        return CoreCheckResult::skip(ID, "no matching mount point found");
    };
    let free = disk.available_space();
    let gb = free as f64 / (1024.0 * 1024.0 * 1024.0);
    if free < LOW_BYTES {
        CoreCheckResult::warn(ID, format!("only {gb:.1} GB free on {}", disk.mount_point().display()))
    } else {
        CoreCheckResult::pass_with(ID, format!("{gb:.1} GB free"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx_for(dir: &std::path::Path) -> EnvContext {
        EnvContext {
            data_dir: dir.to_path_buf(),
            tauri_data_dir: None,
            expect_version: None,
            self_pid: Some(std::process::id()),
            drive_secret_present: None,
            skip: Vec::new(),
            ci: false,
        }
    }

    #[test]
    fn data_dir_passes_when_writable() {
        let dir = tempfile::tempdir().unwrap();
        let result = check_data_dir(&ctx_for(dir.path()));
        assert_eq!(result.status, "pass", "{:?}", result.detail);
    }

    #[test]
    fn data_dir_fails_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        let result = check_data_dir(&ctx_for(&missing));
        assert_eq!(result.status, "fail");
    }

    #[test]
    fn data_dir_fails_loudly_on_path_drift() {
        // The scenario this exists for: Tauri resolves somewhere our
        // derivation does not, so the preflight would silently inspect a
        // directory the app never uses.
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = ctx_for(dir.path());
        ctx.tauri_data_dir = Some(PathBuf::from("/somewhere/else/app.cardo.desktop"));
        let result = check_data_dir(&ctx);
        assert_eq!(result.status, "fail");
        assert!(result.detail.unwrap().contains("path drift"));
    }

    #[tokio::test]
    async fn missing_database_warns_rather_than_failing() {
        // A missing DB is not proof of a broken install (first launch), and a
        // read-only open can legitimately refuse — so it must not be a fail.
        let dir = tempfile::tempdir().unwrap();
        let result = check_db(&ctx_for(dir.path())).await;
        assert_eq!(result.status, "warn");
        // And it must not have created one.
        assert!(!paths::db_path(dir.path()).exists());
    }

    #[test]
    fn sync_check_skips_when_sync_is_not_configured() {
        let dir = tempfile::tempdir().unwrap();
        let result = check_sync_config(&ctx_for(dir.path()));
        assert!(result.skipped, "unconfigured sync must be skipped, not passed");
    }

    #[test]
    fn sync_check_warns_when_configured_but_never_run() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("sync-config.json"), b"{}").unwrap();
        let result = check_sync_config(&ctx_for(dir.path()));
        assert_eq!(result.status, "warn");
        assert!(!result.skipped);
    }

    #[test]
    fn drive_credentials_are_unknowable_headless() {
        let dir = tempfile::tempdir().unwrap();
        let result = check_drive_credentials(&ctx_for(dir.path()));
        assert!(result.skipped, "the doctor binary cannot know what the app was built with");
    }

    #[test]
    fn a_build_without_drive_credentials_fails_when_drive_sync_is_on() {
        // The exact situation that silently broke sync for five days.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("sync-config.json"),
            br#"{"enabled":true,"transport":"gdrive"}"#,
        )
        .unwrap();
        let mut ctx = ctx_for(dir.path());
        ctx.drive_secret_present = Some(false);

        let result = check_drive_credentials(&ctx);
        assert_eq!(result.status, "fail");
        assert!(result.detail.unwrap().contains("NO Google Drive credentials"));
    }

    #[test]
    fn a_build_without_drive_credentials_only_warns_when_drive_is_unused() {
        // Folder or WebDAV transport: the missing secret is irrelevant.
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("sync-config.json"),
            br#"{"enabled":true,"transport":"folder"}"#,
        )
        .unwrap();
        let mut ctx = ctx_for(dir.path());
        ctx.drive_secret_present = Some(false);

        assert_eq!(check_drive_credentials(&ctx).status, "warn");
    }

    #[test]
    fn a_release_build_passes() {
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = ctx_for(dir.path());
        ctx.drive_secret_present = Some(true);
        assert_eq!(check_drive_credentials(&ctx).status, "pass");
    }

    #[test]
    fn disabled_sync_reports_no_transport() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("sync-config.json"),
            br#"{"enabled":false,"transport":"gdrive"}"#,
        )
        .unwrap();
        assert_eq!(configured_transport(dir.path()), None);
    }

    #[test]
    fn skip_list_suppresses_checks() {
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = ctx_for(dir.path());
        ctx.skip = vec!["claude".into()];
        assert!(!ctx.wants("claude"));
        assert!(ctx.wants("keychain"));
    }

    #[tokio::test]
    async fn a_broken_data_dir_short_circuits_the_run() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx_for(&dir.path().join("does-not-exist"));
        let results = run_env_checks(&ctx).await;
        assert_eq!(results.len(), 1, "must not keep probing a dead data dir");
        assert_eq!(results[0].id, "env:data-dir");
        assert_eq!(results[0].status, "fail");
    }

    #[tokio::test]
    async fn ci_mode_skips_a_missing_installation_instead_of_failing() {
        // On a build agent Cardo has never run. That must not be a failure, or
        // the CI smoke run could never be green — and a check that can never be
        // green gets ignored, which defeats the point.
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = ctx_for(&dir.path().join("does-not-exist"));
        ctx.ci = true;
        let results = run_env_checks(&ctx).await;
        assert_eq!(results.len(), 1);
        assert!(results[0].skipped);
        assert!(results.iter().all(|r| r.status != "fail"));
    }

    #[tokio::test]
    async fn every_check_id_is_unique_and_namespaced() {
        let dir = tempfile::tempdir().unwrap();
        let mut ctx = ctx_for(dir.path());
        // Keep the run offline and fast; the ids are what matter here.
        ctx.skip = vec!["claude".into(), "keychain".into()];
        let results = run_env_checks(&ctx).await;

        let mut ids: Vec<&str> = results.iter().map(|r| r.id.as_str()).collect();
        let count = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), count, "duplicate check ids: {ids:?}");
        assert!(results.iter().all(|r| r.id.starts_with("env:")));
        assert!(results.iter().all(|r| ["pass", "warn", "fail"].contains(&r.status.as_str())));
    }
}
