import { useMemo, useState } from "react";
import { api, errString } from "../api";
import type { PluginInfo, ConfigField, ConnectionConfig } from "../api";
import type { SavedConnection } from "../store";
import { genId } from "../store";

interface ConnectionFormProps {
  plugins: PluginInfo[];
  error: string | null;
  /** When editing an existing saved profile; null/undefined for a new one. */
  initial?: SavedConnection | null;
  /** Persist the profile and open a live connection. Should reject on failure
   * so the form can surface the error (the profile is still saved). */
  onSaveAndConnect: (profile: SavedConnection) => Promise<void>;
}

function defaultValues(fields: ConfigField[]): ConnectionConfig {
  const out: ConnectionConfig = {};
  for (const f of fields) {
    if (f.default !== undefined && f.default !== null) out[f.key] = f.default;
    else if (f.type.kind === "boolean") out[f.key] = false;
    else out[f.key] = "";
  }
  return out;
}

/** A field shows unless its `show_if` rule is unmet by the current values. */
function isVisible(field: ConfigField, values: ConnectionConfig): boolean {
  if (!field.show_if) return true;
  return String(values[field.show_if.field] ?? "") === field.show_if.equals;
}

export function ConnectionForm({
  plugins,
  error,
  initial,
  onSaveAndConnect,
}: ConnectionFormProps) {
  const [pluginId, setPluginId] = useState<string>(initial?.pluginId ?? "");
  const selected = useMemo(
    () => plugins.find((p) => p.id === pluginId) ?? null,
    [plugins, pluginId],
  );
  const [name, setName] = useState<string>(initial?.name ?? "");
  const [values, setValues] = useState<ConnectionConfig>(initial?.config ?? {});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "ok"; text: string } | null>(
    null,
  );
  const editing = Boolean(initial);

  function selectPlugin(id: string) {
    setPluginId(id);
    setMsg(null);
    const p = plugins.find((x) => x.id === id);
    setValues(p ? defaultValues(p.config_schema) : {});
  }

  function setField(key: string, value: unknown) {
    setValues((v) => ({ ...v, [key]: value }));
  }

  function coerce(field: ConfigField, raw: string): unknown {
    if (field.type.kind === "number") return raw === "" ? "" : Number(raw);
    return raw;
  }

  /** Auto-derived label used when the user leaves the name blank. */
  function buildLabel(): string {
    const v = values as Record<string, unknown>;
    const host = v.host ?? v.uri ?? v.database;
    return selected
      ? `${selected.name}${host ? " · " + String(host) : ""}`
      : "connection";
  }

  /** Only the fields currently shown, used both for rendering and submit. */
  function visibleFields(): ConfigField[] {
    return selected
      ? selected.config_schema.filter((f) => isVisible(f, values))
      : [];
  }

  /** Config to send: only visible fields, so hidden defaults aren't included. */
  function visibleConfig(): ConnectionConfig {
    return Object.fromEntries(
      visibleFields().map((f) => [f.key, values[f.key]]),
    );
  }

  async function onTest() {
    if (!selected) return;
    setBusy(true);
    setMsg(null);
    try {
      await api.testConnection(selected.id, visibleConfig());
      setMsg({ kind: "ok", text: "Connection succeeded." });
    } catch (e) {
      setMsg({ kind: "error", text: errString(e) });
    } finally {
      setBusy(false);
    }
  }

  async function onSaveAndConnectClick() {
    if (!selected) return;
    setBusy(true);
    setMsg(null);
    const profile: SavedConnection = {
      id: initial?.id ?? genId(),
      name: name.trim() || buildLabel(),
      pluginId: selected.id,
      config: visibleConfig(),
    };
    try {
      await onSaveAndConnect(profile);
      // On success the parent navigates away from the form.
    } catch (e) {
      setMsg({ kind: "error", text: errString(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="conn-form">
      <h1>{editing ? "Edit connection" : "New connection"}</h1>
      {error && <div className="msg error">{error}</div>}
      <label className="field">
        <span className="field-label">Type</span>
        <select value={pluginId} onChange={(e) => selectPlugin(e.target.value)}>
          <option value="" disabled>
            Select a plugin…
          </option>
          {plugins.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <>
          <p className="muted">{selected.description}</p>
          <label className="field">
            <span className="field-label">Connection name</span>
            <input
              type="text"
              value={name}
              placeholder={buildLabel()}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {visibleFields().map((f) => (
            <Field
              key={f.key}
              field={f}
              value={values[f.key]}
              onChange={(val) => setField(f.key, val)}
              coerce={coerce}
            />
          ))}
          {msg && <div className={"msg " + msg.kind}>{msg.text}</div>}
          <div className="form-actions">
            <button disabled={busy} onClick={onTest}>
              Test
            </button>
            <button
              className="primary"
              disabled={busy}
              onClick={onSaveAndConnectClick}
            >
              Save &amp; Connect
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Field({
  field,
  value,
  onChange,
  coerce,
}: {
  field: ConfigField;
  value: unknown;
  onChange: (v: unknown) => void;
  coerce: (f: ConfigField, raw: string) => unknown;
}) {
  const t = field.type;
  return (
    <label className="field">
      <span className="field-label">
        {field.label}
        {field.required && <span className="req">*</span>}
      </span>
      {t.kind === "boolean" ? (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(e) => onChange(e.target.checked)}
        />
      ) : t.kind === "select" ? (
        <select
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        >
          {t.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={
            t.kind === "password"
              ? "password"
              : t.kind === "number"
                ? "number"
                : "text"
          }
          value={value === undefined || value === null ? "" : String(value)}
          placeholder={field.placeholder ?? ""}
          onChange={(e) => onChange(coerce(field, e.target.value))}
        />
      )}
    </label>
  );
}
