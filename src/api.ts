// Typed bridge to the Rust `#[tauri::command]` surface in `src-tauri/src/commands.rs`.
// Types mirror the serde representations of the Rust structs.
//
// The host is a generic pipe: lifecycle commands (list/test/open/close) are
// typed, but every capability call funnels through one `plugin_call` command
// with an opaque `op` string. Only the wrappers below know the op names — the
// workspace components are unchanged.

import { invoke } from "@tauri-apps/api/core";

export type PluginKind = "rdbms" | "document" | "rabbitmq" | "cli" | "filemanager" | "other";

export type ConfigFieldType =
  | { kind: "text" }
  | { kind: "password" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "select"; options: string[] }
  | { kind: "filepath" };

export interface ShowIf {
  field: string;
  equals: string;
}

/** How a secret is stored. Mirrors Rust `SecretField`'s `type` tag. Only
 *  `PLAIN_TEXT` exists today; future variants (keychain/env/encrypted) extend
 *  this without changing the field shape. */
export type SecretType = "PLAIN_TEXT";

/** A credential value in a `ConnectionConfig`. Every `password`-kind field
 *  stores one of these (`{ type, value }`) rather than a bare string. */
export interface SecretField {
  type: SecretType;
  value: string;
}

/** Wrap a plaintext credential as a `SecretField`. */
export const plainSecret = (value: string): SecretField => ({
  type: "PLAIN_TEXT",
  value,
});

export interface ConfigField {
  key: string;
  label: string;
  type: ConfigFieldType;
  required: boolean;
  default?: unknown | null;
  placeholder?: string | null;
  /** When set, only show this field while `values[field]` equals `equals`. */
  show_if?: ShowIf | null;
}

export interface PluginInfo {
  id: string;
  name: string;
  kind: PluginKind;
  version: string;
  description: string;
  config_schema: ConfigField[];
  ui_module?: string | null;
  /** Wire-protocol version the plugin speaks (set by the plugin runtime). */
  protocol_version?: number;
}

/** What the host reports about a GitHub release before installing (see
 *  `preview_github_plugin`). `sha256` is null when no checksum is published. */
export interface GithubPreview {
  repo: string;
  tag: string;
  assetName: string;
  sizeBytes: number;
  sha256: string | null;
  downloadUrl: string;
}

/** Install/update state of an `AvailablePlugin` relative to what's installed. */
export type PluginStatus =
  | "not_installed"
  | "up_to_date"
  | "update_available"
  | "unknown";

/** A plugin installable from the configured GitHub repo (see
 *  `list_github_plugins`). All plugins share one release tag (`plugins-latest`
 *  or `plugins-v<semver>`); `id` is derived from the asset name
 *  (e.g. `rdb-plugin-postgres-<triple>` -> `postgres`) and equals the installed
 *  plugin's id. `status` is computed by the host against what's installed. */
export interface AvailablePlugin {
  id: string;
  tag: string;
  /** `"nightly"` or `"stable"` — the channel this listing reflects. */
  channel: string;
  /** Human-facing name from the release's `plugin_info.json`, if published. */
  name?: string | null;
  /** Plugin description from `plugin_info.json`, if published. */
  description?: string | null;
  assetName: string;
  sizeBytes: number;
  /** Available version (from the tag for stable, or `plugin_info.json` for nightly). */
  availableVersion: string | null;
  /** Release publish timestamp (informational; `status` is computed host-side). */
  publishedAt: string | null;
  /** The currently-installed version, if installed. */
  installedVersion: string | null;
  status: PluginStatus;
}

/** Serializes as a UUID string. */
export type ConnectionId = string;

export type ConnectionConfig = Record<string, unknown>;

// --- RDBMS ----------------------------------------------------------------

export interface Schema {
  name: string;
}

export type TableKind = "table" | "view" | "materializedview";

export interface Table {
  schema: string;
  name: string;
  kind: TableKind;
}

export interface ForeignKey {
  table: string;
  column: string;
}

export interface Column {
  name: string;
  data_type: string;
  /** Underlying type (`udt_name`); the actual enum type for `USER-DEFINED`. */
  udt_name?: string | null;
  nullable: boolean;
  primary_key: boolean;
  /** True when a single-column UNIQUE constraint covers this column. */
  unique?: boolean;
  /** Default value expression from the catalog, if any. */
  default_value?: string | null;
  /** Foreign-key reference this column participates in, if any. */
  foreign_key?: ForeignKey | null;
  /** Declared length for character types (`varchar(n)`/`char(n)`), if any. */
  char_max_length?: number | null;
  /** Precision/scale for `numeric`/`decimal` columns, if declared. */
  numeric_precision?: number | null;
  numeric_scale?: number | null;
  /** JSON-valued column: the UI offers the JSON editor (validate/format). */
  json?: boolean;
  /** Long-text-ish column (incl. JSON): edits open in a modal, not inline.
   * The owning plugin classifies this so the UI stays dialect-agnostic. */
  large?: boolean;
}

