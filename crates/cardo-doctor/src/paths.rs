//! Where Cardo keeps its data — derived without Tauri.
//!
//! Tauri 2 resolves `app_data_dir()` as `dirs::data_dir()/<identifier>`:
//!   macOS   ~/Library/Application Support/app.cardo.desktop
//!   Linux   ~/.local/share/app.cardo.desktop
//!   Windows %APPDATA%\app.cardo.desktop
//!
//! Deriving this ourselves is a drift risk: if Tauri ever changes its
//! resolution, the doctor would silently inspect the wrong directory and
//! report a healthy installation that isn't the one running. The in-app
//! `env:data-dir` check therefore compares this derivation against the real
//! `AppHandle::app_data_dir()` and fails loudly on any mismatch — the doctor
//! alone cannot detect that.

use std::path::PathBuf;

/// Must match `identifier` in apps/desktop/src-tauri/tauri.conf.json.
pub const IDENTIFIER: &str = "app.cardo.desktop";

/// The live database file name, as opened by `SqliteStorage`.
pub const DB_FILE: &str = "cardo.db";

/// Derived app data directory, or an error explaining why it is unknown.
pub fn app_data_dir() -> Result<PathBuf, String> {
    let base = dirs::data_dir()
        .ok_or_else(|| "no platform data directory (is HOME set?)".to_string())?;
    Ok(base.join(IDENTIFIER))
}

/// Path of the live database inside `dir`.
pub fn db_path(dir: &std::path::Path) -> PathBuf {
    dir.join(DB_FILE)
}

/// Where the installed bundle lives, if this platform has a fixed location.
/// Only macOS is checked: that is the demo machine, and the other platforms
/// have no single canonical install path worth guessing at.
pub fn installed_bundle() -> Option<PathBuf> {
    if cfg!(target_os = "macos") {
        let path = PathBuf::from("/Applications/Cardo.app");
        if path.is_dir() {
            return Some(path);
        }
    }
    None
}

/// `CFBundleShortVersionString` from a macOS bundle's Info.plist.
///
/// Parsed textually rather than with a plist crate: the file is a tiny,
/// well-known XML shape, and this avoids a dependency for one field.
pub fn bundle_version(bundle: &std::path::Path) -> Result<String, String> {
    let plist = bundle.join("Contents").join("Info.plist");
    let raw = std::fs::read_to_string(&plist)
        .map_err(|e| format!("{}: {e}", plist.display()))?;
    parse_bundle_version(&raw)
        .ok_or_else(|| "CFBundleShortVersionString not found in Info.plist".to_string())
}

/// Value of the `<string>` following `<key>CFBundleShortVersionString</key>`.
fn parse_bundle_version(plist: &str) -> Option<String> {
    let after_key = plist.split("<key>CFBundleShortVersionString</key>").nth(1)?;
    let start = after_key.find("<string>")? + "<string>".len();
    let rest = &after_key[start..];
    let end = rest.find("</string>")?;
    let value = rest[..end].trim();
    if value.is_empty() {
        None
    } else {
        Some(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_matches_tauri_conf() {
        // Guards the one hard-coded string that would make the doctor inspect
        // a directory the app never uses.
        let conf = include_str!("../../../apps/desktop/src-tauri/tauri.conf.json");
        let parsed: serde_json::Value = serde_json::from_str(conf).unwrap();
        assert_eq!(parsed["identifier"].as_str(), Some(IDENTIFIER));
    }

    #[test]
    fn data_dir_ends_with_the_identifier() {
        let dir = app_data_dir().expect("platform data dir");
        assert!(dir.ends_with(IDENTIFIER), "unexpected data dir: {}", dir.display());
    }

    #[test]
    fn bundle_version_is_parsed() {
        let plist = r#"<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Cardo</string>
  <key>CFBundleShortVersionString</key>
  <string>1.1.3</string>
</dict>
</plist>"#;
        assert_eq!(parse_bundle_version(plist).as_deref(), Some("1.1.3"));
    }

    #[test]
    fn bundle_version_missing_or_empty_is_none() {
        assert_eq!(parse_bundle_version("<plist></plist>"), None);
        assert_eq!(
            parse_bundle_version("<key>CFBundleShortVersionString</key><string>  </string>"),
            None
        );
        // Key present but no string element after it.
        assert_eq!(parse_bundle_version("<key>CFBundleShortVersionString</key>"), None);
    }

    #[test]
    fn bundle_version_is_not_confused_by_an_earlier_key() {
        let plist = r#"<key>CFBundleVersion</key><string>99</string>
<key>CFBundleShortVersionString</key><string>1.1.3</string>"#;
        assert_eq!(parse_bundle_version(plist).as_deref(), Some("1.1.3"));
    }
}
