import { useEffect, useState } from "react";
import { api, errString } from "../api";
import type { AvailablePlugin, GithubPreview, PluginInfo } from "../api";
import { loadConfig } from "../store";

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

/** Install a plugin from the configured GitHub repo. The list of plugins (its
 *  rolling `<plugin>-latest` releases) is fetched up front, so there is no
 *  repo/tag to type — pick a plugin, confirm the checksum, install. */
export function InstallPluginDialog({ onClose, onInstalled }: InstallPluginDialogProps) {
  const [repo, setRepo] = useState<string>("");
  const [available, setAvailable] = useState<AvailablePlugin[] | null>(null);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);

  // The plugin the user picked, plus its fetched preview (asset + checksum)
  // awaiting confirmation.
  const [selected, setSelected] = useState<AvailablePlugin | null>(null);
  const [preview, setPreview] = useState<GithubPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Load the configured repo, then the available + installed plugin lists.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cfg = await loadConfig();
        if (cancelled) return;
        setRepo(cfg.pluginRepo);
        const [avail, inst] = await Promise.all([
          api.listGithubPlugins(cfg.pluginRepo),
          api.listPlugins(),
        ]);
        if (cancelled) return;
        setAvailable(avail);
        setInstalled(new Set(inst.map((p) => p.id)));
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
      const p = await api.previewGithubPlugin(repo, plugin.tag);
      setPreview(p);
    } catch (e) {
      setError(errString(e));
      setSelected(null);
    } finally {
      setBusy(null);
    }
  }

  async function onInstall() {
    if (!preview) return;
    setError(null);
    setBusy("install");
    try {
      const info = await api.installGithubPlugin(
        preview.repo,
        preview.tag,
        preview.sha256,
      );
      // Reflect the new install in the list and close the confirm panel.
      setInstalled((s) => new Set(s).add(info.id));
      setSelected(null);
      setPreview(null);
      onInstalled(info);
    } catch (e) {
      setError(errString(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <span>Install plugin{repo ? ` from ${repo}` : ""}</span>
          <button className="close-x" onClick={onClose} title="Close">
            ×
          </button>
        </header>

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
              const isInstalled = installed.has(plugin.id);
              const active = selected?.tag === plugin.tag;
              return (
                <li key={plugin.tag} className="plugin-row">
                  <div className="plugin-row-main">
                    <span className="plugin-name">{plugin.id}</span>
                    <span className="muted small">
                      {formatSize(plugin.sizeBytes)}
                      {isInstalled && " · installed"}
                    </span>
                  </div>
                  <button
                    onClick={() => onSelect(plugin)}
                    disabled={busy !== null}
                  >
                    {active && busy === "preview"
                      ? "Fetching…"
                      : isInstalled
                      ? "Update"
                      : "Install"}
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
      </div>
    </div>
  );
}
