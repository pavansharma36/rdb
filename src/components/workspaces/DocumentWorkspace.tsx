import { useEffect, useState } from "react";
import { api, errString } from "../../api";
import type { ConnectionId, MongoCollection, FindResult } from "../../api";

interface Props {
  connectionId: ConnectionId;
}

export function DocumentWorkspace({ connectionId }: Props) {
  const [databases, setDatabases] = useState<string[]>([]);
  const [openDb, setOpenDb] = useState<string | null>(null);
  const [collections, setCollections] = useState<
    Record<string, MongoCollection[]>
  >({});
  const [active, setActive] = useState<{ db: string; coll: string } | null>(
    null,
  );
  const [filter, setFilter] = useState("{}");
  const [limit, setLimit] = useState(50);
  const [result, setResult] = useState<FindResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .docListDatabases(connectionId)
      .then(setDatabases)
      .catch((e) => setError(errString(e)));
  }, [connectionId]);

  async function toggleDb(db: string) {
    if (openDb === db) {
      setOpenDb(null);
      return;
    }
    setOpenDb(db);
    if (!collections[db]) {
      try {
        const c = await api.docListCollections(connectionId, db);
        setCollections((m) => ({ ...m, [db]: c }));
      } catch (e) {
        setError(errString(e));
      }
    }
  }

  async function pick(db: string, coll: string) {
    setActive({ db, coll });
    await runFind(db, coll);
  }

  async function runFind(db?: string, coll?: string) {
    const target = db && coll ? { db, coll } : active;
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.docFind(
        connectionId,
        target.db,
        target.coll,
        filter.trim() || null,
        limit,
      );
      setResult(r);
    } catch (e) {
      setError(errString(e));
      setResult(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="workspace">
      <div className="tree">
        {databases.length === 0 && <p className="muted">No databases.</p>}
        {databases.map((db) => (
          <div key={db} className="tree-group">
            <div
              className={"tree-node" + (openDb === db ? " active" : "")}
              onClick={() => toggleDb(db)}
            >
              <span className="tree-caret">{openDb === db ? "▾" : "▸"}</span>
              <span>{db}</span>
            </div>
            {openDb === db &&
              (collections[db] ?? []).map((c) => (
                <div
                  key={c.name}
                  className={
                    "tree-node leaf" +
                    (active && active.db === db && active.coll === c.name
                      ? " active"
                      : "")
                  }
                  onClick={() => pick(db, c.name)}
                >
                  <span>{c.name}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
      <div className="editor-pane">
        <div className="row">
          <span className="muted">
            {active ? `${active.db} / ${active.coll}` : "Select a collection"}
          </span>
        </div>
        <textarea
          className="code"
          value={filter}
          spellCheck={false}
          placeholder="{ }"
          onChange={(e) => setFilter(e.target.value)}
        />
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
          {result && (
            <span className="status-line">
              {result.documents.length} doc(s) · {result.elapsed_ms} ms
            </span>
          )}
        </div>
        {error && <div className="status-line error">{error}</div>}
        <div className="result-scroll">
          {result &&
            result.documents.map((d, i) => (
              <div key={i} className="doc-card">
                <pre>{JSON.stringify(d, null, 2)}</pre>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
