//! Shared abstractions for relational database plugins.
//!
//! Plugins (postgres, mysql, sqlite, ...) implement [`RdbmsPlugin`] in addition
//! to [`rdb_core::Plugin`]. The host calls into the same trait regardless of
//! backend, and the frontend reuses the `rdbms` UI module for all of them.
//!
//! ## Adding a new RDBMS plugin
//!
//! 1. Make a binary crate that depends on `rdb-core`, `rdb-rdbms-common`, and
//!    `rdb-plugin-runtime`.
//! 2. Define a struct that implements `Plugin` (returning `PluginKind::Rdbms`)
//!    and `RdbmsPlugin`.
//! 3. In `main`, call `rdb_plugin_runtime::run(plugin, RdbmsDispatcher(plugin))`.
//!
//! [`dispatch_rdbms`] maps the opaque `op` strings the host forwards
//! (`"rdbms.execute"`, `"rdbms.apply_changes"`, ...) onto the trait methods.

use async_trait::async_trait;
use rdb_core::{Connection, PluginError, Result};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Schema {
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Table {
    pub schema: String,
    pub name: String,
    pub kind: TableKind,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TableKind {
    Table,
    View,
    MaterializedView,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Column {
    pub name: String,
    pub data_type: String,
    /// Underlying type name (`information_schema.columns.udt_name`). Used as the
    /// cast target when `data_type` is not itself a usable SQL type — most
    /// notably `USER-DEFINED` (enums) where `udt_name` is the actual enum type.
    #[serde(default)]
    pub udt_name: Option<String>,
    pub nullable: bool,
    pub primary_key: bool,
}

/// A single cell's value together with the SQL type to cast it to. Used to
/// build parameterized DML for editing: the frontend sends the column name,
/// the type to `CAST` the bound parameter to, and the new (or key) value.
///
/// `value` carries the JSON representation; `Null` means SQL `NULL`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnValue {
    pub column: String,
    /// SQL type used as the `CAST` target for the bound parameter
    /// (e.g. `integer`, `text`, `jsonb`, a user-defined enum name).
    #[serde(rename = "type")]
    pub type_name: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<serde_json::Value>>,
    pub rows_affected: Option<u64>,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
}

/// A staged update to one row: identify it by `pk`, set the columns in `changes`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RowUpdate {
    pub pk: Vec<ColumnValue>,
    pub changes: Vec<ColumnValue>,
}

/// A batch of edits to a single table, applied atomically.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RowChanges {
    #[serde(default)]
    pub updates: Vec<RowUpdate>,
    /// Each entry is the column values for one new row (omit a column to take
    /// its database default).
    #[serde(default)]
    pub inserts: Vec<Vec<ColumnValue>>,
    /// Each entry is the key tuple of a row to delete.
    #[serde(default)]
    pub deletes: Vec<Vec<ColumnValue>>,
}

/// Per-operation row counts from applying a [`RowChanges`] batch.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ApplyResult {
    pub updated: u64,
    pub inserted: u64,
    pub deleted: u64,
}

#[async_trait]
pub trait RdbmsPlugin: Send + Sync {
    async fn list_schemas(&self, conn: Arc<dyn Connection>) -> Result<Vec<Schema>>;

    /// List the databases reachable on the same server as this connection.
    /// Backends with no notion of multiple databases (e.g. SQLite) return
    /// [`PluginError::Unsupported`], in which case the UI hides the picker.
    async fn list_databases(&self, _conn: Arc<dyn Connection>) -> Result<Vec<String>> {
        Err(PluginError::Unsupported)
    }

    /// Point this connection at a different database on the same server,
    /// without changing its id. The connection keeps the same credentials and
    /// host; only the active database changes. Plugins that can't switch return
    /// [`PluginError::Unsupported`].
    async fn use_database(&self, _conn: Arc<dyn Connection>, _database: &str) -> Result<()> {
        Err(PluginError::Unsupported)
    }

    async fn list_tables(&self, conn: Arc<dyn Connection>, schema: &str) -> Result<Vec<Table>>;

    async fn describe_table(
        &self,
        conn: Arc<dyn Connection>,
        schema: &str,
        table: &str,
    ) -> Result<Vec<Column>>;

    /// Return the full `CREATE TABLE` (and related `CREATE INDEX`, etc.) DDL for
    /// a table as backend-specific text. Plugins that can't produce DDL return
    /// [`PluginError::Unsupported`].
    async fn ddl_statement(
        &self,
        _conn: Arc<dyn Connection>,
        _schema: &str,
        _table: &str,
    ) -> Result<String> {
        Err(PluginError::Unsupported)
    }

    async fn execute(&self, conn: Arc<dyn Connection>, sql: &str) -> Result<QueryResult>;

    /// Apply a batch of inserts/updates/deletes to one table atomically (in a
    /// single transaction). Plugins that don't support editing return
    /// [`PluginError::Unsupported`].
    async fn apply_changes(
        &self,
        _conn: Arc<dyn Connection>,
        _schema: &str,
        _table: &str,
        _changes: RowChanges,
    ) -> Result<ApplyResult> {
        Err(PluginError::Unsupported)
    }
}

