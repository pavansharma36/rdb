import type { OpenConnection } from "../App";
import type { PluginInfo, ConnectionId } from "../api";
import type { SavedConnection } from "../store";

interface SidebarProps {
  saved: SavedConnection[];
  plugins: PluginInfo[];
  openConnections: OpenConnection[];
  activeId: ConnectionId | null;
  creating: boolean;
  onSelect: (profile: SavedConnection) => void;
  onNew: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onInstallPlugin: () => void;
}

export function Sidebar({
  saved,
  plugins,
  openConnections,
  activeId,
  creating,
  onSelect,
  onNew,
  onEdit,
  onDelete,
  onInstallPlugin,
}: SidebarProps) {
  function kindOf(pluginId: string): string {
    return plugins.find((p) => p.id === pluginId)?.kind ?? "other";
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <span className="logo">rdb</span>
        <span className="logo-sub">client</span>
      </div>
      <button
        className={"new-btn" + (creating ? " active" : "")}
        onClick={onNew}
      >
        + New connection
      </button>
      <button className="install-btn" onClick={onInstallPlugin}>
        ⤓ Install plugin
      </button>
      <nav className="conn-list">
        {saved.length === 0 && (
          <p className="muted">No saved connections.</p>
        )}
        {saved.map((s) => {
          const live = openConnections.find((o) => o.savedId === s.id);
          const isActive = !creating && live != null && live.id === activeId;
          return (
            <div
              key={s.id}
              className={"conn-item" + (isActive ? " active" : "")}
              onClick={() => onSelect(s)}
            >
              <span
                className={
                  "dot dot-" + kindOf(s.pluginId) + (live ? " connected" : "")
                }
                title={live ? "Connected" : "Not connected"}
              />
              <span className="conn-name">{s.name}</span>
              <button
                className="icon-btn"
                title="Edit connection"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(s.id);
                }}
              >
                ✎
              </button>
              <button
                className="close-x"
                title="Delete connection"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(s.id);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
