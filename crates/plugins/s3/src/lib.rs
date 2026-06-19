use std::any::Any;
use std::sync::Arc;
use async_trait::async_trait;
use aws_config::{BehaviorVersion, Region};
use aws_sdk_s3::Client;
use aws_sdk_s3::config::Credentials;
use serde_json::Value;
use rdb_core::{require_str, ConfigField, ConfigFieldType, Connection, ConnectionConfig, Plugin, PluginError, PluginInfo, PluginKind};
use rdb_plugin_runtime::Dispatcher;

pub struct S3Connection {
    client: Arc<Client>
}

impl Connection for S3Connection {
    fn as_any(&self) -> &dyn Any {
        self
    }
}

pub struct S3Plugin;

impl S3Plugin {
    pub fn new() -> Self {
        Self
    }
}

impl Default for S3Plugin {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Plugin for S3Plugin {
    fn info(&self) -> PluginInfo {
        PluginInfo {
            id: "s3".to_string(),
            name: "AWS S3".to_string(),
            kind: PluginKind::FileManager,
            version: env!("CARGO_PKG_VERSION").into(),
            description: "Browse and manage files on AWS S3 Bucket.".to_string(),
            ui_module: None,
            protocol_version: rdb_core::PROTOCOL_VERSION,
            config_schema: vec![
                ConfigField {
                    key: "access_key".to_string(),
                    label: "Access Key".to_string(),
                    field_type: ConfigFieldType::Text,
                    required: true,
                    default: None,
                    placeholder: None,
                    show_if: None,
                },
                ConfigField {
                    key: "secret_key".to_string(),
                    label: "Secret Key".to_string(),
                    field_type: ConfigFieldType::Password,
                    required: true,
                    default: None,
                    placeholder: None,
                    show_if: None,
                },
                ConfigField {
                    key: "bucket".to_string(),
                    label: "Bucket Name".to_string(),
                    field_type: ConfigFieldType::Text,
                    required: true,
                    default: None,
                    placeholder: None,
                    show_if: None,
                },
                ConfigField {
                    key: "custom_endpoint".to_string(),
                    label: "Custom Endpoint".to_string(),
                    field_type: ConfigFieldType::Text,
                    required: false,
                    default: None,
                    placeholder: Some("http://localhost:8000".to_string()),
                    show_if: None,
                }
            ],
        }
    }

    async fn connect(&self, config: ConnectionConfig) -> rdb_core::Result<Arc<dyn Connection>> {
        let bucket = require_str(&config, "bucket")?.to_owned();
        let endpoint = config.get("custom_endpoint").map(|v| v.to_string());

        let static_credentials = Credentials::new(
            require_str(&config, "access_key")?,
            require_str(&config, "secret_key")?,
            None,
            None,
            "RDB"
        );

        let mut config_loader = aws_config::defaults(BehaviorVersion::latest())
            .credentials_provider(static_credentials)
            .region(Region::new(bucket));
        config_loader = match endpoint {
            Some(endpoint) => {
                config_loader.endpoint_url(endpoint)
            }
            _ => config_loader
        };

        let config = config_loader.load().await;

        // 2. Create the S3 client instance
        let client = Client::new(&config);
        let buckets = client.list_buckets().send().await;
        Ok(
            Arc::new(S3Connection{
                client: Arc::new(client),
            })
        )
    }

    async fn test(&self, config: ConnectionConfig) -> rdb_core::Result<()> {
        todo!()
    }
}

pub struct S3Dispatcher;

#[async_trait]
impl Dispatcher for S3Dispatcher {
    async fn dispatch(&self,
                      op: &str,
                      params: Value,
                      conn: Arc<dyn Connection>) -> rdb_core::Result<Value> {
        todo!()
    }
}