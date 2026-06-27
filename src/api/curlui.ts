import { ConnectionId, pluginCall } from "./api.ts";
import {
  genId,
  listWorkspaceDir,
  readWorkspaceFile,
  writeWorkspaceFileAt,
  deleteWorkspacePath,
} from "./store.ts";

// --- HTTP Client (curlui) ---------------------------------------------------

export type BodyKind = "none" | "json" | "text" | "form" | "multipart";

/** One field of a `multipart/form-data` body. A `file` part carries a local
 *  file path in `value`; the (local sidecar) plugin reads the bytes at send
 *  time, so file contents never cross the host pipe. */
export interface MultipartPart {
  name: string;
  kind: "text" | "file";
  /** Text value for a `text` part, or the local file path for a `file` part. */
  value: string;
  /** Optional filename override for a `file` part (defaults to the basename). */
  filename?: string | null;
  /** Optional explicit Content-Type for the part. */
  content_type?: string | null;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | null;
  body_kind: BodyKind;
  /** Multipart fields, used only when `body_kind === "multipart"`. */
  parts?: MultipartPart[];
}

export interface HttpResponse {
  status: number;
  status_text: string;
  headers: Record<string, string>;
  body: string;
  body_encoding: string;
  elapsed_ms: number;
  curl_command: string;
}

export interface HttpFolder {
  id: string;
  name: string;
  folders: HttpFolder[];
  requests: HttpRequestItem[];
}

export interface HttpRequestItem {
  id: string;
  name: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | null;
  body_kind: BodyKind;
  /** Multipart fields, used only when `body_kind === "multipart"`. */
  parts?: MultipartPart[];
  auth?: Auth;
  /** Whether to merge the parent collection's headers (default true when
   *  unset). When false, only the request's own headers are sent. */
  inheritHeaders?: boolean;
}

export type AuthKind = "inherit" | "none" | "bearer" | "basic" | "apikey";

/** Where an API-key credential is sent. */
export type ApiKeyIn = "header" | "query";

/** Per-request authorization config, Postman-style. All fields optional so
 *  partially-filled forms round-trip through persistence cleanly. `inherit`
 *  means "use the parent collection's auth"; `none` means explicitly no auth. */
export interface Auth {
  kind: AuthKind;
  /** bearer */
  token?: string;
  /** basic */
  username?: string;
  password?: string;
  /** apikey */
  key?: string;
  value?: string;
  in?: ApiKeyIn;
}

/** A request's default auth: inherit from the parent collection. */
export function defaultAuth(): Auth {
  return { kind: "inherit", in: "header" };
}

/** A collection's default auth: no auth (a collection has no parent to
 *  inherit from). */
export function defaultCollectionAuth(): Auth {
  return { kind: "none", in: "header" };
}

export interface HttpCollection {
  id: string;
  name: string;
  folders: HttpFolder[];
  requests: HttpRequestItem[];
  /** Collection-level `{{VAR}}` overrides, merged over the connection env for
   *  every request in this collection (collection wins on key collisions). */
  env?: Record<string, string>;
  /** Headers applied to every request in this collection. A request's own
   *  header with the same name overrides the inherited one. */
  headers?: Record<string, string>;
  /** Default auth for requests in this collection whose own auth is
   *  `none`/unset (Postman-style "inherit from parent"). */
  auth?: Auth;
}

export interface CollectionsFile {
  version: 1;
  collections: HttpCollection[];
}

/** A named set of `{{VAR}}` values. The active environment supplies the base
 *  variable map for every request; a collection's own `env` overrides it. */
export interface HttpEnvironment {
  id: string;
  name: string;
  variables: Record<string, string>;
}

/** All environments for a connection plus the id of the active one (`null` =
 *  none selected). Persisted as a single `environments.json` at the workspace
 *  root, a sibling of the collections tree. */
export interface EnvironmentsFile {
  version: 1;
  environments: HttpEnvironment[];
  activeId: string | null;
}

