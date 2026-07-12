import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { errString } from "../../api/api.ts";
import type { ConnectionConfig } from "../../api/api.ts";
import {
  buildCurl,
  buildSendable,
  collectionFileName,
  collectionFromJson,
  collectionToJson,
  collectionsToFiles,
  defaultAuth,
  defaultCollectionAuth,
  defaultCollectionsFile,
  defaultEnvironmentsFile,
  deleteDraft,
  filesToCollections,
  formToRows,
  headersToRows,
  HTTP_METHODS,
  joinUrl,
  loadCurlFiles,
  loadCurlSession,
  loadDrafts,
  loadEnvironments,
  methodColor,
  newEnvironment,
  newKvRow,
  newRequest,
  autoHeaderRows,
  rowsToForm,
  rowsToHeaders,
  saveCurlFiles,
  saveCurlSession,
  saveDraft,
  saveEnvironments,
  splitUrl,
  type Auth,
  type AuthKind,
  type BodyKind,
  type CollectionsFile,
  type EnvironmentsFile,
  type HttpCollection,
  type HttpEnvironment,
  type HttpFolder,
  type HttpRequestItem,
  type HttpResponse,
  type KvRow,
} from "../../api/curlui.ts";
import { sendHttpRequest, parseHttpSettings } from "../../api/curlHttp.ts";
import { parseCurl } from "../../api/curlParser.ts";
import {
  runScript,
  type ScriptRequest,
  type ScriptResponse,
  type TestResult,
  type LogLine,
} from "../../api/scriptRunner.ts";
import { genId } from "../../api/store.ts";
import { ConfirmDialog, Modal } from "../Modal";
import { KvEditor } from "../KvEditor";
import { MultipartEditor } from "../MultipartEditor";
import { ContentEditor } from "../ContentEditor";
import { CodeEditorV2 } from "../CodeEditorV2";
import { useLoader } from "../Loader";
import { useResizable, TREE_MIN, TREE_MAX, EDITOR_MIN, EDITOR_MAX } from "../../useResizable";
import { ConnScope, useConnectionState } from "../../connectionState";

type RequestTab = "env" | "params" | "auth" | "headers" | "body" | "prescript" | "tests";
type ResponseTab = "body" | "headers" | "tests";
type CollectionTab = "env" | "headers" | "auth" | "prescript" | "tests";

/** Aggregated output of the pre/post scripts for one send: assertion results,
 *  console logs, and a top-level script error (compile/throw/timeout). */
interface TestRun {
  tests: TestResult[];
  logs: LogLine[];
  error?: string;
}

/** Shallow equality of two string maps (same keys, same values). */
function sameRecord(a: Record<string, string>, b: Record<string, string>): boolean {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => a[k] === b[k]);
}

/** A JavaScript editor for a pre-request or test script, with a short hint about
 *  the `client` API available in the sandbox. */
