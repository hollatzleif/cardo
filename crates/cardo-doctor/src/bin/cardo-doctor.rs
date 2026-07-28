//! Headless entry point — the binary behind `pnpm preflight`.
//!
//! Answers one question: is the Cardo installation on THIS machine ready to be
//! demoed right now? Exit codes: 0 healthy, 1 something is broken, 2 warnings
//! only.

use std::path::PathBuf;
use std::process::ExitCode;

use cardo_doctor::checks::{run_env_checks, EnvContext};

const USAGE: &str = "\
cardo-doctor — checks that this Cardo INSTALLATION is healthy.

USAGE:
    cargo run -p cardo-doctor -- [OPTIONS]

OPTIONS:
    --json                  Machine-readable output
    --ci                    Build-agent mode: a missing installation is
                            expected and reported as skipped, and warnings
                            do not affect the exit code
    --expect-version <V>    Version this checkout should have installed
    --data-dir <PATH>       Inspect this directory instead of the derived one
    --skip <A,B>            Skip checks: db, single-instance, claude,
                            keychain, sync, installed-app, disk
    -h, --help              This text

EXIT CODES:
    0  everything healthy (or skipped)
    1  at least one check failed
    2  warnings only
";

struct Args {
    json: bool,
    ci: bool,
    expect_version: Option<String>,
    data_dir: Option<PathBuf>,
    skip: Vec<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut args = Args {
        json: false,
        ci: false,
        expect_version: None,
        data_dir: None,
        skip: Vec::new(),
    };
    let mut it = std::env::args().skip(1);
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--json" => args.json = true,
            "--ci" => args.ci = true,
            "-h" | "--help" => {
                print!("{USAGE}");
                std::process::exit(0);
            }
            "--expect-version" => {
                args.expect_version =
                    Some(it.next().ok_or("--expect-version needs a value")?);
            }
            "--data-dir" => {
                args.data_dir = Some(PathBuf::from(
                    it.next().ok_or("--data-dir needs a value")?,
                ));
            }
            "--skip" => {
                let raw = it.next().ok_or("--skip needs a value")?;
                args.skip = raw.split(',').map(|s| s.trim().to_string()).collect();
            }
            // `--skip=a,b` form.
            other if other.starts_with("--skip=") => {
                args.skip = other["--skip=".len()..]
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .collect();
            }
            other if other.starts_with("--expect-version=") => {
                args.expect_version = Some(other["--expect-version=".len()..].to_string());
            }
            other if other.starts_with("--data-dir=") => {
                args.data_dir = Some(PathBuf::from(&other["--data-dir=".len()..]));
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(args)
}

fn main() -> ExitCode {
    let args = match parse_args() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("cardo-doctor: {e}\n\n{USAGE}");
            return ExitCode::from(1);
        }
    };

    let data_dir = match args.data_dir.clone() {
        Some(d) => d,
        None => match cardo_doctor::paths::app_data_dir() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("cardo-doctor: {e}");
                return ExitCode::from(1);
            }
        },
    };

    let ctx = EnvContext {
        data_dir,
        // Headless: nothing authoritative to compare against. Only the in-app
        // run can detect path drift.
        tauri_data_dir: None,
        expect_version: args.expect_version.clone(),
        self_pid: None,
        // A separate binary from the app: it cannot know what the app bundle
        // was compiled with, so this check reports as skipped here.
        drive_secret_present: None,
        skip: args.skip.clone(),
        ci: args.ci,
    };

    let runtime = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("cardo-doctor: cannot start async runtime: {e}");
            return ExitCode::from(1);
        }
    };
    let results = runtime.block_on(run_env_checks(&ctx));

    let failed = results.iter().filter(|r| r.status == "fail").count();
    let warned = results.iter().filter(|r| r.status == "warn" && !r.skipped).count();
    let skipped = results.iter().filter(|r| r.skipped).count();
    let passed = results.iter().filter(|r| r.status == "pass").count();

    if args.json {
        let payload = serde_json::json!({
            "checks": results.iter().map(|r| serde_json::json!({
                "id": r.id,
                "status": if r.skipped { "skip" } else { r.status.as_str() },
                "detail": r.detail,
            })).collect::<Vec<_>>(),
            "summary": {
                "passed": passed, "warned": warned,
                "failed": failed, "skipped": skipped,
            },
        });
        println!("{}", serde_json::to_string_pretty(&payload).unwrap_or_default());
    } else {
        println!("Cardo Preflight — {}\n", ctx.data_dir.display());
        for r in &results {
            let icon = if r.skipped {
                "⏭"
            } else {
                match r.status.as_str() {
                    "pass" => "✓",
                    "warn" => "!",
                    _ => "✗",
                }
            };
            let id = r.id.strip_prefix("env:").unwrap_or(&r.id);
            match &r.detail {
                Some(d) => println!("  {icon}  {id:<16} {d}"),
                None => println!("  {icon}  {id}"),
            }
        }
        println!("\n  {passed} ok · {warned} warnings · {failed} failed · {skipped} skipped");
        if failed > 0 {
            println!("\n  NOT ready to demo — fix the ✗ entries above.");
        }
    }

    if failed > 0 {
        ExitCode::from(1)
    } else if warned > 0 && !args.ci {
        ExitCode::from(2)
    } else {
        ExitCode::SUCCESS
    }
}
