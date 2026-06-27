//! HTTP Client (`curlui`) plugin: send requests and parse curl commands.
//! `{{VAR}}` placeholder interpolation is handled by the frontend before a
//! request reaches this plugin.

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use percent_encoding::{percent_encode, AsciiSet, CONTROLS};
use rdb_core::{
    ConfigField, ConfigFieldType, Connection, ConnectionConfig, Plugin, PluginError, PluginInfo,
    PluginKind, Result,
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

/// Live session: a shared HTTP client. `{{VAR}}` interpolation is the
/// frontend's responsibility, so no environment map is kept here.
pub struct CurlUiConnection {
    client: Client,
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
    /// Multipart/form-data fields, used only when `body_kind == "multipart"`.
    #[serde(default)]
    pub parts: Option<Vec<MultipartPart>>,
}

fn default_body_kind() -> String {
    "none".into()
}

/// One field of a `multipart/form-data` body. A `file` part carries a local
/// file path in `value` that this (local sidecar) process reads at send time —
/// file bytes never cross the host pipe.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultipartPart {
    pub name: String,
    /// `"text"` or `"file"`.
    #[serde(default = "default_part_kind")]
    pub kind: String,
    /// Text value for a `text` part, or the local file path for a `file` part.
    #[serde(default)]
    pub value: String,
    /// Optional filename override for a `file` part (defaults to the basename).
    #[serde(default)]
    pub filename: Option<String>,
    /// Optional explicit Content-Type for the part.
    #[serde(default)]
    pub content_type: Option<String>,
}

fn default_part_kind() -> String {
    "text".into()
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
        }))
    }

    async fn test(&self, config: ConnectionConfig) -> Result<()> {
        let _ = session_settings(&config)?;
        Ok(())
    }
}

/// Parsed transport settings from a connection config.
struct SessionSettings {
    verify_tls: bool,
    follow_redirects: bool,
    timeout_secs: u64,
}

fn session_settings(config: &ConnectionConfig) -> Result<SessionSettings> {
    Ok(SessionSettings {
        verify_tls: cfg_bool(config, "verify_tls", true),
        follow_redirects: cfg_bool(config, "follow_redirects", true),
        timeout_secs: cfg_u64(config, "timeout_secs", 30).max(1),
    })
}

fn cfg_bool(config: &ConnectionConfig, key: &str, default: bool) -> bool {
    config.get(key).and_then(|v| v.as_bool()).unwrap_or(default)
}

fn cfg_u64(config: &ConnectionConfig, key: &str, default: u64) -> u64 {
    config.get(key).and_then(|v| v.as_u64()).unwrap_or(default)
}

fn build_client(settings: &SessionSettings) -> Result<Client> {
    let mut builder = Client::builder()
        // Default User-Agent; a per-request `User-Agent` header overrides it.
        .user_agent(concat!(
            "rdb/",
            env!("CARGO_PKG_VERSION"),
            " Http-Client (plugin)"
        ))
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

/// Characters to percent-encode inside a query key/value. Anything outside the
/// query-safe set (RFC 3986 unreserved + a few delimiters curl/browsers leave
/// literal) is escaped — notably space, `{`, `}`, `"`, `#`, `%`, `<`, `>`, and
/// all non-ASCII (handled by `percent_encode` operating on UTF-8 bytes).
const QUERY_COMPONENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'%')
    .add(b'<')
    .add(b'>')
    .add(b'`')
    .add(b'{')
    .add(b'}')
    .add(b'|')
    .add(b'\\')
    .add(b'^')
    .add(b'&')
    .add(b'=')
    .add(b'+');

/// Percent-encode the query component of a literal URL, leaving the scheme,
/// host, and path untouched. The query is split on `&`/`=` first, so those
/// separators stay structural while each key and value is encoded — what the
/// user typed in the URL bar gets sent safely without them having to escape it.
fn encode_query_url(url: &str) -> String {
    let Some(q_idx) = url.find('?') else {
        return url.to_string();
    };
    let (base, query) = url.split_at(q_idx);
    let query = &query[1..]; // drop the '?'
    if query.is_empty() {
        return url.to_string();
    }
    let encoded = query
        .split('&')
        .map(|pair| match pair.split_once('=') {
            Some((k, v)) => format!("{}={}", enc(k), enc(v)),
            None => enc(pair),
        })
        .collect::<Vec<_>>()
        .join("&");
    format!("{base}?{encoded}")
}

