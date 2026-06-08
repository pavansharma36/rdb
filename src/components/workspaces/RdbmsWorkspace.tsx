import { useEffect, useRef, useState } from "react";
import { api, errString } from "../../api";
import type {
  Column,
  ColumnValue,
  ConnectionId,
  Index,
  RowChanges,
  Schema,
  Table,
  QueryResult,
} from "../../api";
import type { WorkspaceFile } from "../../store";
import {
  listWorkspaceFiles,
  saveWorkspaceFile,
  deleteWorkspaceFile,
} from "../../store";
import { ConfirmDialog } from "../Modal";
import { useResizable, TREE_MIN, TREE_MAX } from "../../useResizable";
import { normalizeQuotes, parseSingleTable, statementAtCursor } from "./rdbms/sql";
import {
  castType,
  displayType,
  fmt,
  fmtEditable,
  isJsonType,
  isLargeType,
} from "./rdbms/columns";
import { CellEditorModal } from "./rdbms/CellEditorModal";
import { SchemaTree } from "./rdbms/SchemaTree";
import { WorkspaceFileList } from "./WorkspaceFileList";
import { StructureTable } from "./rdbms/StructureTable";

interface Props {
  connectionId: ConnectionId;
  /** Stable saved-profile id; scopes the saved SQL snippets to this profile. */
  savedId: string;
  /** The database this connection was opened against; the initial selection for
   * the database picker. Null when the profile didn't specify one. */
  database?: string | null;
  /** Initial width (px) of the tree panel, restored from per-connection config. */
  treeWidth: number;
  /** Called with the final width (px) when the user finishes dragging. */
  onTreeWidthChange: (width: number) => void;
}

/** Identifies the table currently being browsed, enabling inline editing.
 * Null while viewing the result of an ad-hoc query (which we can't safely
 * map back to a single table). */
interface EditContext {
  schema: string;
  table: string;
  columns: Column[];
}

interface EditingCell {
  row: number;
  col: number;
}

/** Staged edits to existing rows: rowIndex -> columnName -> new value. */
type Edits = Record<number, Record<string, string | null>>;

/** Rows fetched when browsing a table from the tree. */
const BROWSE_LIMIT = 100;

