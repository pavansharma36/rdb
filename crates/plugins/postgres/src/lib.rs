use async_trait::async_trait;
use rdb_core::{
    ConfigField, ConfigFieldType, Connection, ConnectionConfig, Plugin, PluginError, PluginInfo,
    PluginKind, Result,
};
use rdb_rdbms_common::{
    downcast_conn, ApplyResult, Column, ColumnMeta, ColumnValue, QueryResult, RdbmsPlugin,
    RowChanges, Schema, Table, TableKind,
};
use sqlx::postgres::{PgPool, PgPoolOptions, PgRow};
use sqlx::{Column as _, Row, TypeInfo};
use std::sync::{Arc, RwLock};
use std::time::Instant;

pub struct PostgresPlugin;

impl PostgresPlugin {
    pub fn new() -> Self {
        Self
    }
}

impl Default for PostgresPlugin {
    fn default() -> Self {
        Self::new()
    }
}

/// A live connection to one database on a Postgres server.
///
/// The pool sits behind a lock so the active database can be switched in place
/// (Postgres binds a connection to a single database, so switching means
/// building a fresh pool) without changing the connection's id. `config` keeps
/// the original host/credentials so a new pool can be built for another
/// database on the same server.
pub struct PostgresConnection {
    pool: RwLock<PgPool>,
    config: ConnectionConfig,
}

impl PostgresConnection {
    /// A cheap clone of the current pool (sqlx pools are internally `Arc`d). The
    /// lock is released before the returned pool is awaited on, so a concurrent
    /// `use_database` swap never blocks in-flight queries.
    fn pool(&self) -> PgPool {
        self.pool.read().unwrap().clone()
    }
}

impl Connection for PostgresConnection {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

fn cfg_str(cfg: &ConnectionConfig, key: &str) -> Result<String> {
    cfg.get(key)
        .and_then(|v| v.as_str().map(str::to_string))
        .ok_or_else(|| PluginError::Config(format!("missing field: {key}")))
}

fn cfg_str_opt(cfg: &ConnectionConfig, key: &str) -> Option<String> {
    cfg.get(key).and_then(|v| v.as_str().map(str::to_string))
}

fn cfg_u16(cfg: &ConnectionConfig, key: &str, default: u16) -> u16 {
    cfg.get(key)
        .and_then(|v| v.as_u64())
        .map(|n| n as u16)
        .unwrap_or(default)
}

/// Build a `postgres://` URL from a config, pointed at `database`. The database
/// is passed explicitly (rather than read from `cfg`) so the same credentials
/// can be reused to connect to a different database when switching.
fn build_url(cfg: &ConnectionConfig, database: &str) -> Result<String> {
    let host = cfg_str(cfg, "host")?;
    let port = cfg_u16(cfg, "port", 5432);
    let user = cfg_str(cfg, "user")?;
    let password = cfg_str_opt(cfg, "password").unwrap_or_default();
    let ssl = cfg_str_opt(cfg, "ssl").unwrap_or_else(|| "prefer".into());
    Ok(format!(
        "postgres://{u}:{p}@{host}:{port}/{database}?sslmode={ssl}",
        u = urlencode(&user),
        p = urlencode(&password),
        database = urlencode(database),
    ))
}

async fn make_pool(url: &str) -> Result<PgPool> {
    PgPoolOptions::new()
        .max_connections(8)
        .connect(url)
        .await
        .map_err(|e| PluginError::Connection(e.to_string()))
}

#[async_trait]
impl Plugin for PostgresPlugin {
    fn info(&self) -> PluginInfo {
        PluginInfo {
            id: "postgres".into(),
            name: "PostgreSQL".into(),
            kind: PluginKind::Rdbms,
            version: env!("CARGO_PKG_VERSION").into(),
            description: "Connect to PostgreSQL 12+ databases.".into(),
            ui_module: Some("rdbms".into()),
            protocol_version: rdb_core::PROTOCOL_VERSION,
            config_schema: vec![
                ConfigField {
                    key: "host".into(),
                    label: "Host".into(),
                    field_type: ConfigFieldType::Text,
                    required: true,
                    default: Some(serde_json::json!("localhost")),
                    placeholder: Some("localhost".into()),
                    show_if: None,
                },
                ConfigField {
                    key: "port".into(),
                    label: "Port".into(),
                    field_type: ConfigFieldType::Number,
                    required: true,
                    default: Some(serde_json::json!(5432)),
                    placeholder: None,
                    show_if: None,
                },
                ConfigField {
                    key: "database".into(),
                    label: "Database".into(),
                    field_type: ConfigFieldType::Text,
                    required: true,
                    default: None,
                    placeholder: Some("postgres".into()),
                    show_if: None,
                },
                ConfigField {
                    key: "user".into(),
                    label: "User".into(),
                    field_type: ConfigFieldType::Text,
                    required: true,
                    default: None,
                    placeholder: Some("postgres".into()),
                    show_if: None,
                },
                ConfigField {
                    key: "password".into(),
                    label: "Password".into(),
                    field_type: ConfigFieldType::Password,
                    required: false,
                    default: None,
                    placeholder: None,
                    show_if: None,
                },
                ConfigField {
                    key: "ssl".into(),
                    label: "SSL".into(),
                    field_type: ConfigFieldType::Select {
                        options: vec!["disable".into(), "prefer".into(), "require".into()],
                    },
                    required: false,
                    default: Some(serde_json::json!("prefer")),
                    placeholder: None,
                    show_if: None,
                },
            ],
        }
    }