/** A cell value plus the SQL type to CAST it to, for editing DML. */
export interface ColumnValue {
  column: string;
  type: string;
  value: unknown;
}

/** A staged update to one row: identify it by `pk`, set `changes`. */
export interface RowUpdate {
  pk: ColumnValue[];
  changes: ColumnValue[];
}

/** A batch of edits to a single table, applied atomically. */
export interface RowChanges {
  updates: RowUpdate[];
  /** Column values for each new row (omit a column to use its DB default). */
  inserts: ColumnValue[][];
  /** Key tuple of each row to delete. */
  deletes: ColumnValue[][];
}

export interface ApplyResult {
  updated: number;
  inserted: number;
  deleted: number;
}

export interface ColumnMeta {
  name: string;
  data_type: string;
}

/** An index on a table (shown in the structure view). */
export interface Index {
  name: string;
  /** Access method (`btree`, `hash`, `gin`, …). */
  method: string;
  unique: boolean;
  primary: boolean;
  columns: string[];
}

export interface QueryResult {
  columns: ColumnMeta[];
  rows: unknown[][];
  rows_affected: number | null;
  elapsed_ms: number;
  /** True when the result was capped at the row limit, so `rows` is partial. */
  result_truncated?: boolean;
  /** The SQL that produced this result, when re-runnable (SELECT-ish/browse).
   * `null`/absent for DML whose result is a row count. Used to export. */
  sql?: string | null;
}

/** Accepted browse-filter operators (mirrors `BrowseFilter::OPS` in Rust).
 * `is_null`/`is_not_null` ignore the value. */
export type BrowseOp =
  | "eq"
  | "ne"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "like"
  | "ilike"
  | "is_null"
  | "is_not_null";

/** One `ORDER BY` term for browsing a table. */
export interface BrowseSort {
  column: string;
  descending: boolean;
}

/** One structured `WHERE` condition: `column <op> value`. The value is sent as
 * a bound parameter CAST to `type`, so it's never interpolated into SQL. */
export interface BrowseFilter {
  column: string;
  type: string;
  op: BrowseOp;
  value: unknown;
}

/** How to browse a table: structured filters (AND'd), sort terms, a row limit,
 * an offset for paging, and an optional raw `WHERE` fragment (advanced). */
export interface BrowseSpec {
  filters: BrowseFilter[];
  sorts: BrowseSort[];
  limit: number;
  offset: number;
  where_sql?: string | null;
}

// --- Document (MongoDB) ---------------------------------------------------

export interface MongoCollection {
  database: string;
  name: string;
}

export interface FindResult {
  documents: unknown[];
  elapsed_ms: number;
}

// --- RabbitMQ (Management API) --------------------------------------------
// Mirrors the subset of the HTTP Management API payloads the plugin returns.

export interface ObjectTotals {
  queues: number;
  exchanges: number;
  connections: number;
  channels: number;
  consumers: number;
}

export interface QueueTotals {
  messages: number;
  messages_ready: number;
  messages_unacknowledged: number;
}

export interface RateDetails {
  rate: number;
}

export interface MessageStats {
  publish_details: RateDetails;
  deliver_get_details: RateDetails;
  ack_details: RateDetails;
}

export interface MqOverview {
  rabbitmq_version: string;
  erlang_version: string;
  cluster_name: string;
  node: string;
  object_totals: ObjectTotals;
  queue_totals: QueueTotals;
  message_stats: MessageStats;
}

export interface MqQueue {
  name: string;
  vhost: string;
  state: string;
  type: string;
  durable: boolean;
  auto_delete: boolean;
  messages: number;
  messages_ready: number;
  messages_unacknowledged: number;
  consumers: number;
  memory: number;
  message_stats: MessageStats;
}

export interface MqExchange {
  name: string;
  vhost: string;
  type: string;
  durable: boolean;
  auto_delete: boolean;
  internal: boolean;
}

export interface MqConnection {
  name: string;
  user: string;
  state: string;
  channels: number;
  protocol: string;
  peer_host: string;
  peer_port: number;
  vhost: string;
  ssl: boolean;
}

export interface MqChannel {
  name: string;
  user: string;
  state: string;
  vhost: string;
  number: number;
  consumer_count: number;
  messages_unacknowledged: number;
  prefetch_count: number;
}

export interface MqMessage {
  payload: string;
  payload_bytes: number;
  redelivered: boolean;
  routing_key: string;
  exchange: string;
  message_count: number;
}

export interface MqPublishResult {
  routed: boolean;
}

export interface MqPurgeResult {
  queue: string;
}

// --- SFTP (FileManager) ---------------------------------------------------

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

// --- Commands -------------------------------------------------------------