export function RdbmsWorkspace({
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
  const [schemas, setSchemas] = useState<Schema[]>([]);
  // Databases on the server (empty when the backend doesn't support listing,
  // which hides the picker) and the one currently selected.
  const [databases, setDatabases] = useState<string[]>([]);
  const [currentDatabase, setCurrentDatabase] = useState<string | null>(
    database ?? null,
  );
  const [openSchema, setOpenSchema] = useState<string | null>(null);
  const [tables, setTables] = useState<Record<string, Table[]>>({});
  // Saved SQL files for this connection profile (the "SQL files" section).
  const [sqlFiles, setSqlFiles] = useState<WorkspaceFile[]>([]);
  // When non-null, the inline "new SQL file name" input is open with this draft.
  const [newSqlName, setNewSqlName] = useState<string | null>(null);
  // Name of the SQL file currently loaded in the editor (shown in its header).
  const [activeFile, setActiveFile] = useState<string | null>(null);
  // Name of the SQL file awaiting inline delete confirmation, if any.
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Which view of a browsed table is shown: the data grid, its column
  // structure, or a generated CREATE TABLE statement.
  const [tableView, setTableView] = useState<"data" | "structure" | "ddl">(
    "data",
  );
  // Generated DDL for the browsed table (lazily fetched from the plugin for the
  // DDL view); null until loaded for the current table.
  const [ddlText, setDdlText] = useState<string | null>(null);
  // Indexes for the browsed table (lazily fetched for the structure view);
  // null until loaded for the current table.
  const [indexes, setIndexes] = useState<Index[] | null>(null);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [sql, setSql] = useState("select 1;");
  // Results of the last run: one entry per statement in a multi-statement
  // script. `activeResult` selects which one the grid shows.
  const [results, setResults] = useState<QueryResult[]>([]);
  const [activeResult, setActiveResult] = useState(0);
  const [edit, setEdit] = useState<EditContext | null>(null);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [draft, setDraft] = useState("");
  // Large values (text/json/xml) edit in a modal instead of inline. `json`
  // enables the validate/format actions.
  const [popup, setPopup] = useState<{
    row: number;
    col: number;
    json: boolean;
  } | null>(null);
  const [popupDraft, setPopupDraft] = useState("");
  const [popupMsg, setPopupMsg] = useState<{
    kind: "error" | "ok";
    text: string;
  } | null>(null);
  // Staged, uncommitted changes for the table being browsed.
  const [edits, setEdits] = useState<Edits>({});
  const [deletes, setDeletes] = useState<Set<number>>(new Set());
  const [newRows, setNewRows] = useState<Record<string, string>[]>([]);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Set when a blur should be ignored because the edit was already staged or
  // cancelled by a keystroke.
  const editHandled = useRef(false);

  // The result the grid/footer/editing currently act on (the selected tab).
  const result = results[activeResult] ?? null;

  useEffect(() => {
    api
      .rdbmsListSchemas(connectionId)
      .then((list) => {
        setSchemas(list);
        autoOpenSingle(list);
      })
      .catch((e) => setError(errString(e)));
  }, [connectionId]);

  // Populate the database picker. A rejection means the backend doesn't list
  // databases (e.g. SQLite) — leave the list empty so the picker stays hidden.
  useEffect(() => {
    api
      .rdbmsListDatabases(connectionId)
      .then(setDatabases)
      .catch(() => setDatabases([]));
  }, [connectionId]);

  // Load this profile's saved SQL files.
  useEffect(() => {
    listWorkspaceFiles(savedId)
      .then(setSqlFiles)
      .catch(() => setSqlFiles([]));
  }, [savedId]);

  // Auto-save edits to the active SQL file, debounced so we don't write on every
  // keystroke. No-op when nothing's loaded or the content already matches disk.
  useEffect(() => {
    if (!activeFile) return;
    const stored = sqlFiles.find((f) => f.name === activeFile);
    if (!stored || stored.content === sql) return;
    const t = setTimeout(() => {
      saveWorkspaceFile(savedId, activeFile, sql)
        .then(() =>
          setSqlFiles((prev) =>
            prev.map((f) =>
              f.name === activeFile ? { ...f, content: sql } : f,
            ),
          ),
        )
        .catch((e) => setError(errString(e)));
    }, 800);
    return () => clearTimeout(t);
  }, [sql, activeFile, sqlFiles, savedId]);

  // Lazily fetch the table's DDL from the plugin when the DDL view is opened.
  useEffect(() => {
    if (tableView !== "ddl" || !edit || ddlText !== null) return;
    api
      .rdbmsDdlStatement(connectionId, edit.schema, edit.table)
      .then(setDdlText)
      .catch((e) => setDdlText(`-- Failed to load DDL: ${errString(e)}`));
  }, [tableView, edit, ddlText, connectionId]);

  // Lazily fetch the table's indexes when the structure view is opened.
  useEffect(() => {
    if (tableView !== "structure" || !edit || indexes !== null) return;
    api
      .rdbmsListIndexes(connectionId, edit.schema, edit.table)
      .then(setIndexes)
      .catch(() => setIndexes([]));
  }, [tableView, edit, indexes, connectionId]);

  /** Save the current editor SQL under `name` (from the inline name input). */
  async function saveCurrentSql() {
    const name = newSqlName?.trim();
    if (!name) {
      setNewSqlName(null);
      return;
    }
    if (sqlFiles.some((f) => f.name.toLowerCase() === name.toLowerCase())) {
      setError(`A SQL file named "${name}" already exists.`);
      return;
    }
    try {
      await saveWorkspaceFile(savedId, name, sql);
      setSqlFiles(await listWorkspaceFiles(savedId));
      setNewSqlName(null);
      setActiveFile(name);
      setError(null);
    } catch (e) {
      setError(errString(e));
    }
  }

  /** Delete a saved SQL file (after inline confirmation). */
  async function removeSqlFile(name: string) {
    setConfirmDelete(null);
    try {
      await deleteWorkspaceFile(savedId, name);
      setSqlFiles(await listWorkspaceFiles(savedId));
      if (activeFile === name) setActiveFile(null);
    } catch (e) {
      setError(errString(e));
    }
  }

  /** Switch the connection to another database on the same server and reload
   * the schema tree. Disabled while edits are staged, so nothing is lost. */
  async function switchDatabase(db: string) {
    if (db === currentDatabase) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api.rdbmsUseDatabase(connectionId, db);
      setCurrentDatabase(db);
      // Everything shown belonged to the previous database; start fresh.
      setOpenSchema(null);
      setTables({});
      setActiveTable(null);
      setResults([]);
      setEdit(null);
      clearStaged();
      const s = await api.rdbmsListSchemas(connectionId);
      setSchemas(s);
      autoOpenSingle(s);
    } catch (e) {
      setError(errString(e));
    } finally {
      setBusy(false);
    }
  }

  /** When a connection/database has exactly one schema, expand it and load its
   * tables automatically so the user doesn't have to click to reach them. */
  function autoOpenSingle(list: Schema[]) {
    if (list.length !== 1) return;
    const only = list[0].name;
    setOpenSchema(only);
    api
      .rdbmsListTables(connectionId, only)
      .then((t) => setTables((m) => ({ ...m, [only]: t })))
      .catch((e) => setError(errString(e)));
  }

  async function toggleSchema(name: string) {
    if (openSchema === name) {
      setOpenSchema(null);
      return;
    }
    setOpenSchema(name);
    if (!tables[name]) {
      try {
        const t = await api.rdbmsListTables(connectionId, name);
        setTables((m) => ({ ...m, [name]: t }));
      } catch (e) {
        setError(errString(e));
      }
    }
  }

  /** Re-fetch the schema list and the open schema's tables from the server,
   * picking up tables/schemas created since the tree was last loaded. */
  async function refreshTree() {
    setBusy(true);
    setError(null);
    try {
      const list = await api.rdbmsListSchemas(connectionId);
      setSchemas(list);
      const open =
        openSchema && list.some((s) => s.name === openSchema) ? openSchema : null;
      if (open) {
        const t = await api.rdbmsListTables(connectionId, open);
        setTables({ [open]: t });
      } else {
        setTables({});
        setOpenSchema(null);
        autoOpenSingle(list);
      }
    } catch (e) {
      setError(errString(e));
    } finally {
      setBusy(false);
    }
  }

  function clearStaged() {
    setEdits({});
    setDeletes(new Set());
    setNewRows([]);
    setEditing(null);
  }

  /** Surface a run failure: a cancellation shows as a notice, anything else as
   * an error. */
  function reportRunError(e: unknown) {
    const msg = errString(e);
    if (/\bcancelled\b/i.test(msg)) setNotice("Query cancelled.");
    else setError(msg);
  }

  /** Run a query and show its result, without touching the edit context.
   * Returns true if the query succeeded. */
  async function executeQuery(query: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    clearStaged();
    try {
      const r = await api.rdbmsExecute(connectionId, query);
      setResults(r);
      setActiveResult(0);
      return true;
    } catch (e) {
      reportRunError(e);
      setResults([]);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Browse a table's rows via the plugin (which builds the dialect-correct
   * query). Mirrors `executeQuery` but keeps SQL construction out of the UI. */
  async function browseTable(schema: string, table: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    clearStaged();
    try {
      const r = await api.rdbmsBrowseTable(
        connectionId,
        schema,
        table,
        BROWSE_LIMIT,
      );
      setResults([r]);
      setActiveResult(0);
      return true;
    } catch (e) {
      reportRunError(e);
      setResults([]);
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** Reload the current view: re-browse the table when browsing one, else
   * re-run the editor SQL. */
  function refreshData(): Promise<boolean> {
    if (activeTable && edit) return browseTable(edit.schema, edit.table);
    return executeQuery(sql);
  }

  async function pickTable(schema: string, table: string) {
    setActiveTable(schema + "." + table);
    // Leave SQL-file mode: the grid now reflects the table, not a file.
    setActiveFile(null);
    setTableView("data");
    setDdlText(null);
    setIndexes(null);
    setNotice(null);
    try {
      const columns = await api.rdbmsDescribeTable(connectionId, schema, table);
      setEdit({ schema, table, columns });
      if (!columns.some((c) => c.primary_key)) {
        setNotice(
          "No primary key: edits match rows by all column values and may affect duplicates.",
        );
      }
    } catch (e) {
      setEdit(null);
      setError(errString(e));
    }
    await browseTable(schema, table);
  }

  /** Run the SQL in the editor by hand. The result becomes editable when the
   * query is a simple single-table `SELECT` (like Postico); otherwise it's
   * shown read-only. */
  async function runManual(text: string = sql) {
    setActiveTable(null);
    setTableView("data");
    setDdlText(null);
    setIndexes(null);
    await runAndEdit(text);
  }

  /** Execute `query`, then make the result editable if it maps to a single
   * table. Shared by the Run button and SQL-file selection. */
  async function runAndEdit(query: string) {
    setEdit(null);
    setNotice(null);
    const ok = await executeQuery(query);
    if (!ok) return;
    const ctx = await deriveEditContext(query);
    setEdit(ctx);
    if (ctx && !ctx.columns.some((c) => c.primary_key)) {
      setNotice(
        "No primary key: edits match rows by all column values and may affect duplicates.",
      );
    }
  }

  /** Open a saved SQL file: load it into the editor. Run it manually to view
   * its data; a single-table SELECT then becomes editable (see runAndEdit). */
  async function loadSqlFile(file: WorkspaceFile) {
    setSql(file.content);
    setActiveFile(file.name);
    // Leave table-browse mode and clear the previous query's grid so a stale,
    // read-only result doesn't linger until this file is run.
    setActiveTable(null);
    setEdit(null);
    setResults([]);
    setNotice(null);
    clearStaged();
  }

  /** Resolve the editable table behind a query, or null if it isn't a simple
   * single-table select we can safely map back to a table. */
  async function deriveEditContext(query: string): Promise<EditContext | null> {
    const ref = parseSingleTable(query);
    if (!ref) return null;
    try {
      const columns = await api.rdbmsDescribeTable(
        connectionId,
        ref.schema,
        ref.table,
      );
      return columns.length ? { schema: ref.schema, table: ref.table, columns } : null;
    } catch {
      return null;
    }
  }

  function colMeta(name: string): Column | undefined {
    return edit?.columns.find((c) => c.name === name);
  }

  /** Columns that identify a row for UPDATE/DELETE. Uses the primary key when
   * every PK column is present in the result; otherwise matches on all present
   * table columns (so a partial projection can't build a wrong WHERE). */
  function keyColumns(): Column[] {
    if (!edit || !result) return [];
    const present = edit.columns.filter((c) =>
      result.columns.some((rc) => rc.name === c.name),
    );
    const pks = edit.columns.filter((c) => c.primary_key);
    const pkUsable =
      pks.length > 0 && pks.every((pk) => present.some((p) => p.name === pk.name));
    return pkUsable ? pks : present;
  }

  /** Build the key tuple for `row` (aligned to `result.columns`). */
  function rowKey(row: unknown[]): ColumnValue[] {
    if (!result) return [];
    return keyColumns().map((c) => {
      const ci = result.columns.findIndex((rc) => rc.name === c.name);
      return { column: c.name, type: castType(c), value: ci >= 0 ? row[ci] : null };
    });
  }

  /** Original (committed) text of a cell, or null for SQL NULL. */
  function originalText(ri: number, ci: number): string | null {
    const v = result!.rows[ri][ci];
    return v === null ? null : fmtEditable(v);
  }

  /** The value currently displayed for a cell: staged edit if any, else the
   * original. */
  function cellValue(ri: number, ci: number): string | null | unknown {
    const name = result!.columns[ci].name;
    const staged = edits[ri]?.[name];
    return staged !== undefined ? staged : result!.rows[ri][ci];
  }

  function isDirty(ri: number, ci: number): boolean {
    const name = result!.columns[ci].name;
    return edits[ri]?.[name] !== undefined;
  }

  /** Pure: produce the edits map with (ri, ci) set to `value`, dropping the
   * entry when it matches the original (so it's no longer counted dirty). */
  function withEdit(
    prev: Edits,
    ri: number,
    ci: number,
    value: string | null,
  ): Edits {
    const name = result!.columns[ci].name;
    const row = { ...(prev[ri] ?? {}) };
    if (value === originalText(ri, ci)) {
      delete row[name];
    } else {
      row[name] = value;
    }
    const next = { ...prev };
    if (Object.keys(row).length === 0) delete next[ri];
    else next[ri] = row;
    return next;
  }

  function startEdit(ri: number, ci: number) {
    if (!edit || !result) return;
    const meta = colMeta(result.columns[ci].name);
    if (!meta) return; // not a real table column
    if (deletes.has(ri)) return; // don't edit a row staged for deletion
    const v = cellValue(ri, ci);
    // Long values get a roomier modal editor (with JSON helpers when relevant).
    if (isLargeType(meta)) {
      setPopup({ row: ri, col: ci, json: isJsonType(meta) });
      setPopupDraft(v === null ? "" : fmtEditable(v));
      setPopupMsg(null);
      return;
    }
    editHandled.current = false;
    setEditing({ row: ri, col: ci });
    setDraft(v === null ? "" : fmtEditable(v));
  }

  /** Commit the modal editor's value (or NULL) into the staged edits. JSON
   * values get smart quotes folded back so a stray “ ” doesn't reach the DB. */
  function savePopup(value: string | null) {
    if (!popup) return;
    const v = value !== null && popup.json ? normalizeQuotes(value) : value;
    setEdits((prev) => withEdit(prev, popup.row, popup.col, v));
    setPopup(null);
  }

  /** Check the modal draft parses as JSON, reporting the result inline. */
  function validateJson() {
    const fixed = normalizeQuotes(popupDraft);
    if (fixed !== popupDraft) setPopupDraft(fixed);
    try {
      JSON.parse(fixed);
      setPopupMsg({ kind: "ok", text: "Valid JSON." });
    } catch (e) {
      setPopupMsg({ kind: "error", text: errString(e) });
    }
  }

  /** Pretty-print the modal draft as JSON (no-op with an error if invalid). */
  function formatJson() {
    try {
      setPopupDraft(
        JSON.stringify(JSON.parse(normalizeQuotes(popupDraft)), null, 2),
      );
      setPopupMsg({ kind: "ok", text: "Formatted." });
    } catch (e) {
      setPopupMsg({ kind: "error", text: errString(e) });
    }
  }

  /** Stage the open editor's value and close it. */
  function stageEdit(value: string | null) {
    if (!editing) return;
    editHandled.current = true;
    const { row: ri, col: ci } = editing;
    setEdits((prev) => withEdit(prev, ri, ci, value));
    setEditing(null);
  }

  function cancelEdit() {
    editHandled.current = true;
    setEditing(null);
  }

  function toggleDelete(ri: number) {
    setDeletes((prev) => {
      const next = new Set(prev);
      if (next.has(ri)) next.delete(ri);
      else next.add(ri);
      return next;
    });
  }

  const pendingUpdates = Object.keys(edits).filter(
    (ri) => !deletes.has(Number(ri)),
  ).length;
  const dirty =
    pendingUpdates > 0 || deletes.size > 0 || newRows.length > 0;

  async function save() {
    if (!edit || !result) return;
    // Flush an open editor into a local copy so we don't race React state.
    let staged = edits;
    if (editing) {
      staged = withEdit(edits, editing.row, editing.col, draft);
      setEdits(staged);
      setEditing(null);
    }
    if (popup) {
      staged = withEdit(staged, popup.row, popup.col, popupDraft);
      setEdits(staged);
      setPopup(null);
    }

    const changes: RowChanges = {
      updates: Object.entries(staged)
        .filter(([ri]) => !deletes.has(Number(ri)))
        .map(([ri, cols]) => ({
          pk: rowKey(result.rows[Number(ri)]),
          changes: Object.entries(cols).map(([col, val]) => ({
            column: col,
            type: castType(colMeta(col)!),
            value: val,
          })),
        })),
      inserts: newRows.map((nr) =>
        edit.columns
          .filter((c) => (nr[c.name] ?? "") !== "")
          .map((c) => ({ column: c.name, type: castType(c), value: nr[c.name] })),
      ),
      deletes: [...deletes].map((ri) => rowKey(result.rows[ri])),
    };

    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const r = await api.rdbmsApplyChanges(
        connectionId,
        edit.schema,
        edit.table,
        changes,
      );
      setNotice(
        `Saved · ${r.updated} updated, ${r.inserted} inserted, ${r.deleted} deleted.`,
      );
      // Re-fetch so the grid reflects defaults/serials and canonical values.
      await refreshData();
    } catch (e) {
      setError(errString(e));
    } finally {
      setSaving(false);
    }
  }

  function discard() {
    clearStaged();
    setError(null);
    setNotice(null);
  }

  const editable =
    edit !== null &&
    result !== null &&
    result.columns.length > 0 &&
    results.length === 1;

  return (
    <div className="workspace">
      <div className="tree" style={{ width }}>
        <div className="tree-top">
        <WorkspaceFileList
          files={sqlFiles}
          activeFile={activeFile}
          newName={newSqlName}
          onToggleAdd={() => setNewSqlName((n) => (n === null ? "" : null))}
          onNewNameChange={setNewSqlName}
          onSave={saveCurrentSql}
          onCancelAdd={() => setNewSqlName(null)}
          onLoad={loadSqlFile}
          onRequestDelete={setConfirmDelete}
          label="SQL files"
          ext="sql"
          addTitle="Save current SQL as a file"
          emptyText="No SQL files."
        />
        <div className="tree-dbselect">
          {databases.length > 0 && (
            <span className="field-label">Database</span>
          )}
          <div className="tree-db-row">
            {databases.length > 0 && (
              <select
                value={currentDatabase ?? ""}
                disabled={busy || saving || dirty}
                title={
                  dirty
                    ? "Save or discard changes before switching database"
                    : undefined
                }
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
              disabled={busy || saving}
              title="Reload schemas and tables"
              onClick={refreshTree}
            >
              ↻
            </button>
          </div>
        </div>
        </div>
        <SchemaTree
          schemas={schemas}
          tables={tables}
          openSchema={openSchema}
          activeTable={activeTable}
          onToggleSchema={toggleSchema}
          onPickTable={pickTable}
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
            <span className="editor-file-name">{activeFile}.sql</span>
            {sqlFiles.find((f) => f.name === activeFile)?.content !== sql && (
              <span className="editor-file-dirty" title="Auto-saving…">
                ●
              </span>
            )}
          </div>
        )}
        {activeFile && (
          <textarea
            className="code"
            value={sql}
            spellCheck={false}
            onChange={(e) => setSql(e.target.value)}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter runs the selection if any, else the statement the
              // cursor is in.
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                if (busy || saving) return;
                const ta = e.currentTarget;
                const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
                const stmt = sel.trim()
                  ? sel
                  : statementAtCursor(ta.value, ta.selectionStart);
                if (stmt.trim()) void runManual(stmt);
              }
            }}
          />
        )}
        <div className="editor-toolbar">
          {activeFile && (
            <button
              className="primary"
              disabled={busy || saving}
              onClick={() => runManual()}
            >
              Run
            </button>
          )}
          {activeFile && !busy && (
            <span className="editor-hint">
              ⌘/Ctrl+Enter runs the selection, or the statement at the cursor
            </span>
          )}
          {busy && (
            <>
              <span className="running">Running…</span>
              <button
                className="danger"
                onClick={() => void api.cancelLastPluginCall(connectionId)}
              >
                Cancel
              </button>
            </>
          )}
          {editable && tableView === "data" && (
            <>
              <button
                disabled={busy || saving}
                onClick={() => setNewRows((r) => [...r, {}])}
              >
                ＋ Add row
              </button>
              <button
                disabled={busy || saving || dirty}
                title={dirty ? "Save or discard changes first" : undefined}
                onClick={() => refreshData()}
              >
                ↻ Refresh
              </button>
            </>
          )}
        </div>
        {notice && <div className="status-line">{notice}</div>}
        {error && <div className="status-line error">{error}</div>}
        {results.length > 1 && (
          <div className="result-tabs">
            {results.map((_, i) => (
              <button
                key={i}
                className={i === activeResult ? "active" : ""}
                onClick={() => setActiveResult(i)}
              >
                Result {i + 1}
              </button>
            ))}
          </div>
        )}
        <div className="result-scroll">
          {tableView === "structure" && edit ? (
            <div className="structure">
              <StructureTable
                headers={["Column", "Type", "Default", "Constraints"]}
                rows={edit.columns.map((c) => ({
                  key: c.name,
                  cells: [
                    c.name,
                    displayType(c),
                    c.default_value ?? "",
                    <>
                      {c.primary_key && <span className="chip chip-pk">PRIMARY KEY</span>}
                      {!c.nullable && <span className="chip chip-notnull">NOT NULL</span>}
                      {c.unique && <span className="chip chip-unique">UNIQUE</span>}
                      {c.foreign_key && (
                        <span className="chip chip-fk">
                          {`→ ${c.foreign_key.table}.${c.foreign_key.column}`}
                        </span>
                      )}
                    </>,
                  ],
                }))}
              />
              <h4 className="structure-heading">Indexes</h4>
              <StructureTable
                headers={["Name", "Type", "Columns"]}
                rows={(indexes ?? []).map((ix) => ({
                  key: ix.name,
                  cells: [
                    ix.name,
                    [
                      ix.primary ? "PRIMARY" : ix.unique ? "UNIQUE" : null,
                      ix.method,
                    ]
                      .filter(Boolean)
                      .join(" "),
                    ix.columns,
                  ],
                }))}
                empty={indexes === null ? "Loading…" : "No indexes."}
              />
            </div>
          ) : tableView === "ddl" && edit ? (
            <pre className="ddl">{ddlText ?? "Loading…"}</pre>
          ) : (
            result &&
            result.columns.length > 0 && (
              <table className="grid">
              <thead>
                <tr>
                  {editable && <th className="gutter" />}
                  {result.columns.map((c, i) => {
                    const meta = colMeta(c.name);
                    return (
                      <th
                        key={i}
                        title={meta ? meta.data_type : c.data_type}
                        className={meta?.primary_key ? "pk" : ""}
                      >
                        {meta?.primary_key && <span className="key">🔑 </span>}
                        {c.name}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {result.rows.map((row, ri) => {
                  const deleted = deletes.has(ri);
                  return (
                    <tr key={ri} className={deleted ? "deleted" : ""}>
                      {editable && (
                        <td className="gutter">
                          <button
                            className={deleted ? "row-undo" : "row-del"}
                            title={deleted ? "Keep row" : "Delete row"}
                            disabled={saving}
                            onClick={() => toggleDelete(ri)}
                          >
                            {deleted ? "↩" : "✕"}
                          </button>
                        </td>
                      )}
                      {row.map((_cell, ci) => {
                        const isEditing =
                          editing?.row === ri && editing?.col === ci;
                        if (isEditing) {
                          return (
                            <td key={ci} className="editing">
                              <div className="cell-edit">
                                <input
                                  className="cell-input"
                                  autoFocus
                                  value={draft}
                                  onChange={(e) => setDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") stageEdit(draft);
                                    else if (e.key === "Escape") cancelEdit();
                                  }}
                                  onBlur={() => {
                                    if (!editHandled.current) stageEdit(draft);
                                  }}
                                />
                                <button
                                  className="cell-null"
                                  title="Set NULL"
                                  // mousedown fires before the input's blur
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    stageEdit(null);
                                  }}
                                >
                                  ∅
                                </button>
                              </div>
                            </td>
                          );
                        }
                        const v = cellValue(ri, ci);
                        return (
                          <td
                            key={ci}
                            className={
                              (v === null ? "null " : "") +
                              (isDirty(ri, ci) ? "dirty" : "")
                            }
                            onDoubleClick={() => startEdit(ri, ci)}
                          >
                            {fmt(v)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
                {newRows.map((nr, ni) => (
                  <tr key={"new-" + ni} className="new-row">
                    <td className="gutter">
                      <button
                        className="row-del"
                        title="Remove row"
                        disabled={saving}
                        onClick={() =>
                          setNewRows((r) => r.filter((_, i) => i !== ni))
                        }
                      >
                        ✕
                      </button>
                    </td>
                    {result.columns.map((c, ci) => {
                      const meta = colMeta(c.name);
                      return (
                        <td key={ci} className="editing">
                          <input
                            className="cell-input"
                            placeholder={meta ? "default" : ""}
                            disabled={!meta}
                            value={nr[c.name] ?? ""}
                            onChange={(e) =>
                              setNewRows((r) =>
                                r.map((row, i) =>
                                  i === ni
                                    ? { ...row, [c.name]: e.target.value }
                                    : row,
                                ),
                              )
                            }
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
                {result.rows.length === 0 && newRows.length === 0 && (
                  <tr className="empty-row">
                    <td colSpan={result.columns.length + (editable ? 1 : 0)}>
                      No rows.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          ))}
        </div>
        {result && (
          <div className="grid-footer">
            {activeTable && edit && (
              <div className="view-switch">
                <button
                  className={tableView === "data" ? "active" : ""}
                  onClick={() => setTableView("data")}
                >
                  Data
                </button>
                <button
                  className={tableView === "structure" ? "active" : ""}
                  onClick={() => setTableView("structure")}
                >
                  Structure
                </button>
                <button
                  className={tableView === "ddl" ? "active" : ""}
                  onClick={() => setTableView("ddl")}
                >
                  DDL
                </button>
              </div>
            )}
            {tableView === "data" && (
              <span>
                {result.rows_affected !== null
                  ? `${result.rows_affected} row(s) affected`
                  : `${result.rows.length} row(s)`}
              </span>
            )}
            {edit && (
              <span className="grid-footer-table">
                {edit.schema}.{edit.table}
              </span>
            )}
            {tableView === "data" && <span>{result.elapsed_ms} ms</span>}
            <span className="spacer" />
            {editable && dirty && (
              <>
                <span className="status-line">
                  {[
                    pendingUpdates && `${pendingUpdates} row(s) edited`,
                    newRows.length && `${newRows.length} new`,
                    deletes.size && `${deletes.size} to delete`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
                <button disabled={saving} onClick={discard}>
                  Cancel
                </button>
                <button
                  className="primary"
                  disabled={saving}
                  // keep the open editor's value (mousedown precedes its blur)
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={save}
                >
                  {saving ? "Saving…" : "Save"}
                </button>
              </>
            )}
          </div>
        )}
      </div>
      {confirmDelete && (
        <ConfirmDialog
          title="Delete SQL file"
          message={
            <>
              Delete <strong>{confirmDelete}.sql</strong>? This can't be undone.
            </>
          }
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void removeSqlFile(confirmDelete)}
        />
      )}
      {popup && result && (
        <CellEditorModal
          columnName={result.columns[popup.col].name}
          json={popup.json}
          draft={popupDraft}
          message={popupMsg}
          onDraftChange={(v) => {
            setPopupDraft(v);
            setPopupMsg(null);
          }}
          onValidate={validateJson}
          onFormat={formatJson}
          onApply={() => savePopup(popupDraft)}
          onSetNull={() => savePopup(null)}
          onCancel={() => setPopup(null)}
        />
      )}
    </div>
  );
}
