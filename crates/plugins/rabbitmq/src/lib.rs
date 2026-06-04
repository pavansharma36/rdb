use async_trait::async_trait;
use futures_util::StreamExt;
use lapin::{
    options::{
        BasicAckOptions, BasicConsumeOptions, BasicGetOptions, BasicPublishOptions,
        QueueDeclareOptions,
    },
    types::FieldTable,
    BasicProperties, Channel, Connection as AmqpConnection, ConnectionProperties,
};
use rdb_core::{
    ConfigField, ConfigFieldType, Connection, ConnectionConfig, Plugin, PluginError, PluginInfo,
    PluginKind, Result, ShowIf,
};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct RabbitMqPlugin;

impl RabbitMqPlugin {
    pub fn new() -> Self {
        Self
    }
}

impl Default for RabbitMqPlugin {
    fn default() -> Self {
        Self::new()
    }
}

pub struct RabbitMqConnection {
    pub conn: AmqpConnection,
    pub channel: Mutex<Channel>,
}

impl Connection for RabbitMqConnection {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueInfo {
    pub name: String,
    pub message_count: u32,
    pub consumer_count: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublishedMessage {
    pub queue: String,
    pub bytes: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsumedMessage {
    pub body: String,
    pub delivery_tag: u64,
    pub redelivered: bool,
}

/// Connection-config `mode` values. They double as the matched value in
/// [`build_amqp_uri`] and as the `Select` options in [`RabbitMqPlugin::info`].
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

/// Percent-encode a URI component (RFC 3986 unreserved set kept). Used for
/// userinfo and the vhost path segment.
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

/// Resolve the effective AMQP URI, either verbatim from the `uri` field or
/// assembled from the individual host/port/credentials/vhost.
fn build_amqp_uri(cfg: &ConnectionConfig) -> Result<String> {
    let mode = cfg_str_opt(cfg, "mode").unwrap_or_else(|| MODE_URI.to_string());
    if mode != MODE_FIELDS {
        return cfg_str(cfg, "uri");
    }

    let host = cfg_str(cfg, "host")?;
    let port = cfg_u16(cfg, "port", 5672);
    let user = cfg_str_opt(cfg, "user").unwrap_or_else(|| "guest".into());
    let password = cfg_str_opt(cfg, "password").unwrap_or_else(|| "guest".into());
    let vhost = cfg_str_opt(cfg, "vhost").unwrap_or_else(|| "/".into());
    let scheme = if cfg_bool(cfg, "tls") { "amqps" } else { "amqp" };

    Ok(format!(
        "{scheme}://{u}:{p}@{host}:{port}/{vh}",
        u = urlencode(&user),
        p = urlencode(&password),
        vh = urlencode(&vhost),
    ))
}

#[async_trait]
impl Plugin for RabbitMqPlugin {
    fn info(&self) -> PluginInfo {
        PluginInfo {
            id: "rabbitmq".into(),
            name: "RabbitMQ".into(),
            kind: PluginKind::Messaging,
            version: env!("CARGO_PKG_VERSION").into(),
            description: "Connect to a RabbitMQ broker via AMQP 0-9-1.".into(),
            ui_module: Some("messaging".into()),
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
                    label: "AMQP URI".into(),
                    field_type: ConfigFieldType::Text,
                    required: true,
                    default: Some(serde_json::json!("amqp://guest:guest@localhost:5672/%2f")),
                    placeholder: Some("amqp://user:pass@host:5672/vhost".into()),
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
                    placeholder: Some("localhost".into()),
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
                    default: Some(serde_json::json!(5672)),
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
                    default: Some(serde_json::json!("guest")),
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
                    default: Some(serde_json::json!("guest")),
                    placeholder: None,
                    show_if: Some(ShowIf {
                        field: "mode".into(),
                        equals: MODE_FIELDS.into(),
                    }),
                },
                ConfigField {
                    key: "vhost".into(),
                    label: "Virtual host".into(),
                    field_type: ConfigFieldType::Text,
                    required: false,
                    default: Some(serde_json::json!("/")),
                    placeholder: Some("/".into()),
                    show_if: Some(ShowIf {
                        field: "mode".into(),
                        equals: MODE_FIELDS.into(),
                    }),
                },
                ConfigField {
                    key: "tls".into(),
                    label: "Use TLS (amqps)".into(),
                    field_type: ConfigFieldType::Boolean,
                    required: false,
                    default: Some(serde_json::json!(false)),
                    placeholder: None,
                    show_if: Some(ShowIf {
                        field: "mode".into(),
                        equals: MODE_FIELDS.into(),
                    }),
                },
            ],
        }
    }