/// Percent-encode one query component, preserving any existing `%XX` escapes so
/// a value the user already encoded is not double-encoded.
fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.char_indices().peekable();
    while let Some((i, ch)) = chars.next() {
        // Pass through an existing percent-escape (`%` + two hex digits).
        if ch == '%' {
            let rest = &s[i + 1..];
            let mut hex = rest.chars();
            if matches!(hex.next(), Some(a) if a.is_ascii_hexdigit())
                && matches!(hex.next(), Some(b) if b.is_ascii_hexdigit())
            {
                out.push_str(&s[i..i + 3]);
                chars.next();
                chars.next();
                continue;
            }
        }
        let mut buf = [0u8; 4];
        let encoded = ch.encode_utf8(&mut buf);
        out.push_str(&percent_encode(encoded.as_bytes(), QUERY_COMPONENT).to_string());
    }
    out
}

pub async fn send_request(conn: &CurlUiConnection, req: &HttpRequest) -> Result<HttpResponse> {
    let method = Method::from_str(req.method.trim().to_uppercase().as_str())
        .map_err(|_| PluginError::Config(format!("invalid method: {}", req.method)))?;
    // `{{VAR}}` interpolation and URL normalization are done by the frontend
    // before the request reaches us; the URL is otherwise a literal, so we
    // percent-encode its query component here at send time.
    let url = encode_query_url(&req.url);
    let is_multipart = req.body_kind == "multipart";
    let mut headers = HeaderMap::new();
    for (k, v) in &req.headers {
        if k.trim().is_empty() {
            continue;
        }
        // reqwest sets the multipart Content-Type (with the boundary) itself, so
        // a user-supplied one would conflict — drop it for multipart bodies.
        if is_multipart && k.trim().eq_ignore_ascii_case("content-type") {
            continue;
        }
        let name = HeaderName::from_str(k.trim())
            .map_err(|e| PluginError::Config(format!("invalid header name {k}: {e}")))?;
        let hv = HeaderValue::from_str(v)
            .map_err(|e| PluginError::Config(format!("invalid header value for {k}: {e}")))?;
        headers.insert(name, hv);
    }
    let body = match req.body.as_deref() {
        None | Some("") => None,
        Some(raw) => Some(raw.to_owned()),
    };

    let parts = if is_multipart {
        req.parts.as_deref()
    } else {
        None
    };
    let curl_command = build_curl_command(&method, &url, &headers, body.as_deref(), parts);

    let started = Instant::now();
    let mut rb = conn.client.request(method, &url).headers(headers);
    if is_multipart {
        rb = rb.multipart(build_multipart_form(parts.unwrap_or(&[])).await?);
    } else if let Some(body) = body {
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
    parts: Option<&[MultipartPart]>,
) -> String {
    let mut out = vec![format!("curl -X {method} '{url}'")];
    for (k, v) in headers {
        if let Ok(s) = v.to_str() {
            out.push(format!("  -H '{k}: {s}'"));
        }
    }
    if let Some(parts) = parts {
        for p in parts {
            if p.name.trim().is_empty() {
                continue;
            }
            let spec = if p.kind == "file" {
                let mut s = format!("{}=@{}", p.name, p.value);
                if let Some(ct) = p.content_type.as_deref().filter(|s| !s.is_empty()) {
                    s.push_str(&format!(";type={ct}"));
                }
                if let Some(fname) = p.filename.as_deref().filter(|s| !s.is_empty()) {
                    s.push_str(&format!(";filename={fname}"));
                }
                s
            } else {
                format!("{}={}", p.name, p.value)
            };
            let escaped = spec.replace('\'', "'\\''");
            out.push(format!("  -F '{escaped}'"));
        }
    } else if let Some(body) = body {
        let escaped = body.replace('\'', "'\\''");
        out.push(format!("  -d '{escaped}'"));
    }
    out.join(" \\\n")
}

/// Build a `multipart/form-data` form from the request parts, reading each
/// `file` part's bytes from disk (this is a local sidecar process). Parts with
/// an empty name are skipped.
async fn build_multipart_form(parts: &[MultipartPart]) -> Result<reqwest::multipart::Form> {
    use reqwest::multipart::{Form, Part};
    let mut form = Form::new();
    for p in parts {
        if p.name.trim().is_empty() {
            continue;
        }
        if p.kind == "file" {
            let bytes = tokio::fs::read(&p.value)
                .await
                .map_err(|e| PluginError::Backend(format!("read file {}: {e}", p.value)))?;
            let filename = p
                .filename
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| basename(&p.value));
            let mime = p
                .content_type
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| guess_mime(&filename));
            let part = Part::bytes(bytes)
                .file_name(filename)
                .mime_str(&mime)
                .map_err(|e| PluginError::Config(format!("invalid content-type {mime}: {e}")))?;
            form = form.part(p.name.clone(), part);
        } else {
            let mut part = Part::text(p.value.clone());
            if let Some(ct) = p.content_type.as_deref().filter(|s| !s.is_empty()) {
                part = part
                    .mime_str(ct)
                    .map_err(|e| PluginError::Config(format!("invalid content-type {ct}: {e}")))?;
            }
            form = form.part(p.name.clone(), part);
        }
    }
    Ok(form)
}

