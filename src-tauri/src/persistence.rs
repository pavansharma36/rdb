//! Persistence for saved connection profiles.
//!
//! Profiles are stored as human-readable JSON, grouped by the plugin that owns
//! them: `<app_data_dir>/connections/<plugin_id>/connections.json`. Secret values
//! are stored in the OS keychain; only keychain references are written to JSON.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use crate::plugin_manager::PluginManager;
use rdb_core::{ConnectionConfig, PluginError, SecretField};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

/// A reusable connection the user has saved. Mirrors the frontend
/// `SavedConnection` (camelCase on the wire).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    pub name: String,
    pub plugin_id: String,
    pub config: ConnectionConfig,
    /// Sidebar sort position (ascending). Defaults to 0; only set when the user
    /// reorders the list via drag-and-drop.
    #[serde(default)]
    pub order: i64,
    /// Per-connection UI preferences (e.g. `treeWidth`, `editorHeight`), stored
    /// alongside the connection so they travel with it and vanish when the
    /// profile is deleted. A free-form map keeps it open to future prefs.
    #[serde(default)]
    pub settings: HashMap<String, serde_json::Value>,
}

/// `<app_data_dir>/connections` — the root holding one subdirectory per plugin.
fn connections_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("cannot resolve app data dir: {e}"))?;
    Ok(dir.join("connections"))
}

/// Reject plugin ids that could escape the connections root. Plugin ids are
/// used verbatim as directory names, so anything with a path separator or `..`
/// is refused rather than silently writing outside the intended tree.
fn validate_plugin_id(plugin_id: &str) -> Result<(), String> {
    if plugin_id.is_empty()
        || plugin_id == ".."
        || plugin_id.contains('/')
        || plugin_id.contains('\\')
    {
        return Err(format!("invalid plugin id: {plugin_id:?}"));
    }
    Ok(())
}

