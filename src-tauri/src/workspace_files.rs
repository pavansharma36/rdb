//! Per-connection workspace files (saved SQL snippets / shell scripts).
//!
//! Each saved profile gets its own folder of plain files at
//! `<app_data_dir>/workspace/<connection_id>/<name>.<ext>`, where `connection_id`
//! is the stable saved-profile id (not the per-session live connection id) and
//! `ext` is the file extension (e.g. `sql` for the RDBMS workspace, `sh` for the
//! SSH/CLI workspace). Files are human-readable and can be inspected or edited
//! outside the app.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// A saved workspace file. Mirrors the frontend `WorkspaceFile` (camelCase).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFile {
    /// File name without the extension.
    pub name: String,
    pub content: String,
}

/// `<app_data_dir>/workspace/<connection_id>` — the folder of files for one profile.
fn workspace_dir(app: &AppHandle, connection_id: &str) -> Result<PathBuf, String> {
    validate_segment(connection_id, "connection id")?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    Ok(dir.join("workspace").join(connection_id))
}

/// Reject ids/names that could escape the intended folder; they're used verbatim
/// as path segments.
fn validate_segment(value: &str, what: &str) -> Result<(), String> {
    if value.is_empty()
        || value == ".."
        || value.contains('/')
        || value.contains('\\')
    {
        return Err(format!("invalid {what}: {value:?}"));
    }
    Ok(())
}

/// Validate a file extension: non-empty, alphanumeric only (so it can't be used
/// to smuggle a path separator or dotfile trickery into the file name).
fn validate_ext(ext: &str) -> Result<(), String> {
    if ext.is_empty() || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(format!("invalid extension: {ext:?}"));
    }
    Ok(())
}

/// List the saved workspace files with extension `ext` for `connection_id`,
/// sorted by name. Returns an empty list when the profile has no workspace
/// folder yet.
#[tauri::command]
pub fn list_workspace_files(
    app: AppHandle,
    connection_id: String,
    ext: String,
) -> Result<Vec<WorkspaceFile>, String> {
    validate_ext(&ext)?;
    let dir = workspace_dir(&app, &connection_id)?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some(ext.as_str()) {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        files.push(WorkspaceFile {
            name: name.to_string(),
            content,
        });
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(files)
}

/// Create or overwrite `<name>.<ext>` for `connection_id`.
#[tauri::command]
pub fn save_workspace_file(
    app: AppHandle,
    connection_id: String,
    name: String,
    content: String,
    ext: String,
) -> Result<(), String> {
    validate_segment(&name, "workspace file name")?;
    validate_ext(&ext)?;
    let dir = workspace_dir(&app, &connection_id)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::write(dir.join(format!("{name}.{ext}")), content).map_err(|e| e.to_string())
}

/// Delete `<name>.<ext>` for `connection_id`. Missing files are treated as success.
#[tauri::command]
pub fn delete_workspace_file(
    app: AppHandle,
    connection_id: String,
    name: String,
    ext: String,
) -> Result<(), String> {
    validate_segment(&name, "workspace file name")?;
    validate_ext(&ext)?;
    let dir = workspace_dir(&app, &connection_id)?;
    match fs::remove_file(dir.join(format!("{name}.{ext}"))) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}
