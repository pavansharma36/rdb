//! Core abstractions shared by all RDB plugins.
//!
//! A plugin is anything that lets the user connect to an external system
//! (database, queue, cache, ...). Plugins declare a `kind` so the UI knows
//! what surface to render, and provide a serializable config schema so the
//! UI can build a connection form generically.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use thiserror::Error;
use uuid::Uuid;

pub mod protocol;

pub use protocol::PROTOCOL_VERSION;

#[derive(Debug, Error)]
pub enum PluginError {
    #[error("connection failed: {0}")]
    Connection(String),
    #[error("invalid config: {0}")]
    Config(String),
    #[error("operation not supported by plugin")]
    Unsupported,
    #[error("plugin not found: {0}")]
    NotFound(String),
    #[error("backend error: {0}")]
    Backend(String),
}

pub type Result<T> = std::result::Result<T, PluginError>;

/// What kind of system a plugin talks to. The UI uses this to pick which
/// shared component renders the workspace for the connection.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum PluginKind {
    Rdbms,
    Document,
    Rabbitmq,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigField {
    pub key: String,
    pub label: String,
    #[serde(rename = "type")]
    pub field_type: ConfigFieldType,
    #[serde(default)]
    pub required: bool,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
    #[serde(default)]
    pub placeholder: Option<String>,
    /// When set, the UI only shows this field while the field named
    /// `show_if.field` holds the value `show_if.equals`. Lets a plugin offer
    /// e.g. a "connection string" vs "individual settings" mode within one form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub show_if: Option<ShowIf>,
}

/// Conditional-visibility rule for a [`ConfigField`].
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShowIf {
    /// Key of the controlling field.
    pub field: String,
    /// The controlling field's value that makes this field visible.
    pub equals: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase", tag = "kind")]
pub enum ConfigFieldType {
    Text,
    Password,
    Number,
    Boolean,
    Select { options: Vec<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    pub kind: PluginKind,
    pub version: String,
    pub description: String,
    pub config_schema: Vec<ConfigField>,
    /// UI module hint (`rdbms`, `document`, `rabbitmq`, or plugin id).
    #[serde(default)]
    pub ui_module: Option<String>,
    /// Wire-protocol version the plugin speaks. Set by the plugin runtime when
    /// answering `describe`; the host refuses plugins whose version it doesn't
    /// support. Defaults so manifests written before this field deserialize.
    #[serde(default = "protocol::default_protocol_version")]
    pub protocol_version: u32,
}

pub type ConnectionConfig = HashMap<String, serde_json::Value>;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct ConnectionId(pub Uuid);

impl ConnectionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for ConnectionId {
    fn default() -> Self {
        Self::new()
    }
}

/// Marker trait for an open connection. Plugins downcast via `as_any`.
pub trait Connection: Send + Sync + std::any::Any {
    fn as_any(&self) -> &dyn std::any::Any;
}

#[async_trait]
pub trait Plugin: Send + Sync {
    fn info(&self) -> PluginInfo;

    async fn connect(&self, config: ConnectionConfig) -> Result<Arc<dyn Connection>>;

    async fn test(&self, config: ConnectionConfig) -> Result<()> {
        let _ = self.connect(config).await?;
        Ok(())
    }
}
