import { useEffect, useRef, useState } from "react";
import { EJSON } from "bson";
import { parseFilter, toJSString } from "mongodb-query-parser";
import { api, errString } from "../../api/api.ts";
import type { ConnectionId } from "../../api/api.ts";
import type { FindResult, MongoCollection } from "../../api/document.ts";
import type { WorkspaceFile } from "../../api/store.ts";
import {
  listWorkspaceFiles,
  saveWorkspaceFile,
  deleteWorkspaceFile,
} from "../../api/store.ts";
import { useResizable, TREE_MIN, TREE_MAX } from "../../useResizable";
import { ConnScope, useConnectionState } from "../../connectionState";
import { CodeEditorV2, type CodeEditorV2Handle } from "../CodeEditorV2.tsx";
import { ConfirmDialog } from "../Modal";
import { NavTree } from "./NavTree";
import { WorkspaceFileList } from "./WorkspaceFileList";

/** Saved query files use this extension (the editor holds a JSON find filter). */
const QUERY_EXT = "json";

/** Render a result document in MongoDB shell syntax (`ObjectId('...')`,
 * `ISODate('...')`, …). The backend sends documents as extended JSON
 * (`{"$oid":"..."}`); deserialize that back to BSON types, then stringify the
 * shell representation. Falls back to plain JSON so one odd document can't break
 * the whole result view. */
function formatDoc(doc: unknown): string {
  try {
    return (
      toJSString(EJSON.deserialize(doc as Record<string, unknown>), 2) ??
      JSON.stringify(doc, null, 2)
    );
  } catch {
    return JSON.stringify(doc, null, 2);
  }
}

interface Props {
  connectionId: ConnectionId;
  /** Stable saved-profile id; scopes session-preserved workspace state and the
   * saved query files to this profile. */
  savedId: string;
  /** Configured default database; opened automatically on connect when present
   * (and known to the server). Null when none is configured. */
  database: string | null;
  /** Initial width (px) of the tree panel, restored from per-connection config. */
  treeWidth: number;
  /** Called with the final width (px) when the user finishes dragging. */
  onTreeWidthChange: (width: number) => void;
}