    async fn connect(&self, cfg: ConnectionConfig) -> Result<Arc<dyn Connection>> {
        let database = cfg_str(&cfg, "database")?;
        let url = build_url(&cfg, &database)?;
        let pool = make_pool(&url).await?;
        Ok(Arc::new(PostgresConnection {
            pool: RwLock::new(pool),
            config: cfg,
        }))
    }
}

#[async_trait]
impl RdbmsPlugin for PostgresPlugin {
    async fn list_schemas(&self, conn: Arc<dyn Connection>) -> Result<Vec<Schema>> {
        let conn = downcast_conn::<PostgresConnection>(&conn)?;
        let rows: Vec<(String,)> = sqlx::query_as(
            "select schema_name from information_schema.schemata \
             where schema_name not in ('pg_catalog','information_schema') \
             and schema_name not like 'pg_toast%' and schema_name not like 'pg_temp%' \
             order by schema_name",
        )
        .fetch_all(&conn.pool())
        .await
        .map_err(|e| PluginError::Backend(e.to_string()))?;
        Ok(rows.into_iter().map(|(n,)| Schema { name: n }).collect())
    }

    async fn list_databases(&self, conn: Arc<dyn Connection>) -> Result<Vec<String>> {
        let conn = downcast_conn::<PostgresConnection>(&conn)?;
        let rows: Vec<(String,)> = sqlx::query_as(
            "select datname from pg_database \
             where datistemplate = false and datallowconn = true \
             order by datname",
        )
        .fetch_all(&conn.pool())
        .await
        .map_err(|e| PluginError::Backend(e.to_string()))?;
        Ok(rows.into_iter().map(|(n,)| n).collect())
    }

    async fn use_database(&self, conn: Arc<dyn Connection>, database: &str) -> Result<()> {
        let conn = downcast_conn::<PostgresConnection>(&conn)?;
        // Build and validate the new pool before swapping, so a failed switch
        // leaves the existing connection untouched.
        let url = build_url(&conn.config, database)?;
        let pool = make_pool(&url).await?;
        *conn.pool.write().unwrap() = pool;
        Ok(())
    }

    async fn list_tables(&self, conn: Arc<dyn Connection>, schema: &str) -> Result<Vec<Table>> {
        let conn = downcast_conn::<PostgresConnection>(&conn)?;
        let rows: Vec<(String, String)> = sqlx::query_as(
            "select table_name, table_type from information_schema.tables \
             where table_schema = $1 order by table_name",
        )
        .bind(schema)
        .fetch_all(&conn.pool())
        .await
        .map_err(|e| PluginError::Backend(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|(name, kind)| Table {
                schema: schema.to_string(),
                name,
                kind: match kind.as_str() {
                    "VIEW" => TableKind::View,
                    "MATERIALIZED VIEW" => TableKind::MaterializedView,
                    _ => TableKind::Table,
                },
            })
            .collect())
    }

    async fn describe_table(
        &self,
        conn: Arc<dyn Connection>,
        schema: &str,
        table: &str,
    ) -> Result<Vec<Column>> {
        let conn = downcast_conn::<PostgresConnection>(&conn)?;
        let rows: Vec<(String, String, String, String, Option<String>)> = sqlx::query_as(
            "select c.column_name, c.data_type, c.udt_name, c.is_nullable, \
                    (select 'YES' from information_schema.table_constraints tc \
                     join information_schema.key_column_usage kcu using (constraint_name, table_schema) \
                     where tc.constraint_type = 'PRIMARY KEY' \
                       and tc.table_schema = c.table_schema \
                       and tc.table_name = c.table_name \
                       and kcu.column_name = c.column_name limit 1) \
             from information_schema.columns c \
             where c.table_schema = $1 and c.table_name = $2 \
             order by c.ordinal_position",
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&conn.pool())
        .await
        .map_err(|e| PluginError::Backend(e.to_string()))?;

        Ok(rows
            .into_iter()
            .map(|(name, dtype, udt, nullable, pk)| Column {
                name,
                data_type: dtype,
                udt_name: Some(udt),
                nullable: nullable == "YES",
                primary_key: pk.is_some(),
            })
            .collect())
    }

