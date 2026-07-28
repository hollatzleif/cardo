//! Claude Code CLI discovery and state probing.
//!
//! These helpers used to live in `apps/desktop/src-tauri/src/claude.rs`. They
//! moved here so the app and the headless doctor agree on where the CLI is and
//! what it reports *by construction* rather than by copy-paste — the class of
//! drift that let the Settings badge show a green "CLI detected" while the CLI
//! was logged out and the assistant unusable.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

/// How long we wait for the CLI to answer `--version` / `auth status`.
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

/// Leading version token of `claude --version` output,
/// e.g. "2.1.209 (Claude Code)" → "2.1.209".
pub fn parse_version(raw: &str) -> Option<String> {
    let token = raw.split_whitespace().next()?;
    if token.starts_with(|c: char| c.is_ascii_digit()) {
        Some(token.to_string())
    } else {
        None
    }
}

/// First existing candidate: `which claude` (`where` on Windows), then the
/// well-known install locations. GUI apps often run with a minimal PATH, so
/// the lookup command alone is not enough.
pub fn find_claude_cli() -> Option<PathBuf> {
    let lookup = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = Command::new(lookup).arg("claude").output() {
        if out.status.success() {
            // `where` can return several lines; take the first.
            let stdout = String::from_utf8_lossy(&out.stdout);
            if let Some(first) = stdout.lines().next() {
                let found = first.trim();
                if !found.is_empty() {
                    let path = PathBuf::from(found);
                    if path.is_file() {
                        return Some(path);
                    }
                }
            }
        }
    }
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        candidates.push(home.join(".local").join("bin").join("claude"));
        // Node-version managers put the shim outside the standard prefixes.
        candidates.push(home.join(".bun").join("bin").join("claude"));
        candidates.push(home.join(".volta").join("bin").join("claude"));
    }
    candidates.push(PathBuf::from("/usr/local/bin/claude"));
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.into_iter().find(|p| p.is_file())
}

/// What `claude auth status --json` told us. `Unknown` means we could not
/// determine the state (CLI too old, timeout, unparseable output) — that is a
/// warning, never a hard failure, because a false red is as bad as a false
/// green for a pre-demo check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AuthState {
    LoggedIn { method: Option<String>, subscription: Option<String> },
    LoggedOut,
    Unknown(String),
}

/// Parse the JSON body of `claude auth status --json`.
///
/// Observed shape (CLI 2.1.220):
/// `{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}`
pub fn parse_auth_status(stdout: &str) -> AuthState {
    let trimmed = stdout.trim();
    if trimmed.is_empty() {
        return AuthState::Unknown("empty output".into());
    }
    let parsed: serde_json::Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => return AuthState::Unknown(format!("unparseable output: {e}")),
    };
    match parsed.get("loggedIn").and_then(|v| v.as_bool()) {
        Some(true) => AuthState::LoggedIn {
            method: parsed.get("authMethod").and_then(|v| v.as_str()).map(str::to_string),
            subscription: parsed
                .get("subscriptionType")
                .and_then(|v| v.as_str())
                .map(str::to_string),
        },
        Some(false) => AuthState::LoggedOut,
        None => AuthState::Unknown("no loggedIn field".into()),
    }
}

/// Ask the CLI whether it is authenticated. Costs nothing — this is a local
/// credential lookup, not an API call, so it is safe to run on every check.
pub fn auth_status(cli: &std::path::Path) -> AuthState {
    let out = match run_with_timeout(cli, &["auth", "status", "--json"], PROBE_TIMEOUT) {
        Ok(out) => out,
        Err(e) => return AuthState::Unknown(e),
    };
    let stderr = String::from_utf8_lossy(&out.stderr);
    // Older CLIs have no `auth status` subcommand at all.
    if !out.status.success() && stderr.to_lowercase().contains("unknown command") {
        return AuthState::Unknown("CLI too old for `auth status`".into());
    }
    parse_auth_status(&String::from_utf8_lossy(&out.stdout))
}

/// Version string via `claude --version`, or an error describing why not.
pub fn version(cli: &std::path::Path) -> Result<String, String> {
    let out = run_with_timeout(cli, &["--version"], PROBE_TIMEOUT)?;
    if !out.status.success() {
        return Err(format!("`--version` exited with {}", out.status));
    }
    parse_version(&String::from_utf8_lossy(&out.stdout))
        .ok_or_else(|| "could not parse version output".to_string())
}

/// Run a child process with a wall-clock timeout, killing it on expiry.
/// Plain threads rather than tokio: the doctor's checks are synchronous and
/// this keeps the binary free of an async runtime requirement.
fn run_with_timeout(
    program: &std::path::Path,
    args: &[&str],
    timeout: Duration,
) -> Result<std::process::Output, String> {
    use std::sync::mpsc;

    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    // `wait_with_output` consumes the child, so hand it to a thread and let
    // the caller time out independently.
    let (tx, rx) = mpsc::channel();
    let handle = std::thread::spawn(move || {
        let result = child.wait_with_output();
        // A closed receiver just means the caller already gave up.
        let _ = tx.send(result);
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok(out)) => {
            let _ = handle.join();
            Ok(out)
        }
        Ok(Err(e)) => Err(format!("process error: {e}")),
        Err(_) => Err(format!("timed out after {}s", timeout.as_secs())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Moved verbatim from apps/desktop/src-tauri/src/claude.rs.
    #[test]
    fn version_parsing() {
        // Exactly the observed format of claude --version.
        assert_eq!(parse_version("2.1.209 (Claude Code)").as_deref(), Some("2.1.209"));
        assert_eq!(parse_version("  2.1.209 (Claude Code)\n").as_deref(), Some("2.1.209"));
        assert_eq!(parse_version("1.0.0").as_deref(), Some("1.0.0"));
        assert_eq!(parse_version(""), None);
        assert_eq!(parse_version("   \n"), None);
        assert_eq!(parse_version("error: not found"), None);
    }

    #[test]
    fn auth_status_logged_in() {
        // The exact shape observed from CLI 2.1.220.
        let raw = r#"{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}"#;
        assert_eq!(
            parse_auth_status(raw),
            AuthState::LoggedIn {
                method: Some("claude.ai".into()),
                subscription: Some("max".into()),
            }
        );
    }

    #[test]
    fn auth_status_logged_out() {
        assert_eq!(parse_auth_status(r#"{"loggedIn":false}"#), AuthState::LoggedOut);
        // Trailing whitespace / newline must not matter.
        assert_eq!(parse_auth_status("  {\"loggedIn\": false}\n"), AuthState::LoggedOut);
    }

    #[test]
    fn auth_status_undeterminable_is_unknown_not_logged_out() {
        // This is the important distinction: a shape we don't recognise must
        // never be reported as "logged out" – that would be a false red.
        assert!(matches!(parse_auth_status(""), AuthState::Unknown(_)));
        assert!(matches!(parse_auth_status("not json at all"), AuthState::Unknown(_)));
        assert!(matches!(parse_auth_status(r#"{"other":1}"#), AuthState::Unknown(_)));
        assert!(matches!(parse_auth_status(r#"{"loggedIn":"yes"}"#), AuthState::Unknown(_)));
    }

    #[test]
    fn logged_in_without_optional_fields() {
        assert_eq!(
            parse_auth_status(r#"{"loggedIn":true}"#),
            AuthState::LoggedIn { method: None, subscription: None }
        );
    }
}
