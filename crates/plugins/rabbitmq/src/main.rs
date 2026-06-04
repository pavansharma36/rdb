//! RabbitMQ sidecar plugin entry point.
//!
//! Routes the `messaging.*` capability ops the host forwards onto the inherent
//! methods of [`RabbitMqPlugin`].

use std::sync::Arc;

use async_trait::async_trait;
use rdb_core::{Connection, PluginError, Result};
use rdb_plugin_rabbitmq::RabbitMqPlugin;
use rdb_plugin_runtime::Dispatcher;
use serde::Deserialize;
use serde_json::Value;

struct RabbitMqDispatcher(RabbitMqPlugin);

#[derive(Deserialize)]
struct DeclareQueueParams {
    queue: String,
}

#[derive(Deserialize)]
struct PublishParams {
    queue: String,
    body: String,
}

#[derive(Deserialize)]
struct GetOneParams {
    queue: String,
    ack: bool,
}

#[derive(Deserialize)]
struct ConsumeNParams {
    queue: String,
    n: usize,
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T> {
    serde_json::from_value(params).map_err(|e| PluginError::Config(format!("invalid params: {e}")))
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| PluginError::Backend(e.to_string()))
}

#[async_trait]
impl Dispatcher for RabbitMqDispatcher {
    async fn dispatch(&self, op: &str, params: Value, conn: Arc<dyn Connection>) -> Result<Value> {
        match op {
            "messaging.declare_queue" => {
                let p: DeclareQueueParams = parse(params)?;
                to_value(self.0.declare_queue(conn, &p.queue).await?)
            }
            "messaging.publish" => {
                let p: PublishParams = parse(params)?;
                to_value(self.0.publish(conn, &p.queue, &p.body).await?)
            }
            "messaging.get_one" => {
                let p: GetOneParams = parse(params)?;
                to_value(self.0.get_one(conn, &p.queue, p.ack).await?)
            }
            "messaging.consume_n" => {
                let p: ConsumeNParams = parse(params)?;
                to_value(self.0.consume_n(conn, &p.queue, p.n).await?)
            }
            _ => Err(PluginError::Unsupported),
        }
    }
}

fn main() -> anyhow::Result<()> {
    rdb_plugin_runtime::run(RabbitMqPlugin::new(), RabbitMqDispatcher(RabbitMqPlugin::new()))
}