function ScriptEditor({
  value,
  onChange,
  kind,
}: {
  value: string;
  onChange: (v: string) => void;
  kind: "pre" | "post";
}) {
  const hint =
    kind === "pre" ? (
      <>
        Runs before the request in a sandbox. Use <code>client.environment.set(k, v)</code>,{" "}
        <code>client.variables.get(k)</code>, <code>client.request.headers.add(&#123;key, value&#125;)</code>.
      </>
    ) : (
      <>
        Runs after the response. Use <code>client.test(name, fn)</code>,{" "}
        <code>client.expect(client.response.code).to.equal(200)</code>,{" "}
        <code>client.environment.set(k, client.response.json().x)</code>.
      </>
    );
  return (
    <div className="curlui-script">
      <p className="muted curlui-collection-hint">{hint}</p>
      <CodeEditorV2
        className="curlui-script-editor"
        language="javascript"
        value={value}
        onChange={onChange}
        lineWrapping
        placeholder={kind === "pre" ? "// pre-request script" : "// test script"}
      />
    </div>
  );
}

/** Renders a send's test assertions + console output in the response pane. */
function TestResultsView({ run }: { run: TestRun }) {
  const passed = run.tests.filter((t) => t.passed).length;
  const failed = run.tests.length - passed;
  return (
    <div className="curlui-tests">
      {run.error && <div className="curlui-test-error">Script error: {run.error}</div>}
      {run.tests.length > 0 && (
        <div className="curlui-test-summary">
          <span className="curlui-test-pass">{passed} passed</span>
          {failed > 0 && <span className="curlui-test-fail">{failed} failed</span>}
        </div>
      )}
      <ul className="curlui-test-list">
        {run.tests.map((t, i) => (
          <li key={i} className={t.passed ? "curlui-test-ok" : "curlui-test-bad"}>
            <span className="curlui-test-badge">{t.passed ? "PASS" : "FAIL"}</span>
            <span className="curlui-test-name">{t.name}</span>
            {!t.passed && t.error && <div className="curlui-test-msg">{t.error}</div>}
          </li>
        ))}
      </ul>
      {run.logs.length > 0 && (
        <div className="curlui-console">
          <div className="curlui-console-title">Console</div>
          {run.logs.map((l, i) => (
            <div key={i} className={"curlui-log curlui-log-" + l.level}>
              {l.text}
            </div>
          ))}
        </div>
      )}
      {run.tests.length === 0 && run.logs.length === 0 && !run.error && (
        <p className="muted">No test results.</p>
      )}
    </div>
  );
}

/** Case-insensitive header lookup (HTTP header names aren't case-sensitive,
 *  and servers vary the casing they return). */
function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

/** Human-readable byte size of a UTF-8 string. */
function byteSize(s: string): string {
  const bytes = new TextEncoder().encode(s).length;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function statusClass(status: number): string {
  if (status >= 500) return "err";
  if (status >= 400) return "warn";
  if (status >= 200 && status < 300) return "ok";
  return "info";
}

const AUTH_KINDS: { value: AuthKind; label: string }[] = [
  { value: "inherit", label: "Inherit from collection" },
  { value: "none", label: "No Auth" },
  { value: "bearer", label: "Bearer Token" },
  { value: "basic", label: "Basic Auth" },
  { value: "apikey", label: "API Key" },
];

/** Authorization tab body: a type selector plus the fields for the chosen
 *  type. Credential values may reference `{{VAR}}` env placeholders.
 *  `allowInherit` adds the "Inherit from collection" option (requests only). */
function AuthEditor({
  auth,
  onChange,
  allowInherit = false,
}: {
  auth: Auth;
  onChange: (patch: Partial<Auth>) => void;
  allowInherit?: boolean;
}) {
  const kinds = allowInherit ? AUTH_KINDS : AUTH_KINDS.filter((k) => k.value !== "inherit");
  return (
    <div className="curlui-auth">
      <label className="curlui-auth-field">
        <span className="field-label">Type</span>
        <select value={auth.kind} onChange={(e) => onChange({ kind: e.target.value as AuthKind })}>
          {kinds.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>

      {auth.kind === "inherit" && (
        <p className="muted">This request uses the authorization set on its parent collection.</p>
      )}

      {auth.kind === "none" && (
        <p className="muted">This request does not use any authorization.</p>
      )}

      {auth.kind === "bearer" && (
        <label className="curlui-auth-field">
          <span className="field-label">Token</span>
          <input
            type="text"
            className="curlui-auth-input"
            value={auth.token ?? ""}
            placeholder="{{TOKEN}} or a literal token"
            onChange={(e) => onChange({ token: e.target.value })}
          />
        </label>
      )}

      {auth.kind === "basic" && (
        <>
          <label className="curlui-auth-field">
            <span className="field-label">Username</span>
            <input
              type="text"
              className="curlui-auth-input"
              value={auth.username ?? ""}
              onChange={(e) => onChange({ username: e.target.value })}
            />
          </label>
          <label className="curlui-auth-field">
            <span className="field-label">Password</span>
            <input
              type="password"
              className="curlui-auth-input"
              value={auth.password ?? ""}
              onChange={(e) => onChange({ password: e.target.value })}
            />
          </label>
        </>
      )}

      {auth.kind === "apikey" && (
        <>
          <label className="curlui-auth-field">
            <span className="field-label">Key</span>
            <input
              type="text"
              className="curlui-auth-input"
              value={auth.key ?? ""}
              placeholder="X-API-Key"
              onChange={(e) => onChange({ key: e.target.value })}
            />
          </label>
          <label className="curlui-auth-field">
            <span className="field-label">Value</span>
            <input
              type="text"
              className="curlui-auth-input"
              value={auth.value ?? ""}
              placeholder="{{API_KEY}} or a literal value"
              onChange={(e) => onChange({ value: e.target.value })}
            />
          </label>
          <label className="curlui-auth-field">
            <span className="field-label">Add to</span>
            <select
              value={auth.in ?? "header"}
              onChange={(e) => onChange({ in: e.target.value as Auth["in"] })}
            >
              <option value="header">Header</option>
              <option value="query">Query param</option>
            </select>
          </label>
        </>
      )}
    </div>
  );
}

/** Collection-settings editor shown in the main pane when a collection is
 *  opened from the tree: env overrides, inherited headers, and default auth. */
function CollectionEditor({
  collection,
  baseEnv,
  tab,
  onTabChange,
  onPatch,
  onDelete,
  onExport,
}: {
  collection: HttpCollection;
  baseEnv: Record<string, string>;
  tab: CollectionTab;
  onTabChange: (t: CollectionTab) => void;
  onPatch: (patch: Partial<HttpCollection>) => void;
  onDelete: () => void;
  onExport: () => void;
}) {
  const envCount = Object.keys(collection.env ?? {}).length;
  const headerCount = Object.keys(collection.headers ?? {}).length;
  const auth = collection.auth ?? defaultCollectionAuth();
  return (
    <div className="curlui-collection">
      <div className="curlui-collection-head">
        <span className="curlui-collection-icon">🗂</span>
        <input
          type="text"
          className="curlui-req-name-input"
          value={collection.name}
          onChange={(e) => onPatch({ name: e.target.value })}
        />
        <button type="button" title="Export collection" onClick={onExport}>
          Export
        </button>
        <button type="button" title="Delete collection" onClick={onDelete}>
          Delete
        </button>
      </div>
      <div className="tabs">
        <button
          type="button"
          className={"tab" + (tab === "env" ? " active" : "")}
          onClick={() => onTabChange("env")}
        >
          Variables
          {envCount > 0 && <span className="tab-badge">{envCount}</span>}
        </button>
        <button
          type="button"
          className={"tab" + (tab === "headers" ? " active" : "")}
          onClick={() => onTabChange("headers")}
        >
          Headers
          {headerCount > 0 && <span className="tab-badge">{headerCount}</span>}
        </button>
        <button
          type="button"
          className={"tab" + (tab === "auth" ? " active" : "")}
          onClick={() => onTabChange("auth")}
        >
          Auth
          {auth.kind !== "none" && <span className="tab-dot" />}
        </button>
        <button
          type="button"
          className={"tab" + (tab === "prescript" ? " active" : "")}
          onClick={() => onTabChange("prescript")}
        >
          Pre-request
          {collection.preScript?.trim() && <span className="tab-dot" />}
        </button>
        <button
          type="button"
          className={"tab" + (tab === "tests" ? " active" : "")}
          onClick={() => onTabChange("tests")}
        >
          Tests
          {collection.postScript?.trim() && <span className="tab-dot" />}
        </button>
      </div>
      <div className="curlui-tab-panel">
        {tab === "env" && (
          <>
            <p className="muted curlui-collection-hint">
              Overrides the active environment for requests in this collection. Use as{" "}
              <code>{"{{NAME}}"}</code>.
              {Object.keys(baseEnv).length > 0 &&
                ` Environment: ${Object.keys(baseEnv).join(", ")}.`}
            </p>
            <KvEditor
              rows={headersToRows(collection.env ?? {})}
              onChange={(rows) => onPatch({ env: rowsToHeaders(rows) })}
              keyPlaceholder="Variable"
            />
          </>
        )}
        {tab === "headers" && (
          <KvEditor
            rows={headersToRows(collection.headers ?? {})}
            onChange={(rows) => onPatch({ headers: rowsToHeaders(rows) })}
            keyPlaceholder="Header"
          />
        )}
        {tab === "auth" && (
          <AuthEditor auth={auth} onChange={(patch) => onPatch({ auth: { ...auth, ...patch } })} />
        )}
        {tab === "prescript" && (
          <ScriptEditor
            kind="pre"
            value={collection.preScript ?? ""}
            onChange={(v) => onPatch({ preScript: v })}
          />
        )}
        {tab === "tests" && (
          <ScriptEditor
            kind="post"
            value={collection.postScript ?? ""}
            onChange={(v) => onPatch({ postScript: v })}
          />
        )}
      </div>
    </div>
  );
}

interface Props {
  savedId: string;
  /** The saved connection's config, supplying the transport settings
   *  (verify_tls / follow_redirects / timeout_secs) for frontend requests. */
  config: ConnectionConfig;
  treeWidth: number;
  onTreeWidthChange: (width: number) => void;
  /** The running curlui plugin's version, used for the default User-Agent. */
  pluginVersion: string;
}

type TreeTarget =
  | { kind: "collection"; collectionId: string }
  | { kind: "folder"; collectionId: string; folderId: string };

/** A pending "name this new item" dialog. `target` is null for a new
 *  top-level collection; otherwise it's where the new folder is added. */
type NamePrompt =
  { kind: "collection" } | { kind: "environment" } | { kind: "folder"; target: TreeTarget };

/** A pending delete confirmation: what to remove (with its display name). */
type DeleteTarget =
  | { kind: "request"; name: string }
  | { kind: "folder"; collectionId: string; folderId: string; name: string }
  | { kind: "collection"; collectionId: string; name: string }
  | { kind: "environment"; environmentId: string; name: string };

interface SelectedRequest {
  collectionId: string;
  folderId: string | null;
  requestId: string;
}

/** A request tab is identified by the same `collectionId:folderId:requestId`
 *  key string used for the active selection. */
function parseKey(key: string): SelectedRequest | null {
  const [collectionId, folderId, requestId] = key.split(":");
  if (!collectionId || !requestId) return null;
  return { collectionId, folderId: folderId || null, requestId };
}

/** Tab keys are either a request (`collectionId:folderId:requestId`), a
 *  collection (`col␟<id>`), or a folder (`fol␟<collectionId>␟<folderId>`). The
 *  unit-separator prefix can't appear in a request key, so they never collide. */
const COL_TAB = "col␟";
const collectionTabKey = (id: string) => COL_TAB + id;
const collectionIdFromTab = (key: string): string | null =>
  key.startsWith(COL_TAB) ? key.slice(COL_TAB.length) : null;

const FOL_TAB = "fol␟";
const folderTabKey = (collectionId: string, folderId: string) =>
  FOL_TAB + collectionId + "␟" + folderId;
const folderRefFromTab = (key: string): { collectionId: string; folderId: string } | null => {
  if (!key.startsWith(FOL_TAB)) return null;
  const [collectionId, folderId] = key.slice(FOL_TAB.length).split("␟");
  return collectionId && folderId ? { collectionId, folderId } : null;
};

const ENV_TAB = "env␟";
const environmentTabKey = (id: string) => ENV_TAB + id;
const environmentIdFromTab = (key: string): string | null =>
  key.startsWith(ENV_TAB) ? key.slice(ENV_TAB.length) : null;

// A temporary ("scratch") request lives only in memory until saved into a
// collection. Its tab is keyed `tmp␟<reqId>`.
const TMP_TAB = "tmp␟";
const tmpTabKey = (id: string) => TMP_TAB + id;
const tmpIdFromTab = (key: string): string | null =>
  key.startsWith(TMP_TAB) ? key.slice(TMP_TAB.length) : null;

function findRequest(data: CollectionsFile, sel: SelectedRequest): HttpRequestItem | null {
  const col = data.collections.find((c) => c.id === sel.collectionId);
  if (!col) return null;
  if (!sel.folderId) {
    return col.requests.find((r) => r.id === sel.requestId) ?? null;
  }
  const walk = (folders: HttpFolder[]): HttpRequestItem | null => {
    for (const f of folders) {
      if (f.id === sel.folderId) {
        return f.requests.find((r) => r.id === sel.requestId) ?? null;
      }
      const nested = walk(f.folders);
      if (nested) return nested;
    }
    return null;
  };
  return walk(col.folders);
}

function updateRequest(
  data: CollectionsFile,
  sel: SelectedRequest,
  patch: Partial<HttpRequestItem>,
): CollectionsFile {
  const next = structuredClone(data);
  const col = next.collections.find((c) => c.id === sel.collectionId);
  if (!col) return data;
  const apply = (reqs: HttpRequestItem[]) => {
    const i = reqs.findIndex((r) => r.id === sel.requestId);
    if (i >= 0) reqs[i] = { ...reqs[i], ...patch };
  };
  if (!sel.folderId) {
    apply(col.requests);
  } else {
    const walk = (folders: HttpFolder[]): boolean => {
      for (const f of folders) {
        if (f.id === sel.folderId) {
          apply(f.requests);
          return true;
        }
        if (walk(f.folders)) return true;
      }
      return false;
    };
    walk(col.folders);
  }
  return next;
}

function insertRequest(
  data: CollectionsFile,
  target: TreeTarget,
  req: HttpRequestItem,
): CollectionsFile {
  const next = structuredClone(data);
  const col = next.collections.find((c) => c.id === target.collectionId);
  if (!col) return data;
  if (target.kind === "collection") {
    col.requests.push(req);
  } else {
    const walk = (folders: HttpFolder[]): boolean => {
      for (const f of folders) {
        if (f.id === target.folderId) {
          f.requests.push(req);
          return true;
        }
        if (walk(f.folders)) return true;
      }
      return false;
    };
    walk(col.folders);
  }
  return next;
}

/** Find a folder by id anywhere in a collection's folder tree. */
function findFolder(
  data: CollectionsFile,
  collectionId: string,
  folderId: string,
): HttpFolder | null {
  const col = data.collections.find((c) => c.id === collectionId);
  if (!col) return null;
  const walk = (folders: HttpFolder[]): HttpFolder | null => {
    for (const f of folders) {
      if (f.id === folderId) return f;
      const nested = walk(f.folders);
      if (nested) return nested;
    }
    return null;
  };
  return walk(col.folders);
}

/** Flatten a collection's folder tree into a depth-indented option list for the
 *  save-target folder picker. */
function flattenFolders(col: HttpCollection): { id: string; label: string }[] {
  const out: { id: string; label: string }[] = [];
  const walk = (folders: HttpFolder[], depth: number) => {
    for (const f of folders) {
      out.push({ id: f.id, label: `${"  ".repeat(depth)}${f.name}` });
      walk(f.folders, depth + 1);
    }
  };
  walk(col.folders, 0);
  return out;
}

/** Apply a patch to a folder by id, returning a new CollectionsFile. */
function updateFolder(
  data: CollectionsFile,
  collectionId: string,
  folderId: string,
  patch: Partial<HttpFolder>,
): CollectionsFile {
  const next = structuredClone(data);
  const col = next.collections.find((c) => c.id === collectionId);
  if (!col) return data;
  const walk = (folders: HttpFolder[]): boolean => {
    const i = folders.findIndex((f) => f.id === folderId);
    if (i >= 0) {
      folders[i] = { ...folders[i], ...patch };
      return true;
    }
    for (const f of folders) {
      if (walk(f.folders)) return true;
    }
    return false;
  };
  walk(col.folders);
  return next;
}

// --- Drag-and-drop move/reorder helpers (collection-scoped) -----------------
//
// Moves are restricted to within a single collection, so every helper below
// operates on one `HttpCollection` (the colId is fixed and never changes). They
// mutate the passed node in place (callers pass a structuredClone), mirroring
// the recursive `walk` shape used by findFolder/updateFolder/deleteFolder.

/** Remove a request by id from the collection root or any nested folder,
 *  returning the removed node (or null when not found). */
function detachRequestFromCol(col: HttpCollection, reqId: string): HttpRequestItem | null {
  const pull = (reqs: HttpRequestItem[]): HttpRequestItem | null => {
    const i = reqs.findIndex((r) => r.id === reqId);
    return i >= 0 ? reqs.splice(i, 1)[0] : null;
  };
  const top = pull(col.requests);
  if (top) return top;
  const walk = (folders: HttpFolder[]): HttpRequestItem | null => {
    for (const f of folders) {
      const hit = pull(f.requests);
      if (hit) return hit;
      const nested = walk(f.folders);
      if (nested) return nested;
    }
    return null;
  };
  return walk(col.folders);
}

/** Remove a folder by id from the collection root or any nested folder,
 *  returning the removed node (or null when not found). */
function detachFolderFromCol(col: HttpCollection, folderId: string): HttpFolder | null {
  const pull = (folders: HttpFolder[]): HttpFolder | null => {
    const i = folders.findIndex((f) => f.id === folderId);
    return i >= 0 ? folders.splice(i, 1)[0] : null;
  };
  const top = pull(col.folders);
  if (top) return top;
  const walk = (folders: HttpFolder[]): HttpFolder | null => {
    for (const f of folders) {
      const hit = pull(f.folders);
      if (hit) return hit;
      const nested = walk(f.folders);
      if (nested) return nested;
    }
    return null;
  };
  return walk(col.folders);
}

/** Find a folder by id within a single collection. */
function folderInCol(col: HttpCollection, folderId: string): HttpFolder | null {
  const walk = (folders: HttpFolder[]): HttpFolder | null => {
    for (const f of folders) {
      if (f.id === folderId) return f;
      const nested = walk(f.folders);
      if (nested) return nested;
    }
    return null;
  };
  return walk(col.folders);
}

/** The destination `requests` array for a folder id (null = collection root). */
function requestsContainer(col: HttpCollection, folderId: string | null): HttpRequestItem[] | null {
  if (!folderId) return col.requests;
  return folderInCol(col, folderId)?.requests ?? null;
}

/** The destination `folders` array for a folder id (null = collection root). */
function foldersContainer(col: HttpCollection, folderId: string | null): HttpFolder[] | null {
  if (!folderId) return col.folders;
  return folderInCol(col, folderId)?.folders ?? null;
}

/** All descendant folder ids of a folder (excluding the folder itself), used to
 *  reject dropping a folder into itself or one of its own descendants. */
function folderDescendantIds(col: HttpCollection, folderId: string): Set<string> {
  const out = new Set<string>();
  const root = folderInCol(col, folderId);
  if (!root) return out;
  const walk = (folders: HttpFolder[]) => {
    for (const f of folders) {
      out.add(f.id);
      walk(f.folders);
    }
  };
  walk(root.folders);
  return out;
}

function requestNameFromUrl(url: string): string {
  try {
    const u = new URL(url.includes("{{") ? "https://example.com" : url);
    const path = u.pathname.split("/").filter(Boolean).pop();
    return path || "Imported request";
  } catch {
    return "Imported request";
  }
}

export function CurlUiWorkspace({
  savedId,
  config,
  treeWidth,
  onTreeWidthChange,
  pluginVersion,
}: Props) {
  const loader = useLoader();
  const settings = useMemo(() => parseHttpSettings(config), [config]);
  const scope = ConnScope(savedId, "curlui");
  const [selectedId, setSelectedId] = useConnectionState<string | null>(
    scope,
    "selectedRequest",
    null,
  );
  const [expanded, setExpanded] = useConnectionState<Record<string, boolean>>(
    scope,
    "expanded",
    {},
  );
  // Open request tabs, as `collectionId:folderId:requestId` keys (the same
  // shape as `selectedId`, which points at the active tab). App-state-backed so
  // open tabs survive connection switches / remounts.
  const [openTabs, setOpenTabs] = useConnectionState<string[]>(scope, "openTabs", []);
  // Collections open as tabs too (key `col␟<id>`). The active tab is the
  // collection editor when `selectedId` is a collection key.
  const [collectionTab, setCollectionTab] = useState<CollectionTab>("env");

  const [collections, setCollections] = useState<CollectionsFile>(defaultCollectionsFile());
  // All environments + the active selection (`environments.json`). The active
  // environment's variables are the base `{{VAR}}` map for every request.
  const [envFile, setEnvFile] = useState<EnvironmentsFile>(defaultEnvironmentsFile());
  // Per-open-request unsaved edits ("drafts"), keyed by tab key. Holds the
  // edited state of any request tab with pending changes AND every scratch
  // request (a scratch request is always a draft with a `tmp␟` key until it is
  // explicitly saved into a collection). A key present here means the tab is
  // dirty. Autosaved to one temp file per request under `.rdb-drafts/`; the
  // owning collection file is never touched until an explicit Save. App-state-
  // backed so drafts survive connection switches; disk-backed so they survive
  // restart (see the hydrate/persist effects below).
  const [drafts, setDrafts] = useConnectionState<Record<string, HttpRequestItem>>(
    scope,
    "drafts",
    {},
  );
  const [loaded, setLoaded] = useState(false);
  const [headerRows, setHeaderRows] = useState<KvRow[]>([newKvRow()]);
  const [paramRows, setParamRows] = useState<KvRow[]>([newKvRow()]);
  const [formRows, setFormRows] = useState<KvRow[]>([newKvRow()]);
  const [reqTab, setReqTab] = useState<RequestTab>("params");
  const [resTab, setResTab] = useState<ResponseTab>("body");
  // Last response per open tab, keyed by the tab's request key, so switching
  // tabs keeps each request's result on screen. App-state-backed so responses
  // survive connection switches / remounts.
  const [responses, setResponses] = useConnectionState<Record<string, HttpResponse>>(
    scope,
    "responses",
    {},
  );
  // Script test results + console logs per open tab, keyed like `responses`.
  const [testResults, setTestResults] = useConnectionState<Record<string, TestRun>>(
    scope,
    "testResults",
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importTarget, setImportTarget] = useState<TreeTarget | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteTarget | null>(null);
  // A pending confirmation to close a tab with unsaved edits (its key + name +
  // whether it is a scratch request, which needs the Save-As picker to commit).
  const [closeConfirm, setCloseConfirm] = useState<{
    key: string;
    name: string;
    kind: "scratch" | "collection";
  } | null>(null);
  const [namePrompt, setNamePrompt] = useState<NamePrompt | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  // Save-scratch-to-collection dialog: which scratch request, the chosen
  // target collection / folder / name, and whether to close the tab after.
  const [saveDialog, setSaveDialog] = useState<{
    reqId: string;
    name: string;
    collectionId: string;
    folderId: string;
    closeAfterSave?: boolean;
  } | null>(null);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [panelWidth, setPanelWidth] = useState(treeWidth);
  const [editorHeight, setEditorHeight] = useState(220);

  // Drag-and-drop tree state (pointer-event based, like the connection list in
  // Sidebar.tsx — native HTML5 DnD is unreliable on WebKitGTK). `dragId` is the
  // item being dragged; `overRow` is the current drop target + which zone of it
  // (before/into/after) the pointer is in. `dragRef` holds live gesture
  // bookkeeping (kept in a ref so pointermove doesn't re-render every frame);
  // `dragging` only flips true past a 5px threshold so a plain click still
  // selects. `suppressClickRef` swallows the click that trails a completed drag.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overRow, setOverRow] = useState<{ id: string; zone: "before" | "into" | "after" } | null>(
    null,
  );
  const dragRef = useRef<{
    kind: "request" | "folder";
    id: string;
    colId: string;
    // The dragged request's parent folder, or the dragged folder's own parent
    // (null = collection root).
    folderId: string | null;
    startX: number;
    startY: number;
    dragging: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const envSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Per-draft debounce timers (keyed by tab key), a live mirror of `drafts` the
  // debounced writers read, and the session-save debounce.
  const draftSaveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const draftsRef = useRef(drafts);
  const sessionSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Flips true once the open-tabs session has been hydrated (or hydration was
  // skipped because tabs are already live in-session), gating the session-save
  // effect so an empty pre-hydration state can't overwrite the saved session.
  const [sessionReady, setSessionReady] = useState(false);
  const treeResize = useResizable({
    width: panelWidth,
    min: TREE_MIN,
    max: TREE_MAX,
    onChange: setPanelWidth,
    onCommit: onTreeWidthChange,
  });
  const editorResize = useResizable({
    width: editorHeight,
    min: EDITOR_MIN,
    max: EDITOR_MAX,
    onChange: setEditorHeight,
    onCommit: setEditorHeight,
    axis: "y",
  });

  // The active environment supplies the base `{{VAR}}` map for every request.
  const activeEnv = useMemo(
    () => envFile.environments.find((e) => e.id === envFile.activeId) ?? null,
    [envFile],
  );
  const env = activeEnv?.variables ?? {};

  // Resolve the active tab (`selectedId`) to its live entity once. Everything
  // downstream branches on `activeTab.kind`; the request-specific aliases below
  // are derived from it so the existing handlers need no changes.
  type ActiveTab =
    | {
        kind: "request";
        sel: SelectedRequest | null;
        request: HttpRequestItem;
        collection: HttpCollection | null;
        scratch: boolean;
      }
    | { kind: "collection"; collection: HttpCollection }
    | { kind: "folder"; collectionId: string; folderId: string; folder: HttpFolder }
    | { kind: "environment"; environment: HttpEnvironment };
  const activeTab = useMemo((): ActiveTab | null => {
    if (!selectedId) return null;
    const colId = collectionIdFromTab(selectedId);
    if (colId) {
      const col = collections.collections.find((c) => c.id === colId);
      return col ? { kind: "collection", collection: col } : null;
    }
    const envId = environmentIdFromTab(selectedId);
    if (envId) {
      const e = envFile.environments.find((x) => x.id === envId);
      return e ? { kind: "environment", environment: e } : null;
    }
    const tmpId = tmpIdFromTab(selectedId);
    if (tmpId) {
      // A scratch request lives only as a draft (keyed by its `tmp␟` tab key).
      const req = drafts[selectedId];
      return req
        ? { kind: "request", sel: null, request: req, collection: null, scratch: true }
        : null;
    }
    const folRef = folderRefFromTab(selectedId);
    if (folRef) {
      const fol = findFolder(collections, folRef.collectionId, folRef.folderId);
      return fol ? { kind: "folder", ...folRef, folder: fol } : null;
    }
    const sel = parseKey(selectedId);
    const committed = sel ? findRequest(collections, sel) : null;
    if (!sel || !committed) return null;
    // Prefer the draft (unsaved edits) over the committed request when present.
    const req = drafts[selectedId] ?? committed;
    const collection = collections.collections.find((c) => c.id === sel.collectionId) ?? null;
    return { kind: "request", sel, request: req, collection, scratch: false };
  }, [collections, envFile, drafts, selectedId]);

  const selected = activeTab?.kind === "request" ? activeTab.sel : null;
  const activeRequest = activeTab?.kind === "request" ? activeTab.request : null;
  const activeIsScratch = activeTab?.kind === "request" && activeTab.scratch;
  // The collection that owns the active request — used to inherit env/headers/
  // auth when sending or copying as curl.
  const activeRequestCollection = activeTab?.kind === "request" ? activeTab.collection : null;

  // Effective env for the active request: active-environment variables
  // overridden by the owning collection's variables (read-only; shown in the
  // request's Env tab).
  const effectiveEnv = useMemo(
    () =>
      activeRequestCollection?.env
        ? { ...(activeEnv?.variables ?? {}), ...activeRequestCollection.env }
        : (activeEnv?.variables ?? {}),
    [activeEnv, activeRequestCollection],
  );

  const response = selectedId ? (responses[selectedId] ?? null) : null;
  const testRun = selectedId ? (testResults[selectedId] ?? null) : null;

  // Resolve open tab keys to live requests/collections, dropping any whose
  // target was deleted. Keeps the rendered strip in sync with the tree.
  const tabs = useMemo(() => {
    type Tab =
      | {
          key: string;
          kind: "request";
          name: string;
          method: string;
          scratch?: boolean;
          dirty?: boolean;
        }
      | { key: string; kind: "collection"; name: string }
      | { key: string; kind: "folder"; name: string }
      | { key: string; kind: "environment"; name: string };
    return openTabs
      .map((key): Tab | null => {
        const colId = collectionIdFromTab(key);
        if (colId) {
          const col = collections.collections.find((c) => c.id === colId);
          return col ? { key, kind: "collection", name: col.name } : null;
        }
        const envId = environmentIdFromTab(key);
        if (envId) {
          const e = envFile.environments.find((x) => x.id === envId);
          return e ? { key, kind: "environment", name: e.name } : null;
        }
        const tmpId = tmpIdFromTab(key);
        if (tmpId) {
          const req = drafts[key];
          return req
            ? { key, kind: "request", name: req.name, method: req.method, scratch: true, dirty: true }
            : null;
        }
        const folRef = folderRefFromTab(key);
        if (folRef) {
          const fol = findFolder(collections, folRef.collectionId, folRef.folderId);
          return fol ? { key, kind: "folder", name: fol.name } : null;
        }
        const sel = parseKey(key);
        const committed = sel ? findRequest(collections, sel) : null;
        if (!committed) return null;
        // Show the draft's name/method when the tab has unsaved edits.
        const req = drafts[key] ?? committed;
        return { key, kind: "request", name: req.name, method: req.method, dirty: key in drafts };
      })
      .filter((t): t is Tab => !!t);
  }, [openTabs, collections, envFile, drafts]);

  const persist = useCallback(
    (data: CollectionsFile) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        saveCurlFiles(savedId, collectionsToFiles(data)).catch((e) => setError(errString(e)));
      }, 400);
    },
    [savedId],
  );

  const setCollectionsAndSave = useCallback(
    (updater: (prev: CollectionsFile) => CollectionsFile) => {
      setCollections((prev) => {
        const next = updater(prev);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const persistEnv = useCallback(
    (data: EnvironmentsFile) => {
      if (envSaveTimer.current) clearTimeout(envSaveTimer.current);
      envSaveTimer.current = setTimeout(() => {
        saveEnvironments(savedId, data).catch((e) => setError(errString(e)));
      }, 400);
    },
    [savedId],
  );

  const setEnvAndSave = useCallback(
    (updater: (prev: EnvironmentsFile) => EnvironmentsFile) => {
      setEnvFile((prev) => {
        const next = updater(prev);
        persistEnv(next);
        return next;
      });
    },
    [persistEnv],
  );

  // Keep a live mirror of `drafts` for the debounced draft writers to read.
  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  // Flush any pending debounced draft writes on unmount / profile switch, so an
  // edit made just before closing the workspace isn't lost inside the debounce.
  useEffect(() => {
    const timers = draftSaveTimers.current;
    return () => {
      for (const key of Object.keys(timers)) {
        clearTimeout(timers[key]);
        delete timers[key];
        const request = draftsRef.current[key];
        if (!request) continue;
        const kind = tmpIdFromTab(key) ? "scratch" : "collection";
        saveDraft(savedId, { version: 1, key, kind, request }).catch(() => {});
      }
    };
  }, [savedId]);

  // Debounced autosave of a single request's draft file. Reads the current
  // draft from `draftsRef` at fire time so bursts of edits collapse to one write.
  const scheduleDraftSave = useCallback(
    (key: string) => {
      const timers = draftSaveTimers.current;
      if (timers[key]) clearTimeout(timers[key]);
      timers[key] = setTimeout(() => {
        delete timers[key];
        const request = draftsRef.current[key];
        if (!request) return;
        const kind = tmpIdFromTab(key) ? "scratch" : "collection";
        saveDraft(savedId, { version: 1, key, kind, request }).catch((e) =>
          setError(errString(e)),
        );
      }, 300);
    },
    [savedId],
  );

  useEffect(() => {
    loadCurlFiles(savedId)
      .then((files) => {
        if (files.length > 0) {
          setCollections(filesToCollections(files));
        } else {
          const defaults = defaultCollectionsFile();
          setCollections(defaults);
          return saveCurlFiles(savedId, collectionsToFiles(defaults));
        }
      })
      .catch((e) => setError(errString(e)))
      .finally(() => setLoaded(true));
  }, [savedId]);

  useEffect(() => {
    loadEnvironments(savedId)
      .then(setEnvFile)
      .catch((e) => setError(errString(e)));
  }, [savedId]);

  // Hydrate open tabs + per-request drafts from disk so open requests survive a
  // restart. Runs once per profile, and only when there are no live in-session
  // tabs (a connection re-open within the same app session keeps its tabs) so
  // it never clobbers unsaved in-memory work.
  useEffect(() => {
    setSessionReady(false);
    if (openTabs.length > 0) {
      setSessionReady(true);
      return;
    }
    let cancelled = false;
    Promise.all([loadDrafts(savedId), loadCurlSession(savedId)])
      .then(([draftList, session]) => {
        if (cancelled) return;
        if (draftList.length > 0) {
          const map: Record<string, HttpRequestItem> = {};
          for (const d of draftList) map[d.key] = d.request;
          setDrafts(map);
        }
        if (session) {
          setOpenTabs(session.openTabs);
          setSelectedId(session.selectedId);
          setExpanded(session.expanded);
        }
      })
      .catch((e) => setError(errString(e)))
      .finally(() => {
        if (!cancelled) setSessionReady(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedId]);

  // Debounced persistence of the open-tabs session. Persists only resolvable
  // tab keys (mirroring the render-time filter in `tabs`), gated on hydration +
  // collections load so a transient empty state can't wipe the saved session.
  useEffect(() => {
    if (!sessionReady || !loaded) return;
    if (sessionSaveTimer.current) clearTimeout(sessionSaveTimer.current);
    sessionSaveTimer.current = setTimeout(() => {
      saveCurlSession(savedId, {
        version: 1,
        openTabs: tabs.map((t) => t.key),
        selectedId,
        expanded,
      }).catch((e) => setError(errString(e)));
    }, 300);
  }, [tabs, selectedId, expanded, sessionReady, loaded, savedId]);

  useEffect(() => {
    if (activeRequest) {
      setHeaderRows(headersToRows(activeRequest.headers));
      setParamRows(splitUrl(activeRequest.url).params);
      setFormRows(formToRows(activeRequest.body_kind === "form" ? activeRequest.body : ""));
    }
  }, [activeRequest?.id]);

  function toggleExpanded(key: string) {
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  }

  function selectRequest(collectionId: string, folderId: string | null, requestId: string) {
    const key = `${collectionId}:${folderId ?? ""}:${requestId}`;
    setOpenTabs((tabs) => (tabs.includes(key) ? tabs : [...tabs, key]));
    setSelectedId(key);
    setError(null);
  }

  function selectCollection(collectionId: string) {
    const key = collectionTabKey(collectionId);
    setOpenTabs((tabs) => (tabs.includes(key) ? tabs : [...tabs, key]));
    setSelectedId(key);
    setError(null);
  }

  function patchCollection(collectionId: string, patch: Partial<HttpCollection>) {
    setCollectionsAndSave((data) => ({
      ...data,
      collections: data.collections.map((c) => (c.id === collectionId ? { ...c, ...patch } : c)),
    }));
  }

  function selectFolder(collectionId: string, folderId: string) {
    const key = folderTabKey(collectionId, folderId);
    setOpenTabs((tabs) => (tabs.includes(key) ? tabs : [...tabs, key]));
    setSelectedId(key);
    setError(null);
  }

  function patchFolder(collectionId: string, folderId: string, patch: Partial<HttpFolder>) {
    setCollectionsAndSave((data) => updateFolder(data, collectionId, folderId, patch));
  }

  function selectEnvironment(environmentId: string) {
    const key = environmentTabKey(environmentId);
    setOpenTabs((tabs) => (tabs.includes(key) ? tabs : [...tabs, key]));
    setSelectedId(key);
    setError(null);
  }

  function patchEnvironment(environmentId: string, patch: Partial<HttpEnvironment>) {
    setEnvAndSave((data) => ({
      ...data,
      environments: data.environments.map((e) => (e.id === environmentId ? { ...e, ...patch } : e)),
    }));
  }

  function addEnvironment(name: string) {
    const e = newEnvironment(name);
    // First environment created becomes active automatically.
    setEnvAndSave((data) => ({
      ...data,
      environments: [...data.environments, e],
      activeId: data.activeId ?? e.id,
    }));
    selectEnvironment(e.id);
  }

  function setActiveEnvironment(environmentId: string | null) {
    setEnvAndSave((data) => ({ ...data, activeId: environmentId }));
  }

  function deleteEnvironment(environmentId: string) {
    setEnvAndSave((data) => ({
      ...data,
      environments: data.environments.filter((e) => e.id !== environmentId),
      activeId: data.activeId === environmentId ? null : data.activeId,
    }));
  }

  function closeTab(key: string) {
    setOpenTabs((tabs) => {
      const idx = tabs.indexOf(key);
      const next = tabs.filter((t) => t !== key);
      // If the closed tab was active, focus a neighbor (prefer the one to its
      // right, falling back to the left, then nothing).
      if (key === selectedId) {
        const fallback = next[idx] ?? next[idx - 1] ?? null;
        setSelectedId(fallback);
      }
      return next;
    });
    setResponses((r) => {
      if (!(key in r)) return r;
      const next = { ...r };
      delete next[key];
      return next;
    });
    // Drop any unsaved draft for the closed tab (covers discard-on-close and
    // closing a scratch request, whose only home is its draft).
    const draft = drafts[key];
    if (draft) {
      deleteDraft(savedId, draft.id).catch((e) => setError(errString(e)));
      setDrafts((d) => {
        if (!(key in d)) return d;
        const next = { ...d };
        delete next[key];
        return next;
      });
    }
  }

  /** User-initiated close (✕ / middle-click): if the tab has unsaved edits,
   *  prompt to save first (closing would otherwise discard them). Clean tabs
   *  close immediately. */
  function requestCloseTab(key: string) {
    const draft = drafts[key];
    if (draft) {
      setCloseConfirm({
        key,
        name: draft.name,
        kind: tmpIdFromTab(key) ? "scratch" : "collection",
      });
    } else {
      closeTab(key);
    }
  }

  function patchActive(patch: Partial<HttpRequestItem>) {
    if (!selectedId) return;
    const key = selectedId;
    setDrafts((d) => {
      // Seed the draft from the committed request on the first edit; scratch
      // requests always already have a draft entry.
      const base = d[key] ?? (selected ? findRequest(collections, selected) : null);
      if (!base) return d;
      return { ...d, [key]: { ...base, ...patch } };
    });
    scheduleDraftSave(key);
  }

  function onHeaderRowsChange(rows: KvRow[]) {
    setHeaderRows(rows);
    patchActive({ headers: rowsToHeaders(rows) });
  }

  function onParamRowsChange(rows: KvRow[]) {
    setParamRows(rows);
    if (!activeRequest) return;
    const base = splitUrl(activeRequest.url).base;
    patchActive({ url: joinUrl(base, rows) });
  }

  function onFormRowsChange(rows: KvRow[]) {
    setFormRows(rows);
    patchActive({ body: rowsToForm(rows) });
  }

  function patchAuth(patch: Partial<Auth>) {
    if (!activeRequest) return;
    const current = activeRequest.auth ?? defaultAuth();
    patchActive({ auth: { ...current, ...patch } });
  }

  function openNamePrompt(prompt: NamePrompt) {
    setNameDraft(
      prompt.kind === "collection"
        ? "New collection"
        : prompt.kind === "environment"
          ? "New environment"
          : "New folder",
    );
    setNamePrompt(prompt);
  }

  function confirmName() {
    const name = nameDraft.trim();
    if (!namePrompt || !name) return;
    if (namePrompt.kind === "collection") {
      addCollection(name);
    } else if (namePrompt.kind === "environment") {
      addEnvironment(name);
    } else {
      addFolder(namePrompt.target, name);
    }
    setNamePrompt(null);
    setNameDraft("");
  }

  function addCollection(name: string) {
    const col: HttpCollection = {
      id: genId(),
      name,
      folders: [],
      requests: [],
    };
    setCollectionsAndSave((data) => ({
      ...data,
      collections: [...data.collections, col],
    }));
    setExpanded((e) => ({ ...e, [`col:${col.id}`]: true }));
  }

  function addFolder(target: TreeTarget, name: string) {
    const folder: HttpFolder = {
      id: genId(),
      name,
      folders: [],
      requests: [],
    };
    setCollectionsAndSave((data) => {
      const next = structuredClone(data);
      const col = next.collections.find((c) => c.id === target.collectionId);
      if (!col) return data;
      if (target.kind === "collection") {
        col.folders.push(folder);
      } else {
        const walk = (folders: HttpFolder[]): boolean => {
          for (const f of folders) {
            if (f.id === target.folderId) {
              f.folders.push(folder);
              return true;
            }
            if (walk(f.folders)) return true;
          }
          return false;
        };
        walk(col.folders);
      }
      return next;
    });
    // Expand the new folder and, when nesting, its parent so it's visible.
    setExpanded((e) => ({
      ...e,
      [`folder:${folder.id}`]: true,
      ...(target.kind === "folder" ? { [`folder:${target.folderId}`]: true } : {}),
    }));
  }

  function addRequest(target: TreeTarget) {
    const req = newRequest();
    setCollectionsAndSave((data) => insertRequest(data, target, req));
    const folderId = target.kind === "folder" ? target.folderId : null;
    selectRequest(target.collectionId, folderId, req.id);
  }

  /** Open a new scratch request as a tab (a draft, not in any collection). */
  function addScratchRequest() {
    const req = newRequest("Untitled");
    const key = tmpTabKey(req.id);
    setDrafts((d) => ({ ...d, [key]: req }));
    saveDraft(savedId, { version: 1, key, kind: "scratch", request: req }).catch((e) =>
      setError(errString(e)),
    );
    setOpenTabs((tabs) => [...tabs, key]);
    setSelectedId(key);
    setError(null);
  }

  /** Open the "save scratch request to a collection" dialog, defaulting the
   *  target to the first collection and the name to the request's own. When
   *  `closeAfterSave` is set the tab is closed once the save completes (used by
   *  the close-with-unsaved-changes prompt). */
  function openSaveDialog(req: HttpRequestItem, closeAfterSave = false) {
    setSaveDialog({
      reqId: req.id,
      name: req.name === "Untitled" ? "" : req.name,
      collectionId: collections.collections[0]?.id ?? "",
      folderId: "",
      closeAfterSave,
    });
  }

  /** Commit the scratch request into the chosen collection/folder (an explicit
   *  save — the only place a scratch draft reaches a collection file), re-keying
   *  its open tab from `tmp␟<id>` to the real request key (response preserved)
   *  and dropping its now-committed draft. */
  function confirmSave() {
    if (!saveDialog) return;
    const { reqId, collectionId, folderId, closeAfterSave } = saveDialog;
    const name = saveDialog.name.trim();
    if (!collectionId || !name) return;
    const oldKey = tmpTabKey(reqId);
    const req = drafts[oldKey];
    if (!req) return;

    const saved = { ...req, name };
    const target: TreeTarget = folderId
      ? { kind: "folder", collectionId, folderId }
      : { kind: "collection", collectionId };
    setCollectionsAndSave((data) => insertRequest(data, target, saved));

    const newKey = `${collectionId}:${folderId}:${reqId}`;
    setOpenTabs((tabs) => tabs.map((k) => (k === oldKey ? newKey : k)));
    setResponses((r) => {
      if (!(oldKey in r)) return r;
      const next = { ...r };
      next[newKey] = next[oldKey];
      delete next[oldKey];
      return next;
    });
    setSelectedId(newKey);
    // The committed request now backs the tab: drop the draft (file + entry).
    deleteDraft(savedId, reqId).catch((e) => setError(errString(e)));
    setDrafts((d) => {
      if (!(oldKey in d)) return d;
      const next = { ...d };
      delete next[oldKey];
      return next;
    });

    // Reveal the saved request in the tree.
    setExpanded((e) => ({
      ...e,
      [`col:${collectionId}`]: true,
      ...(folderId ? { [`folder:${folderId}`]: true } : {}),
    }));
    setSaveDialog(null);
    if (closeAfterSave) closeTab(newKey);
  }

  /** Commit a specific tab's draft to its collection file and clear the draft.
   *  Returns "needs-dialog" for a scratch draft (which must go through the
   *  Save-As picker to pick a collection/name), "noop" when there is nothing to
   *  save, else "saved". */
  function saveDraftForKey(key: string): "saved" | "needs-dialog" | "noop" {
    const draft = drafts[key];
    if (!draft) return "noop";
    if (tmpIdFromTab(key)) return "needs-dialog";
    const sel = parseKey(key);
    if (!sel) return "noop";
    setCollectionsAndSave((data) => updateRequest(data, sel, draft));
    deleteDraft(savedId, draft.id).catch((e) => setError(errString(e)));
    setDrafts((d) => {
      if (!(key in d)) return d;
      const next = { ...d };
      delete next[key];
      return next;
    });
    return "saved";
  }

  /** Explicit save of the active request (Save button / Cmd+S). A scratch
   *  request opens the Save-As picker; otherwise the draft is committed
   *  in place. No-op when there are no unsaved edits. */
  function saveActive() {
    if (!selectedId) return;
    if (saveDraftForKey(selectedId) === "needs-dialog" && activeRequest) {
      openSaveDialog(activeRequest);
    }
  }


  function persistScriptVars(
    environment: Record<string, string>,
    collection: HttpCollection | null,
    collectionVariables: Record<string, string>,
  ) {
    if (activeEnv && !sameRecord(environment, activeEnv.variables)) {
      patchEnvironment(activeEnv.id, { variables: environment });
    }
    if (collection && !sameRecord(collectionVariables, collection.env ?? {})) {
      patchCollection(collection.id, { env: collectionVariables });
    }
  }

  async function onSend() {
    if (!activeRequest || !selectedId) return;
    const key = selectedId;
    const collection = activeRequestCollection;
    setError(null);
    setResTab("body");
    loader.show({ scope: "workspace", message: "Sending…" });

    // State threaded across every script phase (a script's writes are visible
    // to later phases and, for the request, to the send itself).
    let environment: Record<string, string> = { ...(activeEnv?.variables ?? {}) };
    let collectionVariables: Record<string, string> = { ...(collection?.env ?? {}) };
    let variables: Record<string, string> = {};
    let scriptReq: ScriptRequest = {
      method: activeRequest.method,
      url: activeRequest.url,
      headers: { ...activeRequest.headers },
      body: activeRequest.body ?? null,
    };
    const tests: TestResult[] = [];
    const logs: LogLine[] = [];
    let scriptError: string | undefined;

    const runPhase = async (source: string | undefined, response?: ScriptResponse) => {
      if (!source || !source.trim()) return;
      const outcome = await runScript(source, {
        request: scriptReq,
        response,
        environment,
        collectionVariables,
        variables,
      });
      environment = outcome.environment;
      collectionVariables = outcome.collectionVariables;
      variables = outcome.variables;
      scriptReq = outcome.request;
      tests.push(...outcome.tests);
      logs.push(...outcome.logs);
      if (outcome.error) scriptError = outcome.error;
    };

    const storeRun = () => {
      if (tests.length || logs.length || scriptError) {
        setTestResults((t) => ({ ...t, [key]: { tests, logs, error: scriptError } }));
      } else {
        setTestResults((t) => {
          if (!(key in t)) return t;
          const next = { ...t };
          delete next[key];
          return next;
        });
      }
    };

    try {
      // Pre-request scripts: collection then request.
      await runPhase(collection?.preScript);
      await runPhase(activeRequest.preScript);
      persistScriptVars(environment, collection, collectionVariables);

      // A pre-request script error aborts the send.
      if (scriptError) {
        setError(`Pre-request script: ${scriptError}`);
        storeRun();
        if (tests.length) setResTab("tests");
        return;
      }

      // Apply pre-request request mutations onto a clone, then interpolate with
      // an env that includes script-set vars (local > collection > environment)
      // so `interpolate` resolves anything a script just set. The collection's
      // own env is folded in here, so pass it stripped to buildSendable.
      const mutated: HttpRequestItem = {
        ...activeRequest,
        method: scriptReq.method,
        url: scriptReq.url,
        headers: scriptReq.headers,
        body: scriptReq.body,
      };
      const finalEnv = { ...environment, ...collectionVariables, ...variables };
      const effCollection = collection ? { ...collection, env: undefined } : undefined;
      const res = await sendHttpRequest(
        buildSendable(mutated, finalEnv, effCollection, pluginVersion),
        settings,
      );
      setResponses((r) => ({ ...r, [key]: res }));

      // Post-response (test) scripts: request then collection.
      const scriptResponse: ScriptResponse = {
        code: res.status,
        status: res.status_text,
        headers: res.headers,
        body: res.body,
        responseTime: res.elapsed_ms,
      };
      scriptError = undefined;
      await runPhase(activeRequest.postScript, scriptResponse);
      await runPhase(collection?.postScript, scriptResponse);
      persistScriptVars(environment, collection, collectionVariables);

      storeRun();
      if (scriptError) setError(`Test script: ${scriptError}`);
      if (tests.length) setResTab("tests");
    } catch (e) {
      setError(errString(e));
    } finally {
      loader.hide();
    }
  }

  function onEditorKeyDown(e: ReactKeyboardEvent) {
    // Ctrl/Cmd+Enter sends the request from anywhere in the editor.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      onSend();
    }
    // Ctrl/Cmd+S saves the active request's unsaved edits to its collection.
    if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      saveActive();
    }
  }

  async function onCopyCurl() {
    if (!activeRequest) return;
    try {
      await navigator.clipboard.writeText(
        buildCurl(
          buildSendable(activeRequest, env, activeRequestCollection ?? undefined, pluginVersion),
        ),
      );
      setCopiedCurl(true);
      setTimeout(() => setCopiedCurl(false), 1500);
    } catch (e) {
      setError(errString(e));
    }
  }

  /** When a curl command is pasted into the URL bar, parse it and fill the
   *  whole request (method/url/headers/body) instead of dropping the raw text
   *  into the URL field. Plain URLs paste normally (handler returns early). */
  async function onUrlPaste(e: ReactClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text");
    if (!/^\s*curl\b/i.test(text)) return; // not a curl command — paste as-is
    e.preventDefault();
    setError(null);
    loader.show({ scope: "workspace", message: "Parsing curl…" });
    try {
      const parsed = parseCurl(text.trim());
      patchActive({
        method: parsed.method,
        url: parsed.url,
        headers: parsed.headers,
        body: parsed.body ?? "",
        body_kind: (parsed.body_kind as BodyKind) || "none",
        parts: parsed.parts,
      });
      setHeaderRows(headersToRows(parsed.headers));
      setParamRows(splitUrl(parsed.url).params);
      setFormRows(formToRows(parsed.body_kind === "form" ? (parsed.body ?? "") : ""));
    } catch (err) {
      setError(errString(err));
    } finally {
      loader.hide();
    }
  }

  async function onImport() {
    if (!importTarget || !importText.trim()) return;
    setError(null);
    loader.show({ scope: "workspace", message: "Parsing curl…" });
    try {
      const parsed = parseCurl(importText.trim());
      const req = newRequest(requestNameFromUrl(parsed.url));
      req.method = parsed.method;
      req.url = parsed.url;
      req.headers = parsed.headers;
      req.body = parsed.body ?? "";
      req.body_kind = (parsed.body_kind as BodyKind) || "none";
      req.parts = parsed.parts;
      setCollectionsAndSave((data) => insertRequest(data, importTarget, req));
      const folderId = importTarget.kind === "folder" ? importTarget.folderId : null;
      selectRequest(importTarget.collectionId, folderId, req.id);
      setImportOpen(false);
      setImportText("");
    } catch (e) {
      setError(errString(e));
    } finally {
      loader.hide();
    }
  }

  /** Export a collection to a user-chosen file as v2.1 collection JSON (the same
   *  format the workspace stores internally, so it re-imports cleanly here and
   *  in other v2.1-compatible tools). */
  async function onExportCollection(collectionId: string) {
    const col = collections.collections.find((c) => c.id === collectionId);
    if (!col) return;
    setError(null);
    try {
      const path = await saveFileDialog({
        defaultPath: collectionFileName(col),
        filters: [{ name: "Collection", extensions: ["json"] }],
      });
      if (!path) return; // user cancelled the save dialog
      await writeTextFile(path, collectionToJson(col));
    } catch (e) {
      setError(errString(e));
    }
  }

  /** Import a v2.1 collection file as a new top-level collection. */
  async function onImportCollection() {
    setError(null);
    try {
      const path = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "Collection", extensions: ["json"] }],
      });
      if (typeof path !== "string") return; // user cancelled
      const text = await readTextFile(path);
      const col = collectionFromJson(text);
      setCollectionsAndSave((data) => ({ ...data, collections: [...data.collections, col] }));
      setExpanded((e) => ({ ...e, [`col:${col.id}`]: true }));
      selectCollection(col.id);
    } catch (e) {
      setError(errString(e));
    }
  }

  /** Close every open tab/response whose key references `id` (a collection or
   *  folder id). Request keys are `colId:folderId:reqId`, collection keys
   *  `col␟<id>`, folder keys `fol␟<colId>␟<folderId>` — `id` appears as a
   *  segment in all of them, so a segment match catches each. */
  function closeTabsReferencing(id: string) {
    for (const key of [...openTabs]) {
      if (key.split(/[:␟]/).includes(id)) closeTab(key);
    }
  }

  function confirmDelete() {
    if (!deleteConfirm) return;
    const target = deleteConfirm;
    if (target.kind === "request") {
      deleteSelectedRequest();
    } else if (target.kind === "folder") {
      deleteFolder(target.collectionId, target.folderId);
      closeTabsReferencing(target.folderId);
    } else if (target.kind === "environment") {
      deleteEnvironment(target.environmentId);
      closeTabsReferencing(target.environmentId);
    } else {
      deleteCollection(target.collectionId);
      closeTabsReferencing(target.collectionId);
    }
    setDeleteConfirm(null);
  }

  function deleteSelectedRequest() {
    if (!selected) return;
    setCollectionsAndSave((data) => {
      const next = structuredClone(data);
      const col = next.collections.find((c) => c.id === selected.collectionId);
      if (!col) return data;
      const remove = (reqs: HttpRequestItem[]) => {
        const i = reqs.findIndex((r) => r.id === selected.requestId);
        if (i >= 0) reqs.splice(i, 1);
      };
      if (!selected.folderId) {
        remove(col.requests);
      } else {
        const walk = (folders: HttpFolder[]): boolean => {
          for (const f of folders) {
            if (f.id === selected.folderId) {
              remove(f.requests);
              return true;
            }
            if (walk(f.folders)) return true;
          }
          return false;
        };
        walk(col.folders);
      }
      return next;
    });
    if (selectedId) closeTab(selectedId);
  }

  function deleteCollection(collectionId: string) {
    setCollectionsAndSave((data) => ({
      ...data,
      collections: data.collections.filter((c) => c.id !== collectionId),
    }));
  }

  function deleteFolder(collectionId: string, folderId: string) {
    setCollectionsAndSave((data) => {
      const next = structuredClone(data);
      const col = next.collections.find((c) => c.id === collectionId);
      if (!col) return data;
      const remove = (folders: HttpFolder[]): boolean => {
        const i = folders.findIndex((f) => f.id === folderId);
        if (i >= 0) {
          folders.splice(i, 1);
          return true;
        }
        for (const f of folders) {
          if (remove(f.folders)) return true;
        }
        return false;
      };
      remove(col.folders);
      return next;
    });
  }

  // --- Drag-and-drop: hit-testing, drop resolution, and the move itself ------

  /** A resolved drop: which container array to land in (`destFolderId` null =
   *  collection root), and — when reordering — the sibling to splice relative to
   *  (`after` chooses before/after). No `siblingId` means append. */
  type DropOp = { destFolderId: string | null; siblingId?: string; after?: boolean };
  type DragState = NonNullable<typeof dragRef.current>;

  /** The nearest draggable/droppable tree row under a viewport point. */
  function treeRowAt(x: number, y: number): HTMLElement | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return el?.closest<HTMLElement>(".curlui-tree-request, .curlui-tree-row") ?? null;
  }

  /** Resolve the drop under the pointer for the given drag, or null when the
   *  drop is not allowed (cross-collection, onto itself, or a folder cycle). */
  function resolveDrop(
    st: DragState,
    x: number,
    y: number,
  ): { over: { id: string; zone: "before" | "into" | "after" }; op: DropOp } | null {
    const row = treeRowAt(x, y);
    if (!row) return null;
    const d = row.dataset;
    // Same-collection guard: reject any drop outside the drag's own collection.
    if (d.colId !== st.colId) return null;
    const tKind = d.treeKind;
    const tId = d.treeId;
    if (!tKind || !tId) return null;
    const tParent = d.parentFolderId || null;
    const rect = row.getBoundingClientRect();
    const frac = rect.height > 0 ? (y - rect.top) / rect.height : 0.5;

    if (st.kind === "request") {
      if (tKind === "request") {
        if (tId === st.id) return null; // onto itself — no-op
        const after = frac >= 0.5; // 2-zone before/after among the target's siblings
        return {
          over: { id: tId, zone: after ? "after" : "before" },
          op: { destFolderId: tParent, siblingId: tId, after },
        };
      }
      if (tKind === "folder") return { over: { id: tId, zone: "into" }, op: { destFolderId: tId } };
      // collection row
      return { over: { id: tId, zone: "into" }, op: { destFolderId: null } };
    }

    // Dragging a folder: reject dropping into itself or a descendant.
    const col = collections.collections.find((c) => c.id === st.colId);
    const desc = col ? folderDescendantIds(col, st.id) : new Set<string>();
    const cyclic = (dest: string | null) => dest !== null && (dest === st.id || desc.has(dest));

    if (tKind === "folder") {
      if (tId === st.id) return null;
      if (frac < 0.25) {
        if (cyclic(tParent)) return null;
        return { over: { id: tId, zone: "before" }, op: { destFolderId: tParent, siblingId: tId, after: false } };
      }
      if (frac > 0.75) {
        if (cyclic(tParent)) return null;
        return { over: { id: tId, zone: "after" }, op: { destFolderId: tParent, siblingId: tId, after: true } };
      }
      if (cyclic(tId)) return null; // middle zone: into the target folder
      return { over: { id: tId, zone: "into" }, op: { destFolderId: tId } };
    }
    if (tKind === "request") {
      if (cyclic(tParent)) return null;
      return { over: { id: tId, zone: "into" }, op: { destFolderId: tParent } };
    }
    // collection row
    return { over: { id: tId, zone: "into" }, op: { destFolderId: null } };
  }

  function onTreePointerDown(
    e: ReactPointerEvent,
    kind: "request" | "folder",
    id: string,
    colId: string,
    folderId: string | null,
  ) {
    if (e.button !== 0) return; // left button only
    // Clear any stale suppress flag from a prior drag whose trailing click
    // didn't land on a row's click handler (so a later plain click isn't eaten).
    suppressClickRef.current = false;
    // Don't start a drag from the expand toggle or the row's action buttons.
    if ((e.target as HTMLElement).closest(".curlui-tree-toggle, .curlui-tree-actions")) return;
    dragRef.current = { kind, id, colId, folderId, startX: e.clientX, startY: e.clientY, dragging: false };
  }

  function onTreePointerMove(e: ReactPointerEvent) {
    const st = dragRef.current;
    if (!st) return;
    if (!st.dragging) {
      if (Math.abs(e.clientX - st.startX) < 5 && Math.abs(e.clientY - st.startY) < 5) return;
      st.dragging = true;
      setDragId(st.id);
      // Route the rest of the gesture to this row even if the pointer strays.
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const r = resolveDrop(st, e.clientX, e.clientY);
    setOverRow(r ? r.over : null);
  }

  function onTreePointerUp(e: ReactPointerEvent) {
    const st = dragRef.current;
    dragRef.current = null;
    if (st?.dragging) {
      const r = resolveDrop(st, e.clientX, e.clientY);
      if (r) applyDrop(st, r.op);
      suppressClickRef.current = true; // don't let this gesture also select the row
    }
    setDragId(null);
    setOverRow(null);
  }

  /** Perform a resolved move: mutate the tree, then (for a request whose parent
   *  folder changed) re-key its open tab / response / test-run / draft state. */
  function applyDrop(st: DragState, op: DropOp) {
    setCollectionsAndSave((data) => {
      const next = structuredClone(data);
      const col = next.collections.find((c) => c.id === st.colId);
      if (!col) return data;
      if (st.kind === "request") {
        const node = detachRequestFromCol(col, st.id);
        if (!node) return data;
        const arr = requestsContainer(col, op.destFolderId);
        if (!arr) return data;
        if (op.siblingId == null) {
          arr.push(node);
        } else {
          const i = arr.findIndex((r) => r.id === op.siblingId);
          if (i < 0) arr.push(node);
          else arr.splice(i + (op.after ? 1 : 0), 0, node);
        }
      } else {
        const node = detachFolderFromCol(col, st.id);
        if (!node) return data;
        const arr = foldersContainer(col, op.destFolderId);
        if (!arr) return data;
        if (op.siblingId == null) {
          arr.push(node);
        } else {
          const i = arr.findIndex((f) => f.id === op.siblingId);
          if (i < 0) arr.push(node);
          else arr.splice(i + (op.after ? 1 : 0), 0, node);
        }
      }
      return next;
    });

    // A folder move within a collection changes no tab keys (keys encode
    // immediate-parent ids + colId, none of which change). A request move can
    // change its parent folder, so re-key its single tab across all state maps.
    if (st.kind === "request") {
      const oldKey = `${st.colId}:${st.folderId ?? ""}:${st.id}`;
      const newKey = `${st.colId}:${op.destFolderId ?? ""}:${st.id}`;
      if (oldKey !== newKey) {
        setOpenTabs((tabs) => tabs.map((k) => (k === oldKey ? newKey : k)));
        const remap = <T,>(m: Record<string, T>): Record<string, T> => {
          if (!(oldKey in m)) return m;
          const nextMap = { ...m };
          nextMap[newKey] = nextMap[oldKey];
          delete nextMap[oldKey];
          return nextMap;
        };
        setResponses(remap);
        setTestResults(remap);
        setDrafts((d) => {
          if (!(oldKey in d)) return d;
          const nextMap = { ...d };
          const request = nextMap[oldKey];
          nextMap[newKey] = request;
          delete nextMap[oldKey];
          // The draft file is named by request.id (unchanged), but stores its
          // tab key; rewrite it so a restart restores the draft at the new spot.
          saveDraft(savedId, { version: 1, key: newKey, kind: "collection", request }).catch((e) =>
            setError(errString(e)),
          );
          return nextMap;
        });
        setSelectedId((cur) => (cur === oldKey ? newKey : cur));
      }
      if (op.destFolderId) setExpanded((e) => ({ ...e, [`folder:${op.destFolderId}`]: true }));
    }
  }

  /** Drop-indicator class for a tree row/request given the current hover. */
  const overClass = (id: string) => (overRow?.id === id ? " drag-over-" + overRow.zone : "");

  function renderFolder(folder: HttpFolder, collectionId: string, parentFolderId: string | null, depth: number) {
    const key = `folder:${folder.id}`;
    const isOpen = expanded[key] ?? false;
    return (
      <div key={folder.id} className="curlui-tree-node">
        <div
          data-tree-kind="folder"
          data-tree-id={folder.id}
          data-col-id={collectionId}
          data-parent-folder-id={parentFolderId ?? ""}
          className={
            "curlui-tree-row" +
            (selectedId === folderTabKey(collectionId, folder.id) ? " active" : "") +
            (dragId === folder.id ? " dragging" : "") +
            overClass(folder.id)
          }
          style={{ paddingLeft: 22 + depth * 14 }}
          onPointerDown={(e) => onTreePointerDown(e, "folder", folder.id, collectionId, parentFolderId)}
          onPointerMove={onTreePointerMove}
          onPointerUp={onTreePointerUp}
        >
          <button type="button" className="curlui-tree-toggle" onClick={() => toggleExpanded(key)}>
            {isOpen ? "▾" : "▸"}
          </button>
          <span className="curlui-tree-folder-icon">📁</span>
          <button
            type="button"
            className="curlui-tree-label curlui-tree-col-label"
            title="Open folder settings"
            onClick={() => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false;
                return;
              }
              selectFolder(collectionId, folder.id);
            }}
          >
            {folder.name}
          </button>
          <span className="curlui-tree-actions">
            <button
              type="button"
              title="Add folder"
              onClick={() =>
                openNamePrompt({
                  kind: "folder",
                  target: { kind: "folder", collectionId, folderId: folder.id },
                })
              }
            >
              📁
            </button>
            <button
              type="button"
              title="Add request"
              onClick={() => addRequest({ kind: "folder", collectionId, folderId: folder.id })}
            >
              +
            </button>
            <button
              type="button"
              title="Import curl"
              onClick={() => {
                setImportTarget({
                  kind: "folder",
                  collectionId,
                  folderId: folder.id,
                });
                setImportOpen(true);
              }}
            >
              curl
            </button>
          </span>
        </div>
        {isOpen && (
          <div className="curlui-tree-children">
            {folder.requests.map((r) => renderRequest(r, collectionId, folder.id, depth + 1))}
            {folder.folders.map((f) => renderFolder(f, collectionId, folder.id, depth + 1))}
          </div>
        )}
      </div>
    );
  }

  function renderRequest(
    req: HttpRequestItem,
    collectionId: string,
    folderId: string | null,
    depth: number,
  ) {
    const selKey = `${collectionId}:${folderId ?? ""}:${req.id}`;
    const active = selectedId === selKey;
    return (
      <button
        key={req.id}
        type="button"
        data-tree-kind="request"
        data-tree-id={req.id}
        data-col-id={collectionId}
        data-parent-folder-id={folderId ?? ""}
        className={
          "curlui-tree-request" +
          (active ? " active" : "") +
          (dragId === req.id ? " dragging" : "") +
          overClass(req.id)
        }
        style={{ paddingLeft: 38 + depth * 14 }}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          selectRequest(collectionId, folderId, req.id);
        }}
        onPointerDown={(e) => onTreePointerDown(e, "request", req.id, collectionId, folderId)}
        onPointerMove={onTreePointerMove}
        onPointerUp={onTreePointerUp}
      >
        <span className={"curlui-req-method m-" + methodColor(req.method)}>{req.method}</span>
        <span className="curlui-req-name">{req.name}</span>
      </button>
    );
  }

  // const envEntries = Object.entries(env);

  return (
    <div className="workspace curlui-workspace">
      {/*<div className="workspace-header">*/}
      {/*  <span className="workspace-title">HTTP Client</span>*/}
      {/*  {envEntries.length > 0 && (*/}
      {/*    <span className="curlui-env-summary muted">*/}
      {/*      {envEntries.length} env variable{envEntries.length === 1 ? "" : "s"}*/}
      {/*    </span>*/}
      {/*  )}*/}
      {/*</div>*/}

      <div className="curlui-body">
        <aside className="curlui-tree" style={{ width: panelWidth }}>
          <div className="curlui-env-bar">
            <span className="curlui-env-bar-icon" title="Environment">
              🌱
            </span>
            <select
              className="curlui-env-select"
              value={envFile.activeId ?? ""}
              onChange={(e) => setActiveEnvironment(e.target.value || null)}
              title="Active environment"
            >
              <option value="">No environment</option>
              {envFile.environments.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
            {envFile.activeId && (
              <button
                type="button"
                className="curlui-env-edit"
                title="Edit active environment"
                onClick={() => selectEnvironment(envFile.activeId!)}
              >
                ✎
              </button>
            )}
            <button
              type="button"
              className="curlui-env-add"
              title="New environment"
              aria-label="New environment"
              onClick={() => openNamePrompt({ kind: "environment" })}
            >
              +
            </button>
          </div>
          {!loaded ? (
            <p className="muted">Loading…</p>
          ) : (
            collections.collections.map((col) => {
              const key = `col:${col.id}`;
              const isOpen = expanded[key] ?? true;
              return (
                <div key={col.id} className="curlui-tree-node">
                  <div
                    data-tree-kind="collection"
                    data-tree-id={col.id}
                    data-col-id={col.id}
                    className={
                      "curlui-tree-row curlui-tree-col" +
                      (selectedId === collectionTabKey(col.id) ? " active" : "") +
                      overClass(col.id)
                    }
                    style={{ paddingLeft: 8 }}
                  >
                    <button
                      type="button"
                      className="curlui-tree-toggle"
                      onClick={() => toggleExpanded(key)}
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                    <button
                      type="button"
                      className="curlui-tree-label curlui-tree-col-label"
                      title="Open collection settings"
                      onClick={() => selectCollection(col.id)}
                    >
                      {col.name}
                    </button>
                    <span className="curlui-tree-actions">
                      <button
                        type="button"
                        title="Add folder"
                        onClick={() =>
                          openNamePrompt({
                            kind: "folder",
                            target: { kind: "collection", collectionId: col.id },
                          })
                        }
                      >
                        📁
                      </button>
                      <button
                        type="button"
                        title="Add request"
                        onClick={() => addRequest({ kind: "collection", collectionId: col.id })}
                      >
                        +
                      </button>
                      <button
                        type="button"
                        title="Import curl"
                        onClick={() => {
                          setImportTarget({
                            kind: "collection",
                            collectionId: col.id,
                          });
                          setImportOpen(true);
                        }}
                      >
                        curl
                      </button>
                      <button
                        type="button"
                        title="Export collection"
                        onClick={() => onExportCollection(col.id)}
                      >
                        ⤓
                      </button>
                    </span>
                  </div>
                  {isOpen && (
                    <div className="curlui-tree-children">
                      {col.requests.map((r) => renderRequest(r, col.id, null, 0))}
                      {col.folders.map((f) => renderFolder(f, col.id, null, 0))}
                    </div>
                  )}
                </div>
              );
            })
          )}
          <div className="curlui-tree-fabs">
            <button
              type="button"
              className="curlui-tree-fab"
              title="Import collection"
              aria-label="Import collection"
              onClick={onImportCollection}
            >
              ⤒
            </button>
            <button
              type="button"
              className="curlui-tree-fab"
              title="New collection"
              aria-label="New collection"
              onClick={() => openNamePrompt({ kind: "collection" })}
            >
              +
            </button>
          </div>
        </aside>

        <div
          className="tree-resizer"
          onMouseDown={treeResize.onMouseDown}
          role="separator"
          aria-orientation="vertical"
        />

        <main className="curlui-main">
          {error && <div className="msg error">{error}</div>}

          <div className="curlui-req-tabs" role="tablist">
            {tabs.map((t) => (
              <div
                key={t.key}
                role="tab"
                aria-selected={t.key === selectedId}
                className={"curlui-req-tab" + (t.key === selectedId ? " active" : "")}
                onClick={() => setSelectedId(t.key)}
                onMouseDown={(e) => {
                  // Middle-click closes, like a browser tab.
                  if (e.button === 1) {
                    e.preventDefault();
                    requestCloseTab(t.key);
                  }
                }}
                title={t.name}
              >
                {t.kind === "collection" ? (
                  <span className="curlui-req-tab-icon">🗂</span>
                ) : t.kind === "folder" ? (
                  <span className="curlui-req-tab-icon">📁</span>
                ) : t.kind === "environment" ? (
                  <span className="curlui-req-tab-icon">🌱</span>
                ) : (
                  <span className={"curlui-req-tab-method m-" + methodColor(t.method)}>
                    {t.method}
                  </span>
                )}
                <span className="curlui-req-tab-name">{t.name}</span>
                {t.kind === "request" && t.dirty && (
                  <span
                    className="curlui-req-tab-unsaved"
                    title={
                      t.scratch
                        ? "Unsaved — Save to add it to a collection"
                        : "Unsaved changes — ⌘/Ctrl+S to save"
                    }
                  />
                )}
                <button
                  type="button"
                  className="curlui-req-tab-close"
                  title="Close tab"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    requestCloseTab(t.key);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
            <button
              type="button"
              className="curlui-req-tab-new"
              title="New request"
              aria-label="New request"
              onClick={addScratchRequest}
            >
              +
            </button>
          </div>

          {activeTab?.kind === "collection" ? (
            <CollectionEditor
              collection={activeTab.collection}
              baseEnv={env}
              tab={collectionTab}
              onTabChange={setCollectionTab}
              onPatch={(patch) => patchCollection(activeTab.collection.id, patch)}
              onExport={() => onExportCollection(activeTab.collection.id)}
              onDelete={() =>
                setDeleteConfirm({
                  kind: "collection",
                  collectionId: activeTab.collection.id,
                  name: activeTab.collection.name,
                })
              }
            />
          ) : activeTab?.kind === "environment" ? (
            <div className="curlui-collection">
              <div className="curlui-collection-head">
                <span className="curlui-collection-icon">🌱</span>
                <input
                  type="text"
                  className="curlui-req-name-input"
                  value={activeTab.environment.name}
                  onChange={(e) =>
                    patchEnvironment(activeTab.environment.id, {
                      name: e.target.value,
                    })
                  }
                />
                {envFile.activeId === activeTab.environment.id ? (
                  <span className="curlui-env-active-badge">Active</span>
                ) : (
                  <button
                    type="button"
                    title="Set as active environment"
                    onClick={() => setActiveEnvironment(activeTab.environment.id)}
                  >
                    Set active
                  </button>
                )}
                <button
                  type="button"
                  title="Delete environment"
                  onClick={() =>
                    setDeleteConfirm({
                      kind: "environment",
                      environmentId: activeTab.environment.id,
                      name: activeTab.environment.name,
                    })
                  }
                >
                  Delete
                </button>
              </div>
              <div className="curlui-tab-panel">
                <p className="muted curlui-collection-hint">
                  Variables in this environment. Use them as <code>{"{{NAME}}"}</code> in any
                  request when this environment is active.
                </p>
                <KvEditor
                  rows={headersToRows(activeTab.environment.variables)}
                  onChange={(rows) =>
                    patchEnvironment(activeTab.environment.id, {
                      variables: rowsToHeaders(rows),
                    })
                  }
                  keyPlaceholder="Variable"
                />
              </div>
            </div>
          ) : activeTab?.kind === "folder" ? (
            <div className="curlui-collection">
              <div className="curlui-collection-head">
                <span className="curlui-collection-icon">📁</span>
                <input
                  type="text"
                  className="curlui-req-name-input"
                  value={activeTab.folder.name}
                  onChange={(e) =>
                    patchFolder(activeTab.collectionId, activeTab.folderId, {
                      name: e.target.value,
                    })
                  }
                />
                <button
                  type="button"
                  title="Delete folder"
                  onClick={() =>
                    setDeleteConfirm({
                      kind: "folder",
                      collectionId: activeTab.collectionId,
                      folderId: activeTab.folderId,
                      name: activeTab.folder.name,
                    })
                  }
                >
                  Delete
                </button>
              </div>
            </div>
          ) : activeRequest ? (
            <div className="curlui-editor-pane" onKeyDown={onEditorKeyDown}>
              <div className="curlui-request-bar">
                <input
                  type="text"
                  className="curlui-req-name-input"
                  value={activeRequest.name}
                  onChange={(e) => patchActive({ name: e.target.value })}
                />
                <select
                  className={"curlui-method m-" + methodColor(activeRequest.method)}
                  value={activeRequest.method}
                  onChange={(e) => patchActive({ method: e.target.value })}
                >
                  {HTTP_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
                <input
                  type="text"
                  className="curlui-url-input"
                  placeholder="https://api.example.com/path or {{HOST}}/path or paste curl"
                  value={activeRequest.url}
                  onChange={(e) => {
                    patchActive({ url: e.target.value });
                    setParamRows(splitUrl(e.target.value).params);
                  }}
                  onPaste={onUrlPaste}
                />
                <button type="button" className="primary" onClick={onSend}>
                  Send
                </button>
                <button
                  type="button"
                  title={
                    activeIsScratch
                      ? "Save to a collection"
                      : "Save changes to the collection (⌘/Ctrl+S)"
                  }
                  disabled={selectedId ? !(selectedId in drafts) : true}
                  onClick={saveActive}
                >
                  Save
                </button>
                {!activeIsScratch && (
                  <button
                    type="button"
                    title="Delete request"
                    onClick={() =>
                      setDeleteConfirm({
                        kind: "request",
                        name: activeRequest.name,
                      })
                    }
                  >
                    Delete
                  </button>
                )}
                <button type="button" title="Copy as curl command" onClick={onCopyCurl}>
                  {copiedCurl ? "Copied!" : "</>"}
                </button>
              </div>

              <div className="curlui-editors" style={{ height: editorHeight }}>
                <div className="tabs">
                  <button
                    type="button"
                    className={"tab" + (reqTab === "env" ? " active" : "")}
                    onClick={() => setReqTab("env")}
                  >
                    Env
                    {Object.keys(effectiveEnv).length > 0 && (
                      <span className="tab-badge">{Object.keys(effectiveEnv).length}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={"tab" + (reqTab === "params" ? " active" : "")}
                    onClick={() => setReqTab("params")}
                  >
                    Params
                    {paramRows.some((r) => r.enabled && r.key.trim()) && (
                      <span className="tab-badge">
                        {paramRows.filter((r) => r.enabled && r.key.trim()).length}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={"tab" + (reqTab === "auth" ? " active" : "")}
                    onClick={() => setReqTab("auth")}
                  >
                    Auth
                    {!["inherit", "none"].includes(activeRequest.auth?.kind ?? "inherit") && (
                      <span className="tab-dot" />
                    )}
                  </button>
                  <button
                    type="button"
                    className={"tab" + (reqTab === "headers" ? " active" : "")}
                    onClick={() => setReqTab("headers")}
                  >
                    Headers
                    {headerRows.some((r) => r.enabled && r.key.trim()) && (
                      <span className="tab-badge">
                        {headerRows.filter((r) => r.enabled && r.key.trim()).length}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={"tab" + (reqTab === "body" ? " active" : "")}
                    onClick={() => setReqTab("body")}
                  >
                    Body
                    {activeRequest.body_kind !== "none" && <span className="tab-dot" />}
                  </button>
                  <button
                    type="button"
                    className={"tab" + (reqTab === "prescript" ? " active" : "")}
                    onClick={() => setReqTab("prescript")}
                  >
                    Pre-request
                    {activeRequest.preScript?.trim() && <span className="tab-dot" />}
                  </button>
                  <button
                    type="button"
                    className={"tab" + (reqTab === "tests" ? " active" : "")}
                    onClick={() => setReqTab("tests")}
                  >
                    Tests
                    {activeRequest.postScript?.trim() && <span className="tab-dot" />}
                  </button>
                </div>

                <div className="curlui-tab-panel">
                  {reqTab === "env" && (
                    <div className="curlui-env-tab">
                      {Object.keys(effectiveEnv).length === 0 ? (
                        <p className="muted">
                          No environment variables. Select or create an environment, or define
                          variables in a collection’s Variables tab, then use them as{" "}
                          <code>{"{{NAME}}"}</code>.
                        </p>
                      ) : (
                        <div className="curlui-env-chips">
                          {Object.entries(effectiveEnv).map(([k, v]) => (
                            <span key={k} className="curlui-env-chip" title={v}>
                              {k}={v.length > 24 ? v.slice(0, 24) + "…" : v}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {reqTab === "params" && (
                    <KvEditor
                      rows={paramRows}
                      onChange={onParamRowsChange}
                      keyPlaceholder="Parameter"
                    />
                  )}
                  {reqTab === "auth" && (
                    <AuthEditor
                      auth={activeRequest.auth ?? defaultAuth()}
                      onChange={patchAuth}
                      allowInherit
                    />
                  )}
                  {reqTab === "headers" && (
                    <div className="curlui-headers-tab">
                      <label className="curlui-inherit-toggle">
                        <input
                          type="checkbox"
                          checked={activeRequest.inheritHeaders !== false}
                          onChange={(e) => patchActive({ inheritHeaders: e.target.checked })}
                        />
                        Inherit headers from collection
                      </label>
                      {activeRequest.inheritHeaders !== false &&
                        activeRequestCollection?.headers &&
                        Object.keys(activeRequestCollection.headers).length > 0 && (
                          <div className="curlui-inherited-headers">
                            {Object.entries(activeRequestCollection.headers).map(([k, v]) => (
                              <div key={k} className="curlui-inherited-row">
                                <span className="curlui-inherited-key">{k}</span>
                                <span className="curlui-inherited-val">{v}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      <div className="curlui-auto-headers-label">Auto-generated headers</div>
                      <KvEditor
                        rows={autoHeaderRows(
                          headerRows.filter((r) => r.enabled).map((r) => r.key),
                          pluginVersion,
                        )}
                        onChange={() => {}}
                        disabled
                      />
                      <div className="curlui-auto-headers-label">Custom headers</div>
                      <KvEditor
                        rows={headerRows}
                        onChange={onHeaderRowsChange}
                        keyPlaceholder="Header"
                      />
                    </div>
                  )}
                  {reqTab === "body" && (
                    <div className="curlui-body-editor">
                      <select
                        className="curlui-body-kind"
                        value={activeRequest.body_kind}
                        onChange={(e) => {
                          const body_kind = e.target.value as BodyKind;
                          patchActive({ body_kind });
                          // Form shares the `body` string with text/json; rebuild
                          // its rows from whatever body is currently there.
                          if (body_kind === "form") {
                            setFormRows(formToRows(activeRequest.body));
                          }
                        }}
                      >
                        <option value="none">None</option>
                        <option value="json">JSON</option>
                        <option value="text">Text</option>
                        <option value="form">x-www-form-urlencoded</option>
                        <option value="multipart">Multipart (form-data)</option>
                      </select>
                      {activeRequest.body_kind !== "none" &&
                        (activeRequest.body_kind === "json" ? (
                          <ContentEditor
                            className="curlui-body-input"
                            contentType="application/json"
                            value={activeRequest.body ?? ""}
                            onChange={(body) => patchActive({ body })}
                            placeholder={'{\n  "key": "value"\n}'}
                          />
                        ) : activeRequest.body_kind === "multipart" ? (
                          <MultipartEditor
                            parts={activeRequest.parts ?? []}
                            onChange={(parts) => patchActive({ parts })}
                          />
                        ) : activeRequest.body_kind === "form" ? (
                          <KvEditor
                            rows={formRows}
                            onChange={onFormRowsChange}
                            valuePlaceholder="Value"
                          />
                        ) : (
                          <textarea
                            className="curlui-body-input"
                            value={activeRequest.body ?? ""}
                            onChange={(e) => patchActive({ body: e.target.value })}
                            spellCheck={false}
                          />
                        ))}
                    </div>
                  )}
                  {reqTab === "prescript" && (
                    <ScriptEditor
                      kind="pre"
                      value={activeRequest.preScript ?? ""}
                      onChange={(v) => patchActive({ preScript: v })}
                    />
                  )}
                  {reqTab === "tests" && (
                    <ScriptEditor
                      kind="post"
                      value={activeRequest.postScript ?? ""}
                      onChange={(v) => patchActive({ postScript: v })}
                    />
                  )}
                </div>
              </div>

              <div
                className="pane-resizer-y"
                onMouseDown={editorResize.onMouseDown}
                role="separator"
                aria-orientation="horizontal"
              />

              {response && (
                <div className="curlui-response">
                  <div className="curlui-response-meta">
                    <span className={"curlui-status s-" + statusClass(response.status)}>
                      {response.status} {response.status_text}
                    </span>
                    <span className="muted">{response.elapsed_ms} ms</span>
                    <span className="muted">{byteSize(response.body)}</span>
                  </div>
                  <div className="tabs">
                    <button
                      type="button"
                      className={"tab" + (resTab === "body" ? " active" : "")}
                      onClick={() => setResTab("body")}
                    >
                      Body
                    </button>
                    <button
                      type="button"
                      className={"tab" + (resTab === "headers" ? " active" : "")}
                      onClick={() => setResTab("headers")}
                    >
                      Headers
                      <span className="tab-badge">{Object.keys(response.headers).length}</span>
                    </button>
                    {testRun && (
                      <button
                        type="button"
                        className={"tab" + (resTab === "tests" ? " active" : "")}
                        onClick={() => setResTab("tests")}
                      >
                        Test Results
                        {testRun.tests.length > 0 && (
                          <span
                            className={
                              "tab-badge" + (testRun.tests.some((t) => !t.passed) ? " bad" : "")
                            }
                          >
                            {testRun.tests.filter((t) => t.passed).length}/{testRun.tests.length}
                          </span>
                        )}
                        {testRun.tests.length === 0 && testRun.error && <span className="tab-dot" />}
                      </button>
                    )}
                  </div>
                  <div className="curlui-tab-panel">
                    {resTab === "body" && (
                      <ContentEditor
                        readOnly
                        contentType={
                          response.body_encoding === "binary"
                            ? undefined
                            : headerValue(response.headers, "content-type")
                        }
                        value={response.body}
                        onChange={() => {}}
                      />
                    )}
                    {resTab === "headers" && (
                      <KvEditor
                        rows={Object.entries(response.headers).map(([k, v]) => newKvRow(k, v))}
                        onChange={() => {}}
                        disabled
                        disabledTitle=""
                      />
                    )}
                    {resTab === "tests" && testRun && <TestResultsView run={testRun} />}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="placeholder">
              Select a request from the collections tree, or click <strong>+</strong> above to start
              a new one.
            </div>
          )}
        </main>
      </div>

      {importOpen && (
        <Modal
          title="Import curl command"
          onClose={() => {
            setImportOpen(false);
            setImportText("");
          }}
        >
          <textarea
            className="curlui-import-text"
            rows={8}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder={
              "curl -X POST https://api.example.com -H 'Authorization: Bearer token' -d '{\"key\":\"value\"}'"
            }
            autoFocus
          />
          <div className="form-actions">
            <button
              type="button"
              onClick={() => {
                setImportOpen(false);
                setImportText("");
              }}
            >
              Cancel
            </button>
            <button type="button" className="primary" onClick={onImport}>
              Import
            </button>
          </div>
        </Modal>
      )}

      {deleteConfirm && (
        <ConfirmDialog
          title={`Delete ${deleteConfirm.kind}`}
          message={
            deleteConfirm.kind === "request" || deleteConfirm.kind === "environment"
              ? `Delete “${deleteConfirm.name}”?`
              : `Delete ${deleteConfirm.kind} “${deleteConfirm.name}” and everything inside it?`
          }
          confirmLabel="Delete"
          onConfirm={confirmDelete}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}

      {closeConfirm && (
        <Modal title="Save changes?" onClose={() => setCloseConfirm(null)}>
          <p>
            “{closeConfirm.name || "Untitled"}” has unsaved changes.
            {closeConfirm.kind === "scratch"
              ? " Save it to a collection before closing?"
              : " Save them to the collection before closing?"}
          </p>
          <div className="form-actions">
            <button onClick={() => setCloseConfirm(null)}>Cancel</button>
            <button
              className="danger"
              onClick={() => {
                closeTab(closeConfirm.key);
                setCloseConfirm(null);
              }}
            >
              Don’t Save
            </button>
            <button
              className="primary"
              onClick={() => {
                const { key, kind } = closeConfirm;
                setCloseConfirm(null);
                if (kind === "scratch") {
                  // Route through the Save-As picker, then close on confirm.
                  const draft = drafts[key];
                  if (draft) openSaveDialog(draft, true);
                } else {
                  saveDraftForKey(key);
                  closeTab(key);
                }
              }}
            >
              Save
            </button>
          </div>
        </Modal>
      )}

      {namePrompt && (
        <Modal
          title={
            namePrompt.kind === "collection"
              ? "New collection"
              : namePrompt.kind === "environment"
                ? "New environment"
                : "New folder"
          }
          onClose={() => setNamePrompt(null)}
        >
          <input
            type="text"
            className="curlui-name-input"
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") confirmName();
            }}
            placeholder={
              namePrompt.kind === "collection"
                ? "Collection name"
                : namePrompt.kind === "environment"
                  ? "Environment name"
                  : "Folder name"
            }
            autoFocus
          />
          <div className="form-actions">
            <button type="button" onClick={() => setNamePrompt(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={!nameDraft.trim()}
              onClick={confirmName}
            >
              Create
            </button>
          </div>
        </Modal>
      )}

      {saveDialog &&
        (() => {
          const col = collections.collections.find((c) => c.id === saveDialog.collectionId);
          const folders = col ? flattenFolders(col) : [];
          return (
            <Modal title="Save request to collection" onClose={() => setSaveDialog(null)}>
              <label className="curlui-save-field">
                <span className="field-label">Name</span>
                <input
                  type="text"
                  className="curlui-name-input"
                  value={saveDialog.name}
                  onChange={(e) => setSaveDialog((d) => d && { ...d, name: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmSave();
                  }}
                  placeholder="Request name"
                  autoFocus
                />
              </label>
              <label className="curlui-save-field">
                <span className="field-label">Collection</span>
                <select
                  value={saveDialog.collectionId}
                  onChange={(e) =>
                    setSaveDialog((d) => d && { ...d, collectionId: e.target.value, folderId: "" })
                  }
                >
                  {collections.collections.length === 0 && <option value="">No collections</option>}
                  {collections.collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="curlui-save-field">
                <span className="field-label">Folder</span>
                <select
                  value={saveDialog.folderId}
                  onChange={(e) => setSaveDialog((d) => d && { ...d, folderId: e.target.value })}
                  disabled={folders.length === 0}
                >
                  <option value="">(collection root)</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="form-actions">
                <button type="button" onClick={() => setSaveDialog(null)}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="primary"
                  disabled={!saveDialog.collectionId || !saveDialog.name.trim()}
                  onClick={confirmSave}
                >
                  Save
                </button>
              </div>
            </Modal>
          );
        })()}
    </div>
  );
}
