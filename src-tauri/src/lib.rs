//! Tauri host for the RDB desktop client.
//!
//! Ships with only `rdb-core` (no DB drivers). At startup it discovers
//! out-of-process plugins from the plugins directory and exposes them to the
//! frontend through five generic `#[tauri::command]`s (see [`commands`]).
//!
//! Plugins dir: `$RDB_PLUGINS_DIR` if set, else `<app-data>/plugins`.

mod commands;
mod config;
mod github;
mod persistence;
mod plugin_manager;
mod update;

use std::path::PathBuf;
use std::sync::Arc;

use plugin_manager::PluginManager;
use tauri::Manager;

/// The release channel this app binary was built for. Stamped at build time by
/// `publish-app.yml` via `RDB_RELEASE_CHANNEL`; defaults to `nightly` for
/// local/dev builds so they track nightly plugin releases. Gates which plugin
/// channel the in-app installer offers and drives the nightly logo badge.
pub fn release_channel() -> &'static str {
    option_env!("RDB_RELEASE_CHANNEL").unwrap_or("nightly")
}

/// GitHub repo (`owner/name`) the app self-updates from.
pub(crate) const REPO: &str = "pavansharma36/rdb";

/// The updater manifest (`latest.json`) URL for a given `channel`. Nightly
/// tracks the rolling `latest` prerelease; stable tracks GitHub's "latest"
/// non-prerelease (the app's `vX.Y.Z`, since plugin releases use
/// `make_latest:false`).
pub(crate) fn updater_endpoint(channel: &str, repo: &str) -> String {
    if channel == "stable" {
        format!("https://github.com/{repo}/releases/latest/download/latest.json")
    } else {
        format!("https://github.com/{repo}/releases/download/latest/latest.json")
    }
}

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

            // Self-update: register the updater + process plugins. The
            // channel-aware endpoint is applied per-call in `update::*` via
            // `updater_builder()` (the init Builder has no `.endpoints`).
            #[cfg(desktop)]
            {
                app.handle().plugin(tauri_plugin_process::init())?;
                app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_plugins,
            commands::test_connection,
            commands::open_connection,
            commands::close_connection,
            commands::plugin_call,
            commands::list_github_plugins,
            commands::preview_github_plugin,
            commands::install_github_plugin,
            commands::app_channel,
            update::check_update,
            update::install_update,
            persistence::load_connections,
            persistence::save_connections,
            config::load_config,
            config::save_config,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updater_endpoint_is_channel_specific() {
        let repo = "pavansharma36/rdb";
        assert_eq!(
            updater_endpoint("stable", repo),
            "https://github.com/pavansharma36/rdb/releases/latest/download/latest.json"
        );
        assert_eq!(
            updater_endpoint("nightly", repo),
            "https://github.com/pavansharma36/rdb/releases/download/latest/latest.json"
        );
        // Unknown channels default to the nightly endpoint.
        assert_eq!(updater_endpoint("", repo), updater_endpoint("nightly", repo));
    }
}
