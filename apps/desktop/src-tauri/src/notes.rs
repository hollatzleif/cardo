//! Notes live as plain .md files in a user-visible folder (Obsidian
//! principle: the data belongs to the user). The webview only ever
//! addresses notes by file name; every path is resolved and validated
//! inside the configured notes folder – no traversal, no foreign files.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Default)]
pub struct NotesState {
    dir: Mutex<Option<PathBuf>>,
}

#[derive(serde::Serialize)]
pub struct NoteMeta {
    pub name: String,
    pub modified_ms: u64,
    pub size: u64,
}

type CmdResult<T> = Result<T, String>;

fn validate_name(name: &str) -> CmdResult<()> {
    let ok = !name.is_empty()
        && name.len() <= 255
        && name.ends_with(".md")
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
        && !name.starts_with('.');
    if ok { Ok(()) } else { Err(format!("invalid note name \"{name}\"")) }
}

fn current_dir(state: &NotesState) -> CmdResult<PathBuf> {
    state
        .dir
        .lock()
        .map_err(|_| "notes state poisoned".to_string())?
        .clone()
        .ok_or_else(|| "no notes folder configured".to_string())
}

fn note_path(dir: &Path, name: &str) -> CmdResult<PathBuf> {
    validate_name(name)?;
    Ok(dir.join(name))
}

#[tauri::command]
pub fn notes_set_folder(state: tauri::State<'_, NotesState>, path: String) -> CmdResult<String> {
    let dir = PathBuf::from(&path);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let canonical = dir.canonicalize().map_err(|e| e.to_string())?;
    if !canonical.is_dir() {
        return Err(format!("not a directory: {path}"));
    }
    *state.dir.lock().map_err(|_| "notes state poisoned".to_string())? = Some(canonical.clone());
    Ok(canonical.to_string_lossy().to_string())
}

/// Zero-setup default: a visible "Cardo Notes" folder in the user's
/// documents (fallback: app data dir). Created on demand.
#[tauri::command]
pub fn notes_default_folder(
    app: tauri::AppHandle,
    state: tauri::State<'_, NotesState>,
) -> CmdResult<String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().app_data_dir())
        .map_err(|e| e.to_string())?;
    notes_set_folder(state, base.join("Cardo Notes").to_string_lossy().to_string())
}

#[tauri::command]
pub fn notes_get_folder(state: tauri::State<'_, NotesState>) -> Option<String> {
    state
        .dir
        .lock()
        .ok()
        .and_then(|d| d.clone())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn notes_list(state: tauri::State<'_, NotesState>) -> CmdResult<Vec<NoteMeta>> {
    let dir = current_dir(&state)?;
    let mut notes = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.ends_with(".md") || name.starts_with('.') || !entry.path().is_file() {
            continue;
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        notes.push(NoteMeta { name, modified_ms, size: meta.len() });
    }
    notes.sort_by_key(|n| std::cmp::Reverse(n.modified_ms));
    Ok(notes)
}

#[tauri::command]
pub fn notes_read(state: tauri::State<'_, NotesState>, name: String) -> CmdResult<String> {
    let path = note_path(&current_dir(&state)?, &name)?;
    std::fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notes_write(
    state: tauri::State<'_, NotesState>,
    name: String,
    content: String,
) -> CmdResult<()> {
    let path = note_path(&current_dir(&state)?, &name)?;
    std::fs::write(path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notes_rename(
    state: tauri::State<'_, NotesState>,
    from: String,
    to: String,
) -> CmdResult<()> {
    let dir = current_dir(&state)?;
    let from_path = note_path(&dir, &from)?;
    let to_path = note_path(&dir, &to)?;
    if to_path.exists() {
        return Err(format!("note \"{to}\" already exists"));
    }
    std::fs::rename(from_path, to_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notes_delete(state: tauri::State<'_, NotesState>, name: String) -> CmdResult<()> {
    let path = note_path(&current_dir(&state)?, &name)?;
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_traversal_and_non_md() {
        for bad in ["../x.md", "a/b.md", "a\\b.md", ".hidden.md", "x.txt", ""] {
            assert!(validate_name(bad).is_err(), "should reject {bad:?}");
        }
        assert!(validate_name("hello world.md").is_ok());
    }

    #[test]
    fn roundtrip_in_temp_dir() {
        let tmp = std::env::temp_dir().join(format!("cardo-notes-test-{}", std::process::id()));
        std::fs::create_dir_all(&tmp).unwrap();
        let state = NotesState::default();
        *state.dir.lock().unwrap() = Some(tmp.canonicalize().unwrap());

        let dir = current_dir(&state).unwrap();
        let path = note_path(&dir, "probe.md").unwrap();
        std::fs::write(&path, "# hi").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# hi");
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir_all(tmp).unwrap();
    }
}
