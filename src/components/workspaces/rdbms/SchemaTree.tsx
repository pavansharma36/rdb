import type { Schema, Table } from "../../../api";

interface SchemaTreeProps {
  schemas: Schema[];
  tables: Record<string, Table[]>;
  openSchema: string | null;
  activeTable: string | null;
  onToggleSchema: (name: string) => void;
  onPickTable: (schema: string, table: string) => void;
}

/** The collapsible schema → table navigation tree. */
export function SchemaTree({
  schemas,
  tables,
  openSchema,
  activeTable,
  onToggleSchema,
  onPickTable,
}: SchemaTreeProps) {
  return (
    <div className="tree-schemas">
      {schemas.length === 0 && <p className="muted">No schemas.</p>}
      {schemas.map((s) => (
        <div key={s.name} className="tree-group">
          <div
            className={"tree-node" + (openSchema === s.name ? " active" : "")}
            onClick={() => onToggleSchema(s.name)}
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
                onClick={() => onPickTable(s.name, t.name)}
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
  );
}