export function defaultEnvironmentsFile(): EnvironmentsFile {
  return { version: 1, environments: [], activeId: null };
}

export function newEnvironment(name = "New environment"): HttpEnvironment {
  return { id: genId(), name, variables: {} };
}

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

export function defaultCollectionsFile(): CollectionsFile {
  return {
    version: 1,
    collections: [
      {
        id: genId(),
        name: "Default",
        folders: [],
        requests: [],
      },
    ],
  };
}

export function newRequest(name = "New request"): HttpRequestItem {
  return {
    id: genId(),
    name,
    method: "GET",
    url: "",
    headers: {},
    body: "",
    body_kind: "none",
    auth: defaultAuth(),
    inheritHeaders: true,
  };
}

// --- On-disk tree serialization ---------------------------------------------
//
// The curl workspace persists as a tree of JSON files directly under its
// connection profile's workspace dir (`workspace/<connId>/`): `collections.json`
// holds the tree SHAPE (each collection's id/name/env/headers/auth + its folder
// tree of id/name, plus an ordered `requestIds` list per bucket so authored
// order survives), and each request lives in its own file at a path mirroring
// its position:
//   <colId>/requests/<reqId>.json
//   <colId>/folders/<folderId>/[folders/<subId>/]*requests/<reqId>.json
// The files are stored via the generic per-connection path primitives in
// store.ts (the host knows nothing about this layout). The in-memory model stays
// fully nested with embedded requests; the pure functions below translate
// to/from the flat path->content file list, and loadCurlFiles/saveCurlFiles do
// the actual disk IO over the generic primitives.

/** One stored curl file: path relative to the connection root + its contents. */
export interface CurlFile {
  path: string;
  content: string;
}

/** The shape file at the root of the curl workspace tree. */
export const COLLECTIONS_SHAPE_FILE = "collections.json";

/** Shape of a folder on disk: tree metadata + ordered request ids (bodies live
 *  in their own files). */
interface FolderShape {
  id: string;
  name: string;
  folders: FolderShape[];
  requestIds: string[];
}

interface CollectionShape {
  id: string;
  name: string;
  folders: FolderShape[];
  requestIds: string[];
  env?: Record<string, string>;
  headers?: Record<string, string>;
  auth?: Auth;
}

interface CollectionsShapeFile {
  version: 1;
  collections: CollectionShape[];
}

function stripFolder(f: HttpFolder): FolderShape {
  return {
    id: f.id,
    name: f.name,
    folders: f.folders.map(stripFolder),
    requestIds: f.requests.map((r) => r.id),
  };
}

function stripCollection(c: HttpCollection): CollectionShape {
  return {
    id: c.id,
    name: c.name,
    folders: c.folders.map(stripFolder),
    requestIds: c.requests.map((r) => r.id),
    ...(c.env ? { env: c.env } : {}),
    ...(c.headers ? { headers: c.headers } : {}),
    ...(c.auth ? { auth: c.auth } : {}),
  };
}

/** Serialize the in-memory tree into the flat on-disk file list: one shape file
 *  plus one file per request, keyed by its hierarchy path. */
export function collectionsToFiles(data: CollectionsFile): CurlFile[] {
  const shape: CollectionsShapeFile = {
    version: data.version,
    collections: data.collections.map(stripCollection),
  };
  const files: CurlFile[] = [
    { path: COLLECTIONS_SHAPE_FILE, content: JSON.stringify(shape, null, 2) },
  ];

  const emitRequests = (reqs: HttpRequestItem[], prefix: string) => {
    for (const r of reqs) {
      files.push({
        path: `${prefix}/requests/${r.id}.json`,
        content: JSON.stringify(r, null, 2),
      });
    }
  };
  const walkFolder = (folder: HttpFolder, prefix: string) => {
    const fPrefix = `${prefix}/folders/${folder.id}`;
    emitRequests(folder.requests, fPrefix);
    for (const sub of folder.folders) walkFolder(sub, fPrefix);
  };
  for (const col of data.collections) {
    emitRequests(col.requests, col.id);
    for (const folder of col.folders) walkFolder(folder, col.id);
  }
  return files;
}

