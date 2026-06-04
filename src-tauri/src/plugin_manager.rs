//! Out-of-process plugin manager: discovery, lazy process spawning, request
//! multiplexing, and connection routing.
//!
//! The host knows nothing about SQL/documents/queues. It discovers plugins from
//! `*.plugin.json` manifests, spawns each plugin's executable lazily on first
//! use, and routes opaque JSON `call`s to the plugin that owns a given
//! [`ConnectionId`]. A plugin process stays warm (holding its DB pools) until
//! the app exits.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, RwLock};

use rdb_core::protocol::{Request, Response, RpcError, PROTOCOL_VERSION};
use rdb_core::{ConnectionConfig, ConnectionId, PluginError, PluginInfo};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

use crate::github;

type RpcResult = std::result::Result<Value, RpcError>;
type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<RpcResult>>>>;

/// On-disk plugin manifest (`<id>.plugin.json`). `executable` may be relative,
/// in which case it resolves against the manifest's directory.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    plugin_info: PluginInfo,
    executable: String,
}

/// A discovered plugin: its advertised info plus the resolved executable path.
#[derive(Debug)]
struct DiscoveredPlugin {
    info: PluginInfo,
    executable: PathBuf,
}

/// A running plugin process plus the plumbing to talk to it. One per plugin id;
/// holds many connections.
struct PluginProcess {
    stdin_tx: mpsc::UnboundedSender<String>,
    pending: Pending,
    next_id: AtomicU64,
    alive: Arc<AtomicBool>,
    /// Kept alive so the child isn't reaped; dropped (killed) on manager drop.
    _child: Child,
}

impl PluginProcess {
    fn spawn(executable: &Path) -> std::result::Result<Self, String> {
        let mut child = Command::new(executable)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("failed to spawn plugin {}: {e}", executable.display()))?;

        let mut stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");

        let (stdin_tx, mut stdin_rx) = mpsc::unbounded_channel::<String>();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));

        // Writer: serialize outbound request lines onto the child's stdin.
        tokio::spawn(async move {
            while let Some(line) = stdin_rx.recv().await {
                if stdin.write_all(line.as_bytes()).await.is_err()
                    || stdin.write_all(b"\n").await.is_err()
                    || stdin.flush().await.is_err()
                {
                    break;
                }
            }
        });

        // Reader: match each response line to its waiting caller by id. On EOF
        // (child exited/crashed), mark dead and fail every in-flight request.
        let pending_r = pending.clone();
        let alive_r = alive.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(resp) = serde_json::from_str::<Response>(&line) {
                    if let Some(tx) = pending_r.lock().await.remove(&resp.id) {
                        let res = match resp.err {
                            Some(e) => Err(e),
                            None => Ok(resp.ok.unwrap_or(Value::Null)),
                        };
                        let _ = tx.send(res);
                    }
                }
            }
            alive_r.store(false, Ordering::SeqCst);
            let mut p = pending_r.lock().await;
            for (_, tx) in p.drain() {
                let _ = tx.send(Err(RpcError {
                    kind: "backend".into(),
                    message: "plugin process exited".into(),
                }));
            }
        });

        Ok(Self {
            stdin_tx,
            pending,
            next_id: AtomicU64::new(1),
            alive,
            _child: child,
        })
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Send one request and await its correlated response.
    async fn request(&self, method: &str, params: Value) -> Result<Value, PluginError> {
        if !self.is_alive() {
            return Err(PluginError::Backend("plugin process is not running".into()));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let req = Request {
            id,
            method: method.to_string(),
            params,
        };
        let line = serde_json::to_string(&req).map_err(|e| PluginError::Backend(e.to_string()))?;
        if self.stdin_tx.send(line).is_err() {
            self.pending.lock().await.remove(&id);
            return Err(PluginError::Backend("plugin process is not running".into()));
        }

        match rx.await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(rpc)) => Err(rpc.into()),
            Err(_) => Err(PluginError::Backend("plugin process exited".into())),
        }
    }
}

