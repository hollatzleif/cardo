//! Claude Code CLI bridge: uses the user's locally installed `claude`
//! binary (subscription login) as an assistant engine. The CLI runs in
//! print mode (`-p --output-format json`) inside a user-chosen workspace
//! folder; the app data/config dirs are explicitly forbidden as
//! workspaces so the assistant can never touch Cardo's own storage.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Manager;

type CmdResult<T> = Result<T, String>;

/// Models the webview may request; passed through to `--model` as given.
const ALLOWED_MODELS: [&str; 8] = [
    "fable-5",
    "opus",
    "sonnet",
    "haiku",
    "claude-fable-5",
    "claude-opus-4-8",
    "claude-sonnet-5",
    "claude-haiku-4-5",
];

const GENERATE_TIMEOUT: Duration = Duration::from_secs(180);
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);
const STDERR_TAIL_CHARS: usize = 800;

/* ── Pure helpers (unit-tested) ───────────────────────────────────────── */

fn model_allowed(model: &str) -> bool {
    ALLOWED_MODELS.contains(&model)
}

/// A workspace is allowed unless it equals or lies under a forbidden dir.
/// (`Path::starts_with` also matches equality.)
fn workspace_allowed(workspace: &Path, forbidden: &[PathBuf]) -> bool {
    !forbidden.iter().any(|f| workspace.starts_with(f))
}

/// CLI argument list for one generation. The prompt goes via stdin, so
/// only fixed flags appear here (no arg-length limits, no injection).
fn build_claude_args(model: &str, max_turns: u32) -> Vec<String> {
    vec![
        "-p".to_string(),
        "--output-format".to_string(),
        "json".to_string(),
        "--model".to_string(),
        model.to_string(),
        "--allowedTools".to_string(),
        "Read,Write,Edit,Glob,Grep,LS".to_string(),
        "--max-turns".to_string(),
        max_turns.to_string(),
    ]
}

/// Leading version token of `claude --version` output,
/// e.g. "2.1.209 (Claude Code)" → "2.1.209".
fn parse_version(raw: &str) -> Option<String> {
    let token = raw.split_whitespace().next()?;
    if token.starts_with(|c: char| c.is_ascii_digit()) {
        Some(token.to_string())
    } else {
        None
    }
}

/// The CLI's `-p --output-format json` output is an object with a
/// "result" string field. Returns None if the shape doesn't match.
fn extract_result(stdout: &str) -> Option<String> {
    let parsed: Value = serde_json::from_str(stdout.trim()).ok()?;
    parsed.get("result")?.as_str().map(|s| s.to_string())
}

/// Last chunk of stderr for error messages (char-boundary safe).
fn stderr_tail(stderr: &str) -> String {
    let trimmed = stderr.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= STDERR_TAIL_CHARS {
        trimmed.to_string()
    } else {
        chars[chars.len() - STDERR_TAIL_CHARS..].iter().collect()
    }
}

fn auth_hint(stderr: &str) -> &'static str {
    let lower = stderr.to_lowercase();
    if lower.contains("auth") || lower.contains("login") || lower.contains("logged") {
        " (not logged in?)"
    } else {
        ""
    }
}

/* ── CLI discovery ────────────────────────────────────────────────────── */

/// First existing candidate: `which claude`, then the well-known install
/// locations (GUI apps often run with a minimal PATH, so `which` alone
/// is not enough).
fn find_claude_cli() -> Option<PathBuf> {
    if let Ok(out) = std::process::Command::new("which").arg("claude").output() {
        if out.status.success() {
            let found = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !found.is_empty() {
                let path = PathBuf::from(found);
                if path.is_file() {
                    return Some(path);
                }
            }
        }
    }
    let mut candidates = Vec::new();
    if let Some(home) = std::env::var_os("HOME") {
        candidates.push(PathBuf::from(home).join(".local").join("bin").join("claude"));
    }
    candidates.push(PathBuf::from("/usr/local/bin/claude"));
    candidates.push(PathBuf::from("/opt/homebrew/bin/claude"));
    candidates.into_iter().find(|p| p.is_file())
}