/** Forward an opaque capability call to the plugin owning the connection. */
const pluginCall = <T>(
  connectionId: ConnectionId,
  op: string,
  params: Record<string, unknown>,
) => invoke<T>("plugin_call", { connectionId, op, params });

export const api = {
  listPlugins: () => invoke<PluginInfo[]>("list_plugins"),

  /** The release channel this app build tracks (`"nightly"` or `"stable"`). */
  appChannel: () => invoke<string>("app_channel"),

  testConnection: (pluginId: string, config: ConnectionConfig) =>
    invoke<void>("test_connection", { pluginId, config }),

  openConnection: (pluginId: string, config: ConnectionConfig) =>
    invoke<ConnectionId>("open_connection", { pluginId, config }),

  closeConnection: (connectionId: ConnectionId) =>
    invoke<void>("close_connection", { connectionId }),

  // Plugin install (from GitHub releases)
  listGithubPlugins: (repo: string) =>
    invoke<AvailablePlugin[]>("list_github_plugins", { repo }),

  previewGithubPlugin: (repo: string, tag?: string | null, pluginId?: string | null) =>
    invoke<GithubPreview>("preview_github_plugin", {
      repo,
      tag: tag ?? null,
      pluginId: pluginId ?? null,
    }),

  installGithubPlugin: (repo: string, tag: string, pluginId: string, expectedSha: string | null) =>
    invoke<PluginInfo>("install_github_plugin", { repo, tag, pluginId, expectedSha }),

  /** Uninstall a plugin (stops its process, deletes its files). Rejects if the
   *  plugin has open connections. */
  uninstallPlugin: (pluginId: string) =>
    invoke<void>("uninstall_plugin", { pluginId }),

  // RDBMS
  rdbmsListSchemas: (connectionId: ConnectionId) =>
    pluginCall<Schema[]>(connectionId, "rdbms.list_schemas", {}),

  /** Databases on the same server. Rejects with `Unsupported` for backends
   *  with no notion of multiple databases (e.g. SQLite). */
  rdbmsListDatabases: (connectionId: ConnectionId) =>
    pluginCall<string[]>(connectionId, "rdbms.list_databases", {}),

  /** Switch the connection's active database in place (keeps the same id). */
  rdbmsUseDatabase: (connectionId: ConnectionId, database: string) =>
    pluginCall<void>(connectionId, "rdbms.use_database", { database }),

  rdbmsListTables: (connectionId: ConnectionId, schema: string) =>
    pluginCall<Table[]>(connectionId, "rdbms.list_tables", { schema }),

  rdbmsDescribeTable: (connectionId: ConnectionId, schema: string, table: string) =>
    pluginCall<Column[]>(connectionId, "rdbms.describe_table", { schema, table }),

  /** Full backend-specific DDL (CREATE TABLE + indexes) for a table. */
  rdbmsDdlStatement: (connectionId: ConnectionId, schema: string, table: string) =>
    pluginCall<string>(connectionId, "rdbms.ddl_statement", { schema, table }),

  /** Indexes on a table, for the structure view. */
  rdbmsListIndexes: (connectionId: ConnectionId, schema: string, table: string) =>
    pluginCall<Index[]>(connectionId, "rdbms.list_indexes", { schema, table }),

  /** Run a SQL script; returns one result per statement, in order. */
  rdbmsExecute: (connectionId: ConnectionId, sql: string) =>
    pluginCall<QueryResult[]>(connectionId, "rdbms.execute", { sql }),

  /** Re-run `sql` and have the plugin write the full result set (no row cap) to
   * `path` as CSV. Returns the number of data rows written. */
  rdbmsExportCsv: (connectionId: ConnectionId, sql: string, path: string) =>
    pluginCall<number>(connectionId, "rdbms.export_csv", { sql, path }),

  /** Cancel the in-flight plugin call for a connection (aborts it on the server). */
  cancelLastPluginCall: (connectionId: ConnectionId) =>
    invoke<void>("cancel_last_plugin_call", { connectionId }),

  /** Fetch rows of a table per a browse spec (filters, sort, limit, paging);
   * the plugin builds the dialect-correct query, binding filter values. */
  rdbmsBrowseTable: (
    connectionId: ConnectionId,
    schema: string,
    table: string,
    spec: BrowseSpec,
  ) =>
    pluginCall<QueryResult>(connectionId, "rdbms.browse_table", {
      schema,
      table,
      spec,
    }),

  rdbmsApplyChanges: (
    connectionId: ConnectionId,
    schema: string,
    table: string,
    changes: RowChanges,
  ) =>
    pluginCall<ApplyResult>(connectionId, "rdbms.apply_changes", {
      schema,
      table,
      changes,
    }),

  // Document
  docListDatabases: (connectionId: ConnectionId) =>
    pluginCall<string[]>(connectionId, "document.list_databases", {}),

  docListCollections: (connectionId: ConnectionId, database: string) =>
    pluginCall<MongoCollection[]>(connectionId, "document.list_collections", { database }),

  docFind: (
    connectionId: ConnectionId,
    database: string,
    collection: string,
    filter: string | null,
    limit: number,
  ) =>
    pluginCall<FindResult>(connectionId, "document.find", {
      database,
      collection,
      filter,
      limit,
    }),

  // RabbitMQ (Management API)
  mqOverview: (connectionId: ConnectionId) =>
    pluginCall<MqOverview>(connectionId, "rabbitmq.overview", {}),

  mqListQueues: (connectionId: ConnectionId) =>
    pluginCall<MqQueue[]>(connectionId, "rabbitmq.list_queues", {}),

  mqListExchanges: (connectionId: ConnectionId) =>
    pluginCall<MqExchange[]>(connectionId, "rabbitmq.list_exchanges", {}),

  mqListConnections: (connectionId: ConnectionId) =>
    pluginCall<MqConnection[]>(connectionId, "rabbitmq.list_connections", {}),

  mqListChannels: (connectionId: ConnectionId) =>
    pluginCall<MqChannel[]>(connectionId, "rabbitmq.list_channels", {}),

  /** Fetch up to `count` messages. `ackmode` is the Management API verb:
   *  `ack_requeue_true` peeks (requeues), `ack_requeue_false` removes them. */
  mqGetMessages: (
    connectionId: ConnectionId,
    vhost: string,
    queue: string,
    count: number,
    ackmode: string,
  ) =>
    pluginCall<MqMessage[]>(connectionId, "rabbitmq.get_messages", {
      vhost,
      queue,
      count,
      ackmode,
    }),

  /** Empty `exchange` targets the queue named by `routingKey` (default exchange). */
  mqPublish: (
    connectionId: ConnectionId,
    vhost: string,
    exchange: string,
    routingKey: string,
    payload: string,
  ) =>
    pluginCall<MqPublishResult>(connectionId, "rabbitmq.publish", {
      vhost,
      exchange,
      routing_key: routingKey,
      payload,
    }),

  mqPurgeQueue: (connectionId: ConnectionId, vhost: string, queue: string) =>
    pluginCall<MqPurgeResult>(connectionId, "rabbitmq.purge_queue", { vhost, queue }),

  mqDeclareQueue: (
    connectionId: ConnectionId,
    vhost: string,
    queue: string,
    durable: boolean,
  ) =>
    pluginCall<MqQueue>(connectionId, "rabbitmq.declare_queue", {
      vhost,
      queue,
      durable,
    }),

  mqDeleteQueue: (connectionId: ConnectionId, vhost: string, queue: string) =>
    pluginCall<void>(connectionId, "rabbitmq.delete_queue", { vhost, queue }),

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
};

