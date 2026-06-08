use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use rdb_core::{
    ConfigField, ConfigFieldType, Connection, ConnectionConfig, Plugin, PluginError, PluginInfo,
    PluginKind, Result, ShowIf,
};
use russh::client::{self, Handle};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;
use tokio::sync::Mutex;

// ── Types shared between plugin and frontend ─────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: i64,
    pub permissions: u32,
}

// ── russh client handler ─────────────────────────────────────────────────────

/// A russh client handler that accepts the server key. We don't pin host keys
/// yet (no known-hosts UI); accepting the key keeps the file manager usable
/// while leaving room to add verification later.
struct ClientHandler;

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        Ok(true)
    }
}

// ── Connection ───────────────────────────────────────────────────────────────

pub struct SftpConnection {
    sftp: Mutex<SftpSession>,
    // Keep the ssh handle alive for the lifetime of the connection; dropping it
    // closes the underlying channel the SFTP session rides on.
    _handle: Handle<ClientHandler>,
}

impl Connection for SftpConnection {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

// ── Plugin ───────────────────────────────────────────────────────────────────

pub struct SftpPlugin;

impl SftpPlugin {
    pub fn new() -> Self {
        Self
    }
}

impl Default for SftpPlugin {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Plugin for SftpPlugin {
    fn info(&self) -> PluginInfo {
        PluginInfo {
            id: "sftp".into(),
            name: "SFTP".into(),
            kind: PluginKind::FileManager,
            version: env!("CARGO_PKG_VERSION").into(),
            description: "Browse and manage files on a remote host over SFTP.".into(),
            ui_module: None,
            protocol_version: rdb_core::PROTOCOL_VERSION,
            config_schema: vec![
                ConfigField {
                    key: "host".into(),
                    label: "Host".into(),
                    field_type: ConfigFieldType::Text,
                    required: true,
                    default: None,
                    placeholder: Some("hostname or IP".into()),
                    show_if: None,
                },
                ConfigField {
                    key: "port".into(),
                    label: "Port".into(),
                    field_type: ConfigFieldType::Number,
                    required: false,
                    default: Some(serde_json::json!(22)),
                    placeholder: None,
                    show_if: None,
                },
                ConfigField {
                    key: "user".into(),
                    label: "User".into(),
                    field_type: ConfigFieldType::Text,
                    required: true,
                    default: None,
                    placeholder: Some("username".into()),
                    show_if: None,
                },
                ConfigField {
                    key: "auth_mode".into(),
                    label: "Auth".into(),
                    field_type: ConfigFieldType::Select {
                        options: vec!["password".into(), "key".into(), "agent".into()],
                    },
                    required: false,
                    default: Some(serde_json::json!("password")),
                    placeholder: None,
                    show_if: None,
                },
                ConfigField {
                    key: "password".into(),
                    label: "Password".into(),
                    field_type: ConfigFieldType::Password,
                    required: false,
                    default: None,
                    placeholder: None,
                    show_if: Some(ShowIf {
                        field: "auth_mode".into(),
                        equals: "password".into(),
                    }),
                },
                ConfigField {
                    key: "key_path".into(),
                    label: "Private key".into(),
                    field_type: ConfigFieldType::FilePath,
                    required: false,
                    default: None,
                    placeholder: Some("~/.ssh/id_rsa".into()),
                    show_if: Some(ShowIf {
                        field: "auth_mode".into(),
                        equals: "key".into(),
                    }),
                },
                ConfigField {
                    key: "passphrase".into(),
                    label: "Key passphrase".into(),
                    field_type: ConfigFieldType::Password,
                    required: false,
                    default: None,
                    placeholder: None,
                    show_if: Some(ShowIf {
                        field: "auth_mode".into(),
                        equals: "key".into(),
                    }),
                },
            ],
        }
    }