/// Last path segment of a (possibly Windows or POSIX) file path.
fn basename(path: &str) -> String {
    path.rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(path)
        .to_owned()
}

/// A minimal extension → MIME guess, defaulting to `application/octet-stream`.
fn guess_mime(filename: &str) -> String {
    let ext = filename
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "json" => "application/json",
        "txt" | "text" | "log" => "text/plain",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        _ => "application/octet-stream",
    }
    .to_owned()
}

/// Parse a `curl` command line into an [`HttpRequest`].
///
/// This is a purpose-built, shell-aware parser rather than a strict grammar:
/// real-world commands pasted from a browser's "Copy as cURL" carry many flags
/// (`--compressed`, `-A`, `--data-raw`, cookies, …) and bare-host URLs that a
/// rigid parser rejects. We tokenize respecting quotes/escapes/line-
/// continuations, then interpret the flags we care about and ignore the rest.
pub fn parse_curl_command(curl: &str) -> Result<HttpRequest> {
    let tokens =
        tokenize_shell(curl).map_err(|e| PluginError::Config(format!("parse curl: {e}")))?;
    let mut it = tokens.iter().peekable();

    // Skip an optional leading `curl` (and a shell prompt like `$`). Anything
    // else (a flag or a bare URL) is treated as the start of the args.
    if let Some(tok) = it.peek() {
        if tok.as_str() == "$" || tok.eq_ignore_ascii_case("curl") {
            it.next();
        }
    }

    let mut method: Option<String> = None;
    let mut url: Option<String> = None;
    let mut headers = HashMap::new();
    let mut data: Vec<String> = Vec::new();
    let mut forms: Vec<MultipartPart> = Vec::new();
    let mut basic_auth: Option<String> = None;

    while let Some(tok) = it.next() {
        // Flags that take a value: pull the next token (or the `=value` form).
        let value_flag = |it: &mut std::iter::Peekable<std::slice::Iter<String>>,
                          inline: Option<&str>|
         -> Option<String> {
            if let Some(v) = inline {
                return Some(v.to_string());
            }
            it.next().cloned()
        };

        let (name, inline) = split_flag(tok);
        match name {
            "-X" | "--request" => {
                if let Some(m) = value_flag(&mut it, inline) {
                    method = Some(m.trim().to_uppercase());
                }
            }
            "-H" | "--header" => {
                if let Some(h) = value_flag(&mut it, inline) {
                    if let Some((k, v)) = h.split_once(':') {
                        let k = k.trim();
                        if !k.is_empty() {
                            headers.insert(k.to_owned(), v.trim().to_owned());
                        }
                    }
                }
            }
            "-d" | "--data" | "--data-raw" | "--data-ascii" | "--data-binary"
            | "--data-urlencode" => {
                if let Some(d) = value_flag(&mut it, inline) {
                    // `--data-raw` keeps a leading `$` / `@` literally; we don't
                    // expand @file references.
                    data.push(d);
                }
            }
            "-F" | "--form" | "--form-string" => {
                if let Some(f) = value_flag(&mut it, inline) {
                    // `--form-string` is always a literal text field, even if the
                    // value starts with `@`/`<`.
                    forms.push(parse_form_field(&f, name == "--form-string"));
                }
            }
            "-u" | "--user" => {
                basic_auth = value_flag(&mut it, inline);
            }
            "-A" | "--user-agent" => {
                if let Some(ua) = value_flag(&mut it, inline) {
                    headers.entry("User-Agent".to_owned()).or_insert(ua);
                }
            }
            "-b" | "--cookie" => {
                if let Some(c) = value_flag(&mut it, inline) {
                    headers.entry("Cookie".to_owned()).or_insert(c);
                }
            }
            "-e" | "--referer" => {
                if let Some(r) = value_flag(&mut it, inline) {
                    headers.entry("Referer".to_owned()).or_insert(r);
                }
            }
            "-L" | "--location" | "--url" => {
                // `--url` takes the URL as its value; `-L` is a bare flag in real
                // curl, but some pasted commands put the URL right after it.
                if name == "--url" {
                    if let Some(u) = value_flag(&mut it, inline) {
                        url = Some(u);
                    }
                }
            }
            // Known value-less flags we can safely ignore.
            "-k" | "--insecure" | "--compressed" | "-s" | "--silent" | "-i" | "--include"
            | "-v" | "--verbose" | "-S" | "--show-error" | "-f" | "--fail" | "-G" | "--get"
            | "-#" | "--progress-bar" | "-g" | "--globoff" => {}
            other if other.starts_with('-') => {
                // Unknown flag. If it clearly takes a value (long form without
                // inline `=`), consume the following token so it isn't mistaken
                // for the URL. Short unknown flags are assumed value-less.
                if other.starts_with("--") && inline.is_none() {
                    if let Some(next) = it.peek() {
                        if !next.starts_with('-') && url.is_some() {
                            // URL already found; the trailing token is this
                            // flag's value.
                            it.next();
                        }
                    }
                }
            }
            _ => {
                // Positional token → the URL (first one wins).
                if url.is_none() {
                    url = Some(tok.clone());
                }
            }
        }
    }

    let url = url.ok_or_else(|| PluginError::Config("curl: no URL found".into()))?;

    if let Some(creds) = basic_auth {
        let encoded = STANDARD.encode(creds.as_bytes());
        headers
            .entry("Authorization".to_owned())
            .or_insert(format!("Basic {encoded}"));
    }

    let body = if data.is_empty() {
        None
    } else {
        Some(data.join("&"))
    };
    // `-F` makes it a multipart request; that takes precedence over `-d` data.
    let (body, body_kind, parts) = if !forms.is_empty() {
        (None, "multipart".to_owned(), Some(forms))
    } else {
        (
            body.clone(),
            infer_body_kind(&headers, body.as_deref()),
            None,
        )
    };
    let method = method.unwrap_or_else(|| {
        if body.is_some() || parts.is_some() {
            "POST".into()
        } else {
            "GET".into()
        }
    });

    Ok(HttpRequest {
        method,
        url,
        headers,
        body,
        body_kind,
        parts,
    })
}

