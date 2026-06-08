import {useEffect, useRef, useState, type CSSProperties} from "react";
import type { OpenConnection } from "../App";
import type { PluginInfo, ConnectionId } from "../api";
import type { SavedConnection } from "../store";
import { pluginLogo } from "../pluginLogos";
import { THEMES } from "../theme";
import { getVersion } from '@tauri-apps/api/app'; // v2 Import


interface SidebarProps {
  saved: SavedConnection[];
  plugins: PluginInfo[];
  /** The app's release channel ("nightly" or "stable"); shows a nightly badge. */
  channel: string;
  /** Sidebar width in CSS pixels (driven by the resize handle). */
  width: number;
  /** When true, render as a narrow rail that expands on hover. */
  collapsible: boolean;
  openConnections: OpenConnection[];
  activeId: ConnectionId | null;
  creating: boolean;
  /** Active UI theme id (one of THEMES). */
  theme: string;
  onThemeChange: (theme: string) => void;
  onToggleCollapsible: () => void;
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
  collapsible,
  openConnections,
  activeId,
  creating,
  theme,
  onThemeChange,
  onToggleCollapsible,
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
    <aside
      className={"sidebar" + (collapsible ? " collapsible" : "")}
      style={
        collapsible
          ? ({ "--sidebar-expanded": `${width}px` } as CSSProperties)
          : { width }
      }
    >
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
          const kind = kindOf(s.pluginId);
          const logo = pluginLogo(s.pluginId, kind);
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
              {logo ? (
                <img
                  className={"plugin-logo" + (live ? " connected" : "")}
                  src={logo}
                  alt=""
                  title={live ? "Connected" : "Not connected"}
                />
              ) : (
                <span
                  className={
                    "dot dot-" +
                    kind +
                    " dot-id-" +
                    s.pluginId +
                    (live ? " connected" : "")
                  }
                  title={live ? "Connected" : "Not connected"}
                />
              )}
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
        {/*<button*/}
        {/*  className="support-btn"*/}
        {/*  title="Support / Donate"*/}
        {/*  onClick={() => open("https://github.com/sponsors/pavansharma36")}*/}
        {/*>*/}
        {/*  ♥*/}
        {/*</button>*/}
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
              <label className="footer-menu-toggle">
                <input
                  type="checkbox"
                  checked={collapsible}
                  onChange={() => onToggleCollapsible()}
                />
                <span>Collapse sidebar</span>
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