    async fn connect(&self, cfg: ConnectionConfig) -> Result<Arc<dyn Connection>> {
        let host = require_str(&cfg, "host")?.to_owned();
        let user = require_str(&cfg, "user")?.to_owned();
        let port = cfg.get("port").and_then(|v| v.as_u64()).unwrap_or(22) as u16;
        let auth_mode = cfg
            .get("auth_mode")
            .and_then(|v| v.as_str())
            .unwrap_or("password")
            .to_owned();

        let config = Arc::new(client::Config::default());
        let mut handle = client::connect(config, (host.as_str(), port), ClientHandler)
            .await
            .map_err(|e| PluginError::Connection(format!("cannot reach {host}:{port}: {e}")))?;

        let authed = match auth_mode.as_str() {
            "key" => {
                let key_path = cfg
                    .get("key_path")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| {
                        PluginError::Config("key_path is required for key auth".into())
                    })?;
                let passphrase = cfg
                    .get("passphrase")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty());
                let key = load_secret_key(key_path, passphrase)
                    .map_err(|e| PluginError::Connection(format!("cannot load key: {e}")))?;
                let key = PrivateKeyWithHashAlg::new(Arc::new(key), None);
                handle
                    .authenticate_publickey(&user, key)
                    .await
                    .map_err(|e| PluginError::Connection(format!("key auth failed: {e}")))?
                    .success()
            }
            "agent" => {
                // Try each identity the running ssh-agent offers, signing the
                // auth request through the agent, until one succeeds.
                let mut agent = russh::keys::agent::client::AgentClient::connect_env()
                    .await
                    .map_err(|e| {
                        PluginError::Connection(format!("cannot reach ssh-agent: {e}"))
                    })?;
                let identities = agent
                    .request_identities()
                    .await
                    .map_err(|e| PluginError::Connection(format!("ssh-agent error: {e}")))?;
                if identities.is_empty() {
                    return Err(PluginError::Connection(
                        "ssh-agent has no identities loaded".into(),
                    ));
                }
                let mut ok = false;
                for identity in identities {
                    let public_key = identity.public_key().into_owned();
                    let result = handle
                        .authenticate_publickey_with(&user, public_key, None, &mut agent)
                        .await
                        .map_err(|e| {
                            PluginError::Connection(format!("agent auth failed: {e}"))
                        })?;
                    if result.success() {
                        ok = true;
                        break;
                    }
                }
                ok
            }
            _ => {
                let password = cfg.get("password").and_then(|v| v.as_str()).unwrap_or("");
                handle
                    .authenticate_password(&user, password)
                    .await
                    .map_err(|e| PluginError::Connection(format!("password auth failed: {e}")))?
                    .success()
            }
        };

        if !authed {
            return Err(PluginError::Connection("authentication failed".into()));
        }

        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| PluginError::Connection(e.to_string()))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|e| PluginError::Connection(format!("sftp subsystem failed: {e}")))?;
        let sftp = SftpSession::new(channel.into_stream())
            .await
            .map_err(|e| PluginError::Connection(format!("sftp session failed: {e}")))?;

        Ok(Arc::new(SftpConnection {
            sftp: Mutex::new(sftp),
            _handle: handle,
        }))
    }

    /// Reachability check: open a TCP connection to host:port (no SSH auth).
    async fn test(&self, cfg: ConnectionConfig) -> Result<()> {
        let host = require_str(&cfg, "host")?;
        require_str(&cfg, "user")?;
        let port = cfg.get("port").and_then(|v| v.as_u64()).unwrap_or(22) as u16;
        let addr = format!("{host}:{port}");
        let connect = tokio::net::TcpStream::connect(&addr);
        match tokio::time::timeout(Duration::from_secs(10), connect).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(e)) => Err(PluginError::Connection(format!("cannot reach {addr}: {e}"))),
            Err(_) => Err(PluginError::Connection(format!(
                "connection to {addr} timed out"
            ))),
        }
    }
}

fn require_str<'a>(cfg: &'a ConnectionConfig, key: &str) -> Result<&'a str> {
    cfg.get(key)
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| PluginError::Config(format!("{key} is required")))
}

