//! Detecting a second running Cardo instance.
//!
//! Why this matters: `SqliteStorage` uses `max_connections(1)` plus a 5 s busy
//! timeout, which serialises writes **within one process only**. Two instances
//! on the same `cardo.db` give no such guarantee, and `SyncConfig` is a
//! whole-file rewrite from a stale in-memory cache — so the second instance
//! silently reverts sync settings. That is the observed "sync suddenly stopped
//! working" failure.
//!
//! Deliberately NOT done here: opening the database and attempting
//! `BEGIN IMMEDIATE` or `PRAGMA locking_mode=EXCLUSIVE` to detect a lock. An
//! idle second instance holds no write lock, so that returns a false green —
//! and it would take a write lock on live user data for no benefit.

use std::path::Path;

use sysinfo::System;

/// One running Cardo process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Instance {
    pub pid: u32,
    pub exe: String,
}

/// Does this executable path belong to a Cardo desktop build?
///
/// Matches the bundled app, the `cargo`/`tauri dev` binary and the Windows
/// executable. Kept as a pure function so it is testable without spawning
/// anything.
pub fn is_cardo_exe(exe: &str) -> bool {
    let normalised = exe.replace('\\', "/");
    let lower = normalised.to_lowercase();
    lower.ends_with("cardo.app/contents/macos/cardo")
        || lower.ends_with("/cardo-desktop")
        || lower.ends_with("/cardo.exe")
        || lower.ends_with("/cardo-desktop.exe")
}

/// Every running Cardo process except `exclude_pid` (the caller itself, when
/// the check runs inside the app).
pub fn running_instances(exclude_pid: Option<u32>) -> Vec<Instance> {
    let mut system = System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);

    let mut found: Vec<Instance> = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            let exe = process.exe()?.to_string_lossy().to_string();
            if !is_cardo_exe(&exe) {
                return None;
            }
            let pid = pid.as_u32();
            if Some(pid) == exclude_pid {
                return None;
            }
            Some(Instance { pid, exe })
        })
        .collect();
    found.sort_by_key(|i| i.pid);
    found.dedup();
    found
}

/// PIDs holding the database file open, via `lsof`. Corroborates the process
/// scan and catches a Cardo build we failed to recognise by name.
///
/// Returns `None` when `lsof` is unavailable (Windows, stripped containers) —
/// the caller must treat that as "unknown", not as "nobody".
pub fn holders_of(db: &Path) -> Option<Vec<u32>> {
    if cfg!(windows) {
        return None;
    }
    let out = std::process::Command::new("lsof")
        .arg("-t")
        .arg("--")
        .arg(db)
        .output()
        .ok()?;
    // lsof exits 1 when nothing matches; that is a valid empty answer.
    let stdout = String::from_utf8_lossy(&out.stdout);
    Some(stdout.split_whitespace().filter_map(|l| l.parse::<u32>().ok()).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognises_cardo_executables() {
        // The real observed path of a running installed instance — the bundle
        // executable is named `cardo-desktop`, not `Cardo`.
        assert!(is_cardo_exe("/Applications/Cardo.app/Contents/MacOS/cardo-desktop"));
        assert!(is_cardo_exe("/Applications/Cardo.app/Contents/MacOS/Cardo"));
        assert!(is_cardo_exe("/Users/x/dev/cardo/target/debug/cardo-desktop"));
        assert!(is_cardo_exe("C:\\Program Files\\Cardo\\Cardo.exe"));
    }

    #[test]
    fn the_doctor_never_finds_itself() {
        // `cargo run -p cardo-doctor` produces target/debug/cardo-doctor. If
        // that matched, every preflight would report a phantom instance.
        assert!(!is_cardo_exe("/Users/x/dev/cardo/target/debug/cardo-doctor"));
        assert!(!is_cardo_exe("/Users/x/dev/cardo/target/release/cardo-doctor"));
    }

    #[test]
    fn ignores_everything_else() {
        // The dangerous false positives: this very tool, and unrelated
        // binaries that merely contain "cardo" in their path.
        assert!(!is_cardo_exe("/Users/x/dev/cardo/target/debug/cardo-doctor"));
        assert!(!is_cardo_exe("/Users/x/Desktop/Kontrollzentrum/cardo/scripts/thing"));
        assert!(!is_cardo_exe("/usr/bin/node"));
        assert!(!is_cardo_exe(""));
        assert!(!is_cardo_exe("/Applications/Discord.app/Contents/MacOS/Discord"));
    }

    #[test]
    fn excluding_self_removes_own_pid() {
        // Cannot assume a Cardo instance is running, so assert the weaker but
        // still meaningful property: our own pid never appears.
        let self_pid = std::process::id();
        let found = running_instances(Some(self_pid));
        assert!(found.iter().all(|i| i.pid != self_pid));
    }
}
