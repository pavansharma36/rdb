import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, errString } from "../../api/api.ts";
import type { ConnectionId } from "../../api/api.ts";
import {
  COLLECTIONS_EXT,
  COLLECTIONS_FILE,
  defaultCollectionsFile,
  HTTP_METHODS,
  newRequest,
  type BodyKind,
  type CollectionsFile,
  type HttpCollection,
  type HttpFolder,
  type HttpRequestItem,
  type HttpResponse,
} from "../../api/curlui.ts";
import {
  listWorkspaceFiles,
  saveWorkspaceFile,
  genId,
} from "../../api/store.ts";
import { ConfirmDialog, Modal } from "../Modal";
import { useLoader } from "../Loader";
import { useResizable, TREE_MIN, TREE_MAX } from "../../useResizable";
import { ConnScope, useConnectionState } from "../../connectionState";

interface Props {
  connectionId: ConnectionId;
  savedId: string;
  env: Record<string, string>;
  treeWidth: number;
  onTreeWidthChange: (width: number) => void;
}

type TreeTarget =
  | { kind: "collection"; collectionId: string }
  | { kind: "folder"; collectionId: string; folderId: string };

interface SelectedRequest {
  collectionId: string;
  folderId: string | null;
  requestId: string;
}

function parseCollections(raw: string): CollectionsFile {
  const parsed = JSON.parse(raw) as CollectionsFile;
  if (parsed.version !== 1 || !Array.isArray(parsed.collections)) {
    throw new Error("invalid collections file");
  }
  return parsed;
}

function headersToText(headers: Record<string, string>): string {
  return Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
}

function textToHeaders(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const val = trimmed.slice(idx + 1).trim();
    if (key) out[key] = val;
  }
  return out;
}