// ── Dispatcher ───────────────────────────────────────────────────────────────

pub struct SftpDispatcher;

#[async_trait]
impl rdb_plugin_runtime::Dispatcher for SftpDispatcher {
    async fn dispatch(
        &self,
        op: &str,
        params: serde_json::Value,
        conn: Arc<dyn Connection>,
    ) -> Result<serde_json::Value> {
        let conn = conn
            .as_any()
            .downcast_ref::<SftpConnection>()
            .ok_or_else(|| PluginError::Backend("connection type mismatch".into()))?;
        let sftp = conn.sftp.lock().await;

        match op {
            "filemanager.home_dir" => {
                // The session's working directory resolved to an absolute path —
                // this is the user's home on most servers, and (unlike "/") a
                // directory they can actually write to. Falls back to "/".
                let home = sftp
                    .canonicalize(".")
                    .await
                    .unwrap_or_else(|_| "/".to_owned());
                Ok(serde_json::Value::String(home))
            }
            "filemanager.list_dir" => {
                let path = params["path"].as_str().unwrap_or("/").to_owned();
                let read_dir = sftp
                    .read_dir(path)
                    .await
                    .map_err(|e| PluginError::Backend(format!("read_dir: {e}")))?;
                let mut entries: Vec<FileEntry> = read_dir
                    .map(|entry| {
                        let meta = entry.metadata();
                        FileEntry {
                            name: entry.file_name(),
                            path: entry.path(),
                            is_dir: meta.is_dir(),
                            size: meta.size.unwrap_or(0),
                            modified: meta.mtime.unwrap_or(0) as i64,
                            permissions: meta.permissions.unwrap_or(0),
                        }
                    })
                    .collect();
                entries.sort_by(|a, b| {
                    b.is_dir
                        .cmp(&a.is_dir)
                        .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                });
                serde_json::to_value(entries).map_err(|e| PluginError::Backend(e.to_string()))
            }
            "filemanager.stat" => {
                let path = require_path(&params, "path")?;
                let meta = sftp
                    .metadata(path.clone())
                    .await
                    .map_err(|e| PluginError::Backend(format!("stat: {e}")))?;
                let name = path.rsplit('/').next().unwrap_or(&path).to_owned();
                let entry = FileEntry {
                    name,
                    path: path.clone(),
                    is_dir: meta.is_dir(),
                    size: meta.size.unwrap_or(0),
                    modified: meta.mtime.unwrap_or(0) as i64,
                    permissions: meta.permissions.unwrap_or(0),
                };
                serde_json::to_value(entry).map_err(|e| PluginError::Backend(e.to_string()))
            }
            "filemanager.read_file" => {
                let path = require_path(&params, "path")?;
                let bytes = sftp
                    .read(path)
                    .await
                    .map_err(|e| PluginError::Backend(format!("read: {e}")))?;
                Ok(serde_json::Value::String(B64.encode(&bytes)))
            }
            "filemanager.download_file_to" => {
                // Read a remote file and write it straight to local disk. Bytes
                // never cross the JSON-RPC pipe — the plugin runs on the user's
                // machine, so this is just SFTP read -> std::fs write. Used by
                // the frontend's folder-download loop (one call per file).
                let remote_path = require_path(&params, "remote_path")?;
                let local_path = params["local_path"]
                    .as_str()
                    .ok_or_else(|| PluginError::Config("local_path is required".into()))?
                    .to_owned();
                let bytes = sftp
                    .read(remote_path)
                    .await
                    .map_err(|e| PluginError::Backend(format!("read: {e}")))?;
                let local = std::path::Path::new(&local_path);
                if let Some(parent) = local.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| {
                        PluginError::Backend(format!("create local dir {parent:?}: {e}"))
                    })?;
                }
                std::fs::write(local, &bytes)
                    .map_err(|e| PluginError::Backend(format!("write {local_path}: {e}")))?;
                Ok(serde_json::Value::Null)
            }
            "filemanager.upload_file_from" => {
                // Read a local path and write it to the remote via SFTP. If the
                // local path is a directory, its whole tree is mirrored. Bytes
                // never cross the JSON-RPC pipe, so this scales to large files.
                let local_path = params["local_path"]
                    .as_str()
                    .ok_or_else(|| PluginError::Config("local_path is required".into()))?;
                let remote_path = params["remote_path"]
                    .as_str()
                    .ok_or_else(|| PluginError::Config("remote_path is required".into()))?
                    .to_owned();
                let meta = std::fs::metadata(local_path)
                    .map_err(|e| PluginError::Backend(format!("stat {local_path}: {e}")))?;
                if meta.is_dir() {
                    let n = upload_dir(&sftp, local_path, &remote_path).await?;
                    Ok(serde_json::json!({ "files": n }))
                } else {
                    let bytes = std::fs::read(local_path)
                        .map_err(|e| PluginError::Backend(format!("read {local_path}: {e}")))?;
                    write_remote(&sftp, remote_path, &bytes).await?;
                    Ok(serde_json::json!({ "files": 1 }))
                }
            }
            "filemanager.write_file" => {
                let path = require_path(&params, "path")?;
                let data_b64 = params["data_base64"]
                    .as_str()
                    .ok_or_else(|| PluginError::Config("data_base64 is required".into()))?;
                let data = B64
                    .decode(data_b64)
                    .map_err(|e| PluginError::Config(format!("invalid base64: {e}")))?;
                write_remote(&sftp, path, &data).await?;
                Ok(serde_json::Value::Null)
            }
            "filemanager.delete" => {
                // Recursive: removes a file, or a directory and all its contents
                // (plain SFTP rmdir only removes empty directories).
                let path = require_path(&params, "path")?;
                remove_recursive(&sftp, &path).await?;
                Ok(serde_json::Value::Null)
            }
            "filemanager.mkdir" => {
                let path = require_path(&params, "path")?;
                sftp.create_dir(path)
                    .await
                    .map_err(|e| PluginError::Backend(format!("create_dir: {e}")))?;
                Ok(serde_json::Value::Null)
            }
            "filemanager.rename" => {
                let from = params["from"]
                    .as_str()
                    .ok_or_else(|| PluginError::Config("from is required".into()))?
                    .to_owned();
                let to = params["to"]
                    .as_str()
                    .ok_or_else(|| PluginError::Config("to is required".into()))?
                    .to_owned();
                sftp.rename(from, to)
                    .await
                    .map_err(|e| PluginError::Backend(format!("rename: {e}")))?;
                Ok(serde_json::Value::Null)
            }
            _ => Err(PluginError::Backend(format!("unknown op: {op}"))),
        }
    }
}

