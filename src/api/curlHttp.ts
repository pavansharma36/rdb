// Frontend HTTP transport for the `curlui` workspace.
//
// Requests used to be sent by the out-of-process `curlui` sidecar (reqwest);
// they are now issued directly from the frontend via `@tauri-apps/plugin-http`
// (which bypasses CORS and allows arbitrary headers/URLs). `buildSendable` in
// `curlui.ts` still assembles the concrete request (interpolation, auth, form
// encoding); this module only performs the wire round-trip and mirrors the
// remaining behaviour the sidecar's `send_request` had: query percent-encoding,
// multipart file reads, and text/binary body detection.

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { readFile } from "@tauri-apps/plugin-fs";
import type { ConnectionConfig } from "./api.ts";
import {
  encodeFormComponent,
  type HttpRequest,
  type HttpResponse,
} from "./curlui.ts";

/** Transport settings derived from the connection config. Mirrors the plugin's
 *  `SessionSettings` (`crates/plugins/curlui/src/lib.rs`). */
export interface HttpSettings {
  verifyTls: boolean;
  followRedirects: boolean;
  timeoutSecs: number;
}

function coerceBool(v: unknown, dflt: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return dflt;
}

function coerceNum(v: unknown, dflt: number): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return dflt;
}

/** Read `verify_tls`/`follow_redirects`/`timeout_secs` from a connection config,
 *  applying the same defaults (and `timeout >= 1`) as the Rust plugin did. */
export function parseHttpSettings(config: ConnectionConfig): HttpSettings {
  return {
    verifyTls: coerceBool(config.verify_tls, true),
    followRedirects: coerceBool(config.follow_redirects, true),
    timeoutSecs: Math.max(1, coerceNum(config.timeout_secs, 30)),
  };
}

/** Percent-encode the query component of a literal URL, leaving scheme, host,
 *  and path untouched. Splits the query on `&`/`=` first so those separators
 *  stay structural while each key/value is encoded. Ports the plugin's
 *  `encode_query_url`, reusing `encodeFormComponent` (which mirrors its `enc`,
 *  preserving existing `%XX` escapes). */
function encodeQueryUrl(url: string): string {
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return url;
  const base = url.slice(0, qIdx);
  const query = url.slice(qIdx + 1);
  if (query === "") return url;
  const encoded = query
    .split("&")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return encodeFormComponent(pair);
      return `${encodeFormComponent(pair.slice(0, eq))}=${encodeFormComponent(pair.slice(eq + 1))}`;
    })
    .join("&");
  return `${base}?${encoded}`;
}

/** Last path segment of a (POSIX or Windows) path; the whole path if it ends in
 *  a separator. Mirrors the plugin's `basename`. */
function basename(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const last = idx >= 0 ? path.slice(idx + 1) : path;
  return last === "" ? path : last;
}

/** A minimal extension → MIME guess, defaulting to `application/octet-stream`.
 *  Mirrors the plugin's `guess_mime`. */
function guessMime(filename: string): string {
  const dot = filename.lastIndexOf(".");
  const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  switch (ext) {
    case "json":
      return "application/json";
    case "txt":
    case "text":
    case "log":
      return "text/plain";
    case "csv":
      return "text/csv";
    case "html":
    case "htm":
      return "text/html";
    case "xml":
      return "application/xml";
    case "pdf":
      return "application/pdf";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "webp":
      return "image/webp";
    case "zip":
      return "application/zip";
    case "gz":
      return "application/gzip";
    default:
      return "application/octet-stream";
  }
}

/** Build a `multipart/form-data` body, reading each `file` part's bytes from
 *  disk via the fs plugin (this replaces the sidecar's `tokio::fs::read`).
 *  Parts with an empty name are skipped. */
async function buildFormData(parts: HttpRequest["parts"]): Promise<FormData> {
  const fd = new FormData();
  for (const p of parts ?? []) {
    if (!p.name.trim()) continue;
    if (p.kind === "file") {
      const bytes = await readFile(p.value);
      const filename =
        p.filename && p.filename.trim() ? p.filename : basename(p.value);
      const type =
        p.content_type && p.content_type.trim()
          ? p.content_type
          : guessMime(filename);
      fd.append(p.name, new File([bytes], filename, { type }), filename);
    } else if (p.content_type && p.content_type.trim()) {
      // Preserve an explicit Content-Type on a text field via a Blob (the
      // browser labels it filename="blob"); a plain string can't carry one.
      fd.append(p.name, new Blob([p.value], { type: p.content_type }));
    } else {
      fd.append(p.name, p.value);
    }
  }
  return fd;
}

/** Send an already-assembled request (from `buildSendable`) and return the same
 *  `HttpResponse` shape the sidecar produced. Replaces the `curlui.send` op. */
export async function sendHttpRequest(
  req: HttpRequest,
  settings: HttpSettings,
): Promise<HttpResponse> {
  const url = encodeQueryUrl(req.url);
  const isMultipart = req.body_kind === "multipart";

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const name = k.trim();
    if (!name) continue;
    // The transport sets the multipart Content-Type (with the boundary), so a
    // user-supplied one would conflict — drop it for multipart bodies.
    if (isMultipart && name.toLowerCase() === "content-type") continue;
    headers[name] = v;
  }

  let body: BodyInit | undefined;
  if (isMultipart) {
    body = await buildFormData(req.parts);
  } else if (req.body != null && req.body !== "") {
    body = req.body;
  }

  const started = performance.now();
  let res: Response;
  try {
    res = await tauriFetch(url, {
      method: req.method,
      headers,
      body,
      maxRedirections: settings.followRedirects ? 10 : 0,
      // `danger` (DangerousSettings) requires both fields when present, so only
      // send it when TLS verification is disabled.
      ...(settings.verifyTls
        ? {}
        : { danger: { acceptInvalidCerts: true, acceptInvalidHostnames: true } }),
      // A total-request timeout, matching reqwest's `.timeout(...)`.
      signal: AbortSignal.timeout(settings.timeoutSecs * 1000),
    });
  } catch (e) {
    if (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError")) {
      throw new Error(`request timed out after ${settings.timeoutSecs}s`);
    }
    throw new Error(`request failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const elapsed_ms = Math.round(performance.now() - started);

  const respHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    respHeaders[k] = v;
  });

  const buf = await res.arrayBuffer();
  let respBody: string;
  let body_encoding: string;
  try {
    respBody = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    body_encoding = "text";
  } catch {
    respBody = `[${buf.byteLength} bytes of binary data]`;
    body_encoding = "binary";
  }

  return {
    status: res.status,
    status_text: res.statusText,
    headers: respHeaders,
    body: respBody,
    body_encoding,
    elapsed_ms,
  };
}
