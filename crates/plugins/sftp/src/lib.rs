use async_trait::async_trait;
use rdb_core::{
    ConfigField, ConfigFieldType, Connection, ConnectionConfig, Plugin, PluginError, PluginInfo,
    PluginKind, Result, ShowIf,
};
use russh::client::{self, Handle};
use russh::keys::{load_secret_key, PrivateKeyWithHashAlg};
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::Mutex;

/// Per-file copies are streamed in chunks of this size so the cooperative
/// `cancel` flag can be observed *mid-file* (not just between files) and so a
/// large file isn't buffered whole in memory.
const TRANSFER_CHUNK: usize = 64 * 1024;

/// Returned by the per-file copy helpers when the cooperative cancel flag was
/// observed mid-file. The caller stops the loop and leaves the phase at
/// `Cancelled`; the partially-written destination has already been removed.
struct Cancelled;

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

// ── Background transfer jobs ─────────────────────────────────────────────────
//
// Uploads and downloads run as background tasks *inside the plugin process*, so
// they survive the frontend workspace unmounting on a connection switch (the
// plugin process outlives the React component, like the host's PTY). The
// frontend kicks a job off with `transfer_start`, polls `transfer_stats` for
// progress, and can `transfer_cancel` it. State is in-memory only — it lives as
// long as the connection (a full disconnect drops the connection and its jobs).

/// Where a transfer job is in its lifecycle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum JobPhase {
    /// Walking the remote tree to count files (download only); `total` not final.
    Scanning,
    Running,
    Done,
    Cancelled,
    Error,
}

/// Live, shared state of one transfer job. Counters are atomics so the running
/// task updates them while `transfer_stats` reads them without locking the SFTP
/// session (which the transfer itself holds for the duration).
struct JobState {
    /// Files completed so far.
    done: AtomicU64,
    /// Total files to transfer; 0 while still scanning (download).
    total: AtomicU64,
    /// `JobPhase` encoded as a small int (atomic so reads never block).
    phase: AtomicU64,
    /// Cooperative cancel flag, checked between files.
    cancel: AtomicBool,
    /// The file currently being transferred (relative path), for display.
    current: Mutex<String>,
    /// Error message once `phase == Error`.
    error: Mutex<Option<String>>,
}

impl JobState {
    fn new() -> Self {
        Self {
            done: AtomicU64::new(0),
            total: AtomicU64::new(0),
            phase: AtomicU64::new(JobPhase::Scanning as u64),
            cancel: AtomicBool::new(false),
            current: Mutex::new(String::new()),
            error: Mutex::new(None),
        }
    }

    fn set_phase(&self, p: JobPhase) {
        self.phase.store(p as u64, Ordering::SeqCst);
    }

    fn phase(&self) -> JobPhase {
        match self.phase.load(Ordering::SeqCst) {
            x if x == JobPhase::Scanning as u64 => JobPhase::Scanning,
            x if x == JobPhase::Running as u64 => JobPhase::Running,
            x if x == JobPhase::Done as u64 => JobPhase::Done,
            x if x == JobPhase::Cancelled as u64 => JobPhase::Cancelled,
            _ => JobPhase::Error,
        }
    }
}

/// The progress snapshot returned by `transfer_stats` (mirrored in `api.ts`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferStats {
    pub phase: JobPhase,
    pub done: u64,
    pub total: u64,
    pub current: String,
    pub error: Option<String>,
}

/// Direction of a background transfer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TransferKind {
    Upload,
    Download,
}

/// One file/directory to transfer. For an upload, `local_path` is the source and
/// `remote_path` the destination; for a download it's the reverse. A directory
/// is mirrored recursively.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferItem {
    pub local_path: String,
    pub remote_path: String,
}

