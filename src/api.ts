// Typed bridge to the Rust `#[tauri::command]` surface in `src-tauri/src/commands.rs`.
// Types mirror the serde representations of the Rust structs.
//
// The host is a generic pipe: lifecycle commands (list/test/open/close) are
// typed, but every capability call funnels through one `plugin_call` command
// with an opaque `op` string. Only the wrappers below know the op names — the
// workspace components are unchanged.

import { invoke } from "@tauri-apps/api/core";

export type PluginKind = "rdbms" | "document" | "messaging" | "other";

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

// --- Messaging (RabbitMQ) -------------------------------------------------

export interface QueueInfo {
  name: string;
  message_count: number;
  consumer_count: number;
}

export interface PublishedMessage {
  queue: string;
  bytes: number;
}

export interface ConsumedMessage {
  body: string;
  delivery_tag: number;
  redelivered: boolean;
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

  testConnection: (pluginId: string, config: ConnectionConfig) =>
    invoke<void>("test_connection", { pluginId, config }),

  openConnection: (pluginId: string, config: ConnectionConfig) =>
    invoke<ConnectionId>("open_connection", { pluginId, config }),

  closeConnection: (connectionId: ConnectionId) =>
    invoke<void>("close_connection", { connectionId }),

  // Plugin install (from GitHub releases)
  previewGithubPlugin: (repo: string, tag?: string | null) =>
    invoke<GithubPreview>("preview_github_plugin", { repo, tag: tag ?? null }),

  installGithubPlugin: (repo: string, tag: string, expectedSha: string | null) =>
    invoke<PluginInfo>("install_github_plugin", { repo, tag, expectedSha }),

  // RDBMS
  rdbmsListSchemas: (connectionId: ConnectionId) =>
    pluginCall<Schema[]>(connectionId, "rdbms.list_schemas", {}),

  rdbmsListTables: (connectionId: ConnectionId, schema: string) =>
    pluginCall<Table[]>(connectionId, "rdbms.list_tables", { schema }),

  rdbmsDescribeTable: (connectionId: ConnectionId, schema: string, table: string) =>
    pluginCall<Column[]>(connectionId, "rdbms.describe_table", { schema, table }),

  rdbmsExecute: (connectionId: ConnectionId, sql: string) =>
    pluginCall<QueryResult>(connectionId, "rdbms.execute", { sql }),

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

  // Messaging
  mqDeclareQueue: (connectionId: ConnectionId, queue: string) =>
    pluginCall<QueueInfo>(connectionId, "messaging.declare_queue", { queue }),

  mqPublish: (connectionId: ConnectionId, queue: string, body: string) =>
    pluginCall<PublishedMessage>(connectionId, "messaging.publish", { queue, body }),

  mqGetOne: (connectionId: ConnectionId, queue: string, ack: boolean) =>
    pluginCall<ConsumedMessage | null>(connectionId, "messaging.get_one", { queue, ack }),

  mqConsumeN: (connectionId: ConnectionId, queue: string, n: number) =>
    pluginCall<ConsumedMessage[]>(connectionId, "messaging.consume_n", { queue, n }),
};

/** Normalize a thrown Tauri command error into a string. */
export function errString(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