/** Rebuild a live folder from its shape, with requests filled in from the parsed
 *  request map (in the shape's recorded order; missing ids are skipped). */
function reviveFolder(shape: FolderShape, reqs: Map<string, HttpRequestItem>): HttpFolder {
  return {
    id: shape.id,
    name: shape.name,
    folders: shape.folders.map((f) => reviveFolder(f, reqs)),
    requests: shape.requestIds.map((id) => reqs.get(id)).filter((r): r is HttpRequestItem => !!r),
  };
}

/** Rebuild the in-memory tree from the on-disk file list: parse the shape file,
 *  collect every request file into an id->request map, then assemble the tree in
 *  the shape's recorded order. Falls back to a default file when no shape is
 *  present. */
export function filesToCollections(files: CurlFile[]): CollectionsFile {
  const shapeFile = files.find((f) => f.path === COLLECTIONS_SHAPE_FILE);
  if (!shapeFile) return defaultCollectionsFile();
  const shape = JSON.parse(shapeFile.content) as CollectionsShapeFile;
  if (shape.version !== 1 || !Array.isArray(shape.collections)) {
    throw new Error("invalid collections file");
  }

  // Parse every request file into an id -> request map.
  const reqs = new Map<string, HttpRequestItem>();
  for (const file of files) {
    if (file.path === COLLECTIONS_SHAPE_FILE) continue;
    const segs = file.path.split("/");
    if (segs.length < 3 || segs[segs.length - 2] !== "requests") continue;
    try {
      const req = JSON.parse(file.content) as HttpRequestItem;
      if (req && typeof req.id === "string") reqs.set(req.id, req);
    } catch {
      // Skip an unparseable request file rather than failing the whole load.
    }
  }

  return {
    version: 1,
    collections: shape.collections.map((c) => ({
      id: c.id,
      name: c.name,
      folders: c.folders.map((f) => reviveFolder(f, reqs)),
      requests: c.requestIds.map((id) => reqs.get(id)).filter((r): r is HttpRequestItem => !!r),
      ...(c.env ? { env: c.env } : {}),
      ...(c.headers ? { headers: c.headers } : {}),
      ...(c.auth ? { auth: c.auth } : {}),
    })),
  };
}

// --- Disk IO over the generic workspace primitives --------------------------

/** Recursively collect every `*.json` path under the connection root, driving
 *  `listWorkspaceDir`. `rel` is the dir's path relative to the root ("" for the
 *  root itself). */
async function walkJson(savedId: string, rel: string, out: string[]): Promise<void> {
  const entries = await listWorkspaceDir(savedId, rel);
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDir) {
      await walkJson(savedId, childRel, out);
    } else if (e.name.endsWith(".json")) {
      out.push(childRel);
    }
  }
}

/** Load every curl file for a profile as a flat `{path, content}` list, with
 *  paths relative to the connection root. Empty when nothing is saved yet. Feed
 *  the result to {@link filesToCollections}. */
export async function loadCurlFiles(savedId: string): Promise<CurlFile[]> {
  const paths: string[] = [];
  await walkJson(savedId, "", paths);
  const files: CurlFile[] = [];
  for (const path of paths) {
    const content = await readWorkspaceFile(savedId, path);
    if (content !== null) files.push({ path, content });
  }
  return files;
}

/** Persist the curl file set (from {@link collectionsToFiles}) for a profile:
 *  write every desired file, then prune any existing `*.json` not in the set and
 *  any stale top-level collection dir, so deletions are reflected on disk. */
