import { type KvRow, newKvRow } from "../api/curlui.ts";

/** Editable key/value table shared by params, headers, and form body.
 *  Keeps a trailing blank row so typing into it appends a new one. */
export function KvEditor({
  rows,
  onChange,
  keyPlaceholder = "Key",
  valuePlaceholder = "Value",
}: {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}) {
  function patch(id: string, field: "key" | "value" | "enabled", value: unknown) {
    let next = rows.map((r) => (r.id === id ? { ...r, [field]: value } : r));
    const last = next[next.length - 1];
    if (last && (last.key.trim() || last.value.trim())) {
      next = [...next, newKvRow()];
    }
    onChange(next);
  }
  function remove(id: string) {
    const next = rows.filter((r) => r.id !== id);
    onChange(next.length ? next : [newKvRow()]);
  }
  return (
    <div className="curlui-kv">
      {rows.map((r, i) => {
        const isLast = i === rows.length - 1;
        return (
          <div key={r.id} className="curlui-kv-row">
            <input
              type="checkbox"
              className="curlui-kv-check"
              checked={r.enabled}
              disabled={isLast && !r.key.trim() && !r.value.trim()}
              onChange={(e) => patch(r.id, "enabled", e.target.checked)}
            />
            <input
              type="text"
              className="curlui-kv-key"
              placeholder={keyPlaceholder}
              value={r.key}
              onChange={(e) => patch(r.id, "key", e.target.value)}
            />
            <input
              type="text"
              className="curlui-kv-value"
              placeholder={valuePlaceholder}
              value={r.value}
              onChange={(e) => patch(r.id, "value", e.target.value)}
            />
            <button
              type="button"
              className="curlui-kv-del"
              title="Remove"
              tabIndex={-1}
              onClick={() => remove(r.id)}
              style={{ visibility: isLast ? "hidden" : "visible" }}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
