use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

/// Per-file copies are streamed in chunks of this size so the cooperative
/// `cancel` flag can be observed *mid-file* (not just between files) and so a
/// large file isn't buffered whole in memory.
pub const TRANSFER_CHUNK: usize = 64 * 1024;

/// Returned by the per-file copy helpers when the cooperative cancel flag was
/// observed mid-file. The caller stops the loop and leaves the phase at
/// `Cancelled`; the partially-written destination has already been removed.
pub struct Cancelled;

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
pub struct JobState {
    /// Files completed so far.
    pub done: AtomicU64,
    /// Total files to transfer; 0 while still scanning (download).
    pub total: AtomicU64,
    /// `JobPhase` encoded as a small int (atomic so reads never block).
    pub phase: AtomicU64,
    /// Cooperative cancel flag, checked between files.
    pub cancel: AtomicBool,
    /// The file currently being transferred (relative path), for display.
    pub current: Mutex<String>,
    /// Error message once `phase == Error`.
    pub error: Mutex<Option<String>>,
}

impl JobState {
    pub fn new() -> Self {
        Self {
            done: AtomicU64::new(0),
            total: AtomicU64::new(0),
            phase: AtomicU64::new(JobPhase::Scanning as u64),
            cancel: AtomicBool::new(false),
            current: Mutex::new(String::new()),
            error: Mutex::new(None),
        }
    }

    pub fn set_phase(&self, p: JobPhase) {
        self.phase.store(p as u64, Ordering::SeqCst);
    }

    pub fn phase(&self) -> JobPhase {
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