/// Load saved profiles from every `connections/<plugin_id>/connections.json`,
/// limited to plugins that are currently installed. Profiles whose owning
/// plugin is no longer installed are skipped (their files are left on disk).
/// Returns an empty list when nothing has been saved yet. Plugins are visited
/// in sorted order so the merged list is stable across loads.
#[tauri::command]
pub fn load_connections(
    app: AppHandle,
    manager: State<'_, Arc<PluginManager>>,
) -> Result<Vec<SavedConnection>, String> {
    let dir = connections_dir(&app)?;
    let installed: HashSet<String> = manager.list_plugins().into_iter().map(|p| p.id).collect();
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };

    // Collect connection files for installed plugins only, sorted by plugin id
    // for deterministic order.
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|name| installed.contains(name))
        })
        .map(|p| p.join("connections.json"))
        .collect();
    files.sort();

    let mut out = Vec::new();
    for file in files {
        match fs::read(&file) {
            Ok(bytes) => {
                let conns: Vec<SavedConnection> =
                    serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
                out.extend(conns);
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(out)
}

// Serialize read-modify-write operations so concurrent profile saves cannot
// overwrite each other within a plugin's connections.json.
static CONNECTION_WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Insert or replace one profile and return its reference-only saved config.
#[tauri::command]
pub fn save_connection(
    app: AppHandle,
    connection: SavedConnection,
) -> Result<SavedConnection, String> {
    let _guard = CONNECTION_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = connections_dir(&app)?;
    save_connection_in_dir(&dir, connection)
}

fn save_connection_in_dir(
    dir: &PathBuf,
    connection: SavedConnection,
) -> Result<SavedConnection, String> {
    validate_plugin_id(&connection.plugin_id)?;
    let all = read_all_connections(dir)?;
    if all
        .iter()
        .any(|old| old.id == connection.id && old.plugin_id != connection.plugin_id)
    {
        return Err("cannot change the plugin of an existing connection".into());
    }
    let old_refs = secret_refs(&all)?;
    let mut created = Vec::new();
    let result = (|| {
        let connection =
            transform_secrets(connection, &old_refs, &mut created).map_err(|e| e.to_string())?;
        let mut profiles: Vec<_> = all
            .into_iter()
            .filter(|old| old.plugin_id == connection.plugin_id)
            .collect();
        if let Some(old) = profiles.iter_mut().find(|old| old.id == connection.id) {
            *old = connection.clone();
        } else {
            profiles.push(connection.clone());
        }
        write_profiles(dir, &connection.plugin_id, &profiles)?;
        Ok(connection)
    })();
    if result.is_err() {
        for secret in created {
            let _ = secret.delete_key_ring();
        }
    } else {
        cleanup_secrets(dir, &old_refs);
    }
    result
}

/// Delete one saved profile without changing any other profile.
#[tauri::command]
pub fn delete_connection(app: AppHandle, connection_id: String) -> Result<(), String> {
    let _guard = CONNECTION_WRITE_LOCK.lock().map_err(|e| e.to_string())?;
    let dir = connections_dir(&app)?;
    delete_connection_in_dir(&dir, &connection_id)
}

fn delete_connection_in_dir(dir: &PathBuf, connection_id: &str) -> Result<(), String> {
    let all = read_all_connections(dir)?;
    let Some(connection) = all.iter().find(|old| old.id == connection_id) else {
        return Ok(());
    };
    validate_plugin_id(&connection.plugin_id)?;
    let old_refs = secret_refs(&all)?;
    let profiles: Vec<_> = all
        .iter()
        .filter(|old| old.plugin_id == connection.plugin_id && old.id != connection_id)
        .cloned()
        .collect();
    write_profiles(dir, &connection.plugin_id, &profiles)?;
    cleanup_secrets(dir, &old_refs);
    Ok(())
}

fn write_profiles(
    dir: &PathBuf,
    plugin_id: &str,
    profiles: &[SavedConnection],
) -> Result<(), String> {
    let plugin_dir = dir.join(plugin_id);
    fs::create_dir_all(&plugin_dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(profiles).map_err(|e| e.to_string())?;
    let temporary = plugin_dir.join("connections.json.tmp");
    fs::write(&temporary, json).map_err(|e| e.to_string())?;
    fs::rename(&temporary, plugin_dir.join("connections.json")).map_err(|e| e.to_string())
}

fn cleanup_secrets(dir: &PathBuf, old_refs: &HashSet<String>) {
    // Cleanup failure must not report an already committed save as failed.
    match secret_refs_from_files(dir) {
        Ok(retained) => {
            for reference in old_refs.difference(&retained) {
                if let Err(error) = SecretField::KeyRing(reference.clone()).delete_key_ring() {
                    tracing::warn!("cannot clean up unused keychain entry: {error}");
                }
            }
        }
        Err(error) => tracing::warn!("cannot inspect keychain references for cleanup: {error}"),
    }
}

fn read_all_connections(dir: &PathBuf) -> Result<Vec<SavedConnection>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.to_string()),
    };
    let mut files: Vec<PathBuf> = entries
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())?;
    files.retain(|path| path.is_dir());
    files.sort();

    let mut connections = Vec::new();
    for file in files.into_iter().map(|path| path.join("connections.json")) {
        match fs::read(file) {
            Ok(bytes) => connections.extend(
                serde_json::from_slice::<Vec<SavedConnection>>(&bytes)
                    .map_err(|e| e.to_string())?,
            ),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(connections)
}

fn secret_refs(connections: &[SavedConnection]) -> Result<HashSet<String>, String> {
    let mut references = HashSet::new();
    for value in connections
        .iter()
        .flat_map(|connection| connection.config.values())
    {
        if !matches!(
            value.get("type").and_then(serde_json::Value::as_str),
            Some("KEY_RING")
        ) {
            continue;
        }
        let SecretField::KeyRing(reference) = serde_json::from_value(value.clone())
            .map_err(|e| format!("invalid keychain secret reference: {e}"))?
        else {
            continue;
        };
        references.insert(reference);
    }
    Ok(references)
}

fn secret_refs_from_files(dir: &PathBuf) -> Result<HashSet<String>, String> {
    secret_refs(&read_all_connections(dir)?)
}

fn transform_secrets(
    mut conn: SavedConnection,
    old_refs: &HashSet<String>,
    created: &mut Vec<SecretField>,
) -> Result<SavedConnection, PluginError> {
    for (k, v) in conn.config.iter_mut() {
        let Ok(secret) = serde_json::from_value::<SecretField>(v.clone()) else {
            continue;
        };
        let plain = match secret {
            SecretField::PlainText(value) => value,
            SecretField::KeyRing(ref reference)
                if reference.starts_with(&format!("connection:{}:{k}:", conn.id))
                    && old_refs.contains(reference) =>
            {
                continue
            }
            // Copy references owned by another profile when cloning. Legacy
            // entries without a version suffix are migrated on their next save.
            other => other.reveal()?,
        };
        let secret = SecretField::key_ring_from_plain(&conn.id, k, plain)?;
        created.push(secret.clone());
        *v = serde_json::to_value(secret).map_err(|e| PluginError::Backend(e.to_string()))?;
    }
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, plugin: &str, name: &str) -> SavedConnection {
        SavedConnection {
            id: id.into(),
            name: name.into(),
            plugin_id: plugin.into(),
            config: HashMap::new(),
            order: 0,
            settings: HashMap::new(),
        }
    }

    #[test]
    fn saving_and_deleting_one_profile_preserves_other_profiles_and_plugins() {
        let dir = std::env::temp_dir().join(format!(
            "rdb-persistence-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        save_connection_in_dir(&dir, profile("a", "postgres", "first")).unwrap();
        save_connection_in_dir(&dir, profile("b", "postgres", "second")).unwrap();
        save_connection_in_dir(&dir, profile("c", "mysql", "third")).unwrap();
        let other_file = dir.join("mysql/connections.json");
        let other_bytes = fs::read(&other_file).unwrap();

        save_connection_in_dir(&dir, profile("a", "postgres", "edited")).unwrap();
        let all = read_all_connections(&dir).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all.iter().find(|p| p.id == "a").unwrap().name, "edited");
        assert_eq!(all.iter().find(|p| p.id == "b").unwrap().name, "second");
        assert_eq!(fs::read(&other_file).unwrap(), other_bytes);
        assert!(save_connection_in_dir(&dir, profile("a", "mysql", "moved")).is_err());

        // A failed staging write must leave the existing profile file intact.
        let profile_file = dir.join("postgres/connections.json");
        let before_failure = fs::read(&profile_file).unwrap();
        let staging = dir.join("postgres/connections.json.tmp");
        fs::create_dir(&staging).unwrap();
        assert!(save_connection_in_dir(&dir, profile("a", "postgres", "failed")).is_err());
        assert_eq!(fs::read(&profile_file).unwrap(), before_failure);
        fs::remove_dir(staging).unwrap();

        delete_connection_in_dir(&dir, "a").unwrap();
        delete_connection_in_dir(&dir, "a").unwrap();
        let all = read_all_connections(&dir).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.iter().all(|p| p.id != "a"));
        assert_eq!(fs::read(&other_file).unwrap(), other_bytes);
        fs::remove_dir_all(dir).unwrap();
    }
}