export async function saveCurlFiles(savedId: string, files: CurlFile[]): Promise<void> {
  const wanted = new Set(files.map((f) => f.path));

  // Snapshot what's currently on disk before writing.
  const existing: string[] = [];
  await walkJson(savedId, "", existing);

  // Write all desired files.
  for (const f of files) {
    await writeWorkspaceFileAt(savedId, f.path, f.content);
  }

  // Delete stale files no longer wanted. `environments.json` lives at the root
  // alongside the collections tree but is owned by saveEnvironments — never
  // prune it here.
  for (const path of existing) {
    if (path !== ENVIRONMENTS_FILE && !wanted.has(path)) {
      await deleteWorkspacePath(savedId, path);
    }
  }

  // Drop whole top-level collection dirs that no longer exist (removes any now-
  // empty folder subtrees in one shot). Top-level dir names are collection ids.
  const liveCollectionDirs = new Set(
    files
      .map((f) => f.path.split("/"))
      .filter((segs) => segs.length > 1)
      .map((segs) => segs[0]),
  );
  const topEntries = await listWorkspaceDir(savedId, "");
  for (const e of topEntries) {
    if (e.isDir && !liveCollectionDirs.has(e.name)) {
      await deleteWorkspacePath(savedId, e.name);
    }
  }
}

/** The single file holding all environments + the active selection. */
export const ENVIRONMENTS_FILE = "environments.json";

/** Load the environments file for a profile, falling back to an empty set when
 *  absent or unparseable. */
export async function loadEnvironments(savedId: string): Promise<EnvironmentsFile> {
  const content = await readWorkspaceFile(savedId, ENVIRONMENTS_FILE);
  if (content === null) return defaultEnvironmentsFile();
  try {
    const data = JSON.parse(content) as EnvironmentsFile;
    if (data.version !== 1 || !Array.isArray(data.environments)) {
      return defaultEnvironmentsFile();
    }
    return {
      version: 1,
      environments: data.environments,
      activeId: data.activeId ?? null,
    };
  } catch {
    return defaultEnvironmentsFile();
  }
}

/** Persist the environments file for a profile. */
export async function saveEnvironments(savedId: string, data: EnvironmentsFile): Promise<void> {
  await writeWorkspaceFileAt(savedId, ENVIRONMENTS_FILE, JSON.stringify(data, null, 2));
}

/** Color class suffix for an HTTP method, Postman-style. */
export function methodColor(method: string): string {
  switch (method.toUpperCase()) {
    case "GET":
      return "get";
    case "POST":
      return "post";
    case "PUT":
      return "put";
    case "PATCH":
      return "patch";
    case "DELETE":
      return "delete";
    case "HEAD":
    case "OPTIONS":
      return "info";
    default:
      return "other";
  }
}

/** An editable key/value row used for headers and query params. */
export interface KvRow {
  id: string;
  enabled: boolean;
  key: string;
  value: string;
}

export function newKvRow(key = "", value = "", enabled = true): KvRow {
  return { id: genId(), enabled, key, value };
}

/** The User-Agent rdb sends, embedding the running plugin's version (which is
 *  the plugin's `CARGO_PKG_VERSION`, so it matches the backend client default). */
export function userAgent(version: string): string {
  return `rdb/${version || "0"} Http-Client (plugin)`;
}

/** Headers rdb adds to every request automatically (Postman-style). They are
 *  shown read-only in the Headers tab and sent unless the user (or the owning
 *  collection) sets a header with the same name, which overrides them. */
export function autoHeaders(version: string): Record<string, string> {
  return { "User-Agent": userAgent(version) };
}

/** Read-only display rows for {@link autoHeaders}. Any auto header whose name
 *  the caller's own (enabled) header keys override — case-insensitively — is
 *  marked `enabled: false` so the UI can show it as inactive/struck-through. */
export function autoHeaderRows(overrideKeys: string[], version: string): KvRow[] {
  const overridden = new Set(overrideKeys.map((k) => k.trim().toLowerCase()).filter(Boolean));
  return Object.entries(autoHeaders(version)).map(([k, v]) => ({
    id: "auto:" + k,
    enabled: !overridden.has(k.toLowerCase()),
    key: k,
    value: v,
  }));
}

