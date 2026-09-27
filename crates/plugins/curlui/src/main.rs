use std::sync::Arc;

use async_trait::async_trait;
use rdb_core::{Connection, PluginError, Result};
use rdb_plugin_curlui::CurlUiPlugin;
use rdb_plugin_runtime::Dispatcher;
use serde_json::Value;

/// The `curlui` plugin exposes no `call` ops — HTTP requests and curl import
/// are handled entirely by the frontend. This dispatcher exists only to satisfy
/// the runtime and rejects any op.
struct CurlUiDispatcher;

#[async_trait]
impl Dispatcher for CurlUiDispatcher {
    async fn dispatch(
        &self,
        _op: &str,
        _params: Value,
        _conn: Arc<dyn Connection>,
    ) -> Result<Value> {
        Err(PluginError::Unsupported)
    }
}

fn main() -> anyhow::Result<()> {
    rdb_plugin_runtime::run(CurlUiPlugin::new(), CurlUiDispatcher)
}
