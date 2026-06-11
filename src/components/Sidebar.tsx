import {useEffect, useRef, useState, type CSSProperties} from "react";
import type { OpenConnection } from "../App";
import type { PluginInfo, ConnectionId } from "../api";
import type { SavedConnection } from "../store";
import { pluginLogo } from "../pluginLogos";
import { THEMES } from "../theme";
import { Modal } from "./Modal";
import { open as openExternal } from "@tauri-apps/plugin-shell";
import { getVersion } from '@tauri-apps/api/app'; // v2 Import
import pkg from "../../package.json";

/** Project home (from package.json) — opened by Help and shown in About. */
const REPO_URL = pkg.homepage;


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
  onClone: (id: string) => void;
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
  onClone,
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

  // Saved-profile id whose per-connection actions popup (⋮) is open, or null.
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  // Viewport coords (right/top, px) to anchor the open popup. The popup is
  // position:fixed so it escapes the scrollable .conn-list (which would
  // otherwise clip it and add a scrollbar).
  const [menuPos, setMenuPos] = useState<{ right: number; top: number } | null>(
    null,
  );
  const connMenuRef = useRef<HTMLDivElement>(null);

  const [version, setVersion] = useState('');
  // When true, the About dialog is shown.
  const [aboutOpen, setAboutOpen] = useState(false);

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

  // Dismiss an open per-connection actions popup on any outside click. The
  // popup is position:fixed, so also close it on scroll (it wouldn't follow the
  // row) — captured so a scroll anywhere, including inside .conn-list, fires.
  useEffect(() => {
    if (openMenuId === null) return;
    function onClick(e: MouseEvent) {
      if (connMenuRef.current && !connMenuRef.current.contains(e.target as Node)) {
        setOpenMenuId(null);
      }
    }
    function onScroll() {
      setOpenMenuId(null);
    }
    document.addEventListener("mousedown", onClick);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onClick);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [openMenuId]);

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
              <div
                className="conn-menu"
                ref={openMenuId === s.id ? connMenuRef : undefined}
              >
                <button
                  className="icon-btn"
                  title="More"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (openMenuId === s.id) {
                      setOpenMenuId(null);
                      return;
                    }
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenuPos({
                      right: window.innerWidth - r.right,
                      top: r.bottom + 4,
                    });
                    setOpenMenuId(s.id);
                  }}
                >
                  ⋮
                </button>
                {openMenuId === s.id && menuPos && (
                  <div
                    className="conn-menu-popup"
                    style={{ right: menuPos.right, top: menuPos.top }}
                  >
                    <button
                      className="footer-menu-item"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuId(null);
                        onEdit(s.id);
                      }}
                    >
                      ✎ Edit
                    </button>
                    <button
                      className="footer-menu-item"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuId(null);
                        onClone(s.id);
                      }}
                    >
                      ⧉ Clone
                    </button>
                    <button
                      className="footer-menu-item danger"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuId(null);
                        onDelete(s.id);
                      }}
                    >
                      × Delete
                    </button>
                  </div>
                )}
              </div>
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
              <button
                className="footer-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  openExternal(REPO_URL).catch(() => {});
                }}
              >
                ? Help
              </button>
              <button
                className="footer-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  setAboutOpen(true);
                }}
              >
                ⓘ About
              </button>
            </div>
          )}
        </div>
      </div>
      {aboutOpen && (
        <Modal title="About rdb" onClose={() => setAboutOpen(false)}>
          <div className="about-dialog">
            <p className="about-name">
              <span className="logo">rdb</span>{" "}
              <span className="muted">client</span>
            </p>
            <p>
              Version{" "}
              <strong>
                {channel === "nightly" ? `${version} (nightly)` : `v${version}`}
              </strong>
            </p>
            <p className="muted">
              A cross-platform desktop client for relational databases, document
              stores, and message brokers.
            </p>
            <p>
              <a
                href={REPO_URL}
                onClick={(e) => {
                  e.preventDefault();
                  openExternal(REPO_URL).catch(() => {});
                }}
              >
                {REPO_URL}
              </a>
            </p>
            <p className="muted">Licensed under MIT OR Apache-2.0.</p>
          </div>
        </Modal>
      )}
    </aside>
  );
}
