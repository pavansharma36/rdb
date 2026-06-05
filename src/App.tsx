import { useEffect, useMemo, useState } from "react";
import { api, errString } from "./api";
import type { PluginInfo, ConnectionId, PluginKind } from "./api";
import { Sidebar } from "./components/Sidebar";
import { ConnectionForm } from "./components/ConnectionForm";
import { InstallPluginDialog } from "./components/InstallPluginDialog";
import { RdbmsWorkspace } from "./components/workspaces/RdbmsWorkspace";
import { DocumentWorkspace } from "./components/workspaces/DocumentWorkspace";
import { RabbitMqWorkspace } from "./components/workspaces/RabbitMqWorkspace";
import type { SavedConnection } from "./store";
import { loadConnections, saveConnections, upsert, remove } from "./store";

/** A live, currently-open connection to a backend (one per connected profile). */
export interface OpenConnection {
  id: ConnectionId;
  savedId: string;
  pluginId: string;
  name: string;
  kind: PluginKind;
  uiModule: string;
}

export function App() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  // Persisted connection profiles (survive app restarts).
  const [saved, setSaved] = useState<SavedConnection[]>([]);
  // Live connections opened this session, keyed back to their saved profile.
  const [open, setOpen] = useState<OpenConnection[]>([]);
  const [activeId, setActiveId] = useState<ConnectionId | null>(null);
  const [creating, setCreating] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    api
      .listPlugins()
      .then(setPlugins)
      .catch((e) => setLoadError(errString(e)));
    loadConnections()
      .then(setSaved)
      .catch((e) => setLoadError(errString(e)));
  }, []);

  /** Re-fetch the installed plugin list (e.g. after installing a new one). */
  function refreshPlugins() {
    api
      .listPlugins()
      .then(setPlugins)
      .catch((e) => setLoadError(errString(e)));
  }

  const active = open.find((c) => c.id === activeId) ?? null;
  const editingProfile = useMemo(
    () => saved.find((s) => s.id === editingId) ?? null,
    [saved, editingId],
  );
  // Show the form when creating, editing, or when nothing is open/selected.
  const showForm = creating || editingId !== null || active === null;

  /** Update saved profiles in state and persist them to disk. */
  function persist(next: SavedConnection[]) {
    setSaved(next);
    saveConnections(next).catch((e) => setConnectError(errString(e)));
  }

  /** Build a live OpenConnection record from a saved profile + backend id. */
  function toOpen(profile: SavedConnection, id: ConnectionId): OpenConnection {
    const plugin = plugins.find((p) => p.id === profile.pluginId);
    return {
      id,
      savedId: profile.id,
      pluginId: profile.pluginId,
      name: profile.name,
      kind: plugin?.kind ?? "other",
      uiModule: plugin?.ui_module ?? plugin?.kind ?? profile.pluginId,
    };
  }

  /** Persist the profile, then open a live connection. Persisting first means
   * settings are kept even if connecting fails. Throws on connect failure so
   * the form can show it. */
  async function saveAndConnect(profile: SavedConnection) {
    persist(upsert(saved, profile));
    // If this profile already had a live connection (e.g. editing it), close
    // the stale one so we don't leak a backend connection.
    const prevLive = open.find((o) => o.savedId === profile.id);
    if (prevLive) {
      try {
        await api.closeConnection(prevLive.id);
      } catch {
        // Best effort.
      }
    }
    const id = await api.openConnection(profile.pluginId, profile.config);
    const conn = toOpen(profile, id);
    setOpen((os) => [...os.filter((o) => o.savedId !== profile.id), conn]);
    setActiveId(id);
    setCreating(false);
    setEditingId(null);
    setConnectError(null);
  }

  /** Connect a saved profile from the sidebar (or focus it if already open). */
  async function connectSaved(profile: SavedConnection) {
    const existing = open.find((o) => o.savedId === profile.id);
    if (existing) {
      setActiveId(existing.id);
      setCreating(false);
      setEditingId(null);
      return;
    }
    setConnectError(null);
    try {
      const id = await api.openConnection(profile.pluginId, profile.config);
      const conn = toOpen(profile, id);
      setOpen((os) => [...os, conn]);
      setActiveId(id);
      setCreating(false);
      setEditingId(null);
    } catch (e) {
      // Drop into the prefilled form so the user can fix the settings.
      setConnectError(errString(e));
      setEditingId(profile.id);
      setCreating(false);
    }
  }

  async function deleteSaved(id: string) {
    const live = open.find((o) => o.savedId === id);
    if (live) {
      try {
        await api.closeConnection(live.id);
      } catch {
        // Best effort.
      }
      setOpen((os) => os.filter((o) => o.savedId !== id));
      setActiveId((cur) => (cur === live.id ? null : cur));
    }
    persist(remove(saved, id));
    setEditingId((cur) => (cur === id ? null : cur));
  }

  function renderWorkspace(conn: OpenConnection) {
    const mod = conn.uiModule || conn.kind;
    switch (mod) {
      case "rdbms": {
        // The configured database seeds the workspace's database picker.
        const db = saved.find((s) => s.id === conn.savedId)?.config?.database;
        return (
          <RdbmsWorkspace
            key={conn.id}
            connectionId={conn.id}
            database={typeof db === "string" ? db : null}
          />
        );
      }
      case "document":
        return <DocumentWorkspace key={conn.id} connectionId={conn.id} />;
      case "rabbitmq":
        return <RabbitMqWorkspace key={conn.id} connectionId={conn.id} />;
      default:
        return (
          <div className="placeholder">No workspace available for “{mod}”.</div>
        );
    }
  }

  const formError = loadError
    ? "Failed to load plugins: " + loadError
    : connectError;

  return (
    <div className="app">
      <Sidebar
        saved={saved}
        plugins={plugins}
        openConnections={open}
        activeId={activeId}
        creating={creating || editingId !== null}
        onSelect={connectSaved}
        onNew={() => {
          setCreating(true);
          setEditingId(null);
          setActiveId(null);
          setConnectError(null);
        }}
        onEdit={(id) => {
          setEditingId(id);
          setCreating(false);
          setConnectError(null);
        }}
        onDelete={deleteSaved}
        onInstallPlugin={() => setInstalling(true)}
      />
      <main className="main">
        {showForm ? (
          <ConnectionForm
            key={editingId ?? (creating ? "new" : "default")}
            plugins={plugins}
            error={formError}
            initial={editingProfile}
            onSaveAndConnect={saveAndConnect}
          />
        ) : (
          <>
            <header className="workspace-header">
              <span className="workspace-title">{active!.name}</span>
              <span className="badge">{active!.pluginId}</span>
            </header>
            {renderWorkspace(active!)}
          </>
        )}
      </main>
      {installing && (
        <InstallPluginDialog
          onClose={() => setInstalling(false)}
          onInstalled={() => refreshPlugins()}
        />
      )}
    </div>
  );
}
