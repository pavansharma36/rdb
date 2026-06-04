import { useEffect, useRef, useState } from "react";
import { api, errString } from "../../api";
import type {
  Column,
  ColumnValue,
  ConnectionId,
  RowChanges,
  Schema,
  Table,
  QueryResult,
} from "../../api";

interface Props {
  connectionId: ConnectionId;
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

/** Heuristically extract the single table a `SELECT` reads from, so its result
 * can be made editable. Returns null for anything we can't safely map to one
 * table: joins, unions, group-by, distinct, multiple tables, or subqueries.
 * An unqualified table name is assumed to live in `public`. */
function parseSingleTable(
  query: string,
): { schema: string; table: string } | null {
  // Drop line comments and normalize whitespace.
  const q = query
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const lower = q.toLowerCase();
  if (!lower.startsWith("select ") && lower !== "select") return null;
  if (
    /\bjoin\b|\bunion\b|\bintersect\b|\bexcept\b|\bgroup\s+by\b|\bdistinct\b|\bhaving\b/.test(
      lower,
    )
  ) {
    return null;
  }
  const fromMatch = lower.search(/\bfrom\b/);
  if (fromMatch < 0) return null;

  let rest = q.slice(fromMatch + 4).trim();
  // Cut the FROM clause at the next clause keyword (or statement end).
  const end = rest
    .toLowerCase()
    .search(/(\bwhere\b|\bgroup\b|\border\b|\blimit\b|\bhaving\b|\boffset\b|\bfetch\b|\bfor\b|;)/);
  if (end >= 0) rest = rest.slice(0, end).trim();
  // Reject multiple tables or a subquery in FROM.
  if (!rest || rest.includes(",") || rest.includes("(")) return null;

  // Match `schema.table` or `table`, each part optionally double-quoted; any
  // trailing alias is ignored.
  const m = rest.match(
    /^("[^"]+"|[A-Za-z_][\w$]*)(?:\s*\.\s*("[^"]+"|[A-Za-z_][\w$]*))?/,
  );
  if (!m) return null;
  const unq = (s: string) => (s.startsWith('"') ? s.slice(1, -1) : s);
  return m[2]
    ? { schema: unq(m[1]), table: unq(m[2]) }
    : { schema: "public", table: unq(m[1]) };
}

export function RdbmsWorkspace({ connectionId }: Props) {
  const [schemas, setSchemas] = useState<Schema[]>([]);
  const [openSchema, setOpenSchema] = useState<string | null>(null);
  const [tables, setTables] = useState<Record<string, Table[]>>({});
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [sql, setSql] = useState("select 1;");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [edit, setEdit] = useState<EditContext | null>(null);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [draft, setDraft] = useState("");
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

  useEffect(() => {
    api
      .rdbmsListSchemas(connectionId)
      .then(setSchemas)
      .catch((e) => setError(errString(e)));
  }, [connectionId]);

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

  function clearStaged() {
    setEdits({});
    setDeletes(new Set());
    setNewRows([]);
    setEditing(null);
  }

  /** Run a query and show its result, without touching the edit context.
   * Returns true if the query succeeded. */
  async function executeQuery(query: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    clearStaged();
    try {
      const r = await api.rdbmsExecute(connectionId, query);
      setResult(r);
      return true;
    } catch (e) {
      setError(errString(e));
      setResult(null);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function pickTable(schema: string, table: string) {
    setActiveTable(schema + "." + table);
    setNotice(null);
    const q = `SELECT * FROM "${schema}"."${table}" LIMIT 100;`;
    setSql(q);
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
    await executeQuery(q);
  }

  /** Run the SQL in the editor by hand. The result becomes editable when the
   * query is a simple single-table `SELECT` (like Postico); otherwise it's
   * shown read-only. */
  async function runManual() {
    setEdit(null);
    setActiveTable(null);
    setNotice(null);
    const ok = await executeQuery(sql);
    if (!ok) return;
    const ctx = await deriveEditContext(sql);
    setEdit(ctx);
    if (ctx && !ctx.columns.some((c) => c.primary_key)) {
      setNotice(
        "No primary key: edits match rows by all column values and may affect duplicates.",
      );
    }
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

  function fmt(v: unknown): string {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  /** Text shown in the inline editor for a cell value. */
  function fmtEditable(v: unknown): string {
    if (v === null || v === undefined) return "";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  function colMeta(name: string): Column | undefined {
    return edit?.columns.find((c) => c.name === name);
  }

  /** SQL type to CAST a bound value to. Enums report `USER-DEFINED` for
   * `data_type`; their real type name lives in `udt_name`. */
  function castType(c: Column): string {
    if (c.data_type === "USER-DEFINED" && c.udt_name) return c.udt_name;
    return c.data_type;
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
    if (!colMeta(result.columns[ci].name)) return; // not a real table column
    if (deletes.has(ri)) return; // don't edit a row staged for deletion
    editHandled.current = false;
    setEditing({ row: ri, col: ci });
    const v = cellValue(ri, ci);
    setDraft(v === null ? "" : fmtEditable(v));
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
      await executeQuery(sql);
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

  const editable = edit !== null && result !== null && result.columns.length > 0;

  return (
    <div className="workspace">
      <div className="tree">
        {schemas.length === 0 && <p className="muted">No schemas.</p>}
        {schemas.map((s) => (
          <div key={s.name} className="tree-group">
            <div
              className={"tree-node" + (openSchema === s.name ? " active" : "")}
              onClick={() => toggleSchema(s.name)}
            >
              <span className="tree-caret">
                {openSchema === s.name ? "▾" : "▸"}
              </span>
              <span>{s.name}</span>
            </div>
            {openSchema === s.name &&
              (tables[s.name] ?? []).map((t) => (
                <div
                  key={t.name}
                  className={
                    "tree-node leaf" +
                    (activeTable === s.name + "." + t.name ? " active" : "")
                  }
                  onClick={() => pickTable(s.name, t.name)}
                >
                  <span>{t.name}</span>
                  {t.kind !== "table" && (
                    <span className="tree-kind">{t.kind}</span>
                  )}
                </div>
              ))}
          </div>
        ))}
      </div>
      <div className="editor-pane">
        <textarea
          className="code"
          value={sql}
          spellCheck={false}
          onChange={(e) => setSql(e.target.value)}
        />
        <div className="editor-toolbar">
          <button className="primary" disabled={busy || saving} onClick={runManual}>
            Run
          </button>
          {editable && (
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
                onClick={() => executeQuery(sql)}
              >
                ↻ Refresh
              </button>
              <span className="status-line">
                Editing {edit!.schema}.{edit!.table}
              </span>
            </>
          )}
          {result && !editable && (
            <span className="status-line">
              {result.rows_affected !== null
                ? `${result.rows_affected} row(s) affected`
                : `${result.rows.length} row(s)`}{" "}
              · {result.elapsed_ms} ms
            </span>
          )}
        </div>
        {notice && <div className="status-line">{notice}</div>}
        {error && <div className="status-line error">{error}</div>}
        <div className="result-scroll">
          {result && result.columns.length > 0 && (
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
              </tbody>
            </table>
          )}
        </div>
        {editable && dirty && (
          <div className="edit-bar">
            <span className="status-line">
              {[
                pendingUpdates && `${pendingUpdates} row(s) edited`,
                newRows.length && `${newRows.length} new`,
                deletes.size && `${deletes.size} to delete`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
            <span className="spacer" />
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
          </div>
        )}
      </div>
    </div>
  );
}
