//! Tauri host for the RDB desktop client.
//!
//! Ships with only `rdb-core` (no DB drivers). At startup it discovers
//! out-of-process plugins from the plugins directory and exposes them to the
//! frontend through five generic `#[tauri::command]`s (see [`commands`]).
//!
//! Plugins dir: `$RDB_PLUGINS_DIR` if set, else `<app-data>/plugins`.

mod commands;
mod github;
mod persistence;
mod plugin_manager;

use std::path::PathBuf;
use std::sync::Arc;

use plugin_manager::PluginManager;
use tauri::Manager;

/// Resolve the directory to scan for plugin manifests.
fn plugins_dir(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Ok(dir) = std::env::var("RDB_PLUGINS_DIR") {
        return Ok(PathBuf::from(dir));
    }
    Ok(app.path().app_data_dir()?.join("plugins"))
}

pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    tauri::Builder::default()
        .setup(|app| {
            let dir = plugins_dir(app)?;
            tracing::info!("discovering plugins in {}", dir.display());
            let manager = Arc::new(PluginManager::discover(&dir));
            app.manage(manager);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_plugins,
            commands::test_connection,
            commands::open_connection,
            commands::close_connection,
            commands::plugin_call,
            commands::preview_github_plugin,
            commands::install_github_plugin,
            persistence::load_connections,
            persistence::save_connections,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
