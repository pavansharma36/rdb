

// --- SFTP (FileManager) ---------------------------------------------------

import {ConnectionId, pluginCall} from "./api.ts";

export interface FileEntry {
    name: string;
    path: string;
    is_dir: boolean;
    size: number;
    /** Unix timestamp seconds */
    modified: number;
    /** Unix mode bits */
    permissions: number;
}

/** Direction of a background transfer. */
export type TransferKind = "upload" | "download";

/** One file/dir to transfer. For an upload, `local_path` is the source; for a
 *  download, `remote_path` is. A directory is mirrored recursively. */
export interface TransferItem {
    local_path: string;
    remote_path: string;
}

/** Lifecycle of a background transfer job (mirrors `JobPhase` in the plugin). */
export type TransferPhase =
    | "scanning"
    | "running"
    | "done"
    | "cancelled"
    | "error";

/** Progress snapshot of the connection's current/last transfer (mirrors
 *  `TransferStats` in the plugin). `total` is 0 while still scanning. */
export interface TransferStats {
    phase: TransferPhase;
    done: number;
    total: number;
    current: string;
    error: string | null;
}

export const sftp_api = {
    // SFTP (FileManager)
    /** The session's home directory (canonicalized cwd); a writable starting
     *  point, unlike "/". */
    sftpHomeDir: (connectionId: ConnectionId) =>
        pluginCall<string>(connectionId, "filemanager.home_dir", {}),

    sftpListDir: (connectionId: ConnectionId, path: string) =>
        pluginCall<FileEntry[]>(connectionId, "filemanager.list_dir", { path }),

    /** Start an upload or download as a background task *inside the plugin*. Runs
     *  independent of the workspace component, so it survives a connection switch;
     *  the frontend polls `sftpLastTransferStats` and can `sftpCancelLastTransfer`.
     *  One transfer at a time per connection — rejects if one is already running.
     *  A directory item is mirrored recursively by the plugin. */
    sftpStartTransfer: (
        connectionId: ConnectionId,
        kind: TransferKind,
        items: TransferItem[],
    ) =>
        pluginCall<null>(connectionId, "filemanager.start_transfer", {
            kind,
            items,
        }),

    /** Progress of the connection's current/last transfer, or null if none has
     *  run. Cheap to poll. */
    sftpLastTransferStats: (connectionId: ConnectionId) =>
        pluginCall<TransferStats | null>(
            connectionId,
            "filemanager.last_transfer_stats",
            {},
        ),

    /** Cooperatively cancel the current transfer (observed between files). */
    sftpCancelLastTransfer: (connectionId: ConnectionId) =>
        pluginCall<null>(connectionId, "filemanager.cancel_last_transfer", {}),

    sftpDelete: (connectionId: ConnectionId, path: string) =>
        pluginCall<null>(connectionId, "filemanager.delete", { path }),

    sftpMkdir: (connectionId: ConnectionId, path: string) =>
        pluginCall<null>(connectionId, "filemanager.mkdir", { path }),

    sftpRename: (connectionId: ConnectionId, from: string, to: string) =>
        pluginCall<null>(connectionId, "filemanager.rename", { from, to }),
}