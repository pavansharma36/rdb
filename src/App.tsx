import { useEffect, useMemo, useState } from "react";
import { api, errString } from "./api";
import type { PluginInfo, ConnectionId, PluginKind } from "./api";
import { Sidebar } from "./components/Sidebar";
import { ConnectionForm } from "./components/ConnectionForm";
import { InstallPluginDialog } from "./components/InstallPluginDialog";
import { UpdateBanner } from "./components/UpdateBanner";
import { ConfirmDialog } from "./components/Modal";
import { checkForUpdate, type UpdateInfo } from "./updater";
import { RdbmsWorkspace } from "./components/workspaces/RdbmsWorkspace";
import { DocumentWorkspace } from "./components/workspaces/DocumentWorkspace";
import { RabbitMqWorkspace } from "./components/workspaces/RabbitMqWorkspace";
import type { SavedConnection } from "./store";
import { loadConnections, saveConnections, upsert, remove } from "./store";
import { loadConfig, saveConfig } from "./store";
import type { AppConfig } from "./store";
import { applyTheme, resolveTheme } from "./theme";

/** Min/max sidebar width (px) enforced while dragging the resize handle. */
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 500;

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
  // The release channel this app build tracks ("nightly" or "stable").
  const [channel, setChannel] = useState<string>("");
  // An available app self-update (auto-checked on launch + manual).
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  // Transient note from a manual update check ("up to date" / error).
  const [updateNote, setUpdateNote] = useState<string | null>(null);
  // Persisted app config (UI prefs); kept so width saves merge other fields.
  const [config, setConfig] = useState<AppConfig | null>(null);
  // Sidebar width in px, restored from config and updated by the drag handle.
  const [sidebarWidth, setSidebarWidth] = useState(240);
  // Saved-profile id pending a delete confirmation (null = no prompt shown).
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  useEffect(() => {
    api
      .listPlugins()
      .then(setPlugins)
      .catch((e) => setLoadError(errString(e)));
    api
      .appChannel()
      .then(setChannel)
      .catch(() => {});
    loadConnections()
      .then(setSaved)
      .catch((e) => setLoadError(errString(e)));
    // First launch: show the plugin install step once, then remember it so it
    // doesn't reappear on subsequent launches.
    loadConfig()
      .then((cfg) => {
        const effective = cfg.pluginsDialogShown
          ? cfg
          : { ...cfg, pluginsDialogShown: true };
        setConfig(effective);
        applyTheme(cfg.theme);
        if (cfg.sidebarWidth) {
          setSidebarWidth(
            Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, cfg.sidebarWidth)),
          );
        }
        if (!cfg.pluginsDialogShown) {
          setInstalling(true);
          saveConfig(effective).catch(() => {});
        }
      })
      .catch(() => {});
    // Auto-check for an app update shortly after launch (non-blocking; errors,
    // e.g. running under `tauri dev`, are ignored).
    const t = setTimeout(() => {
      checkForUpdate()
        .then((u) => u && setUpdate(u))
        .catch(() => {});
    }, 3000);
    return () => clearTimeout(t);
  }, []);

  /** Manual "Check for updates": show the banner if one exists, else a note. */
  function checkForUpdates() {
    setUpdateNote(null);
    checkForUpdate()
      .then((u) => {
        if (u) setUpdate(u);
        else {
          setUpdateNote("You're up to date.");
          setTimeout(() => setUpdateNote(null), 4000);
        }
      })
      .catch((e) => {
        setUpdateNote(errString(e));
        setTimeout(() => setUpdateNote(null), 5000);
      });
  }

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

  /** Close the live connection for a saved profile (leaving the profile). */
  async function disconnect(savedId: string) {
    const live = open.find((o) => o.savedId === savedId);
    if (!live) return;
    try {
      await api.closeConnection(live.id);
    } catch {
      // Best effort — drop it locally regardless.
    }
    setOpen((os) => os.filter((o) => o.id !== live.id));
    setActiveId((cur) => (cur === live.id ? null : cur));
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
            savedId={conn.savedId}
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

  // Drag the divider between sidebar and main to resize; persist on release.
  function startSidebarResize(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    function onMove(ev: MouseEvent) {
      const next = Math.min(
        SIDEBAR_MAX,
        Math.max(SIDEBAR_MIN, startWidth + ev.clientX - startX),
      );
      setSidebarWidth(next);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      setSidebarWidth((w) => {
        saveConfig({ ...(config ?? ({} as AppConfig)), sidebarWidth: w }).catch(
          () => {},
        );
        return w;
      });
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
  }

  /** Switch the UI theme: apply it immediately and persist to config. */
  function changeTheme(theme: string) {
    applyTheme(theme);
    setConfig((c) => {
      const next = { ...(c ?? ({} as AppConfig)), theme };
      saveConfig(next).catch(() => {});
      return next;
    });
  }

  return (
    <div className="app">
      <Sidebar
        saved={saved}
        plugins={plugins}
        channel={channel}
        width={sidebarWidth}
        openConnections={open}
        activeId={activeId}
        creating={creating || editingId !== null}
        theme={resolveTheme(config?.theme)}
        onThemeChange={changeTheme}
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
        onDelete={(id) => setPendingDelete(id)}
        onDisconnect={disconnect}
        onInstallPlugin={() => setInstalling(true)}
        onCheckUpdates={checkForUpdates}
      />
      <div
        className="sidebar-resizer"
        onMouseDown={startSidebarResize}
        title="Drag to resize sidebar"
      />
      <main className="main">
        {showForm ? (
          <ConnectionForm
            key={editingId ?? (creating ? "new" : "default")}
            plugins={plugins}
            error={formError}
            existing={saved}
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
      {update && (
        <UpdateBanner update={update} onDismiss={() => setUpdate(null)} />
      )}
      {updateNote && <div className="update-toast">{updateNote}</div>}
      {pendingDelete && (
        <ConfirmDialog
          title="Delete connection"
          message={
            <>
              Delete{" "}
              <strong>
                {saved.find((c) => c.id === pendingDelete)?.name ??
                  "this connection"}
              </strong>
              ? This can't be undone.
            </>
          }
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => {
            const id = pendingDelete;
            setPendingDelete(null);
            void deleteSaved(id);
          }}
        />
      )}
    </div>
  );
}
