import { useEffect, useState } from "react";
import { api, errString } from "../api";
import type { AvailablePlugin, GithubPreview, PluginInfo, PluginStatus } from "../api";
import { loadConfig } from "../store";
import { Modal } from "./Modal";

interface InstallPluginDialogProps {
  onClose: () => void;
  /** Called after a successful install with the new plugin's info. */
  onInstalled: (info: PluginInfo) => void;
}

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + " KB";
  return bytes + " B";
}

/** The action button label for a plugin's install/update status. */
function actionLabel(status: PluginStatus): string {
  switch (status) {
    case "not_installed":
      return "Install";
    case "update_available":
      return "Update";
    case "up_to_date":
      return "✓ Installed";
    case "unknown":
      return "Reinstall";
  }
}

/** Install a plugin from the configured GitHub repo. The installable plugins
 *  (the app channel's releases) are fetched up front with a per-plugin
 *  install/update status, so there is no repo/tag to type — pick a plugin,
 *  confirm the checksum, install. */
export function InstallPluginDialog({ onClose, onInstalled }: InstallPluginDialogProps) {
  const [repo, setRepo] = useState<string>("");
  const [channel, setChannel] = useState<string>("");
  const [available, setAvailable] = useState<AvailablePlugin[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The plugin the user picked, plus its fetched preview (asset + checksum)
  // awaiting confirmation.
  const [selected, setSelected] = useState<AvailablePlugin | null>(null);
  const [preview, setPreview] = useState<GithubPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the configured repo + app channel, then the available plugin list
  // (each entry already carries its install/update status from the host).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cfg, ch] = await Promise.all([loadConfig(), api.appChannel()]);
        if (cancelled) return;
        setRepo(cfg.pluginRepo);
        setChannel(ch);
        const avail = await api.listGithubPlugins(cfg.pluginRepo);
        if (cancelled) return;
        setAvailable(avail);
      } catch (e) {
        if (!cancelled) setLoadError(errString(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Pick a plugin and fetch its preview (asset + published checksum) for the
   *  confirmation step. Nothing is downloaded or executed yet. */
  async function onSelect(plugin: AvailablePlugin) {
    setError(null);
    setPreview(null);
    setSelected(plugin);
    setBusy("preview");
    try {
      const p = await api.previewGithubPlugin(repo, plugin.tag, plugin.id);
      setPreview(p);
    } catch (e) {
      setError(errString(e));
      setSelected(null);
    } finally {
      setBusy(null);
    }
  }

  async function onInstall() {
    if (!preview || !selected) return;
    setError(null);
    setBusy("install");
    try {
      const info = await api.installGithubPlugin(
        preview.repo,
        preview.tag,
        selected.id,
        preview.sha256,
      );
      // Reflect the new install in the list: this plugin is now up to date.
      setAvailable((list) =>
        (list ?? []).map((p) =>
          p.id === info.id
            ? { ...p, status: "up_to_date", installedVersion: info.version }
            : p,
        ),
      );
      setSelected(null);
      setPreview(null);
      onInstalled(info);
    } catch (e) {
      setError(errString(e));
    } finally {
      setBusy(null);
    }
  }

  /** Secondary line under a plugin name: size + install/update state. */
  function statusNote(plugin: AvailablePlugin): string {
    const size = formatSize(plugin.sizeBytes);
    const v = plugin.installedVersion;
    switch (plugin.status) {
      case "up_to_date":
        return `${size} · up to date${v ? ` (v${v})` : ""}`;
      case "update_available":
        return `${size} · update available${v ? ` (have v${v})` : ""}`;
      case "unknown":
        return `${size} · installed${v ? ` (v${v})` : ""}`;
      case "not_installed":
        return size;
    }
  }

  return (
    <Modal
      onClose={onClose}
      title={
        <>
          Install plugin{repo ? ` from ${repo}` : ""}
          {channel && <span className="channel-tag">{channel}</span>}
        </>
      }
    >
      {loadError && <p className="msg error">{loadError}</p>}

        {!available && !loadError && <p className="muted">Loading plugins…</p>}

        {available && available.length === 0 && !loadError && (
          <p className="muted">
            No installable plugins found for this platform in <code>{repo}</code>.
          </p>
        )}

        {available && available.length > 0 && (
          <ul className="plugin-list">
            {available.map((plugin) => {
              const active = selected?.id === plugin.id;
              const upToDate = plugin.status === "up_to_date";
              return (
                <li key={plugin.id} className="plugin-row">
                  <div className="plugin-row-main">
                    <span className="plugin-name">{plugin.id}</span>
                    <span className="muted small">{statusNote(plugin)}</span>
                  </div>
                  <button
                    onClick={() => onSelect(plugin)}
                    disabled={busy !== null || upToDate}
                    className={plugin.status === "update_available" ? "primary" : ""}
                  >
                    {active && busy === "preview"
                      ? "Fetching…"
                      : actionLabel(plugin.status)}
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {selected && preview && (
          <div className="preview">
            <div className="preview-row">
              <span className="muted">Plugin</span>
              <span>{selected.id}</span>
            </div>
            <div className="preview-row">
              <span className="muted">Asset</span>
              <span>{preview.assetName}</span>
            </div>
            <div className="preview-row">
              <span className="muted">Size</span>
              <span>{formatSize(preview.sizeBytes)}</span>
            </div>
            <div className="preview-row">
              <span className="muted">Checksum</span>
              {preview.sha256 ? (
                <span className="ok" title={preview.sha256}>
                  ✓ sha256 published
                </span>
              ) : (
                <span className="warn">⚠ no published checksum</span>
              )}
            </div>
            {!preview.sha256 && (
              <p className="warn small">
                This release publishes no checksum. The download cannot be
                verified — only install if you trust this source.
              </p>
            )}
            <p className="muted small">
              Plugins are native executables that run with full access to your
              machine. Only install plugins you trust.
            </p>
            <button className="primary" onClick={onInstall} disabled={busy !== null}>
              {busy === "install"
                ? "Installing…"
                : preview.sha256
                ? "Verify & install"
                : "Install anyway"}
            </button>
          </div>
        )}

        {error && <p className="msg error">{error}</p>}
    </Modal>
  );
}