fn require_path(params: &serde_json::Value, key: &str) -> Result<String> {
    params[key]
        .as_str()
        .map(|s| s.to_owned())
        .ok_or_else(|| PluginError::Config(format!("{key} is required")))
}

/// Write `data` to `remote_path`, creating the file if it doesn't exist and
/// truncating it if it does. `SftpSession::write` opens with the WRITE flag
/// only (no CREATE), so it fails with "No such file" on a new file — `create`
/// opens with CREATE | TRUNCATE | WRITE, which is what an upload needs.
async fn write_remote(sftp: &SftpSession, remote_path: String, data: &[u8]) -> Result<()> {
    let mut file = sftp
        .create(remote_path)
        .await
        .map_err(|e| PluginError::Backend(format!("create: {e}")))?;
    file.write_all(data)
        .await
        .map_err(|e| PluginError::Backend(format!("write: {e}")))?;
    file.shutdown()
        .await
        .map_err(|e| PluginError::Backend(format!("flush: {e}")))?;
    Ok(())
}

/// Create a remote directory, tolerating "already exists". SFTP has no mkdir -p,
/// so callers create each level in order.
async fn ensure_remote_dir(sftp: &SftpSession, path: &str) -> Result<()> {
    match sftp.try_exists(path.to_owned()).await {
        Ok(true) => return Ok(()),
        _ => {}
    }
    // Race-tolerant: if it appeared between the check and now, ignore the error.
    if sftp.create_dir(path.to_owned()).await.is_err()
        && !sftp.try_exists(path.to_owned()).await.unwrap_or(false)
    {
        return Err(PluginError::Backend(format!("mkdir {path}: failed")));
    }
    Ok(())
}