/* ── Commands ─────────────────────────────────────────────────────────── */

/// Detects the Claude CLI. Never errors: any failure (not found, version
/// call fails or times out, unparseable output) reports installed:false.
#[tauri::command]
pub async fn claude_check() -> Value {
    let not_installed = json!({ "installed": false, "version": null, "path": null });
    let Some(path) = find_claude_cli() else {
        return not_installed;
    };
    let version_cmd = tokio::process::Command::new(&path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .output();
    let output = match tokio::time::timeout(VERSION_TIMEOUT, version_cmd).await {
        Ok(Ok(out)) if out.status.success() => out,
        _ => return not_installed,
    };
    match parse_version(&String::from_utf8_lossy(&output.stdout)) {
        Some(version) => json!({
            "installed": true,
            "version": version,
            "path": path.to_string_lossy(),
        }),
        None => not_installed,
    }
}

/// Dirs the workspace must never equal or live under (raw + canonical,
/// so macOS /var ↔ /private/var symlinks can't bypass the check).
fn forbidden_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let bases = [app.path().app_data_dir().ok(), app.path().app_config_dir().ok()];
    for dir in bases.into_iter().flatten() {
        if let Ok(canonical) = dir.canonicalize() {
            if canonical != dir {
                dirs.push(canonical);
            }
        }
        dirs.push(dir);
    }
    dirs
}

/// One generation round: system+user prompt via stdin, scoped file tools,
/// cwd = the user's workspace folder. Returns the CLI's "result" text.
#[tauri::command]
pub async fn claude_generate(
    app: tauri::AppHandle,
    system: String,
    user: String,
    model: String,
    workspace_dir: String,
    max_turns: u32,
) -> CmdResult<String> {
    if !model_allowed(&model) {
        return Err(format!(
            "model \"{model}\" not allowed (allowed: {})",
            ALLOWED_MODELS.join(", ")
        ));
    }
    let max_turns = max_turns.clamp(1, 10);

    if workspace_dir.is_empty() {
        return Err("workspace not allowed".to_string());
    }
    let workspace = PathBuf::from(&workspace_dir);
    if !workspace.is_dir() {
        return Err("workspace not allowed".to_string());
    }
    let workspace = workspace
        .canonicalize()
        .map_err(|_| "workspace not allowed".to_string())?;
    if !workspace.is_dir() || !workspace_allowed(&workspace, &forbidden_dirs(&app)) {
        return Err("workspace not allowed".to_string());
    }

    let cli = find_claude_cli().ok_or_else(|| "claude CLI not found".to_string())?;
    let args = build_claude_args(&model, max_turns);

    let mut child = tokio::process::Command::new(&cli)
        .args(&args)
        .current_dir(&workspace)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("failed to start claude: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "failed to open claude stdin".to_string())?;
    let prompt = format!("{system}\n\n{user}");

    // On timeout the future owning `child` is dropped and kill_on_drop
    // terminates the process.
    let run = async move {
        let write = async move {
            use tokio::io::AsyncWriteExt;
            let mut stdin = stdin;
            stdin.write_all(prompt.as_bytes()).await?;
            stdin.shutdown().await?;
            drop(stdin); // close the pipe so the CLI sees EOF
            Ok::<(), std::io::Error>(())
        };
        let (write_result, output) = tokio::join!(write, child.wait_with_output());
        write_result.map_err(|e| format!("failed to write prompt: {e}"))?;
        output.map_err(|e| format!("claude failed: {e}"))
    };
    let output = tokio::time::timeout(GENERATE_TIMEOUT, run)
        .await
        .map_err(|_| "claude timed out".to_string())??;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!(
            "claude-error: {}{}",
            stderr_tail(&stderr),
            auth_hint(&stderr)
        ));
    }

    if let Some(result) = extract_result(&stdout) {
        return Ok(result);
    }
    let trimmed = stdout.trim();
    if !trimmed.is_empty() {
        return Ok(trimmed.to_string());
    }
    Err(format!(
        "claude-error: empty output{}",
        auth_hint(&stderr)
    ))
}

