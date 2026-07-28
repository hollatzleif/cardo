//! Cardo Doctor — checks that the *installation* is healthy, not that the
//! *code* is correct.
//!
//! The main diagnose suite (339 checks) deliberately runs against a scratch
//! database so real user data is never touched. That makes it blind to the
//! failures that actually broke demos: a logged-out Claude CLI, a second app
//! instance holding the SQLite file, a stale installed bundle. Those are
//! properties of the machine, not of the code, and they live here.
//!
//! Two front ends share this one implementation:
//!   * the app, via the `diagnose_env` Tauri command → the "Environment"
//!     category in Settings → Diagnostics
//!   * `cargo run -p cardo-doctor` → `pnpm preflight`, run before a demo

pub mod checks;
pub mod claude;
pub mod db;
pub mod paths;
pub mod procs;

pub use checks::{run_env_checks, EnvContext};
/// Re-exported so the desktop crate keeps a single source of truth for where
/// the Claude CLI lives and how its version string is parsed.
pub use claude::{find_claude_cli, parse_version};