/// Discovers plugins and routes host commands to the right plugin process.
pub struct PluginManager {
    /// Directory holding plugin executables + `*.plugin.json` manifests; also
    /// the install target for plugins fetched from GitHub.
    plugins_dir: PathBuf,
    plugins: RwLock<HashMap<String, DiscoveredPlugin>>,
    processes: Mutex<HashMap<String, Arc<PluginProcess>>>,
    routes: Mutex<HashMap<ConnectionId, String>>,
}

/// What [`PluginManager::preview_github`] reports for the UI to confirm before
/// anything is downloaded or executed. `sha256` is `None` when the release
/// publishes no checksum for the asset.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GithubPreview {
    pub repo: String,
    pub tag: String,
    pub asset_name: String,
    pub size_bytes: u64,
    pub sha256: Option<String>,
    pub download_url: String,
}

impl PluginManager {
    /// Scan `dir` for `*.plugin.json` manifests, caching each plugin's info and
    /// executable. Never spawns a process. Malformed or version-incompatible
    /// manifests are logged and skipped.
    pub fn discover(dir: &Path) -> Self {
        let mut plugins = HashMap::new();
        match std::fs::read_dir(dir) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let is_manifest = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .is_some_and(|n| n.ends_with(".plugin.json"));
                    if !is_manifest {
                        continue;
                    }
                    match load_manifest(&path) {
                        Ok(p) => {
                            tracing::info!("discovered plugin '{}' ({})", p.info.id, path.display());
                            plugins.insert(p.info.id.clone(), p);
                        }
                        Err(e) => tracing::warn!("skipping plugin manifest {}: {e}", path.display()),
                    }
                }
            }
            Err(e) => tracing::warn!("plugins dir {} not readable: {e}", dir.display()),
        }
        Self {
            plugins_dir: dir.to_path_buf(),
            plugins: RwLock::new(plugins),
            processes: Mutex::new(HashMap::new()),
            routes: Mutex::new(HashMap::new()),
        }
    }

    /// Cached plugin infos — no process spawn.
    pub fn list_plugins(&self) -> Vec<PluginInfo> {
        self.plugins
            .read()
            .unwrap()
            .values()
            .map(|p| p.info.clone())
            .collect()
    }

    /// Get (or lazily spawn / respawn) the process for `plugin_id`.
    async fn process(&self, plugin_id: &str) -> Result<Arc<PluginProcess>, PluginError> {
        let mut procs = self.processes.lock().await;
        if let Some(p) = procs.get(plugin_id) {
            if p.is_alive() {
                return Ok(p.clone());
            }
            procs.remove(plugin_id);
        }
        let executable = {
            let plugins = self.plugins.read().unwrap();
            plugins
                .get(plugin_id)
                .map(|p| p.executable.clone())
                .ok_or_else(|| PluginError::NotFound(format!("plugin {plugin_id}")))?
        };
        let proc = Arc::new(PluginProcess::spawn(&executable).map_err(PluginError::Backend)?);
        procs.insert(plugin_id.to_string(), proc.clone());
        Ok(proc)
    }

    pub async fn test_connection(
        &self,
        plugin_id: &str,
        config: ConnectionConfig,
    ) -> Result<(), PluginError> {
        let proc = self.process(plugin_id).await?;
        proc.request("test", json!({ "config": config })).await?;
        Ok(())
    }

    pub async fn open_connection(
        &self,
        plugin_id: &str,
        config: ConnectionConfig,
    ) -> Result<ConnectionId, PluginError> {
        let proc = self.process(plugin_id).await?;
        let id = ConnectionId::new();
        proc.request("connect", json!({ "connectionId": id, "config": config }))
            .await?;
        self.routes.lock().await.insert(id, plugin_id.to_string());
        Ok(id)
    }

    pub async fn close_connection(&self, id: ConnectionId) -> Result<(), PluginError> {
        let plugin_id = self.routes.lock().await.remove(&id);
        if let Some(plugin_id) = plugin_id {
            // Best-effort: if the process is gone the connection is already gone.
            if let Some(proc) = self.processes.lock().await.get(&plugin_id).cloned() {
                let _ = proc.request("close", json!({ "connectionId": id })).await;
            }
        }
        Ok(())
    }

    /// Route an opaque capability call to the plugin that owns `connection_id`.
    pub async fn plugin_call(
        &self,
        connection_id: ConnectionId,
        op: String,
        params: Value,
    ) -> Result<Value, PluginError> {
        let plugin_id = self
            .routes
            .lock()
            .await
            .get(&connection_id)
            .cloned()
            .ok_or_else(|| PluginError::NotFound(format!("connection {connection_id:?}")))?;
        let proc = self.process(&plugin_id).await?;
        proc.request(
            "call",
            json!({ "connectionId": connection_id, "op": op, "params": params }),
        )
        .await
    }

    // -- GitHub install ----------------------------------------------------

    /// Resolve a GitHub release and report which asset would be installed and
    /// its published checksum, WITHOUT downloading the binary or executing
    /// anything. Drives the confirmation step in the UI.
    pub async fn preview_github(
        &self,
        repo: &str,
        tag: Option<String>,
    ) -> Result<GithubPreview, String> {
        let triple = github::target_triple()
            .ok_or_else(|| "unsupported platform: no known target triple".to_string())?;
        let release = github::fetch_release(repo, tag.as_deref()).await?;
        let asset = github::select_binary_asset(&release, triple)?;

        // The checksum file is small and safe to fetch (no execution).
        let sha256 = match github::find_checksum(&release, &asset.name) {
            Some(c) => {
                let text = github::download_text(&c.browser_download_url).await?;
                github::parse_sha256sums(&text, &asset.name)
            }
            None => None,
        };

        Ok(GithubPreview {
            repo: repo.to_string(),
            tag: release.tag_name.clone(),
            asset_name: asset.name.clone(),
            size_bytes: asset.size,
            sha256,
            download_url: asset.browser_download_url.clone(),
        })
    }

    /// Download, verify, and install the plugin from the release `tag` resolved
    /// during [`preview_github`]. `expected_sha` is the checksum the user
    /// confirmed; a mismatch is a hard error. `None` means the release published
    /// no checksum and the user opted to install anyway.
    pub async fn install_github(
        &self,
        repo: &str,
        tag: &str,
        expected_sha: Option<String>,
    ) -> Result<PluginInfo, String> {
        let triple = github::target_triple()
            .ok_or_else(|| "unsupported platform: no known target triple".to_string())?;
        let release = github::fetch_release(repo, Some(tag)).await?;
        let asset = github::select_binary_asset(&release, triple)?;
        let asset_name = asset.name.clone();

        let bytes = github::download_bytes(&asset.browser_download_url).await?;
        let actual = github::sha256_hex(&bytes);
        if let Some(expected) = &expected_sha {
            if !actual.eq_ignore_ascii_case(expected) {
                return Err(format!(
                    "checksum mismatch: expected {expected}, downloaded {actual}"
                ));
            }
        }

        // Place the binary in the plugins dir and make it executable.
        std::fs::create_dir_all(&self.plugins_dir).map_err(|e| e.to_string())?;
        let bin_path = self.plugins_dir.join(&asset_name);
        std::fs::write(&bin_path, &bytes).map_err(|e| e.to_string())?;
        set_executable(&bin_path)?;

        // Generate the manifest from the binary itself (checksum-verified bytes).
        let info = describe_binary(&bin_path).await?;
        if info.protocol_version != PROTOCOL_VERSION {
            let _ = std::fs::remove_file(&bin_path);
            return Err(format!(
                "plugin speaks protocol version {} but host speaks {PROTOCOL_VERSION}",
                info.protocol_version
            ));
        }

        let manifest_path = self.plugins_dir.join(format!("{}.plugin.json", info.id));
        let info_value = serde_json::to_value(&info).map_err(|e| e.to_string())?;
        let manifest = json!({ "pluginInfo": info_value, "executable": format!("./{asset_name}") });
        std::fs::write(
            &manifest_path,
            serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;

        // Replace any previously-running process for this id so the next call
        // spawns the new binary; register the plugin for discovery.
        self.processes.lock().await.remove(&info.id);
        self.plugins.write().unwrap().insert(
            info.id.clone(),
            DiscoveredPlugin {
                info: info.clone(),
                executable: bin_path,
            },
        );
        tracing::info!("installed plugin '{}' from {repo}@{tag}", info.id);
        Ok(info)
    }
}