    async fn execute(&self, conn: Arc<dyn Connection>, sql: &str) -> Result<QueryResult> {
        let conn = downcast_conn::<PostgresConnection>(&conn)?;
        let pool = conn.pool();
        let start = Instant::now();

        if is_select(sql) {
            let rows = sqlx::query(sql)
                .fetch_all(&pool)
                .await
                .map_err(|e| PluginError::Backend(e.to_string()))?;
            let columns = if let Some(first) = rows.first() {
                first
                    .columns()
                    .iter()
                    .map(|c| ColumnMeta {
                        name: c.name().to_string(),
                        data_type: c.type_info().name().to_string(),
                    })
                    .collect()
            } else {
                Vec::new()
            };
            let data = rows.iter().map(row_to_json).collect();
            Ok(QueryResult {
                columns,
                rows: data,
                rows_affected: None,
                elapsed_ms: start.elapsed().as_millis(),
            })
        } else {
            let res = sqlx::query(sql)
                .execute(&pool)
                .await
                .map_err(|e| PluginError::Backend(e.to_string()))?;
            Ok(QueryResult {
                columns: Vec::new(),
                rows: Vec::new(),
                rows_affected: Some(res.rows_affected()),
                elapsed_ms: start.elapsed().as_millis(),
            })
        }
    }

    async fn apply_changes(
        &self,
        conn: Arc<dyn Connection>,
        schema: &str,
        table: &str,
        changes: RowChanges,
    ) -> Result<ApplyResult> {
        let conn = downcast_conn::<PostgresConnection>(&conn)?;
        let mut tx = conn
            .pool()
            .begin()
            .await
            .map_err(|e| PluginError::Backend(e.to_string()))?;

        let mut result = ApplyResult::default();

        for u in &changes.updates {
            let (sql, params) = build_update(schema, table, &u.pk, &u.changes)?;
            result.updated += run_dml(&mut tx, &sql, &params).await?;
        }
        for values in &changes.inserts {
            let (sql, params) = build_insert(schema, table, values)?;
            result.inserted += run_dml(&mut tx, &sql, &params).await?;
        }
        for pk in &changes.deletes {
            let (sql, params) = build_delete(schema, table, pk)?;
            result.deleted += run_dml(&mut tx, &sql, &params).await?;
        }

        tx.commit()
            .await
            .map_err(|e| PluginError::Backend(e.to_string()))?;
        Ok(result)
    }
}

/// Bind `params` to `sql` and execute it on the transaction, returning the
/// number of affected rows.
async fn run_dml(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    sql: &str,
    params: &[String],
) -> Result<u64> {
    let mut q = sqlx::query(sql);
    for p in params {
        q = q.bind(p);
    }
    let res = q
        .execute(&mut **tx)
        .await
        .map_err(|e| PluginError::Backend(e.to_string()))?;
    Ok(res.rows_affected())
}

/// Build an `UPDATE ... SET ... WHERE ...` and its bound parameters.
fn build_update(
    schema: &str,
    table: &str,
    pk: &[ColumnValue],
    changes: &[ColumnValue],
) -> Result<(String, Vec<String>)> {
    if changes.is_empty() {
        return Err(PluginError::Config("no columns to update".into()));
    }
    let mut params: Vec<String> = Vec::new();
    let mut set_parts = Vec::new();
    for cv in changes {
        set_parts.push(format!(
            "{} = {}",
            quote_ident(&cv.column),
            value_expr(cv, &mut params)?
        ));
    }
    let where_sql = build_where(pk, &mut params)?;
    let sql = format!(
        "UPDATE {}.{} SET {} WHERE {}",
        quote_ident(schema),
        quote_ident(table),
        set_parts.join(", "),
        where_sql,
    );
    Ok((sql, params))
}

/// Build an `INSERT INTO ...` and its bound parameters.
fn build_insert(
    schema: &str,
    table: &str,
    values: &[ColumnValue],
) -> Result<(String, Vec<String>)> {
    let mut params: Vec<String> = Vec::new();
    let mut cols = Vec::new();
    let mut vals = Vec::new();
    for cv in values {
        cols.push(quote_ident(&cv.column));
        vals.push(value_expr(cv, &mut params)?);
    }
    let sql = if cols.is_empty() {
        format!(
            "INSERT INTO {}.{} DEFAULT VALUES",
            quote_ident(schema),
            quote_ident(table),
        )
    } else {
        format!(
            "INSERT INTO {}.{} ({}) VALUES ({})",
            quote_ident(schema),
            quote_ident(table),
            cols.join(", "),
            vals.join(", "),
        )
    };
    Ok((sql, params))
}

/// Build a `DELETE FROM ... WHERE ...` and its bound parameters.
fn build_delete(schema: &str, table: &str, pk: &[ColumnValue]) -> Result<(String, Vec<String>)> {
    let mut params: Vec<String> = Vec::new();
    let where_sql = build_where(pk, &mut params)?;
    let sql = format!(
        "DELETE FROM {}.{} WHERE {}",
        quote_ident(schema),
        quote_ident(table),
        where_sql,
    );
    Ok((sql, params))
}

/// Quote an SQL identifier, escaping embedded double quotes.
fn quote_ident(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

/// Reject type names that aren't a plausible SQL type, so they can be
/// interpolated into a `CAST(... AS <type>)` without opening an injection hole.
/// Postgres type names are letters/digits/underscores plus spaces, parens and
/// brackets (`character varying`, `numeric(10,2)`, `int[]`).
fn validate_type(t: &str) -> Result<&str> {
    let ok = !t.is_empty()
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '_' | '(' | ')' | '[' | ']' | ',' | '.'));
    if ok {
        Ok(t)
    } else {
        Err(PluginError::Config(format!("invalid column type: {t}")))
    }
}