/** Build rows from a header map, always leaving one trailing blank row. */
export function headersToRows(headers: Record<string, string>): KvRow[] {
  const rows = Object.entries(headers).map(([k, v]) => newKvRow(k, v));
  rows.push(newKvRow());
  return rows;
}

/** Collapse rows back into a header map (enabled, non-empty keys only). */
export function rowsToHeaders(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const key = r.key.trim();
    if (!r.enabled || !key) continue;
    out[key] = r.value;
  }
  return out;
}

/** Parse a urlencoded form body (`a=1&b=2`) into editable rows. Values are kept
 *  verbatim — no percent-decoding — so `{{VAR}}` placeholders and any
 *  already-encoded text round-trip unchanged through {@link rowsToForm}. Always
 *  leaves one trailing blank row. */
export function formToRows(body: string | null | undefined): KvRow[] {
  const rows: KvRow[] = [];
  for (const pair of (body ?? "").split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const val = eq < 0 ? "" : pair.slice(eq + 1);
    rows.push(newKvRow(key, val));
  }
  rows.push(newKvRow());
  return rows;
}

/** Collapse rows back into a urlencoded form body string (enabled, non-empty
 *  keys only). Written verbatim — the inverse of {@link formToRows}. */
export function rowsToForm(rows: KvRow[]): string {
  return rows
    .filter((r) => r.enabled && r.key.trim())
    .map((r) => `${r.key.trim()}=${r.value}`)
    .join("&");
}

/** Split a URL into its base (scheme://host/path) and query rows. Values are
 *  kept verbatim — no percent-decoding — so `{{VAR}}` placeholders and any
 *  already-encoded text round-trip unchanged through {@link joinUrl}. */
export function splitUrl(url: string): { base: string; params: KvRow[] } {
  const qIdx = url.indexOf("?");
  if (qIdx < 0) return { base: url, params: [newKvRow()] };
  const base = url.slice(0, qIdx);
  const query = url.slice(qIdx + 1);
  const params: KvRow[] = [];
  for (const pair of query.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const rawKey = eq < 0 ? pair : pair.slice(0, eq);
    const rawVal = eq < 0 ? "" : pair.slice(eq + 1);
    params.push(newKvRow(rawKey, rawVal));
  }
  params.push(newKvRow());
  return { base, params };
}

/** Reassemble a URL from a base and query rows. Keys/values are written
 *  verbatim — the URL input is not percent-encoded, so what the user types is
 *  what gets sent (matching curl / browser address-bar behaviour). */
export function joinUrl(base: string, params: KvRow[]): string {
  const stem = base.split("?")[0];
  const query = params
    .filter((p) => p.enabled && p.key.trim())
    .map((p) => `${p.key.trim()}=${p.value}`)
    .join("&");
  return query ? `${stem}?${query}` : stem;
}