    async fn connect(&self, cfg: ConnectionConfig) -> Result<Arc<dyn Connection>> {
        let uri = build_amqp_uri(&cfg)?;
        let conn = AmqpConnection::connect(&uri, ConnectionProperties::default())
            .await
            .map_err(|e| PluginError::Connection(e.to_string()))?;
        let channel = conn
            .create_channel()
            .await
            .map_err(|e| PluginError::Connection(e.to_string()))?;
        Ok(Arc::new(RabbitMqConnection {
            conn,
            channel: Mutex::new(channel),
        }))
    }
}

impl RabbitMqPlugin {
    pub async fn declare_queue(
        &self,
        conn: Arc<dyn Connection>,
        queue: &str,
    ) -> Result<QueueInfo> {
        let conn = downcast(&conn)?;
        let ch = conn.channel.lock().await;
        let q = ch
            .queue_declare(
                queue,
                QueueDeclareOptions {
                    passive: false,
                    durable: true,
                    ..Default::default()
                },
                FieldTable::default(),
            )
            .await
            .map_err(|e| PluginError::Backend(e.to_string()))?;
        Ok(QueueInfo {
            name: q.name().to_string(),
            message_count: q.message_count(),
            consumer_count: q.consumer_count(),
        })
    }

    pub async fn publish(
        &self,
        conn: Arc<dyn Connection>,
        queue: &str,
        body: &str,
    ) -> Result<PublishedMessage> {
        let conn = downcast(&conn)?;
        let ch = conn.channel.lock().await;
        let bytes = body.as_bytes();
        ch.basic_publish(
            "",
            queue,
            BasicPublishOptions::default(),
            bytes,
            BasicProperties::default(),
        )
        .await
        .map_err(|e| PluginError::Backend(e.to_string()))?
        .await
        .map_err(|e| PluginError::Backend(e.to_string()))?;
        Ok(PublishedMessage {
            queue: queue.to_string(),
            bytes: bytes.len(),
        })
    }

    pub async fn get_one(
        &self,
        conn: Arc<dyn Connection>,
        queue: &str,
        ack: bool,
    ) -> Result<Option<ConsumedMessage>> {
        let conn = downcast(&conn)?;
        let ch = conn.channel.lock().await;
        let opt = ch
            .basic_get(queue, BasicGetOptions { no_ack: !ack })
            .await
            .map_err(|e| PluginError::Backend(e.to_string()))?;
        let Some(delivery) = opt else {
            return Ok(None);
        };
        let body = String::from_utf8_lossy(&delivery.delivery.data).to_string();
        let tag = delivery.delivery.delivery_tag;
        let redelivered = delivery.delivery.redelivered;
        if ack {
            delivery
                .delivery
                .ack(BasicAckOptions::default())
                .await
                .map_err(|e| PluginError::Backend(e.to_string()))?;
        }
        Ok(Some(ConsumedMessage {
            body,
            delivery_tag: tag,
            redelivered,
        }))
    }

    pub async fn consume_n(
        &self,
        conn: Arc<dyn Connection>,
        queue: &str,
        n: usize,
    ) -> Result<Vec<ConsumedMessage>> {
        let conn = downcast(&conn)?;
        let ch = conn.channel.lock().await;
        let mut consumer = ch
            .basic_consume(
                queue,
                "",
                BasicConsumeOptions::default(),
                FieldTable::default(),
            )
            .await
            .map_err(|e| PluginError::Backend(e.to_string()))?;

        let mut out = Vec::with_capacity(n);
        while out.len() < n {
            let Some(next) = consumer.next().await else {
                break;
            };
            let delivery = next.map_err(|e| PluginError::Backend(e.to_string()))?;
            let body = String::from_utf8_lossy(&delivery.data).to_string();
            let tag = delivery.delivery_tag;
            let redelivered = delivery.redelivered;
            delivery
                .ack(BasicAckOptions::default())
                .await
                .map_err(|e| PluginError::Backend(e.to_string()))?;
            out.push(ConsumedMessage {
                body,
                delivery_tag: tag,
                redelivered,
            });
        }
        Ok(out)
    }
}

fn downcast(conn: &Arc<dyn Connection>) -> Result<&RabbitMqConnection> {
    conn.as_any()
        .downcast_ref::<RabbitMqConnection>()
        .ok_or_else(|| PluginError::Backend("connection type mismatch".into()))
}
