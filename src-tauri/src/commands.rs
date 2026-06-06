//! `#[tauri::command]` bridge between the frontend and the [`PluginManager`].
//!
//! Five generic commands cover the whole surface: the host is a pure pipe and
//! knows nothing about SQL/documents/queues. `plugin_call` forwards an opaque
//! `op` + `params` to the plugin that owns the connection.

use std::sync::Arc;

use rdb_core::{ConnectionConfig, ConnectionId, PluginInfo};
use serde_json::Value;
use tauri::State;

use crate::plugin_manager::{AvailablePlugin, GithubPreview, PluginManager};

/// Shared manager handle managed by Tauri.
type Manager<'a> = State<'a, Arc<PluginManager>>;

/// Convert any displayable error into the string the frontend receives.
fn err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub fn list_plugins(manager: Manager<'_>) -> Vec<PluginInfo> {
    manager.list_plugins()
}

/// The release channel this app build tracks (`"nightly"` or `"stable"`). Gates
/// the installer's plugin channel and drives the nightly logo badge.
#[tauri::command]
pub fn app_channel() -> String {
    crate::release_channel().to_string()
}

#[tauri::command]
pub async fn test_connection(
    manager: Manager<'_>,
    plugin_id: String,
    config: ConnectionConfig,
) -> Result<(), String> {
    manager.test_connection(&plugin_id, config).await.map_err(err)
}

#[tauri::command]
pub async fn open_connection(
    manager: Manager<'_>,
    plugin_id: String,
    config: ConnectionConfig,
) -> Result<ConnectionId, String> {
    manager.open_connection(&plugin_id, config).await.map_err(err)
}

#[tauri::command]
pub async fn close_connection(
    manager: Manager<'_>,
    connection_id: ConnectionId,
) -> Result<(), String> {
    manager.close_connection(connection_id).await.map_err(err)
}

/// Forward an opaque capability call to the plugin owning `connection_id`.
/// `op` is a plugin-defined string (e.g. `"rdbms.execute"`); `params` is passed
/// through untouched.
#[tauri::command]
pub async fn plugin_call(
    manager: Manager<'_>,
    connection_id: ConnectionId,
    op: String,
    params: Value,
) -> Result<Value, String> {
    manager
        .plugin_call(connection_id, op, params)
        .await
        .map_err(err)
}

/// Cancel the in-flight `plugin_call` for `connection_id`, if any.
#[tauri::command]
pub async fn cancel_last_plugin_call(
    manager: Manager<'_>,
    connection_id: ConnectionId,
) -> Result<(), String> {
    manager.cancel(connection_id).await.map_err(err)
}

/// List the plugins installable from `repo` (`owner/name`): the rolling
/// `plugins-latest` release's assets with a binary for this platform, one entry
/// per plugin. No download.
#[tauri::command]
pub async fn list_github_plugins(
    manager: Manager<'_>,
    repo: String,
) -> Result<Vec<AvailablePlugin>, String> {
    manager.list_github_plugins(&repo).await
}

/// Resolve a GitHub release and report the asset + checksum that would be
/// installed, without downloading the binary or executing anything.
/// `plugin_id` disambiguates when a single release publishes several plugins.
#[tauri::command]
pub async fn preview_github_plugin(
    manager: Manager<'_>,
    repo: String,
    tag: Option<String>,
    plugin_id: Option<String>,
) -> Result<GithubPreview, String> {
    manager.preview_github(&repo, tag, plugin_id.as_deref()).await
}

/// Download, checksum-verify, and install the plugin from the previewed release.
/// `expected_sha` is the checksum the user confirmed (`None` = no published
/// checksum, install anyway). Returns the installed plugin's info.
#[tauri::command]
pub async fn install_github_plugin(
    manager: Manager<'_>,
    repo: String,
    tag: String,
    plugin_id: String,
    expected_sha: Option<String>,
) -> Result<PluginInfo, String> {
    manager.install_github(&repo, &tag, Some(&plugin_id), expected_sha).await
}
