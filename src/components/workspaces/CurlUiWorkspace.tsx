import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { api, errString } from "../../api/api.ts";
import type { ConnectionId } from "../../api/api.ts";
import {
  buildCurl,
  buildSendable,
  collectionsToFiles,
  defaultAuth,
  defaultCollectionAuth,
  defaultCollectionsFile,
  defaultEnvironmentsFile,
  filesToCollections,
  formToRows,
  headersToRows,
  HTTP_METHODS,
  joinUrl,
  loadCurlFiles,
  loadEnvironments,
  methodColor,
  newEnvironment,
  newKvRow,
  newRequest,
  autoHeaderRows,
  rowsToForm,
  rowsToHeaders,
  saveCurlFiles,
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
import { genId } from "../../api/store.ts";
import { ConfirmDialog, Modal } from "../Modal";
import { KvEditor } from "../KvEditor";
import { MultipartEditor } from "../MultipartEditor";
import { ContentEditor } from "../ContentEditor";
import { useLoader } from "../Loader";
import { useResizable, TREE_MIN, TREE_MAX, EDITOR_MIN, EDITOR_MAX } from "../../useResizable";
import { ConnScope, useConnectionState } from "../../connectionState";

type RequestTab = "env" | "params" | "auth" | "headers" | "body";
type ResponseTab = "body" | "headers" | "curl";
type CollectionTab = "env" | "headers" | "auth";

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
}: {
  collection: HttpCollection;
  baseEnv: Record<string, string>;
  tab: CollectionTab;
  onTabChange: (t: CollectionTab) => void;
  onPatch: (patch: Partial<HttpCollection>) => void;
  onDelete: () => void;
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
        <button type="button" title="Delete collection" onClick={onDelete}>
          Delete
        </button>
      </div>
      <div className="curlui-tabs">
        <button
          type="button"
          className={"curlui-tab" + (tab === "env" ? " active" : "")}
          onClick={() => onTabChange("env")}
        >
          Variables
          {envCount > 0 && <span className="curlui-tab-badge">{envCount}</span>}
        </button>
        <button
          type="button"
          className={"curlui-tab" + (tab === "headers" ? " active" : "")}
          onClick={() => onTabChange("headers")}
        >
          Headers
          {headerCount > 0 && <span className="curlui-tab-badge">{headerCount}</span>}
        </button>
        <button
          type="button"
          className={"curlui-tab" + (tab === "auth" ? " active" : "")}
          onClick={() => onTabChange("auth")}
        >
          Auth
          {auth.kind !== "none" && <span className="curlui-tab-dot" />}
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
      </div>
    </div>
  );
}