/* ── Tests ────────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_claude_args_golden() {
        assert_eq!(
            build_claude_args("claude-sonnet-5", 5),
            vec![
                "-p",
                "--output-format",
                "json",
                "--model",
                "claude-sonnet-5",
                "--allowedTools",
                "Read,Write,Edit,Glob,Grep,LS",
                "--max-turns",
                "5",
            ]
        );
    }

    #[test]
    fn workspace_allowed_matrix() {
        let forbidden = vec![
            PathBuf::from("/Users/x/Library/Application Support/cardo"),
            PathBuf::from("/Users/x/Library/Application Support/cardo-config"),
        ];
        // Equal to a forbidden dir → rejected.
        assert!(!workspace_allowed(
            Path::new("/Users/x/Library/Application Support/cardo"),
            &forbidden
        ));
        // Under a forbidden dir → rejected.
        assert!(!workspace_allowed(
            Path::new("/Users/x/Library/Application Support/cardo/models"),
            &forbidden
        ));
        assert!(!workspace_allowed(
            Path::new("/Users/x/Library/Application Support/cardo-config/deep/nested"),
            &forbidden
        ));
        // Sibling with a shared name prefix (NOT a path component match) → allowed.
        assert!(workspace_allowed(
            Path::new("/Users/x/Library/Application Support/cardo-notes"),
            &forbidden
        ));
        // Unrelated dir → allowed.
        assert!(workspace_allowed(Path::new("/Users/x/Documents/Notizen"), &forbidden));
        // Parent of a forbidden dir → allowed (forbidding cascades down, not up).
        assert!(workspace_allowed(
            Path::new("/Users/x/Library/Application Support"),
            &forbidden
        ));
        // No forbidden dirs → everything allowed.
        assert!(workspace_allowed(Path::new("/anything"), &[]));
    }

    #[test]
    fn model_allowlist() {
        for good in [
            "fable-5",
            "opus",
            "sonnet",
            "haiku",
            "claude-fable-5",
            "claude-opus-4-8",
            "claude-sonnet-5",
            "claude-haiku-4-5",
        ] {
            assert!(model_allowed(good), "should accept {good:?}");
        }
        for bad in [
            "",
            "Opus",
            "gpt-4",
            "claude-opus-4-8 ",
            "claude-3-5-sonnet",
            "sonnet-5",
            "opus;rm -rf /",
        ] {
            assert!(!model_allowed(bad), "should reject {bad:?}");
        }
    }

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
    fn result_extraction() {
        assert_eq!(
            extract_result(r#"{"result": "Hallo!", "cost_usd": 0.01}"#).as_deref(),
            Some("Hallo!")
        );
        assert_eq!(
            extract_result("\n  {\"result\": \"x\"}  \n").as_deref(),
            Some("x")
        );
        // No result field / non-string result / invalid JSON → None.
        assert_eq!(extract_result(r#"{"type": "text"}"#), None);
        assert_eq!(extract_result(r#"{"result": 42}"#), None);
        assert_eq!(extract_result("plain text output"), None);
        assert_eq!(extract_result(""), None);
    }

    #[test]
    fn stderr_tail_and_hint() {
        assert_eq!(stderr_tail("  short error \n"), "short error");
        let long = "x".repeat(2000);
        assert_eq!(stderr_tail(&long).chars().count(), STDERR_TAIL_CHARS);

        assert_eq!(auth_hint("Invalid API key · Please run /login"), " (not logged in?)");
        assert_eq!(auth_hint("authentication_error"), " (not logged in?)");
        assert_eq!(auth_hint("some network problem"), "");
    }
}