/// Render the SQL expression for a value: `NULL`, or a `CAST($n AS <type>)`
/// placeholder whose bound text is appended to `params`.
fn value_expr(cv: &ColumnValue, params: &mut Vec<String>) -> Result<String> {
    if cv.value.is_null() {
        return Ok("NULL".into());
    }
    let ty = validate_type(&cv.type_name)?;
    params.push(bind_text(&cv.value));
    Ok(format!("CAST(${} AS {})", params.len(), ty))
}

/// Build a `WHERE` clause that matches a single row by the given key columns.
fn build_where(key: &[ColumnValue], params: &mut Vec<String>) -> Result<String> {
    if key.is_empty() {
        return Err(PluginError::Config(
            "cannot identify row: no key columns".into(),
        ));
    }
    let mut parts = Vec::new();
    for cv in key {
        if cv.value.is_null() {
            parts.push(format!("{} IS NULL", quote_ident(&cv.column)));
        } else {
            parts.push(format!("{} = {}", quote_ident(&cv.column), value_expr(cv, params)?));
        }
    }
    Ok(parts.join(" AND "))
}

/// Text form of a JSON value to bind as a string parameter; Postgres coerces it
/// via the surrounding `CAST`. Objects/arrays serialize back to JSON text (for
/// `json`/`jsonb`/array columns).
fn bind_text(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Bool(b) => b.to_string(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn is_select(sql: &str) -> bool {
    let head = sql
        .trim_start()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(head.as_str(), "select" | "with" | "show" | "explain")
}

fn row_to_json(row: &PgRow) -> Vec<serde_json::Value> {
    use sqlx::ValueRef;
    let mut out = Vec::with_capacity(row.len());
    for i in 0..row.len() {
        let raw = match row.try_get_raw(i) {
            Ok(r) => r,
            Err(_) => {
                out.push(serde_json::Value::Null);
                continue;
            }
        };
        if raw.is_null() {
            out.push(serde_json::Value::Null);
            continue;
        }
        if let Ok(v) = row.try_get::<bool, _>(i) {
            out.push(serde_json::Value::Bool(v));
        } else if let Ok(v) = row.try_get::<i64, _>(i) {
            out.push(serde_json::Value::Number(v.into()));
        } else if let Ok(v) = row.try_get::<f64, _>(i) {
            out.push(
                serde_json::Number::from_f64(v)
                    .map(serde_json::Value::Number)
                    .unwrap_or(serde_json::Value::Null),
            );
        } else if let Ok(v) = row.try_get::<serde_json::Value, _>(i) {
            out.push(v);
        } else if let Ok(v) = row.try_get::<String, _>(i) {
            out.push(serde_json::Value::String(v));
        } else {
            out.push(serde_json::Value::String(format!(
                "<{}>",
                raw.type_info().name()
            )));
        }
    }
    out
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
