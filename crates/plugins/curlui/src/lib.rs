//! HTTP Client (`curlui`) plugin: send requests, parse curl commands, and
//! interpolate `{{VAR}}` placeholders from the connection's environment map.

use async_trait::async_trait;
use rdb_core::{
    ConfigField, ConfigFieldType, Connection, ConnectionConfig, Plugin, PluginError, PluginInfo,
    PluginKind, Result, SecretField,
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use std::time::Instant;

pub struct CurlUiPlugin;

impl CurlUiPlugin {
    pub fn new() -> Self {
        Self
    }
}

impl Default for CurlUiPlugin {
    fn default() -> Self {
        Self::new()
    }
}

/// Live session: shared HTTP client + environment variables for interpolation.
pub struct CurlUiConnection {
    client: Client,
    env: HashMap<String, String>,
}

impl Connection for CurlUiConnection {
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

// ── Wire types (mirrored in src/api/curlui.ts) ───────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpRequest {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default = "default_body_kind")]
    pub body_kind: String,
}

fn default_body_kind() -> String {
    "none".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: HashMap<String, String>,
    pub body: String,
    pub body_encoding: String,
    pub elapsed_ms: u64,
    pub curl_command: String,
}

// ── Plugin ───────────────────────────────────────────────────────────────────

#[async_trait]
impl Plugin for CurlUiPlugin {
    fn info(&self) -> PluginInfo {
        PluginInfo {
            id: "curlui".into(),
            name: "HTTP Client".into(),
            kind: PluginKind::Http,
            version: env!("CARGO_PKG_VERSION").into(),
            description:
                "Send HTTP requests with collections, environment variables, and curl import."
                    .into(),
            ui_module: Some("curlui".into()),
            protocol_version: rdb_core::PROTOCOL_VERSION,
            config_schema: vec![
                ConfigField {
                    key: "env".into(),
                    label: "Environment variables".into(),
                    field_type: ConfigFieldType::KeyValue,
                    required: false,
                    default: Some(serde_json::json!({})),
                    placeholder: None,
                    show_if: None,
                },
                ConfigField {
                    key: "verify_tls".into(),
                    label: "Verify TLS certificates".into(),
                    field_type: ConfigFieldType::Boolean,
                    required: false,
                    default: Some(serde_json::json!(true)),
                    placeholder: None,
                    show_if: None,
                },
                ConfigField {
                    key: "follow_redirects".into(),
                    label: "Follow redirects".into(),
                    field_type: ConfigFieldType::Boolean,
                    required: false,
                    default: Some(serde_json::json!(true)),
                    placeholder: None,
                    show_if: None,
                },
                ConfigField {
                    key: "timeout_secs".into(),
                    label: "Timeout (seconds)".into(),
                    field_type: ConfigFieldType::Number,
                    required: false,
                    default: Some(serde_json::json!(30)),
                    placeholder: Some("30".into()),
                    show_if: None,
                },
            ],
        }
    }

    async fn connect(&self, config: ConnectionConfig) -> Result<Arc<dyn Connection>> {
        let settings = session_settings(&config)?;
        Ok(Arc::new(CurlUiConnection {
            client: build_client(&settings)?,
            env: settings.env,
        }))
    }

    async fn test(&self, config: ConnectionConfig) -> Result<()> {
        let _ = session_settings(&config)?;
        Ok(())
    }
}

/// Parsed transport + env settings from a connection config.
struct SessionSettings {
    env: HashMap<String, String>,
    verify_tls: bool,
    follow_redirects: bool,
    timeout_secs: u64,
}

fn session_settings(config: &ConnectionConfig) -> Result<SessionSettings> {
    Ok(SessionSettings {
        env: parse_env_map(config)?,
        verify_tls: cfg_bool(config, "verify_tls", true),
        follow_redirects: cfg_bool(config, "follow_redirects", true),
        timeout_secs: cfg_u64(config, "timeout_secs", 30).max(1),
    })
}

fn cfg_bool(config: &ConnectionConfig, key: &str, default: bool) -> bool {
    config
        .get(key)
        .and_then(|v| v.as_bool())
        .unwrap_or(default)
}

fn cfg_u64(config: &ConnectionConfig, key: &str, default: u64) -> u64 {
    config
        .get(key)
        .and_then(|v| v.as_u64())
        .unwrap_or(default)
}

/// Read the `env` KeyValue field: each entry is a plain string or a
/// [`SecretField`] wrapper.
pub fn parse_env_map(config: &ConnectionConfig) -> Result<HashMap<String, String>> {
    let Some(raw) = config.get("env") else {
        return Ok(HashMap::new());
    };
    let obj = raw
        .as_object()
        .ok_or_else(|| PluginError::Config("env must be an object".into()))?;
    let mut out = HashMap::new();
    for (key, value) in obj {
        if key.is_empty() {
            continue;
        }
        let resolved = if let Some(s) = value.as_str() {
            s.to_owned()
        } else if let Ok(secret) = serde_json::from_value::<SecretField>(value.clone()) {
            secret.reveal().to_owned()
        } else {
            return Err(PluginError::Config(format!(
                "env.{key}: expected string or secret"
            )));
        };
        out.insert(key.clone(), resolved);
    }
    Ok(out)
}

fn build_client(settings: &SessionSettings) -> Result<Client> {
    let mut builder = Client::builder()
        .redirect(if settings.follow_redirects {
            reqwest::redirect::Policy::limited(10)
        } else {
            reqwest::redirect::Policy::none()
        })
        .timeout(std::time::Duration::from_secs(settings.timeout_secs));
    if !settings.verify_tls {
        builder = builder.danger_accept_invalid_certs(true);
    }
    builder
        .build()
        .map_err(|e| PluginError::Connection(format!("HTTP client: {e}")))
}

pub fn downcast_conn(conn: &Arc<dyn Connection>) -> Result<&CurlUiConnection> {
    conn.as_any()
        .downcast_ref::<CurlUiConnection>()
        .ok_or_else(|| PluginError::Backend("not a curlui connection".into()))
}

/// Replace `{{NAME}}` placeholders using the connection environment.
pub fn interpolate(template: &str, env: &HashMap<String, String>) -> Result<String> {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        rest = &rest[start + 2..];
        let Some(end) = rest.find("}}") else {
            return Err(PluginError::Config(
                "unclosed variable placeholder".into(),
            ));
        };
        let name = rest[..end].trim();
        if name.is_empty() {
            return Err(PluginError::Config("empty variable name".into()));
        }
        let value = env.get(name).ok_or_else(|| {
            PluginError::Config(format!("unknown variable: {name}"))
        })?;
        out.push_str(value);
        rest = &rest[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}

pub async fn send_request(conn: &CurlUiConnection, req: &HttpRequest) -> Result<HttpResponse> {
    let method = Method::from_str(req.method.trim().to_uppercase().as_str())
        .map_err(|_| PluginError::Config(format!("invalid method: {}", req.method)))?;
    let url = interpolate(&req.url, &conn.env)?;
    let mut headers = HeaderMap::new();
    for (k, v) in &req.headers {
        if k.trim().is_empty() {
            continue;
        }
        let name = HeaderName::from_str(k.trim())
            .map_err(|e| PluginError::Config(format!("invalid header name {k}: {e}")))?;
        let value = interpolate(v, &conn.env)?;
        let hv = HeaderValue::from_str(&value)
            .map_err(|e| PluginError::Config(format!("invalid header value for {k}: {e}")))?;
        headers.insert(name, hv);
    }
    let body = match req.body.as_deref() {
        None | Some("") => None,
        Some(raw) => Some(interpolate(raw, &conn.env)?),
    };

    let curl_command = build_curl_command(&method, &url, &headers, body.as_deref());

    let started = Instant::now();
    let mut rb = conn.client.request(method, &url).headers(headers);
    if let Some(body) = body {
        rb = rb.body(body);
    }
    let response = rb
        .send()
        .await
        .map_err(|e| PluginError::Backend(format!("request failed: {e}")))?;
    let elapsed_ms = started.elapsed().as_millis() as u64;

    let status = response.status().as_u16();
    let status_text = response
        .status()
        .canonical_reason()
        .unwrap_or("Unknown")
        .to_string();
    let mut resp_headers = HashMap::new();
    for (k, v) in response.headers() {
        if let Ok(s) = v.to_str() {
            resp_headers.insert(k.as_str().to_owned(), s.to_owned());
        }
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| PluginError::Backend(format!("read body: {e}")))?;
    let (body, body_encoding) = match std::str::from_utf8(&bytes) {
        Ok(text) => (text.to_owned(), "text".into()),
        Err(_) => (
            format!("[{} bytes of binary data]", bytes.len()),
            "binary".into(),
        ),
    };

    Ok(HttpResponse {
        status,
        status_text,
        headers: resp_headers,
        body,
        body_encoding,
        elapsed_ms,
        curl_command,
    })
}

fn build_curl_command(
    method: &Method,
    url: &str,
    headers: &HeaderMap,
    body: Option<&str>,
) -> String {
    let mut parts = vec![format!("curl -X {method} '{url}'")];
    for (k, v) in headers {
        if let Ok(s) = v.to_str() {
            parts.push(format!("  -H '{k}: {s}'"));
        }
    }
    if let Some(body) = body {
        let escaped = body.replace('\'', "'\\''");
        parts.push(format!("  -d '{escaped}'"));
    }
    parts.join(" \\\n")
}

pub fn parse_curl_command(curl: &str) -> Result<HttpRequest> {
    use curl_parser::ParsedRequest;
    let trimmed = curl.trim();
    if trimmed.is_empty() {
        return Err(PluginError::Config("curl command is empty".into()));
    }
    let parsed = ParsedRequest::from_str(trimmed)
        .map_err(|e| PluginError::Config(format!("parse curl: {e}")))?;

    let method = parsed.method.to_string();
    let url = parsed.url.to_string();
    let mut headers = HashMap::new();
    for (k, v) in parsed.headers.iter() {
        if let Ok(val) = v.to_str() {
            headers.insert(k.as_str().to_owned(), val.to_owned());
        }
    }

    let body = if parsed.body.is_empty() {
        None
    } else {
        Some(parsed.body.join("\n"))
    };
    let body_kind = infer_body_kind(&headers, body.as_deref());

    Ok(HttpRequest {
        method,
        url,
        headers,
        body,
        body_kind,
    })
}

fn infer_body_kind(headers: &HashMap<String, String>, body: Option<&str>) -> String {
    if body.is_none() || body == Some("") {
        return "none".into();
    }
    for (k, v) in headers {
        if k.eq_ignore_ascii_case("content-type") {
            if v.contains("json") {
                return "json".into();
            }
            if v.contains("x-www-form-urlencoded") {
                return "form".into();
            }
        }
    }
    "text".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn interpolate_replaces_variables() {
        let mut env = HashMap::new();
        env.insert("HOST".into(), "https://api.example.com".into());
        assert_eq!(
            interpolate("{{HOST}}/users", &env).unwrap(),
            "https://api.example.com/users"
        );
    }

    #[test]
    fn interpolate_errors_on_unknown() {
        assert!(interpolate("{{MISSING}}", &HashMap::new()).is_err());
    }

    #[test]
    fn parse_env_accepts_plain_and_secret_values() {
        let mut config = ConnectionConfig::new();
        config.insert(
            "env".into(),
            json!({
                "HOST": "https://example.com",
                "TOKEN": { "type": "PLAIN_TEXT", "value": "secret" }
            }),
        );
        let env = parse_env_map(&config).unwrap();
        assert_eq!(env.get("HOST").map(String::as_str), Some("https://example.com"));
        assert_eq!(env.get("TOKEN").map(String::as_str), Some("secret"));
    }
}
