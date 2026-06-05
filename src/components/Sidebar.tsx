import { useEffect, useRef, useState } from "react";
import type { OpenConnection } from "../App";
import type { PluginInfo, ConnectionId } from "../api";
import type { SavedConnection } from "../store";

interface SidebarProps {
  saved: SavedConnection[];
  plugins: PluginInfo[];
  /** The app's release channel ("nightly" or "stable"); shows a nightly badge. */
  channel: string;
  /** Sidebar width in CSS pixels (driven by the resize handle). */
  width: number;
  openConnections: OpenConnection[];
  activeId: ConnectionId | null;
  creating: boolean;
  onSelect: (profile: SavedConnection) => void;
  onNew: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onInstallPlugin: () => void;
  onCheckUpdates: () => void;
}

export function Sidebar({
  saved,
  plugins,
  channel,
  width,
  openConnections,
  activeId,
  creating,
  onSelect,
  onNew,
  onEdit,
  onDelete,
  onInstallPlugin,
  onCheckUpdates,
}: SidebarProps) {
  function kindOf(pluginId: string): string {
    return plugins.find((p) => p.id === pluginId)?.kind ?? "other";
  }

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [menuOpen]);

  return (
    <aside className="sidebar" style={{ width }}>
      <div className="sidebar-header">
        <span className="logo">rdb</span>
        <span className="logo-sub">client</span>
        {channel === "nightly" && (
          <span className="logo-badge" title="Nightly build">
            nightly
          </span>
        )}
      </div>
      <button
        className={"new-btn" + (creating ? " active" : "")}
        onClick={onNew}
      >
        + New connection
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
              <span className="conn-name" title={s.name}>
                {s.name}
              </span>
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
      <div className="sidebar-footer">
        <button className="install-btn" onClick={onInstallPlugin}>
          ⤓ Install plugin
        </button>
        <div className="footer-menu" ref={menuRef}>
          <button
            className="icon-btn"
            title="More"
            onClick={() => setMenuOpen((o) => !o)}
          >
            ⋮
          </button>
          {menuOpen && (
            <div className="footer-menu-popup">
              <button
                className="footer-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onCheckUpdates();
                }}
              >
                Check for updates
              </button>
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