/// Params for `filemanager.start_transfer` (mirrored in `api.ts`).
#[derive(Debug, Clone, Deserialize)]
pub struct StartTransfer {
    pub kind: TransferKind,
    pub items: Vec<TransferItem>,
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
    // `Arc` (not `Mutex`): `SftpSession` methods take `&self` and the session
    // multiplexes concurrent ops over its channel internally, so we can share it
    // freely — including handing a clone to a background transfer task without
    // blocking ordinary calls like `list_dir`.
    sftp: Arc<SftpSession>,
    // The single current/last transfer job for this connection, or `None` if no
    // transfer has run yet. Lives as long as the connection, so it survives the
    // frontend workspace unmounting on a connection switch; the frontend
    // reattaches by polling `last_transfer_stats`.
    job: Mutex<Option<Arc<JobState>>>,
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
                        // ssh-agent auth relies on a Unix socket (SSH_AUTH_SOCK)
                        // and is only offered on Unix targets.
                        #[cfg(unix)]
                        options: vec!["password".into(), "key".into(), "agent".into()],
                        #[cfg(not(unix))]
                        options: vec!["password".into(), "key".into()],
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
            #[cfg(not(unix))]
            "agent" => {
                // `AgentClient::connect_env` connects over the `SSH_AUTH_SOCK`
                // Unix socket and only exists on Unix targets, so ssh-agent
                // auth is unavailable on Windows.
                return Err(PluginError::Connection(
                    "ssh-agent authentication is not supported on this platform; \
                     use key or password auth instead"
                        .into(),
                ));
            }
            #[cfg(unix)]
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
            sftp: Arc::new(sftp),
            job: Mutex::new(None),
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
        let sftp = &conn.sftp;

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
            "filemanager.start_transfer" => {
                // Kick off an upload or download as a background task *inside the
                // plugin process*. Returns immediately; the frontend polls
                // `last_transfer_stats` for progress and can `cancel_last_transfer`.
                // The job lives on the connection, so it survives the frontend
                // workspace unmounting on a connection switch.
                let req: StartTransfer = serde_json::from_value(params)
                    .map_err(|e| PluginError::Config(format!("invalid params: {e}")))?;
                if req.items.is_empty() {
                    return Err(PluginError::Config("no transfer items".into()));
                }

                let mut slot = conn.job.lock().await;
                if let Some(existing) = slot.as_ref() {
                    if matches!(existing.phase(), JobPhase::Scanning | JobPhase::Running) {
                        return Err(PluginError::Backend(
                            "a transfer is already running".into(),
                        ));
                    }
                }
                let job = Arc::new(JobState::new());
                *slot = Some(job.clone());
                drop(slot);

                let sftp = conn.sftp.clone();
                let kind = req.kind;
                let items = req.items;
                tokio::spawn(async move {
                    let result = run_transfer(&sftp, kind, &items, &job).await;
                    match result {
                        Ok(()) => {
                            // A cooperative cancel leaves the phase at Cancelled;
                            // don't overwrite it with Done.
                            if job.phase() == JobPhase::Running {
                                job.set_phase(JobPhase::Done);
                            }
                        }
                        Err(e) => {
                            *job.error.lock().await = Some(e.to_string());
                            job.set_phase(JobPhase::Error);
                        }
                    }
                });
                Ok(serde_json::Value::Null)
            }
            "filemanager.last_transfer_stats" => {
                // Snapshot the current/last job's progress, or null if none ran.
                let slot = conn.job.lock().await;
                match slot.as_ref() {
                    None => Ok(serde_json::Value::Null),
                    Some(job) => {
                        let stats = TransferStats {
                            phase: job.phase(),
                            done: job.done.load(Ordering::SeqCst),
                            total: job.total.load(Ordering::SeqCst),
                            current: job.current.lock().await.clone(),
                            error: job.error.lock().await.clone(),
                        };
                        serde_json::to_value(stats)
                            .map_err(|e| PluginError::Backend(e.to_string()))
                    }
                }
            }
            "filemanager.cancel_last_transfer" => {
                // Set the cooperative cancel flag; the running task observes it
                // between files and transitions to Cancelled.
                let slot = conn.job.lock().await;
                if let Some(job) = slot.as_ref() {
                    job.cancel.store(true, Ordering::SeqCst);
                }
                Ok(serde_json::Value::Null)
            }
            "filemanager.delete" => {
                // Recursive: removes a file, or a directory and all its contents
                // (plain SFTP rmdir only removes empty directories).
                let path = require_path(&params, "path")?;
                remove_recursive(sftp, &path).await?;
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

/// Stream the local file at `src` to `remote_path`, creating the file if it
/// doesn't exist and truncating it if it does. `SftpSession::write` opens with
/// the WRITE flag only (no CREATE), so it fails with "No such file" on a new
/// file — `create` opens with CREATE | TRUNCATE | WRITE, which is what an upload
/// needs. Streamed in `TRANSFER_CHUNK` chunks, checking `job.cancel` between
/// chunks so a large file can be aborted mid-copy; on cancel the
/// partially-written remote file is removed and `Ok(Some(Cancelled))` returned.
async fn write_remote(
    sftp: &SftpSession,
    src: &str,
    remote_path: String,
    job: &JobState,
) -> Result<Option<Cancelled>> {
    let mut input = tokio::fs::File::open(src)
        .await
        .map_err(|e| PluginError::Backend(format!("open {src}: {e}")))?;
    let mut file = sftp
        .create(remote_path.clone())
        .await
        .map_err(|e| PluginError::Backend(format!("create {remote_path}: {e}")))?;

    let mut buf = vec![0u8; TRANSFER_CHUNK];
    loop {
        if job.cancel.load(Ordering::SeqCst) {
            // Abandon the remote handle and unlink the truncated destination.
            let _ = file.shutdown().await;
            drop(file);
            let _ = sftp.remove_file(remote_path.clone()).await;
            return Ok(Some(Cancelled));
        }
        let n = input
            .read(&mut buf)
            .await
            .map_err(|e| PluginError::Backend(format!("read {src}: {e}")))?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n])
            .await
            .map_err(|e| PluginError::Backend(format!("write {remote_path}: {e}")))?;
    }
    file.shutdown()
        .await
        .map_err(|e| PluginError::Backend(format!("flush {remote_path}: {e}")))?;
    Ok(None)
}