/** Normalize a thrown Tauri command error into a string. */
export function errString(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}

// ---------------------------------------------------------------------------
// PTY (CLI / SSH workspace)
// ---------------------------------------------------------------------------
//
// A CLI connection can host several terminal tabs, so PTYs are keyed by a
// frontend-minted `terminalId` (a UUID), not the connection id. `ptySpawn`
// still needs the connection id to route the `cli.spawn_spec` query to the
// owning plugin; everything else addresses a terminal directly.

/** Spawn the CLI plugin's terminal process in a PTY for `terminalId`. The host
 * asks the owning plugin how to launch it (`cli.spawn_spec`, routed by
 * `connectionId`), so no config is sent from here. Idempotent: a no-op if the
 * terminal's PTY is already running. */
export function ptySpawn(
  connectionId: ConnectionId,
  terminalId: string,
): Promise<void> {
  return invoke("pty_spawn", { connectionId, terminalId });
}

/** Send raw bytes (keystrokes / paste) to a terminal's PTY. */
export function ptyWrite(
  terminalId: string,
  data: number[],
): Promise<void> {
  return invoke("pty_write", { terminalId, data });
}

/** Notify a terminal's PTY of a resize. */
export function ptyResize(
  terminalId: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("pty_resize", { terminalId, cols, rows });
}

/** Close and drop a single terminal's PTY. */
export function ptyClose(terminalId: string): Promise<void> {
  return invoke("pty_close", { terminalId });
}

/** Close and drop every terminal PTY owned by a connection (teardown on
 * disconnect / delete). */
export function ptyCloseConnection(
  connectionId: ConnectionId,
): Promise<void> {
  return invoke("pty_close_connection", { connectionId });
}

/** Retained scrollback (recent output bytes) for a terminal's PTY, so a
 * remounted terminal can repaint its history. Empty if no live PTY. */
export function ptySnapshot(terminalId: string): Promise<number[]> {
  return invoke("pty_snapshot", { terminalId });
}
