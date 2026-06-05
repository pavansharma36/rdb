// Persistent store for saved connection profiles.
//
// Profiles live in per-plugin JSON files in the OS app-data dir
// (connections/<pluginId>/connections.json), written by the Rust backend (see
// src-tauri/src/persistence.rs). The backend merges them into one list on load
// and splits them back out by plugin on save. This module is the single place
// the UI touches persistence.
//
// NOTE: configs are stored as-is, including any password field, in plaintext.

import { invoke } from "@tauri-apps/api/core";
import type { ConnectionConfig } from "./api";

/** A reusable connection the user has saved. `id` is stable across edits so
 * the sidebar selection and open-connection mapping survive updates. */
export interface SavedConnection {
  id: string;
  name: string;
  pluginId: string;
  config: ConnectionConfig;
}

/** Generate a stable profile id (falls back when crypto.randomUUID is absent). */
export function genId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "c-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Load all saved profiles from disk. */
export function loadConnections(): Promise<SavedConnection[]> {
  return invoke<SavedConnection[]>("load_connections");
}

/** Persist the full set of saved profiles to disk. */
export function saveConnections(connections: SavedConnection[]): Promise<void> {
  return invoke<void>("save_connections", { connections });
}

/** Pure: insert or replace `conn` (matched by id). Returns the new list. */
export function upsert(
  list: SavedConnection[],
  conn: SavedConnection,
): SavedConnection[] {
  const i = list.findIndex((c) => c.id === conn.id);
  return i >= 0 ? list.map((c) => (c.id === conn.id ? conn : c)) : [...list, conn];
}

/** Pure: remove the profile with `id`. Returns the new list. */
export function remove(list: SavedConnection[], id: string): SavedConnection[] {
  return list.filter((c) => c.id !== id);
}

// --- App config -----------------------------------------------------------
//
// App-wide UI state (not tied to any plugin/connection), persisted by the Rust
// backend at <app_data_dir>/config.json. See src-tauri/src/config.rs.

/** App-wide configuration. Mirrors the Rust `AppConfig` (camelCase). */
export interface AppConfig {
  /** Whether the first-run plugin install step has been shown to the user. */
  pluginsDialogShown: boolean;
  /** GitHub repo (`owner/name`) the in-app plugin installer fetches from. */
  pluginRepo: string;
  /** Sidebar width in CSS pixels, set by dragging the sidebar's resize handle. */
  sidebarWidth: number;
}

/** Load the app config, creating it with defaults on first run. */
export function loadConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("load_config");
}

/** Persist the full app config. */
export function saveConfig(config: AppConfig): Promise<void> {
  return invoke<void>("save_config", { config });
}

// --- Per-connection workspace files ---------------------------------------
//
// Plain `.sql` files saved per connection profile at
// <app_data_dir>/workspace/<connectionId>/<name>.sql. See
// src-tauri/src/workspace_files.rs. `connectionId` here is the stable
// saved-profile id, so files persist across sessions (not the per-session live
// connection id).

/** A saved workspace file. Mirrors the Rust `WorkspaceFile` (camelCase). */
export interface WorkspaceFile {
  /** File name without the `.sql` extension. */
  name: string;
  content: string;
}

/** List the saved workspace files for a connection profile, sorted by name. */
export function listWorkspaceFiles(
  connectionId: string,
): Promise<WorkspaceFile[]> {
  return invoke<WorkspaceFile[]>("list_workspace_files", { connectionId });
}

/** Create or overwrite a named workspace file for a connection profile. */
export function saveWorkspaceFile(
  connectionId: string,
  name: string,
  content: string,
): Promise<void> {
  return invoke<void>("save_workspace_file", { connectionId, name, content });
}

/** Delete a named workspace file from a connection profile. */
export function deleteWorkspaceFile(
  connectionId: string,
  name: string,
): Promise<void> {
  return invoke<void>("delete_workspace_file", { connectionId, name });
}