/** UTF-8-safe base64 (btoa alone mishandles non-Latin1 chars). */
function base64Utf8(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Replace `{{NAME}}` placeholders using the environment map. Throws on an
 *  unclosed placeholder, an empty name, or an unknown variable. Mirrors the
 *  behaviour the curlui plugin used to apply server-side. */
export function interpolate(template: string, env: Record<string, string>): string {
  let out = "";
  let rest = template;
  for (let start = rest.indexOf("{{"); start >= 0; start = rest.indexOf("{{")) {
    out += rest.slice(0, start);
    rest = rest.slice(start + 2);
    const end = rest.indexOf("}}");
    if (end < 0) throw new Error("unclosed variable placeholder");
    const name = rest.slice(0, end).trim();
    if (!name) throw new Error("empty variable name");
    if (!(name in env)) throw new Error(`unknown variable: ${name}`);
    out += env[name];
    rest = rest.slice(end + 2);
  }
  return out + rest;
}

/** Default a schemeless URL to `https://` so a bare host like `www.google.com`
 *  works like it does in a browser. A leading `scheme://` is left untouched. */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || /^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

/** Build the concrete request to send: merge the owning collection's env
 *  overrides, headers, and default auth, interpolate `{{VAR}}` placeholders,
 *  normalize the URL, then merge the effective auth into headers (and, for an
 *  API key sent as a query param, the URL). Basic credentials are interpolated
 *  *before* base64 so a `{{USER}}`/`{{PASS}}` resolves correctly. Throws (via
 *  {@link interpolate}) on an unknown/malformed placeholder.
 *
 *  Precedence: request headers/auth override the collection's; the collection's
 *  env overrides the connection env. */
export function buildSendable(
  req: HttpRequestItem,
  env: Record<string, string>,
  collection?: Pick<HttpCollection, "env" | "headers" | "auth">,
  pluginVersion = "",
): HttpRequest {
  // Collection env overrides connection env.
  const effEnv = collection?.env ? { ...env, ...collection.env } : env;

  // Collection headers are defaults (when inheritance is on); request headers
  // (same key, case-insensitive) win.
  const headers: Record<string, string> = {};
  const haveKey = (k: string) =>
    Object.keys(headers).some((h) => h.toLowerCase() === k.toLowerCase());
  if (req.inheritHeaders !== false) {
    for (const [k, v] of Object.entries(collection?.headers ?? {})) {
      if (k.trim()) headers[k] = interpolate(v, effEnv);
    }
  }
  for (const [k, v] of Object.entries(req.headers)) {
    if (!k.trim()) continue;
    // Drop any inherited header with the same name before setting the override.
    for (const h of Object.keys(headers)) {
      if (h.toLowerCase() === k.toLowerCase()) delete headers[h];
    }
    headers[k] = interpolate(v, effEnv);
  }

  let url = normalizeUrl(interpolate(req.url, effEnv));

  // Resolve effective auth: a request that inherits (or has no auth set) uses
  // the collection's auth; an explicit `none` means no auth. The collection's
  // own auth may itself be `inherit`/`none`, which resolves to no auth.
  const reqAuth = req.auth ?? { kind: "inherit" as AuthKind };
  const auth = reqAuth.kind === "inherit" ? collection?.auth : reqAuth;

  switch (auth?.kind) {
    case "bearer":
      if (auth.token?.trim() && !haveKey("Authorization")) {
        headers["Authorization"] = `Bearer ${interpolate(auth.token.trim(), effEnv)}`;
      }
      break;
    case "basic":
      if ((auth.username || auth.password) && !haveKey("Authorization")) {
        const user = interpolate(auth.username ?? "", effEnv);
        const pass = interpolate(auth.password ?? "", effEnv);
        headers["Authorization"] = `Basic ${base64Utf8(`${user}:${pass}`)}`;
      }
      break;
    case "apikey":
      if (auth.key?.trim()) {
        const key = interpolate(auth.key.trim(), effEnv);
        const value = interpolate(auth.value ?? "", effEnv);
        if ((auth.in ?? "header") === "query") {
          const { base, params } = splitUrl(url);
          params.splice(params.length - 1, 0, {
            id: "auth",
            enabled: true,
            key,
            value,
          });
          url = joinUrl(base, params);
        } else if (!haveKey(key)) {
          headers[key] = value;
        }
      }
      break;
  }

  // Add the auto-generated headers (e.g. User-Agent) unless the user or the
  // collection already set one with the same name — a same-name header the user
  // adds overrides the auto value.
  for (const [k, v] of Object.entries(autoHeaders(pluginVersion))) {
    if (!haveKey(k)) headers[k] = v;
  }

  // A body of kind "none" carries no content regardless of any text left in the
  // editor from a previous kind, so don't send it. A "multipart" body carries
  // structured `parts` instead of a body string.
  if (req.body_kind === "multipart") {
    const parts = (req.parts ?? [])
      .filter((p) => p.name.trim() || p.value.trim())
      .map((p) => ({
        name: interpolate(p.name, effEnv),
        kind: p.kind,
        value: interpolate(p.value, effEnv),
        ...(p.filename ? { filename: interpolate(p.filename, effEnv) } : {}),
        ...(p.content_type ? { content_type: interpolate(p.content_type, effEnv) } : {}),
      }));
    return {
      method: req.method,
      url,
      headers,
      body: "",
      body_kind: req.body_kind,
      parts,
    };
  }

  // An `application/x-www-form-urlencoded` body: percent-encode the field pairs
  // (the editor keeps them verbatim) and default the Content-Type header.
  if (req.body_kind === "form") {
    if (!haveKey("Content-Type")) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    return {
      method: req.method,
      url,
      headers,
      body: encodeFormBody(req.body ?? "", effEnv),
      body_kind: req.body_kind,
    };
  }

  const body = req.body_kind === "none" ? "" : interpolate(req.body ?? "", effEnv);

  return {
    method: req.method,
    url,
    headers,
    body,
    body_kind: req.body_kind,
  };
}

/** Percent-encode one `x-www-form-urlencoded` key or value, preserving any
 *  existing `%XX` escapes so an already-encoded value (e.g. from curl import) is
 *  not double-encoded. Iterates by code point so multi-byte chars round-trip.
 *  Mirrors the URL-query `enc` in the curlui plugin. */
function encodeFormComponent(s: string): string {
  let out = "";
  const chars = Array.from(s);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (
      ch === "%" &&
      i + 2 < chars.length &&
      /^[0-9a-fA-F]$/.test(chars[i + 1]) &&
      /^[0-9a-fA-F]$/.test(chars[i + 2])
    ) {
      out += ch + chars[i + 1] + chars[i + 2];
      i += 2;
      continue;
    }
    out += encodeURIComponent(ch);
  }
  return out;
}