/// Create a remote directory, tolerating "already exists". SFTP has no mkdir -p,
/// so callers create each level in order.
async fn ensure_remote_dir(sftp: &SftpSession, path: &str) -> Result<()> {
    if let Ok(true) = sftp.try_exists(path.to_owned()).await {
        return Ok(());
    }
    // Race-tolerant: if it appeared between the check and now, ignore the error.
    if sftp.create_dir(path.to_owned()).await.is_err()
        && !sftp.try_exists(path.to_owned()).await.unwrap_or(false)
    {
        return Err(PluginError::Backend(format!("mkdir {path}: failed")));
    }
    Ok(())
}

// ── Background transfer driver ───────────────────────────────────────────────

/// Read one remote file and write it straight to `local_path` on disk, creating
/// parent directories as needed. Bytes never cross the JSON-RPC pipe (the plugin
/// runs locally). Streamed in `TRANSFER_CHUNK` chunks, checking `job.cancel`
/// between chunks so a large file can be aborted mid-copy; on cancel the
/// partially-written local file is removed and `Ok(Some(Cancelled))` is returned.
async fn download_one(
    sftp: &SftpSession,
    remote_path: &str,
    local_path: &str,
    job: &JobState,
) -> Result<Option<Cancelled>> {
    let mut remote = sftp
        .open(remote_path.to_owned())
        .await
        .map_err(|e| PluginError::Backend(format!("open {remote_path}: {e}")))?;
    let local = std::path::Path::new(local_path);
    if let Some(parent) = local.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| PluginError::Backend(format!("create local dir {parent:?}: {e}")))?;
    }
    let mut out = tokio::fs::File::create(local)
        .await
        .map_err(|e| PluginError::Backend(format!("create {local_path}: {e}")))?;

    let mut buf = vec![0u8; TRANSFER_CHUNK];
    loop {
        if job.cancel.load(Ordering::SeqCst) {
            // Drop the open handles and discard the truncated destination.
            drop(out);
            let _ = tokio::fs::remove_file(local).await;
            return Ok(Some(Cancelled));
        }
        let n = remote
            .read(&mut buf)
            .await
            .map_err(|e| PluginError::Backend(format!("read {remote_path}: {e}")))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])
            .await
            .map_err(|e| PluginError::Backend(format!("write {local_path}: {e}")))?;
    }
    out.flush()
        .await
        .map_err(|e| PluginError::Backend(format!("flush {local_path}: {e}")))?;
    Ok(None)
}

