use async_trait::async_trait;
use futures_util::StreamExt;
use mongodb::{bson::doc, Client};
use rdb_core::{
    cfg_secret, ConfigField, ConfigFieldType, Connection, ConnectionConfig, Plugin, PluginError,
    PluginInfo, PluginKind, Result, ShowIf,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

pub struct MongoPlugin;

impl MongoPlugin {
    pub fn new() -> Self {
        Self
    }
}

impl Default for MongoPlugin {
    fn default() -> Self {
        Self::new()
    }
}

pub struct MongoConnection {
    pub client: Client,
    pub default_db: Option<String>,
}

impl Connection for MongoConnection {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MongoCollection {
    pub database: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FindResult {
    pub documents: Vec<serde_json::Value>,
    pub elapsed_ms: u128,
}

/// Connection-config `mode` values. They double as the matched value in
/// [`build_mongo_uri`] and as the `Select` options in [`MongoPlugin::info`].
const MODE_URI: &str = "Connection string";
const MODE_FIELDS: &str = "Individual settings";

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

fn cfg_bool(cfg: &ConnectionConfig, key: &str) -> bool {
    cfg.get(key).and_then(|v| v.as_bool()).unwrap_or(false)
}

/// Percent-encode a URI userinfo component (RFC 3986 unreserved set kept).
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

/// Resolve the effective MongoDB connection string, either taken verbatim from
/// the `uri` field or assembled from the individual host/port/credentials.
fn build_mongo_uri(cfg: &ConnectionConfig) -> Result<String> {
    let mode = cfg_str_opt(cfg, "mode").unwrap_or_else(|| MODE_URI.to_string());
    if mode != MODE_FIELDS {
        return cfg_str(cfg, "uri");
    }

    let host = cfg_str(cfg, "host")?;
    let user = cfg_str_opt(cfg, "user").unwrap_or_default();
    let password = cfg_secret(cfg, "password")?.unwrap_or_default();
    let srv = cfg_bool(cfg, "srv");

    let scheme = if srv { "mongodb+srv" } else { "mongodb" };
    let auth = if user.is_empty() {
        String::new()
    } else {
        format!("{}:{}@", urlencode(&user), urlencode(&password))
    };
    // SRV records carry their own port; a literal port is invalid there.
    let host_port = if srv {
        host
    } else {
        format!("{host}:{}", cfg_u16(cfg, "port", 27017))
    };
    Ok(format!("{scheme}://{auth}{host_port}"))
}

#[async_trait]
impl Plugin for MongoPlugin {
    fn info(&self) -> PluginInfo {
        PluginInfo {
            id: "mongodb".into(),
            name: "MongoDB".into(),
            kind: PluginKind::Document,
            version: env!("CARGO_PKG_VERSION").into(),
            description: "Connect to MongoDB and Atlas clusters.".into(),
            ui_module: Some("document".into()),
            protocol_version: rdb_core::PROTOCOL_VERSION,
            config_schema: vec![
                ConfigField {
                    key: "mode".into(),
                    label: "Configure with".into(),
                    field_type: ConfigFieldType::Select {
                        options: vec![MODE_URI.into(), MODE_FIELDS.into()],
                    },
                    required: true,
                    default: Some(serde_json::json!(MODE_URI)),
                    placeholder: None,
                    show_if: None,
                },
                ConfigField {
                    key: "uri".into(),
                    label: "Connection URI".into(),
                    field_type: ConfigFieldType::Text,
                    required: true,
                    default: Some(serde_json::json!("mongodb://localhost:27017")),
                    placeholder: Some("mongodb://user:pass@host/db".into()),
                    show_if: Some(ShowIf {
                        field: "mode".into(),
                        equals: MODE_URI.into(),
                    }),
                },
                ConfigField {
                    key: "host".into(),
                    label: "Host".into(),
                    field_type: ConfigFieldType::Text,
                    required: true,
                    default: Some(serde_json::json!("localhost")),
                    placeholder: Some("localhost or cluster.mongodb.net".into()),
                    show_if: Some(ShowIf {
                        field: "mode".into(),
                        equals: MODE_FIELDS.into(),
                    }),
                },
                ConfigField {
                    key: "srv".into(),
                    label: "Use SRV (Atlas / mongodb+srv)".into(),
                    field_type: ConfigFieldType::Boolean,
                    required: false,
                    default: Some(serde_json::json!(false)),
                    placeholder: None,
                    show_if: Some(ShowIf {
                        field: "mode".into(),
                        equals: MODE_FIELDS.into(),
                    }),
                },
                ConfigField {
                    key: "port".into(),
                    label: "Port".into(),
                    field_type: ConfigFieldType::Number,
                    required: false,
                    default: Some(serde_json::json!(27017)),
                    placeholder: None,
                    show_if: Some(ShowIf {
                        field: "mode".into(),
                        equals: MODE_FIELDS.into(),
                    }),
                },
                ConfigField {
                    key: "user".into(),
                    label: "User".into(),
                    field_type: ConfigFieldType::Text,
                    required: false,
                    default: None,
                    placeholder: None,
                    show_if: Some(ShowIf {
                        field: "mode".into(),
                        equals: MODE_FIELDS.into(),
                    }),
                },
                ConfigField {
                    key: "password".into(),
                    label: "Password".into(),
                    field_type: ConfigFieldType::Password,
                    required: false,
                    default: None,
                    placeholder: None,
                    show_if: Some(ShowIf {
                        field: "mode".into(),
                        equals: MODE_FIELDS.into(),
                    }),
                },
                ConfigField {
                    key: "database".into(),
                    label: "Default DB (optional)".into(),
                    field_type: ConfigFieldType::Text,
                    required: false,
                    default: None,
                    placeholder: None,
                    show_if: None,
                },
            ],
        }
    }

    async fn connect(&self, cfg: ConnectionConfig) -> Result<Arc<dyn Connection>> {
        let uri = build_mongo_uri(&cfg)?;
        let default_db = cfg_str_opt(&cfg, "database");
        // Never log `uri` — it can carry credentials. Log only safe fields.
        tracing::info!(
            "connecting to mongodb host={} srv={} default_db={}",
            cfg_str_opt(&cfg, "host").as_deref().unwrap_or("(uri)"),
            cfg_bool(&cfg, "srv"),
            default_db.as_deref().unwrap_or("-"),
        );
        let client = Client::with_uri_str(&uri).await.map_err(|e| {
            tracing::warn!("mongodb client init failed: {e}");
            PluginError::Connection(e.to_string())
        })?;
        client
            .database("admin")
            .run_command(doc! { "ping": 1 })
            .await
            .map_err(|e| {
                tracing::warn!("mongodb ping failed: {e}");
                PluginError::Connection(e.to_string())
            })?;
        tracing::info!("mongodb connected (ping ok)");
        Ok(Arc::new(MongoConnection { client, default_db }))
    }
}

impl MongoPlugin {
    pub async fn list_databases(&self, conn: Arc<dyn Connection>) -> Result<Vec<String>> {
        let conn = downcast(&conn)?;
        conn.client
            .list_database_names()
            .await
            .map_err(|e| PluginError::Backend(e.to_string()))
    }

    pub async fn list_collections(
        &self,
        conn: Arc<dyn Connection>,
        database: &str,
    ) -> Result<Vec<MongoCollection>> {
        let conn = downcast(&conn)?;
        let names = conn
            .client
            .database(database)
            .list_collection_names()
            .await
            .map_err(|e| PluginError::Backend(e.to_string()))?;
        Ok(names
            .into_iter()
            .map(|n| MongoCollection {
                database: database.to_string(),
                name: n,
            })
            .collect())
    }

    pub async fn find(
        &self,
        conn: Arc<dyn Connection>,
        database: &str,
        collection: &str,
        filter_json: Option<&str>,
        limit: i64,
    ) -> Result<FindResult> {
        let conn = downcast(&conn)?;
        let start = std::time::Instant::now();
        let filter = match filter_json {
            Some(s) if !s.trim().is_empty() => {
                let v: serde_json::Value = serde_json::from_str(s)
                    .map_err(|e| PluginError::Config(format!("invalid filter: {e}")))?;
                bson::serialize_to_document(&v).map_err(|e| PluginError::Config(e.to_string()))?
            }
            _ => doc! {},
        };
        let mut cursor = conn
            .client
            .database(database)
            .collection::<bson::Document>(collection)
            .find(filter)
            .limit(limit)
            .await
            .map_err(|e| PluginError::Backend(e.to_string()))?;

        let mut out = Vec::new();
        while let Some(next) = cursor.next().await {
            let doc = next.map_err(|e| PluginError::Backend(e.to_string()))?;
            let v: serde_json::Value =
                bson::deserialize_from_document(doc).map_err(|e| PluginError::Backend(e.to_string()))?;
            out.push(v);
        }
        let elapsed_ms = start.elapsed().as_millis();
        tracing::debug!(
            "find {database}.{collection} returned {} doc(s) in {elapsed_ms}ms (limit {limit})",
            out.len()
        );
        Ok(FindResult {
            documents: out,
            elapsed_ms,
        })
    }
}

fn downcast(conn: &Arc<dyn Connection>) -> Result<&MongoConnection> {
    conn.as_any()
        .downcast_ref::<MongoConnection>()
        .ok_or_else(|| PluginError::Backend("connection type mismatch".into()))
}
