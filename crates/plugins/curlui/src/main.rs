use std::sync::Arc;

use async_trait::async_trait;
use rdb_core::{Connection, PluginError, Result};
use rdb_plugin_curlui::{
    downcast_conn, parse_curl_command, send_request, CurlUiPlugin, HttpRequest,
};
use rdb_plugin_runtime::Dispatcher;
use serde::Deserialize;
use serde_json::Value;

struct CurlUiDispatcher;

#[derive(Deserialize)]
struct SendParams {
    request: HttpRequest,
}

#[derive(Deserialize)]
struct ParseCurlParams {
    curl: String,
}

fn parse<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T> {
    serde_json::from_value(params).map_err(|e| PluginError::Config(format!("invalid params: {e}")))
}

fn to_value<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|e| PluginError::Backend(e.to_string()))
}

#[async_trait]
impl Dispatcher for CurlUiDispatcher {
    async fn dispatch(&self, op: &str, params: Value, conn: Arc<dyn Connection>) -> Result<Value> {
        let conn = downcast_conn(&conn)?;
        match op {
            "curlui.send" => {
                let p: SendParams = parse(params)?;
                to_value(send_request(conn, &p.request).await?)
            }
            "curlui.parse_curl" => {
                let p: ParseCurlParams = parse(params)?;
                to_value(parse_curl_command(&p.curl)?)
            }
            _ => Err(PluginError::Unsupported),
        }
    }
}

fn main() -> anyhow::Result<()> {
    rdb_plugin_runtime::run(CurlUiPlugin::new(), CurlUiDispatcher)
}