/// Mark a file executable (no-op on non-Unix).
fn set_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(path).map_err(|e| e.to_string())?.permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(path, perms).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Run a plugin binary's `--describe` and parse its `PluginInfo`.
async fn describe_binary(bin_path: &Path) -> Result<PluginInfo, String> {
    let out = Command::new(bin_path)
        .arg("--describe")
        .output()
        .await
        .map_err(|e| format!("failed to run {} --describe: {e}", bin_path.display()))?;
    if !out.status.success() {
        return Err(format!(
            "{} --describe exited with {}: {}",
            bin_path.display(),
            out.status,
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    serde_json::from_slice::<PluginInfo>(&out.stdout)
        .map_err(|e| format!("invalid PluginInfo from --describe: {e}"))
}

/// Read and validate one manifest file, resolving its executable path.
fn load_manifest(path: &Path) -> Result<DiscoveredPlugin, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let manifest: Manifest = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;

    if manifest.plugin_info.protocol_version != PROTOCOL_VERSION {
        return Err(format!(
            "incompatible protocol version {} (host speaks {PROTOCOL_VERSION})",
            manifest.plugin_info.protocol_version
        ));
    }

    let exe = PathBuf::from(&manifest.executable);
    let executable = if exe.is_absolute() {
        exe
    } else {
        path.parent().unwrap_or_else(|| Path::new(".")).join(exe)
    };
    if !executable.exists() {
        return Err(format!("executable not found: {}", executable.display()));
    }

    Ok(DiscoveredPlugin {
        info: manifest.plugin_info,
        executable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest_json(version: u32, executable: &str) -> String {
        format!(
            r#"{{"pluginInfo":{{"id":"x","name":"X","kind":"rdbms","version":"0.1.0",
               "description":"","config_schema":[],"protocol_version":{version}}},
               "executable":"{executable}"}}"#
        )
    }

    #[test]
    fn rejects_incompatible_protocol_version() {
        let dir = std::env::temp_dir().join("rdb_pm_test_badver");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x.plugin.json");
        std::fs::write(&path, manifest_json(PROTOCOL_VERSION + 1, "x")).unwrap();

        let err = load_manifest(&path).unwrap_err();
        assert!(err.contains("incompatible protocol version"), "{err}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn rejects_missing_executable() {
        let dir = std::env::temp_dir().join("rdb_pm_test_noexe");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("x.plugin.json");
        std::fs::write(&path, manifest_json(PROTOCOL_VERSION, "does-not-exist")).unwrap();

        let err = load_manifest(&path).unwrap_err();
        assert!(err.contains("executable not found"), "{err}");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn discover_skips_bad_manifests_and_returns_empty() {
        let dir = std::env::temp_dir().join("rdb_pm_test_discover");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("x.plugin.json"), manifest_json(999, "x")).unwrap();
        std::fs::write(dir.join("ignore.txt"), "not a manifest").unwrap();

        let mgr = PluginManager::discover(&dir);
        assert!(mgr.list_plugins().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