/** Encode a verbatim form body (`a=hello world&b={{V}}`) as
 *  `application/x-www-form-urlencoded`: split on the structural `&`/`=`,
 *  interpolate `{{VAR}}` in each component, then percent-encode each. Splitting
 *  before interpolating keeps a variable whose value contains `&`/`=` from
 *  corrupting the field structure. */
function encodeFormBody(body: string, env: Record<string, string>): string {
  return body
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const eq = pair.indexOf("=");
      if (eq < 0) return encodeFormComponent(interpolate(pair, env));
      const k = encodeFormComponent(interpolate(pair.slice(0, eq), env));
      const v = encodeFormComponent(interpolate(pair.slice(eq + 1), env));
      return `${k}=${v}`;
    })
    .join("&");
}

/** Render a request as a copy-pasteable `curl` command. Mirrors the plugin's
 *  `build_curl_command` output so a copied command matches the "As cURL" view.
 *  Pass the concrete request from {@link buildSendable} so auth and `{{VAR}}`
 *  values are already resolved. */
export function buildCurl(req: HttpRequest): string {
  const parts = [`curl -X ${req.method} '${req.url}'`];
  for (const [k, v] of Object.entries(req.headers)) {
    parts.push(`  -H '${k}: ${v}'`);
  }
  const esc = (s: string) => s.replace(/'/g, "'\\''");
  if (req.body_kind === "multipart") {
    for (const p of req.parts ?? []) {
      if (!p.name.trim()) continue;
      let spec: string;
      if (p.kind === "file") {
        spec = `${p.name}=@${p.value}`;
        if (p.content_type) spec += `;type=${p.content_type}`;
        if (p.filename) spec += `;filename=${p.filename}`;
      } else {
        spec = `${p.name}=${p.value}`;
      }
      parts.push(`  -F '${esc(spec)}'`);
    }
  } else {
    const body = req.body ?? "";
    if (body) {
      parts.push(`  -d '${esc(body)}'`);
    }
  }
  return parts.join(" \\\n");
}

export const curlui_api = {
  httpSend: (connectionId: ConnectionId, request: HttpRequest) =>
    pluginCall<HttpResponse>(connectionId, "curlui.send", { request }),

  httpParseCurl: (connectionId: ConnectionId, curl: string) =>
    pluginCall<HttpRequest>(connectionId, "curlui.parse_curl", { curl }),
};