interface Props {
  connectionId: ConnectionId;
  savedId: string;
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
  connectionId,
  savedId,
  treeWidth,
  onTreeWidthChange,
  pluginVersion,
}: Props) {
  const loader = useLoader();
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
  // Temporary ("scratch") requests created from the tab-strip `+`. App-state-
  // backed so they survive connection switches / remounts (session only — lost
  // on reload until saved into a collection). Keyed in `openTabs` as
  // `tmp␟<reqId>`.
  const [scratch, setScratch] = useConnectionState<HttpRequestItem[]>(scope, "scratch", []);
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
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importTarget, setImportTarget] = useState<TreeTarget | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DeleteTarget | null>(null);
  // A pending confirmation to close an unsaved scratch tab (its key + name).
  const [closeConfirm, setCloseConfirm] = useState<{
    key: string;
    name: string;
  } | null>(null);
  const [namePrompt, setNamePrompt] = useState<NamePrompt | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  // Save-scratch-to-collection dialog: which scratch request, and the chosen
  // target collection / folder / name.
  const [saveDialog, setSaveDialog] = useState<{
    reqId: string;
    name: string;
    collectionId: string;
    folderId: string;
  } | null>(null);
  const [copiedCurl, setCopiedCurl] = useState(false);
  const [panelWidth, setPanelWidth] = useState(treeWidth);
  const [editorHeight, setEditorHeight] = useState(220);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const envSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      const req = scratch.find((r) => r.id === tmpId);
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
    const req = sel ? findRequest(collections, sel) : null;
    if (!sel || !req) return null;
    const collection = collections.collections.find((c) => c.id === sel.collectionId) ?? null;
    return { kind: "request", sel, request: req, collection, scratch: false };
  }, [collections, envFile, scratch, selectedId]);

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

  // Resolve open tab keys to live requests/collections, dropping any whose
  // target was deleted. Keeps the rendered strip in sync with the tree.
  const tabs = useMemo(() => {
    type Tab =
      | { key: string; kind: "request"; name: string; method: string; scratch?: boolean }
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
          const req = scratch.find((r) => r.id === tmpId);
          return req
            ? { key, kind: "request", name: req.name, method: req.method, scratch: true }
            : null;
        }
        const folRef = folderRefFromTab(key);
        if (folRef) {
          const fol = findFolder(collections, folRef.collectionId, folRef.folderId);
          return fol ? { key, kind: "folder", name: fol.name } : null;
        }
        const sel = parseKey(key);
        const req = sel ? findRequest(collections, sel) : null;
        return req ? { key, kind: "request", name: req.name, method: req.method } : null;
      })
      .filter((t): t is Tab => !!t);
  }, [openTabs, collections, envFile, scratch]);

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
    // A scratch request only lives in memory — drop it when its tab closes.
    const tmpId = tmpIdFromTab(key);
    if (tmpId) {
      setScratch((list) => list.filter((r) => r.id !== tmpId));
    }
  }

  /** User-initiated close (✕ / middle-click): confirm first for an unsaved
   *  scratch tab, since closing it discards the request. Other tabs close
   *  immediately. */
  function requestCloseTab(key: string) {
    const tmpId = tmpIdFromTab(key);
    const req = tmpId ? scratch.find((r) => r.id === tmpId) : null;
    if (req) {
      setCloseConfirm({ key, name: req.name });
    } else {
      closeTab(key);
    }
  }

  function patchActive(patch: Partial<HttpRequestItem>) {
    const tmpId = selectedId ? tmpIdFromTab(selectedId) : null;
    if (tmpId) {
      setScratch((list) => list.map((r) => (r.id === tmpId ? { ...r, ...patch } : r)));
      return;
    }
    if (!selected) return;
    setCollectionsAndSave((data) => updateRequest(data, selected, patch));
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
    setExpanded((e) => ({ ...e, [`folder:${folder.id}`]: true }));
  }

  function addRequest(target: TreeTarget) {
    const req = newRequest();
    setCollectionsAndSave((data) => insertRequest(data, target, req));
    const folderId = target.kind === "folder" ? target.folderId : null;
    selectRequest(target.collectionId, folderId, req.id);
  }

  /** Open a new in-memory scratch request as a tab (not in any collection). */
  function addScratchRequest() {
    const req = newRequest("Untitled");
    const key = tmpTabKey(req.id);
    setScratch((list) => [...list, req]);
    setOpenTabs((tabs) => [...tabs, key]);
    setSelectedId(key);
    setError(null);
  }

  /** Open the "save scratch request to a collection" dialog, defaulting the
   *  target to the first collection and the name to the request's own. */
  function openSaveDialog(req: HttpRequestItem) {
    setSaveDialog({
      reqId: req.id,
      name: req.name === "Untitled" ? "" : req.name,
      collectionId: collections.collections[0]?.id ?? "",
      folderId: "",
    });
  }

  /** Move the scratch request into the chosen collection/folder, re-keying its
   *  open tab from `tmp␟<id>` to the real request key (response preserved). */
  function confirmSave() {
    if (!saveDialog) return;
    const { reqId, collectionId, folderId } = saveDialog;
    const name = saveDialog.name.trim();
    if (!collectionId || !name) return;
    const req = scratch.find((r) => r.id === reqId);
    if (!req) return;

    const saved = { ...req, name };
    const target: TreeTarget = folderId
      ? { kind: "folder", collectionId, folderId }
      : { kind: "collection", collectionId };
    setCollectionsAndSave((data) => insertRequest(data, target, saved));

    const oldKey = tmpTabKey(reqId);
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
    setScratch((list) => list.filter((r) => r.id !== reqId));

    // Reveal the saved request in the tree.
    setExpanded((e) => ({
      ...e,
      [`col:${collectionId}`]: true,
      ...(folderId ? { [`folder:${folderId}`]: true } : {}),
    }));
    setSaveDialog(null);
  }

  async function onSend() {
    if (!activeRequest || !selectedId) return;
    const key = selectedId;
    setError(null);
    setResTab("body");
    loader.show({ scope: "workspace", message: "Sending…" });
    try {
      const res = await api.httpSend(
        connectionId,
        buildSendable(activeRequest, env, activeRequestCollection ?? undefined, pluginVersion),
      );
      setResponses((r) => ({ ...r, [key]: res }));
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
      const parsed = await api.httpParseCurl(connectionId, text.trim());
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
      const parsed = await api.httpParseCurl(connectionId, importText.trim());
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

  function renderFolder(folder: HttpFolder, collectionId: string, depth: number) {
    const key = `folder:${folder.id}`;
    const isOpen = expanded[key] ?? false;
    return (
      <div key={folder.id} className="curlui-tree-node">
        <div
          className={
            "curlui-tree-row" +
            (selectedId === folderTabKey(collectionId, folder.id) ? " active" : "")
          }
          style={{ paddingLeft: 22 + depth * 14 }}
        >
          <button type="button" className="curlui-tree-toggle" onClick={() => toggleExpanded(key)}>
            {isOpen ? "▾" : "▸"}
          </button>
          <span className="curlui-tree-folder-icon">📁</span>
          <button
            type="button"
            className="curlui-tree-label curlui-tree-col-label"
            title="Open folder settings"
            onClick={() => selectFolder(collectionId, folder.id)}
          >
            {folder.name}
          </button>
          <span className="curlui-tree-actions">
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
            {folder.folders.map((f) => renderFolder(f, collectionId, depth + 1))}
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
        className={"curlui-tree-request" + (active ? " active" : "")}
        style={{ paddingLeft: 38 + depth * 14 }}
        onClick={() => selectRequest(collectionId, folderId, req.id)}
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
                    className={
                      "curlui-tree-row curlui-tree-col" +
                      (selectedId === collectionTabKey(col.id) ? " active" : "")
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
                    </span>
                  </div>
                  {isOpen && (
                    <div className="curlui-tree-children">
                      {col.requests.map((r) => renderRequest(r, col.id, null, 0))}
                      {col.folders.map((f) => renderFolder(f, col.id, 0))}
                    </div>
                  )}
                </div>
              );
            })
          )}
          <button
            type="button"
            className="curlui-tree-fab"
            title="New collection"
            aria-label="New collection"
            onClick={() => openNamePrompt({ kind: "collection" })}
          >
            +
          </button>
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
                {t.kind === "request" && t.scratch && (
                  <span
                    className="curlui-req-tab-unsaved"
                    title="Unsaved — Save to add it to a collection"
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
                {activeIsScratch ? (
                  <button
                    type="button"
                    title="Save to a collection"
                    onClick={() => openSaveDialog(activeRequest)}
                  >
                    Save
                  </button>
                ) : (
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
                <div className="curlui-tabs">
                  <button
                    type="button"
                    className={"curlui-tab" + (reqTab === "env" ? " active" : "")}
                    onClick={() => setReqTab("env")}
                  >
                    Env
                    {Object.keys(effectiveEnv).length > 0 && (
                      <span className="curlui-tab-badge">{Object.keys(effectiveEnv).length}</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={"curlui-tab" + (reqTab === "params" ? " active" : "")}
                    onClick={() => setReqTab("params")}
                  >
                    Params
                    {paramRows.some((r) => r.enabled && r.key.trim()) && (
                      <span className="curlui-tab-badge">
                        {paramRows.filter((r) => r.enabled && r.key.trim()).length}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={"curlui-tab" + (reqTab === "auth" ? " active" : "")}
                    onClick={() => setReqTab("auth")}
                  >
                    Auth
                    {!["inherit", "none"].includes(activeRequest.auth?.kind ?? "inherit") && (
                      <span className="curlui-tab-dot" />
                    )}
                  </button>
                  <button
                    type="button"
                    className={"curlui-tab" + (reqTab === "headers" ? " active" : "")}
                    onClick={() => setReqTab("headers")}
                  >
                    Headers
                    {headerRows.some((r) => r.enabled && r.key.trim()) && (
                      <span className="curlui-tab-badge">
                        {headerRows.filter((r) => r.enabled && r.key.trim()).length}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={"curlui-tab" + (reqTab === "body" ? " active" : "")}
                    onClick={() => setReqTab("body")}
                  >
                    Body
                    {activeRequest.body_kind !== "none" && <span className="curlui-tab-dot" />}
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
                  <div className="curlui-tabs">
                    <button
                      type="button"
                      className={"curlui-tab" + (resTab === "body" ? " active" : "")}
                      onClick={() => setResTab("body")}
                    >
                      Body
                    </button>
                    <button
                      type="button"
                      className={"curlui-tab" + (resTab === "headers" ? " active" : "")}
                      onClick={() => setResTab("headers")}
                    >
                      Headers
                      <span className="curlui-tab-badge">
                        {Object.keys(response.headers).length}
                      </span>
                    </button>
                    <button
                      type="button"
                      className={"curlui-tab" + (resTab === "curl" ? " active" : "")}
                      onClick={() => setResTab("curl")}
                    >
                      cURL
                    </button>
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
                    {resTab === "curl" && (
                      <pre className="curlui-curl">{response.curl_command}</pre>
                    )}
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
        <ConfirmDialog
          title="Close unsaved request"
          message={`“${closeConfirm.name || "Untitled"}” hasn’t been saved to a collection. Close and discard it?`}
          confirmLabel="Discard"
          onConfirm={() => {
            closeTab(closeConfirm.key);
            setCloseConfirm(null);
          }}
          onCancel={() => setCloseConfirm(null)}
        />
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
