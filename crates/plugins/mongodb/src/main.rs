//! MongoDB sidecar plugin entry point.
//!
//! Routes the `document.*` capability ops the host forwards onto the inherent
//! methods of [`MongoPlugin`].

use std::sync::Arc;

use async_trait::async_trait;
use rdb_core::{Connection, PluginError, Result};
use rdb_plugin_mongodb::MongoPlugin;
use rdb_plugin_runtime::Dispatcher;
use serde::Deserialize;
use serde_json::Value;

struct MongoDispatcher(MongoPlugin);

#[derive(Deserialize)]
struct ListCollectionsParams {
    database: String,
}

#[derive(Deserialize)]
struct FindParams {
    database: String,
    collection: String,
    #[serde(default)]
    filter: Option<String>,
    limit: i64,
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T> {
    serde_json::from_value(params).map_err(|e| PluginError::Config(format!("invalid params: {e}")))
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| PluginError::Backend(e.to_string()))
}

#[async_trait]
impl Dispatcher for MongoDispatcher {
    async fn dispatch(&self, op: &str, params: Value, conn: Arc<dyn Connection>) -> Result<Value> {
        match op {
            "document.list_databases" => to_value(self.0.list_databases(conn).await?),
            "document.list_collections" => {
                let p: ListCollectionsParams = parse(params)?;
                to_value(self.0.list_collections(conn, &p.database).await?)
            }
            "document.find" => {
                let p: FindParams = parse(params)?;
                to_value(
                    self.0
                        .find(conn, &p.database, &p.collection, p.filter.as_deref(), p.limit)
                        .await?,
                )
            }
            _ => Err(PluginError::Unsupported),
        }
    }
}

fn main() -> anyhow::Result<()> {
    rdb_plugin_runtime::run(MongoPlugin::new(), MongoDispatcher(MongoPlugin::new()))
}