/// Downcast a `Arc<dyn Connection>` to a plugin's concrete connection type.
pub fn downcast_conn<T: 'static>(conn: &Arc<dyn Connection>) -> Result<&T> {
    conn.as_any()
        .downcast_ref::<T>()
        .ok_or_else(|| PluginError::Backend("connection type mismatch".into()))
}

// ---------------------------------------------------------------------------
// Capability dispatch (sidecar plugin <- host `call`)
// ---------------------------------------------------------------------------

use rdb_plugin_runtime::Dispatcher;
use serde_json::Value;

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T> {
    serde_json::from_value(params).map_err(|e| PluginError::Config(format!("invalid params: {e}")))
}

fn to_value<T: Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| PluginError::Backend(e.to_string()))
}

#[derive(Deserialize)]
struct ListTablesParams {
    schema: String,
}

#[derive(Deserialize)]
struct DescribeTableParams {
    schema: String,
    table: String,
}

#[derive(Deserialize)]
struct ExecuteParams {
    sql: String,
}

#[derive(Deserialize)]
struct UseDatabaseParams {
    database: String,
}

#[derive(Deserialize)]
struct ApplyChangesParams {
    schema: String,
    table: String,
    changes: RowChanges,
}

/// Map an `rdbms.*` op (forwarded opaquely by the host) onto an [`RdbmsPlugin`]
/// method, returning the JSON-serialized result. Unknown ops are
/// [`PluginError::Unsupported`].
pub async fn dispatch_rdbms(
    op: &str,
    params: Value,
    plugin: &dyn RdbmsPlugin,
    conn: Arc<dyn Connection>,
) -> Result<Value> {
    match op {
        "rdbms.list_schemas" => to_value(plugin.list_schemas(conn).await?),
        "rdbms.list_databases" => to_value(plugin.list_databases(conn).await?),
        "rdbms.use_database" => {
            let p: UseDatabaseParams = parse(params)?;
            plugin.use_database(conn, &p.database).await?;
            to_value(())
        }
        "rdbms.list_tables" => {
            let p: ListTablesParams = parse(params)?;
            to_value(plugin.list_tables(conn, &p.schema).await?)
        }
        "rdbms.describe_table" => {
            let p: DescribeTableParams = parse(params)?;
            to_value(plugin.describe_table(conn, &p.schema, &p.table).await?)
        }
        "rdbms.ddl_statement" => {
            let p: DescribeTableParams = parse(params)?;
            to_value(plugin.ddl_statement(conn, &p.schema, &p.table).await?)
        }
        "rdbms.execute" => {
            let p: ExecuteParams = parse(params)?;
            to_value(plugin.execute(conn, &p.sql).await?)
        }
        "rdbms.apply_changes" => {
            let p: ApplyChangesParams = parse(params)?;
            to_value(plugin.apply_changes(conn, &p.schema, &p.table, p.changes).await?)
        }
        _ => Err(PluginError::Unsupported),
    }
}

/// Adapts any [`RdbmsPlugin`] into a runtime [`Dispatcher`] by routing through
/// [`dispatch_rdbms`]. A plugin binary wires it up with
/// `run(plugin, RdbmsDispatcher(plugin))`.
pub struct RdbmsDispatcher<P: RdbmsPlugin>(pub P);

#[async_trait]
impl<P: RdbmsPlugin + 'static> Dispatcher for RdbmsDispatcher<P> {
    async fn dispatch(&self, op: &str, params: Value, conn: Arc<dyn Connection>) -> Result<Value> {
        dispatch_rdbms(op, params, &self.0, conn).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dummy;

    #[async_trait]
    impl RdbmsPlugin for Dummy {
        async fn list_schemas(&self, _conn: Arc<dyn Connection>) -> Result<Vec<Schema>> {
            Ok(vec![Schema {
                name: "public".into(),
            }])
        }
        async fn list_tables(&self, _c: Arc<dyn Connection>, _s: &str) -> Result<Vec<Table>> {
            Ok(vec![])
        }
        async fn describe_table(
            &self,
            _c: Arc<dyn Connection>,
            _s: &str,
            _t: &str,
        ) -> Result<Vec<Column>> {
            Ok(vec![])
        }
        async fn execute(&self, _c: Arc<dyn Connection>, _sql: &str) -> Result<QueryResult> {
            Ok(QueryResult {
                columns: vec![],
                rows: vec![],
                rows_affected: Some(0),
                elapsed_ms: 0,
            })
        }
    }

    struct NoConn;
    impl Connection for NoConn {
        fn as_any(&self) -> &dyn std::any::Any {
            self
        }
    }

    #[tokio::test]
    async fn maps_known_op() {
        let conn: Arc<dyn Connection> = Arc::new(NoConn);
        let v = dispatch_rdbms("rdbms.list_schemas", Value::Null, &Dummy, conn)
            .await
            .unwrap();
        assert_eq!(v, serde_json::json!([{ "name": "public" }]));
    }

    #[tokio::test]
    async fn rejects_unknown_op() {
        let conn: Arc<dyn Connection> = Arc::new(NoConn);
        let err = dispatch_rdbms("rdbms.bogus", Value::Null, &Dummy, conn)
            .await
            .unwrap_err();
        assert!(matches!(err, PluginError::Unsupported));
    }
}