function findRequest(
  data: CollectionsFile,
  sel: SelectedRequest,
): HttpRequestItem | null {
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
  env,
  treeWidth,
  onTreeWidthChange,
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

  const [collections, setCollections] = useState<CollectionsFile>(
    defaultCollectionsFile(),
  );
  const [loaded, setLoaded] = useState(false);
  const [headersText, setHeadersText] = useState("");
  const [response, setResponse] = useState<HttpResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importTarget, setImportTarget] = useState<TreeTarget | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [panelWidth, setPanelWidth] = useState(treeWidth);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const treeResize = useResizable({
    width: panelWidth,
    min: TREE_MIN,
    max: TREE_MAX,
    onChange: setPanelWidth,
    onCommit: onTreeWidthChange,
  });

  const selected = useMemo((): SelectedRequest | null => {
    if (!selectedId) return null;
    const [collectionId, folderId, requestId] = selectedId.split(":");
    if (!collectionId || !requestId) return null;
    return {
      collectionId,
      folderId: folderId || null,
      requestId,
    };
  }, [selectedId]);

  const activeRequest = useMemo(() => {
    if (!selected) return null;
    return findRequest(collections, selected);
  }, [collections, selected]);

  const persist = useCallback((data: CollectionsFile) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveWorkspaceFile(
        savedId,
        COLLECTIONS_FILE,
        JSON.stringify(data, null, 2),
        COLLECTIONS_EXT,
      ).catch((e) => setError(errString(e)));
    }, 400);
  }, [savedId]);

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

  useEffect(() => {
    listWorkspaceFiles(savedId, COLLECTIONS_EXT)
      .then((files) => {
        const file = files.find((f) => f.name === COLLECTIONS_FILE);
        if (file) {
          setCollections(parseCollections(file.content));
        } else {
          const defaults = defaultCollectionsFile();
          setCollections(defaults);
          return saveWorkspaceFile(
            savedId,
            COLLECTIONS_FILE,
            JSON.stringify(defaults, null, 2),
            COLLECTIONS_EXT,
          );
        }
      })
      .catch((e) => setError(errString(e)))
      .finally(() => setLoaded(true));
  }, [savedId]);

  useEffect(() => {
    if (activeRequest) {
      setHeadersText(headersToText(activeRequest.headers));
    }
  }, [activeRequest?.id]);

  function toggleExpanded(key: string) {
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  }

  function selectRequest(
    collectionId: string,
    folderId: string | null,
    requestId: string,
  ) {
    setSelectedId(`${collectionId}:${folderId ?? ""}:${requestId}`);
    setResponse(null);
    setError(null);
  }

  function patchActive(patch: Partial<HttpRequestItem>) {
    if (!selected) return;
    setCollectionsAndSave((data) => updateRequest(data, selected, patch));
  }

  function addCollection() {
    const name = prompt("Collection name:", "New collection");
    if (!name?.trim()) return;
    const col: HttpCollection = {
      id: genId(),
      name: name.trim(),
      folders: [],
      requests: [],
    };
    setCollectionsAndSave((data) => ({
      ...data,
      collections: [...data.collections, col],
    }));
    setExpanded((e) => ({ ...e, [`col:${col.id}`]: true }));
  }

  function addFolder(target: TreeTarget) {
    const name = prompt("Folder name:", "New folder");
    if (!name?.trim()) return;
    const folder: HttpFolder = {
      id: genId(),
      name: name.trim(),
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

  async function onSend() {
    if (!activeRequest) return;
    setError(null);
    loader.show({ scope: "workspace", message: "Sending…" });
    try {
      const headers = textToHeaders(headersText);
      patchActive({ headers });
      const res = await api.httpSend(connectionId, {
        method: activeRequest.method,
        url: activeRequest.url,
        headers,
        body: activeRequest.body ?? "",
        body_kind: activeRequest.body_kind,
      });
      setResponse(res);
    } catch (e) {
      setError(errString(e));
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
      setCollectionsAndSave((data) => insertRequest(data, importTarget, req));
      const folderId =
        importTarget.kind === "folder" ? importTarget.folderId : null;
      selectRequest(importTarget.collectionId, folderId, req.id);
      setImportOpen(false);
      setImportText("");
    } catch (e) {
      setError(errString(e));
    } finally {
      loader.hide();
    }
  }

  function deleteSelected() {
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
    setSelectedId(null);
    setDeleteConfirm(null);
  }

  function renderFolder(
    folder: HttpFolder,
    collectionId: string,
    depth: number,
  ) {
    const key = `folder:${folder.id}`;
    const isOpen = expanded[key] ?? false;
    return (
      <div key={folder.id} className="curlui-tree-node">
        <div className="curlui-tree-row" style={{ paddingLeft: 8 + depth * 12 }}>
          <button
            type="button"
            className="curlui-tree-toggle"
            onClick={() => toggleExpanded(key)}
          >
            {isOpen ? "▾" : "▸"}
          </button>
          <span className="curlui-tree-label">{folder.name}</span>
          <span className="curlui-tree-actions">
            <button
              type="button"
              title="Add request"
              onClick={() =>
                addRequest({ kind: "folder", collectionId, folderId: folder.id })
              }
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
        style={{ paddingLeft: 24 + depth * 12 }}
        onClick={() => selectRequest(collectionId, folderId, req.id)}
      >
        <span className="curlui-req-method">{req.method}</span>
        <span className="curlui-req-name">{req.name}</span>
      </button>
    );
  }

  const envEntries = Object.entries(env);

  return (
    <div className="workspace curlui-workspace">
      <div className="workspace-header">
        <span className="workspace-title">HTTP Client</span>
        {envEntries.length > 0 && (
          <span className="curlui-env-summary muted">
            {envEntries.length} env variable{envEntries.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <div className="curlui-body">
        <aside className="curlui-tree" style={{ width: panelWidth }}>
          <div className="curlui-tree-toolbar">
            <button type="button" onClick={addCollection}>
              + Collection
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
                  <div className="curlui-tree-row">
                    <button
                      type="button"
                      className="curlui-tree-toggle"
                      onClick={() => toggleExpanded(key)}
                    >
                      {isOpen ? "▾" : "▸"}
                    </button>
                    <span className="curlui-tree-label">{col.name}</span>
                    <span className="curlui-tree-actions">
                      <button
                        type="button"
                        title="Add folder"
                        onClick={() =>
                          addFolder({ kind: "collection", collectionId: col.id })
                        }
                      >
                        📁
                      </button>
                      <button
                        type="button"
                        title="Add request"
                        onClick={() =>
                          addRequest({ kind: "collection", collectionId: col.id })
                        }
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
        </aside>

        <div
          className="tree-resizer"
          onMouseDown={treeResize.onMouseDown}
          role="separator"
          aria-orientation="vertical"
        />

        <main className="curlui-main">
          {error && <div className="msg error">{error}</div>}

          {activeRequest ? (
            <>
              <div className="curlui-request-bar">
                <input
                  type="text"
                  className="curlui-req-name-input"
                  value={activeRequest.name}
                  onChange={(e) => patchActive({ name: e.target.value })}
                />
                <select
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
                  placeholder="https://api.example.com/path or {{HOST}}/path"
                  value={activeRequest.url}
                  onChange={(e) => patchActive({ url: e.target.value })}
                />
                <button type="button" className="primary" onClick={onSend}>
                  Send
                </button>
                <button
                  type="button"
                  title="Delete request"
                  onClick={() => setDeleteConfirm(activeRequest.name)}
                >
                  Delete
                </button>
              </div>

              {envEntries.length > 0 && (
                <div className="curlui-env-panel">
                  <span className="field-label">Environment</span>
                  <div className="curlui-env-chips">
                    {envEntries.map(([k, v]) => (
                      <span key={k} className="curlui-env-chip" title={v}>
                        {k}={v.length > 24 ? v.slice(0, 24) + "…" : v}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="curlui-editors">
                <label className="field">
                  <span className="field-label">Headers</span>
                  <textarea
                    className="curlui-headers"
                    value={headersText}
                    onChange={(e) => setHeadersText(e.target.value)}
                    onBlur={() => patchActive({ headers: textToHeaders(headersText) })}
                    placeholder={"Content-Type: application/json\nAuthorization: Bearer {{TOKEN}}"}
                    rows={4}
                  />
                </label>
                <label className="field">
                  <span className="field-label">Body</span>
                  <select
                    value={activeRequest.body_kind}
                    onChange={(e) =>
                      patchActive({ body_kind: e.target.value as BodyKind })
                    }
                  >
                    <option value="none">None</option>
                    <option value="json">JSON</option>
                    <option value="text">Text</option>
                    <option value="form">Form</option>
                  </select>
                  {activeRequest.body_kind !== "none" && (
                    <textarea
                      className="curlui-body-input"
                      value={activeRequest.body ?? ""}
                      onChange={(e) => patchActive({ body: e.target.value })}
                      rows={8}
                      spellCheck={false}
                    />
                  )}
                </label>
              </div>

              {response && (
                <div className="curlui-response">
                  <div className="curlui-response-meta">
                    <span
                      className={
                        "curlui-status" +
                        (response.status >= 400 ? " error" : " ok")
                      }
                    >
                      {response.status} {response.status_text}
                    </span>
                    <span className="muted">{response.elapsed_ms} ms</span>
                  </div>
                  <details>
                    <summary>Response headers</summary>
                    <pre className="curlui-response-headers">
                      {Object.entries(response.headers)
                        .map(([k, v]) => `${k}: ${v}`)
                        .join("\n")}
                    </pre>
                  </details>
                  <pre className="curlui-response-body">{response.body}</pre>
                  <details>
                    <summary>As curl</summary>
                    <pre className="curlui-curl">{response.curl_command}</pre>
                  </details>
                </div>
              )}
            </>
          ) : (
            <div className="placeholder">
              Select or create a request from the collections tree.
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
            placeholder={"curl -X POST https://api.example.com -H 'Authorization: Bearer token' -d '{\"key\":\"value\"}'"}
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
          title="Delete request"
          message={`Delete “${deleteConfirm}”?`}
          confirmLabel="Delete"
          onConfirm={deleteSelected}
          onCancel={() => setDeleteConfirm(null)}
        />
      )}
    </div>
  );
}
