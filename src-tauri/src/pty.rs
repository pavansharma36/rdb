//! PTY management for CLI workspaces.
//!
//! Each open CLI connection gets one PTY running the process the owning plugin
//! describes (via the `cli.spawn_spec` op). Output is forwarded to the frontend
//! as Tauri events on the channel `pty://output/<connection_id_uuid>`. Input and
//! resize come in via the `pty_write` / `pty_resize` Tauri commands.
//!
//! The host has no backend-specific knowledge: the command to run and any
//! prompt auto-answer come from the plugin's `PtySpawnSpec`.

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use rdb_core::ConnectionId;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;

/// Cap on the per-connection scrollback buffer the host retains so a remounted
/// UI can replay recent output. ~256 KiB is plenty for a screen of history
/// without unbounded growth on a chatty session.
const SCROLLBACK_CAP: usize = 256 * 1024;

/// A bounded byte buffer holding the most recent PTY output. Old bytes are
/// dropped from the front once `SCROLLBACK_CAP` is exceeded.
#[derive(Default)]
struct Scrollback {
    bytes: std::collections::VecDeque<u8>,
}

impl Scrollback {
    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend(chunk.iter().copied());
        let overflow = self.bytes.len().saturating_sub(SCROLLBACK_CAP);
        if overflow > 0 {
            self.bytes.drain(..overflow);
        }
    }

    fn snapshot(&self) -> Vec<u8> {
        self.bytes.iter().copied().collect()
    }
}

struct PtyHandle {
    writer: Arc<std::sync::Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn portable_pty::MasterPty + Send>,
    /// The child process, kept so `close` can kill it (dropping the master
    /// alone does not terminate the child).
    child: Box<dyn portable_pty::Child + Send + Sync>,
    /// Recent output, replayed to a (re)mounting UI via [`snapshot`].
    scrollback: Arc<std::sync::Mutex<Scrollback>>,
}

pub struct PtyManager {
    handles: Mutex<HashMap<ConnectionId, PtyHandle>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            handles: Mutex::new(HashMap::new()),
        }
    }
}

/// Does `chunk` contain the prompt `pattern` (case-insensitive substring)?
fn matches_prompt(chunk: &str, pattern: &str) -> bool {
    chunk.to_ascii_lowercase().contains(&pattern.to_ascii_lowercase())
}

/// Spawn a CLI plugin's terminal process in a PTY for `connection_id`, per the
/// plugin-provided [`PtySpawnSpec`]. The host runs `spec.program` with
/// `spec.args`/`spec.env` and, if the spec carries a `prompt_response`,
/// auto-answers the first matching prompt.
pub async fn spawn(
    manager: Arc<PtyManager>,
    app: AppHandle,
    connection_id: ConnectionId,
    spec: rdb_core::PtySpawnSpec,
) -> Result<(), String> {
    if spec.program.is_empty() {
        return Err("spawn spec has no program".into());
    }

    // Idempotent: if a PTY already exists for this connection (e.g. React
    // StrictMode double-invokes the mount effect in dev), don't spawn a second
    // process.
    if manager.handles.lock().await.contains_key(&connection_id) {
        return Ok(());
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let mut cmd = CommandBuilder::new(&spec.program);
    for arg in &spec.args {
        cmd.arg(arg);
    }
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }

    // Optional one-shot prompt auto-answer (e.g. feeding a saved password).
    let prompt = spec.prompt_response.clone();

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| e.to_string())?;

    let writer: Arc<std::sync::Mutex<Box<dyn Write + Send>>> =
        Arc::new(std::sync::Mutex::new(
            pair.master.take_writer().map_err(|e| e.to_string())?,
        ));
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let event_name = format!("pty://output/{}", connection_id.0);
    let reader_writer = writer.clone();
    let scrollback: Arc<std::sync::Mutex<Scrollback>> =
        Arc::new(std::sync::Mutex::new(Scrollback::default()));
    let reader_scrollback = scrollback.clone();
    // Spawn a thread (not async task) because `Read` on the PTY master blocks.
    std::thread::spawn(move || {
        // Only auto-answer the prompt once.
        let mut answered = false;
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    if !answered {
                        if let Some(ref p) = prompt {
                            if matches_prompt(&String::from_utf8_lossy(chunk), &p.pattern) {
                                if let Ok(mut w) = reader_writer.lock() {
                                    let _ = w.write_all(p.send.as_bytes());
                                    let _ = w.write_all(b"\n");
                                    let _ = w.flush();
                                }
                                answered = true;
                            }
                        }
                    }
                    // Retain recent output so a remounting UI can replay it.
                    if let Ok(mut sb) = reader_scrollback.lock() {
                        sb.push(chunk);
                    }
                    let _ = app.emit(&event_name, chunk.to_vec());
                }
            }
        }
    });

    let handle = PtyHandle {
        writer,
        master: pair.master,
        child,
        scrollback,
    };
    manager.handles.lock().await.insert(connection_id, handle);
    Ok(())
}

/// Return the retained scrollback for a connection (recent PTY output), so a
/// freshly-mounted UI can repaint the terminal. Empty if there's no live PTY.
pub async fn snapshot(
    manager: Arc<PtyManager>,
    connection_id: ConnectionId,
) -> Result<Vec<u8>, String> {
    let handles = manager.handles.lock().await;
    match handles.get(&connection_id) {
        Some(h) => Ok(h
            .scrollback
            .lock()
            .map_err(|e| e.to_string())?
            .snapshot()),
        None => Ok(Vec::new()),
    }
}

/// Whether a live PTY exists for this connection.
pub async fn is_alive(manager: Arc<PtyManager>, connection_id: ConnectionId) -> bool {
    manager.handles.lock().await.contains_key(&connection_id)
}

pub async fn write(
    manager: Arc<PtyManager>,
    connection_id: ConnectionId,
    data: Vec<u8>,
) -> Result<(), String> {
    let handles = manager.handles.lock().await;
    let h = handles
        .get(&connection_id)
        .ok_or_else(|| format!("no PTY for connection {connection_id:?}"))?;
    let mut w = h.writer.lock().map_err(|e| e.to_string())?;
    w.write_all(&data).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

pub async fn resize(
    manager: Arc<PtyManager>,
    connection_id: ConnectionId,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let handles = manager.handles.lock().await;
    let h = handles
        .get(&connection_id)
        .ok_or_else(|| format!("no PTY for connection {connection_id:?}"))?;
    h.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

pub async fn close(manager: Arc<PtyManager>, connection_id: ConnectionId) -> Result<(), String> {
    if let Some(mut handle) = manager.handles.lock().await.remove(&connection_id) {
        // Kill the process; dropping the master alone leaves it running.
        let _ = handle.child.kill();
        let _ = handle.child.wait();
    }
    Ok(())
}
