// Typed bridge to the Rust `#[tauri::command]` surface in `src-tauri/src/commands.rs`.
// Types mirror the serde representations of the Rust structs.
//
// The host is a generic pipe: lifecycle commands (list/test/open/close) are
// typed, but every capability call funnels through one `plugin_call` command
// with an opaque `op` string. Only the wrappers below know the op names — the
// workspace components are unchanged.

import { invoke } from "@tauri-apps/api/core";

export type PluginKind = "rdbms" | "document" | "rabbitmq" | "other";

export type ConfigFieldType =
  | { kind: "text" }
  | { kind: "password" }
  | { kind: "number" }
  | { kind: "boolean" }
  | { kind: "select"; options: string[] };

export interface ShowIf {
  field: string;
  equals: string;
}

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
  assetName: string;
  sizeBytes: number;
  /** Available version (stable releases only; nightly has none in the tag). */
  availableVersion: string | null;
  /** Release publish timestamp (drives nightly update detection). */
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

export interface Column {
  name: string;
  data_type: string;
  /** Underlying type (`udt_name`); the actual enum type for `USER-DEFINED`. */
  udt_name?: string | null;
  nullable: boolean;
  primary_key: boolean;
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

  /** Cancel the in-flight plugin call for a connection (aborts it on the server). */
  cancelLastPluginCall: (connectionId: ConnectionId) =>
    invoke<void>("cancel_last_plugin_call", { connectionId }),

  /** Fetch the first `limit` rows of a table; the plugin builds the
   * dialect-correct query (quoting + row limit). */
  rdbmsBrowseTable: (
    connectionId: ConnectionId,
    schema: string,
    table: string,
    limit: number,
  ) =>
    pluginCall<QueryResult>(connectionId, "rdbms.browse_table", {
      schema,
      table,
      limit,
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
};

/** Normalize a thrown Tauri command error into a string. */
export function errString(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