/// Parse one `-F`/`--form` field value into a [`MultipartPart`].
///
/// curl syntax: `name=value` is a text field; `name=@path` / `name=<path` is a
/// file field, with optional `;type=<mime>` and `;filename=<name>` modifiers.
/// `force_text` (from `--form-string`) keeps the value literal even if it begins
/// with `@`/`<`.
fn parse_form_field(field: &str, force_text: bool) -> MultipartPart {
    let (name, rhs) = match field.split_once('=') {
        Some((n, r)) => (n.trim().to_owned(), r),
        None => (field.trim().to_owned(), ""),
    };

    let is_file = !force_text && (rhs.starts_with('@') || rhs.starts_with('<'));
    if !is_file {
        return MultipartPart {
            name,
            kind: "text".into(),
            value: rhs.to_owned(),
            filename: None,
            content_type: None,
        };
    }

    // Split the path from any `;type=`/`;filename=` modifiers.
    let mut segs = rhs[1..].split(';');
    let path = segs.next().unwrap_or("").to_owned();
    let mut content_type = None;
    let mut filename = None;
    for seg in segs {
        if let Some(v) = seg.trim().strip_prefix("type=") {
            content_type = Some(v.to_owned());
        } else if let Some(v) = seg.trim().strip_prefix("filename=") {
            filename = Some(v.to_owned());
        }
    }
    MultipartPart {
        name,
        kind: "file".into(),
        value: path,
        filename,
        content_type,
    }
}

