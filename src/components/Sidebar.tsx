import {useEffect, useRef, useState} from "react";
import type { OpenConnection } from "../App";
import type { PluginInfo, ConnectionId } from "../api";
import type { SavedConnection } from "../store";
import { THEMES } from "../theme";
import { getVersion } from '@tauri-apps/api/app'; // v2 Import


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
  /** Active UI theme id (one of THEMES). */
  theme: string;
  onThemeChange: (theme: string) => void;
  onSelect: (profile: SavedConnection) => void;
  onNew: () => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onDisconnect: (savedId: string) => void;
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
  theme,
  onThemeChange,
  onSelect,
  onNew,
  onEdit,
  onDelete,
  onDisconnect,
  onInstallPlugin,
  onCheckUpdates,
}: SidebarProps) {
  function kindOf(pluginId: string): string {
    return plugins.find((p) => p.id === pluginId)?.kind ?? "other";
  }

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const [version, setVersion] = useState('');

  useEffect(() => {
    // getVersion returns a Promise <string>
    getVersion()
        .then((appVersion) => setVersion(appVersion))
        .catch((err) => console.error('Failed to get version:', err));
  }, []);

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
        <span className="logo-badge" title="App Version">
          { channel === "nightly" ? "nightly" : `v${version}` }
        </span>
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
              className={
                "conn-item" +
                (isActive ? " active" : "") +
                (live ? " connected" : "")
              }
              onClick={() => onSelect(s)}
            >
              <span
                className={
                  "dot dot-" +
                  kindOf(s.pluginId) +
                  " dot-id-" +
                  s.pluginId +
                  (live ? " connected" : "")
                }
                title={live ? "Connected" : "Not connected"}
              />
              <span className="conn-name" title={s.name}>
                {s.name}
              </span>
              {live && (
                <button
                  className="icon-btn"
                  title="Disconnect"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDisconnect(s.id);
                  }}
                >
                  ⏏
                </button>
              )}
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
              <label className="footer-menu-theme">
                <span className="muted">Theme</span>
                <select
                  value={theme}
                  onChange={(e) => onThemeChange(e.target.value)}
                >
                  {THEMES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </label>
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