export function MongodbWorkspace({
  connectionId,
  savedId,
  database,
  treeWidth,
  onTreeWidthChange,
}: Props) {
  // Tree panel width (px); restored from per-connection config, resizable.
  const [width, setWidth] = useState(treeWidth);
  const treeResize = useResizable({
    width,
    min: TREE_MIN,
    max: TREE_MAX,
    onChange: setWidth,
    onCommit: onTreeWidthChange,
  });
  // Session-preserved workspace state (see connectionState.ts): survives the
  // unmount a connection switch causes, keyed by the stable saved-profile id.
  const scope = ConnScope(savedId, "document");
  // Databases on the server (drive the picker) and the one currently selected.
  const [databases, setDatabases] = useConnectionState<string[]>(
    scope,
    "databases",
    [],
  );
  const [currentDatabase, setCurrentDatabase] = useConnectionState<
    string | null
  >(scope, "currentDatabase", null);
  // Collections cache keyed by database; only the current database's list shows.
  const [collections, setCollections] = useConnectionState<
    Record<string, MongoCollection[]>
  >(scope, "collections", {});
  // The expanded database node in the tree (its name), or null when collapsed.
  const [openDb, setOpenDb] = useConnectionState<string | null>(
    scope,
    "openDb",
    null,
  );
  // The selected collection (within the current database), or null.
  const [active, setActive] = useConnectionState<string | null>(
    scope,
    "active",
    null,
  );
  const [filter, setFilter] = useConnectionState(scope, "filter", "{}");
  const [limit, setLimit] = useConnectionState(scope, "limit", 50);
  const [result, setResult] = useConnectionState<FindResult | null>(
    scope,
    "result",
    null,
  );
  // Saved query files for this connection profile (the "Queries" section).
  const [queryFiles, setQueryFiles] = useState<WorkspaceFile[]>([]);
  // When non-null, the inline "new query file name" input is open with this draft.
  const [newQueryName, setNewQueryName] = useState<string | null>(null);
  // Name of the query file currently loaded in the editor (shown in its header).
  const [activeFile, setActiveFile] = useConnectionState<string | null>(
    scope,
    "activeFile",
    null,
  );
  // Name of the query file awaiting inline delete confirmation, if any.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const filterEditorRef = useRef<CodeEditorV2Handle>(null);

  // Whether a database was already selected on mount (state restored from a
  // connection switch-back); if so, don't auto-select and clobber it.
  const restoredOnMount = useRef(currentDatabase !== null);

  useEffect(() => {
    api
      .docListDatabases(connectionId)
      .then((dbs) => {
        setDatabases(dbs);
        if (restoredOnMount.current) return;
        // Prefer the configured default DB; otherwise, with a single database,
        // select it so the user doesn't have to. With several and no default,
        // leave the picker on its "Select a database…" prompt.
        let pick: string | null = null;
        if (database && dbs.includes(database)) pick = database;
        else if (dbs.length === 1) pick = dbs[0];
        if (pick) {
          setCurrentDatabase(pick);
          setOpenDb(pick);
          void loadCollections(pick);
        }
      })
      .catch((e) => setError(errString(e)));
  }, [connectionId]);

  // Load this profile's saved query files.
  useEffect(() => {
    listWorkspaceFiles(savedId, QUERY_EXT)
      .then(setQueryFiles)
      .catch(() => setQueryFiles([]));
  }, [savedId]);

  // Auto-save edits to the active query file, debounced so we don't write on
  // every keystroke. No-op when nothing's loaded or content already matches disk.
  useEffect(() => {
    if (!activeFile) return;
    const stored = queryFiles.find((f) => f.name === activeFile);
    if (!stored || stored.content === filter) return;
    const t = setTimeout(() => {
      saveWorkspaceFile(savedId, activeFile, filter, QUERY_EXT)
        .then(() =>
          setQueryFiles((prev) =>
            prev.map((f) =>
              f.name === activeFile ? { ...f, content: filter } : f,
            ),
          ),
        )
        .catch((e) => setError(errString(e)));
    }, 800);
    return () => clearTimeout(t);
  }, [filter, activeFile, queryFiles, savedId]);

  async function loadCollections(db: string) {
    try {
      const c = await api.docListCollections(connectionId, db);
      setCollections((m) => ({ ...m, [db]: c }));
    } catch (e) {
      setError(errString(e));
    }
  }

  /** Switch the picker to another database and load its collections. Everything
   * shown belonged to the previous database, so the selection/result reset. */
  async function switchDatabase(db: string) {
    if (db === currentDatabase) return;
    setCurrentDatabase(db);
    setOpenDb(db);
    setActive(null);
    setResult(null);
    if (!collections[db]) await loadCollections(db);
  }

  /** Reload the database list and the current database's collections from the
   * server, picking up anything created since the tree was last loaded. */
  async function refreshTree() {
    setBusy(true);
    setError(null);
    try {
      const dbs = await api.docListDatabases(connectionId);
      setDatabases(dbs);
      if (currentDatabase && dbs.includes(currentDatabase)) {
        const c = await api.docListCollections(connectionId, currentDatabase);
        setCollections((m) => ({ ...m, [currentDatabase]: c }));
      } else {
        setCurrentDatabase(null);
        setOpenDb(null);
        setCollections({});
        setActive(null);
        setResult(null);
      }
    } catch (e) {
      setError(errString(e));
    } finally {
      setBusy(false);
    }
  }

  async function pick(coll: string) {
    setActive(coll);
    await runFind(coll);
  }

  async function runFind(coll?: string) {
    const db = currentDatabase;
    const target = coll ?? active;
    if (!db || !target) return;
    // Parse the filter box (which accepts MongoDB shell syntax like
    // `{ _id: ObjectId('...') }`) into BSON, then send canonical extended JSON
    // the backend can interpret. An empty box means "no filter".
    let filterArg: string | null = null;
    const text = filter.trim();
    if (text) {
      let parsed: unknown;
      try {
        parsed = parseFilter(text);
      } catch (e) {
        setError("Invalid filter: " + errString(e));
        return;
      }
      filterArg = EJSON.stringify(parsed as Record<string, unknown>, {
        relaxed: false,
      });
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api.docFind(connectionId, db, target, filterArg, limit);
      setResult(r);
    } catch (e) {
      setError(errString(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  /** Save the current editor filter under `name` (from the inline name input). */
  async function saveCurrentQuery() {
    const name = newQueryName?.trim();
    if (!name) {
      setNewQueryName(null);
      return;
    }
    if (queryFiles.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
      setError(`A query named "${name}" already exists.`);
      return;
    }
    try {
      await saveWorkspaceFile(savedId, name, filter, QUERY_EXT);
      setQueryFiles(await listWorkspaceFiles(savedId, QUERY_EXT));
      setNewQueryName(null);
      setActiveFile(name);
      setError(null);
    } catch (e) {
      setError(errString(e));
    }
  }

  /** Delete a saved query file (after inline confirmation). */
  async function removeQueryFile(name: string) {
    setConfirmDelete(null);
    try {
      await deleteWorkspaceFile(savedId, name, QUERY_EXT);
      setQueryFiles(await listWorkspaceFiles(savedId, QUERY_EXT));
      if (activeFile === name) setActiveFile(null);
    } catch (e) {
      setError(errString(e));
    }
  }

  /** Open a saved query file: load its filter into the editor. */
  function loadQueryFile(file: WorkspaceFile) {
    setFilter(file.content);
    setActiveFile(file.name);
  }

  const fileDirty =
    !!activeFile &&
    queryFiles.find((f) => f.name === activeFile)?.content !== filter;
  const shownCollections = currentDatabase
    ? [...(collections[currentDatabase] ?? [])].sort((a, b) =>
        a.name.localeCompare(b.name),
      )
    : [];

  return (
    <div className="workspace">
      <div className="tree" style={{ width }}>
        <div className="tree-top">
          <WorkspaceFileList
            files={queryFiles}
            activeFile={activeFile}
            newName={newQueryName}
            onToggleAdd={() => setNewQueryName((n) => (n === null ? "" : null))}
            onNewNameChange={setNewQueryName}
            onSave={saveCurrentQuery}
            onCancelAdd={() => setNewQueryName(null)}
            onLoad={loadQueryFile}
            onRequestDelete={setConfirmDelete}
            label="Queries"
            ext={QUERY_EXT}
            addTitle="Save current filter as a query"
            emptyText="No saved queries."
          />
          <div className="tree-dbselect">
            {databases.length > 0 && (
              <span className="field-label">Database</span>
            )}
            <div className="tree-db-row">
              {databases.length > 0 && (
                <select
                  value={currentDatabase ?? ""}
                  onChange={(e) => switchDatabase(e.target.value)}
                >
                  {currentDatabase === null && (
                    <option value="" disabled>
                      Select a database…
                    </option>
                  )}
                  {databases.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              )}
              <button
                className="tree-refresh"
                disabled={busy}
                title="Reload databases and collections"
                onClick={refreshTree}
              >
                ↻
              </button>
            </div>
          </div>
        </div>
        <NavTree
          groups={currentDatabase ? [currentDatabase] : []}
          items={
            currentDatabase
              ? { [currentDatabase]: shownCollections.map((c) => ({ name: c.name })) }
              : {}
          }
          openGroup={openDb}
          activeKey={
            active && currentDatabase ? currentDatabase + "." + active : null
          }
          onToggleGroup={(name) =>
            setOpenDb((o) => (o === name ? null : name))
          }
          onPickItem={(_db, name) => pick(name)}
          emptyText="Select a database."
        />
      </div>
      <div
        className="tree-resizer"
        onMouseDown={treeResize.onMouseDown}
        title="Drag to resize"
      />
      <div className="editor-pane">
        {activeFile && (
          <div className="editor-file">
            <span className="editor-file-name">
              {activeFile}.{QUERY_EXT}
            </span>
            {fileDirty && (
              <span className="editor-file-dirty" title="Auto-saving…">
                ●
              </span>
            )}
          </div>
        )}
        <div className="editor-code-pane" style={{ height: 160 }}>
          <CodeEditorV2
            handleRef={filterEditorRef}
            className="code"
            language="javascript"
            value={filter}
            onChange={setFilter}
            placeholder="{ }"
            lineWrapping
            keybindings={[{ key: "Mod-Enter", run: () => void runFind() }]}
          />
        </div>
        <div className="editor-toolbar">
          <label className="row">
            Limit{" "}
            <input
              type="number"
              min={1}
              value={limit}
              style={{ width: 80 }}
              onChange={(e) => setLimit(Number(e.target.value) || 1)}
            />
          </label>
          <button
            className="primary"
            disabled={busy || !active}
            onClick={() => runFind()}
          >
            Find
          </button>
          <span className="muted">
            {active && currentDatabase
              ? `${currentDatabase} / ${active}`
              : "Select a collection"}
          </span>
          {result && (
            <span className="status-line">
              {result.documents.length} doc(s) · {result.elapsed_ms} ms
            </span>
          )}
        </div>
        {error && <div className="status-line error">{error}</div>}
        {result && (
          <div className="result-scroll">
            {result.documents.map((d, i) => (
              <CodeEditorV2
                key={i}
                className="doc-card"
                language="javascript"
                value={formatDoc(d)}
                readOnly
                lineWrapping
              />
            ))}
          </div>
        )}
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title="Delete query"
          message={
            <>
              Delete{" "}
              <strong>
                {confirmDelete}.{QUERY_EXT}
              </strong>
              ? This can't be undone.
            </>
          }
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void removeQueryFile(confirmDelete)}
        />
      )}
    </div>
  );
}
