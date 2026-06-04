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