/// Recursively upload a local directory tree to `remote_root`. Walks the local
/// filesystem iteratively (a stack) — async recursion would need boxing — and
/// mirrors each subdirectory and file onto the remote via SFTP. Bytes never
/// cross the JSON-RPC pipe. Returns the number of files written.
async fn upload_dir(sftp: &SftpSession, local_root: &str, remote_root: &str) -> Result<u64> {
    ensure_remote_dir(sftp, remote_root).await?;
    let mut count = 0u64;
    // Stack of (local_dir, remote_dir) pairs still to process.
    let mut stack: Vec<(std::path::PathBuf, String)> =
        vec![(std::path::PathBuf::from(local_root), remote_root.to_owned())];

    while let Some((local_dir, remote_dir)) = stack.pop() {
        let entries = std::fs::read_dir(&local_dir)
            .map_err(|e| PluginError::Backend(format!("read_dir {local_dir:?}: {e}")))?;
        for entry in entries {
            let entry =
                entry.map_err(|e| PluginError::Backend(format!("dir entry: {e}")))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let remote_child = format!("{remote_dir}/{name}");
            let file_type = entry
                .file_type()
                .map_err(|e| PluginError::Backend(format!("file type {name}: {e}")))?;
            if file_type.is_dir() {
                ensure_remote_dir(sftp, &remote_child).await?;
                stack.push((entry.path(), remote_child));
            } else if file_type.is_file() {
                let bytes = std::fs::read(entry.path()).map_err(|e| {
                    PluginError::Backend(format!("read {:?}: {e}", entry.path()))
                })?;
                write_remote(sftp, remote_child, &bytes).await?;
                count += 1;
            }
            // Symlinks / special files are skipped.
        }
    }
    Ok(count)
}

/// Recursively delete a remote path. SFTP `rmdir` only removes *empty*
/// directories, so for a directory we first gather the whole subtree (BFS),
/// then unlink every file and rmdir every directory deepest-first. Walks
/// iteratively — async recursion would need boxing.
async fn remove_recursive(sftp: &SftpSession, path: &str) -> Result<()> {
    let meta = sftp
        .metadata(path.to_owned())
        .await
        .map_err(|e| PluginError::Backend(format!("stat {path}: {e}")))?;
    if !meta.is_dir() {
        return sftp
            .remove_file(path.to_owned())
            .await
            .map_err(|e| PluginError::Backend(format!("remove_file {path}: {e}")));
    }

    // BFS the tree, recording dirs (in discovery order) and files.
    let mut dirs: Vec<String> = vec![path.to_owned()];
    let mut files: Vec<String> = Vec::new();
    let mut queue: Vec<String> = vec![path.to_owned()];
    while let Some(dir) = queue.pop() {
        let read_dir = sftp
            .read_dir(dir.clone())
            .await
            .map_err(|e| PluginError::Backend(format!("read_dir {dir}: {e}")))?;
        for entry in read_dir {
            let child = entry.path();
            if entry.metadata().is_dir() {
                dirs.push(child.clone());
                queue.push(child);
            } else {
                files.push(child);
            }
        }
    }

    // Files first, then dirs deepest-first (reverse of discovery order, which is
    // breadth-first, so parents precede children — reversing empties children
    // before their parents).
    for f in files {
        sftp.remove_file(f.clone())
            .await
            .map_err(|e| PluginError::Backend(format!("remove_file {f}: {e}")))?;
    }
    for d in dirs.into_iter().rev() {
        sftp.remove_dir(d.clone())
            .await
            .map_err(|e| PluginError::Backend(format!("remove_dir {d}: {e}")))?;
    }
    Ok(())
}