/// Split a flag token into its name and optional inline value (`--data=x`).
fn split_flag(tok: &str) -> (&str, Option<&str>) {
    if tok.starts_with("--") {
        if let Some((name, value)) = tok.split_once('=') {
            return (name, Some(value));
        }
    }
    (tok, None)
}

/// Tokenize a shell-style command line: split on whitespace, honor single and
/// double quotes, backslash escapes, and `\`-newline line continuations.
fn tokenize_shell(input: &str) -> std::result::Result<Vec<String>, String> {
    let mut tokens = Vec::new();
    let mut cur = String::new();
    let mut has_token = false;
    let mut chars = input.chars().peekable();

    while let Some(c) = chars.next() {
        match c {
            ' ' | '\t' | '\r' | '\n' => {
                if has_token {
                    tokens.push(std::mem::take(&mut cur));
                    has_token = false;
                }
            }
            '\\' => {
                match chars.next() {
                    // Line continuation: swallow the newline, no token started.
                    Some('\n') | Some('\r') => {}
                    Some(next) => {
                        has_token = true;
                        cur.push(next);
                    }
                    None => {}
                }
            }
            '\'' => {
                has_token = true;
                for q in chars.by_ref() {
                    if q == '\'' {
                        break;
                    }
                    cur.push(q);
                }
            }
            '"' => {
                has_token = true;
                let mut closed = false;
                while let Some(q) = chars.next() {
                    match q {
                        '"' => {
                            closed = true;
                            break;
                        }
                        '\\' => {
                            // In double quotes, backslash escapes a few chars.
                            match chars.next() {
                                Some(e @ ('"' | '\\' | '$' | '`')) => cur.push(e),
                                Some(e) => {
                                    cur.push('\\');
                                    cur.push(e);
                                }
                                None => {}
                            }
                        }
                        _ => cur.push(q),
                    }
                }
                if !closed {
                    return Err("unterminated double quote".into());
                }
            }
            _ => {
                has_token = true;
                cur.push(c);
            }
        }
    }
    if has_token {
        tokens.push(cur);
    }
    Ok(tokens)
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

    #[test]
    fn parse_curl_simple_get() {
        let r = parse_curl_command("curl https://example.com").unwrap();
        assert_eq!(r.method, "GET");
        assert_eq!(r.url, "https://example.com");
        assert!(r.body.is_none());
    }

    #[test]
    fn parse_curl_bare_host_url() {
        // A bare host (no scheme) is accepted; the frontend normalizes it.
        let r = parse_curl_command("curl www.google.com").unwrap();
        assert_eq!(r.url, "www.google.com");
    }

    #[test]
    fn parse_curl_form_files_and_fields() {
        let r = parse_curl_command(
            "curl https://x.com/up -F 'name=Bob' -F 'photo=@/tmp/a.png;type=image/png;filename=pic.png' -F 'doc=<readme.txt'",
        )
        .unwrap();
        assert_eq!(r.method, "POST"); // -F present, no explicit -X
        assert_eq!(r.body_kind, "multipart");
        assert!(r.body.is_none());
        let parts = r.parts.expect("parts");
        assert_eq!(parts.len(), 3);

        assert_eq!(parts[0].name, "name");
        assert_eq!(parts[0].kind, "text");
        assert_eq!(parts[0].value, "Bob");

        assert_eq!(parts[1].name, "photo");
        assert_eq!(parts[1].kind, "file");
        assert_eq!(parts[1].value, "/tmp/a.png");
        assert_eq!(parts[1].content_type.as_deref(), Some("image/png"));
        assert_eq!(parts[1].filename.as_deref(), Some("pic.png"));

        assert_eq!(parts[2].name, "doc");
        assert_eq!(parts[2].kind, "file");
        assert_eq!(parts[2].value, "readme.txt");
    }

    #[test]
    fn parse_curl_form_string_keeps_literal_at() {
        let r = parse_curl_command("curl https://x.com --form-string 'q=@notafile'").unwrap();
        let parts = r.parts.expect("parts");
        assert_eq!(parts[0].kind, "text");
        assert_eq!(parts[0].value, "@notafile");
    }

    #[test]
    fn parse_curl_post_with_headers_and_data() {
        let r = parse_curl_command(
            "curl -X POST https://api.example.com -H 'Content-Type: application/json' -d '{\"a\":1}'",
        )
        .unwrap();
        assert_eq!(r.method, "POST");
        assert_eq!(r.url, "https://api.example.com");
        assert_eq!(
            r.headers.get("Content-Type").map(String::as_str),
            Some("application/json")
        );
        assert_eq!(r.body.as_deref(), Some("{\"a\":1}"));
        assert_eq!(r.body_kind, "json");
    }

    #[test]
    fn parse_curl_ignores_unsupported_flags() {
        // Browser "Copy as cURL" style: flags the old grammar rejected.
        let r = parse_curl_command(
            "curl 'https://x.com/api' --compressed -A 'Mozilla/5.0' \\\n  -H 'Accept: */*' --data-raw 'hello'",
        )
        .unwrap();
        assert_eq!(r.url, "https://x.com/api");
        assert_eq!(r.method, "POST"); // data present, no explicit -X
        assert_eq!(r.headers.get("Accept").map(String::as_str), Some("*/*"));
        assert_eq!(
            r.headers.get("User-Agent").map(String::as_str),
            Some("Mozilla/5.0")
        );
        assert_eq!(r.body.as_deref(), Some("hello"));
    }

    #[test]
    fn parse_curl_basic_auth_to_header() {
        let r = parse_curl_command("curl -u user:pass https://x.com").unwrap();
        // base64("user:pass") == "dXNlcjpwYXNz"
        assert_eq!(
            r.headers.get("Authorization").map(String::as_str),
            Some("Basic dXNlcjpwYXNz")
        );
    }

    #[test]
    fn parse_curl_method_after_url_and_multiple_data() {
        let r = parse_curl_command("curl https://x.com -d a=1 --data b=2 -X PUT").unwrap();
        assert_eq!(r.method, "PUT");
        assert_eq!(r.body.as_deref(), Some("a=1&b=2"));
    }

    #[test]
    fn parse_curl_errors_without_url() {
        assert!(parse_curl_command("curl -X GET").is_err());
        assert!(parse_curl_command("   ").is_err());
    }

    #[test]
    fn tokenize_handles_quotes_and_continuations() {
        let toks = tokenize_shell("curl -H \"A: b c\" \\\n  'http://x'").unwrap();
        assert_eq!(toks, vec!["curl", "-H", "A: b c", "http://x"]);
        assert!(tokenize_shell("curl \"unterminated").is_err());
    }

    #[test]
    fn encode_query_url_leaves_base_and_separators() {
        assert_eq!(
            encode_query_url("https://x.com/p?a=1&b=2"),
            "https://x.com/p?a=1&b=2"
        );
        // No query → untouched.
        assert_eq!(encode_query_url("https://x.com/p"), "https://x.com/p");
    }

    #[test]
    fn encode_query_url_escapes_unsafe_chars() {
        assert_eq!(
            encode_query_url("https://x.com?q=hello world"),
            "https://x.com?q=hello%20world"
        );
        assert_eq!(
            encode_query_url("https://x.com?q={{VAR}}"),
            "https://x.com?q=%7B%7BVAR%7D%7D"
        );
        // Non-ASCII is encoded as UTF-8 bytes.
        assert_eq!(
            encode_query_url("https://x.com?q=café"),
            "https://x.com?q=caf%C3%A9"
        );
    }

    #[test]
    fn encode_query_url_preserves_existing_escapes() {
        assert_eq!(
            encode_query_url("https://x.com?q=a%20b"),
            "https://x.com?q=a%20b"
        );
        // A lone '%' that is not a valid escape is itself encoded.
        assert_eq!(
            encode_query_url("https://x.com?q=100%"),
            "https://x.com?q=100%25"
        );
    }
}