/// One file discovered while scanning a transfer source: its source path and the
/// path relative to the transfer root (used to mirror the tree at the destination).
struct ScannedFile {
    /// Absolute source path (remote for download, local for upload).
    src: String,
    /// Path relative to the item root, e.g. `sub/dir/file.txt`. Empty for a
    /// single top-level file.
    rel: String,
}

/// Walk a remote tree rooted at `root`, returning every file under it. Iterative
/// (async recursion would need boxing), mirroring `remove_recursive`'s BFS.
async fn walk_remote(sftp: &SftpSession, root: &str) -> Result<Vec<ScannedFile>> {
    let mut out = Vec::new();
    // Stack of (remote_dir, rel_prefix) to process.
    let mut stack: Vec<(String, String)> = vec![(root.to_owned(), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        let read_dir = sftp
            .read_dir(dir.clone())
            .await
            .map_err(|e| PluginError::Backend(format!("read_dir {dir}: {e}")))?;
        for entry in read_dir {
            let name = entry.file_name();
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if entry.metadata().is_dir() {
                stack.push((entry.path(), rel));
            } else {
                out.push(ScannedFile {
                    src: entry.path(),
                    rel,
                });
            }
        }
    }
    Ok(out)
}

/// Walk a local tree rooted at `root`, returning every file under it. Iterative
/// (mirrors `upload_dir`).
fn walk_local(root: &str) -> Result<Vec<ScannedFile>> {
    let mut out = Vec::new();
    let mut stack: Vec<(std::path::PathBuf, String)> =
        vec![(std::path::PathBuf::from(root), String::new())];
    while let Some((dir, prefix)) = stack.pop() {
        let entries = std::fs::read_dir(&dir)
            .map_err(|e| PluginError::Backend(format!("read_dir {dir:?}: {e}")))?;
        for entry in entries {
            let entry = entry.map_err(|e| PluginError::Backend(format!("dir entry: {e}")))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            let file_type = entry
                .file_type()
                .map_err(|e| PluginError::Backend(format!("file type {name}: {e}")))?;
            if file_type.is_dir() {
                stack.push((entry.path(), rel));
            } else if file_type.is_file() {
                out.push(ScannedFile {
                    src: entry.path().to_string_lossy().into_owned(),
                    rel,
                });
            }
            // Symlinks / special files are skipped (matches `upload_dir`).
        }
    }
    Ok(out)
}

/// Join a destination root with a relative path, using "/" (remote paths always
/// use it; local paths on macOS/Linux accept it, and the `create_dir_all` /
/// `write` calls normalize either way — same convention the frontend used).
fn join_rel(root: &str, rel: &str) -> String {
    if rel.is_empty() {
        root.to_owned()
    } else {
        format!("{root}/{rel}")
    }
}

/// Drive a whole transfer (every item) to completion, updating `job` as it goes.
/// Runs in a spawned task so it outlives the frontend workspace. Phases:
/// `Scanning` while building the file list, `Running` while copying, then the
/// caller flips to `Done`. Honors the cooperative `cancel` flag between files.
async fn run_transfer(
    sftp: &SftpSession,
    kind: TransferKind,
    items: &[TransferItem],
    job: &JobState,
) -> Result<()> {
    // Phase 1 — scan: build the flat (src, dest) work list across all items and
    // learn the total file count up front, so the progress bar is accurate.
    job.set_phase(JobPhase::Scanning);
    // (src_path, dest_path, display_rel)
    let mut work: Vec<(String, String, String)> = Vec::new();
    for item in items {
        if job.cancel.load(Ordering::SeqCst) {
            job.set_phase(JobPhase::Cancelled);
            return Ok(());
        }
        match kind {
            TransferKind::Download => {
                let meta = sftp
                    .metadata(item.remote_path.clone())
                    .await
                    .map_err(|e| PluginError::Backend(format!("stat {}: {e}", item.remote_path)))?;
                if meta.is_dir() {
                    for f in walk_remote(sftp, &item.remote_path).await? {
                        let dest = join_rel(&item.local_path, &f.rel);
                        work.push((f.src, dest, f.rel));
                    }
                } else {
                    let name = file_name_of(&item.remote_path);
                    work.push((item.remote_path.clone(), item.local_path.clone(), name));
                }
            }
            TransferKind::Upload => {
                let meta = std::fs::metadata(&item.local_path).map_err(|e| {
                    PluginError::Backend(format!("stat {}: {e}", item.local_path))
                })?;
                if meta.is_dir() {
                    // Mirror the destination root so an uploaded folder exists
                    // even when empty; nested dirs are created lazily as each
                    // file's parent chain is ensured during copy.
                    ensure_remote_dirs(sftp, &item.remote_path).await?;
                    for f in walk_local(&item.local_path)? {
                        let dest = join_rel(&item.remote_path, &f.rel);
                        work.push((f.src, dest, f.rel));
                    }
                } else {
                    let name = file_name_of(&item.local_path);
                    work.push((item.local_path.clone(), item.remote_path.clone(), name));
                }
            }
        }
    }

    job.total.store(work.len() as u64, Ordering::SeqCst);
    job.set_phase(JobPhase::Running);

    // Phase 2 — copy each file. Cancel is checked both between files (here) and
    // mid-file (inside the copy helpers, between chunks), so a large in-progress
    // file is aborted promptly rather than running to completion first.
    for (src, dest, rel) in work {
        if job.cancel.load(Ordering::SeqCst) {
            job.set_phase(JobPhase::Cancelled);
            return Ok(());
        }
        *job.current.lock().await = rel;
        let cancelled = match kind {
            TransferKind::Download => download_one(sftp, &src, &dest, job).await?,
            TransferKind::Upload => {
                // Mirror the parent directory chain on the remote before writing.
                if let Some(parent) = dest.rsplit_once('/').map(|(p, _)| p) {
                    if !parent.is_empty() {
                        ensure_remote_dirs(sftp, parent).await?;
                    }
                }
                write_remote(sftp, &src, dest.clone(), job).await?
            }
        };
        if cancelled.is_some() {
            // The current file was aborted mid-copy and its partial destination
            // removed; stop here without counting it as done.
            job.set_phase(JobPhase::Cancelled);
            return Ok(());
        }
        job.done.fetch_add(1, Ordering::SeqCst);
    }
    Ok(())
}

/// The last path segment of a "/"-separated path (the file name).
fn file_name_of(path: &str) -> String {
    path.rsplit('/').next().unwrap_or(path).to_owned()
}

/// Create every level of a remote directory path in order (SFTP has no mkdir -p),
/// tolerating levels that already exist.
async fn ensure_remote_dirs(sftp: &SftpSession, path: &str) -> Result<()> {
    let mut acc = String::new();
    for segment in path.split('/') {
        if segment.is_empty() {
            // Leading "/" (absolute path): keep building from root.
            acc.push('/');
            continue;
        }
        if acc.is_empty() || acc == "/" {
            acc.push_str(segment);
        } else {
            acc.push('/');
            acc.push_str(segment);
        }
        ensure_remote_dir(sftp, &acc).await?;
    }
    Ok(())
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
