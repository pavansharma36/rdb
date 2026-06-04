import { useState } from "react";
import { api, errString } from "../api";
import type { GithubPreview, PluginInfo } from "../api";

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

/** Install a plugin from a GitHub release: fetch (preview) the matching asset
 *  and its checksum, then confirm to download, verify, and install. */
export function InstallPluginDialog({ onClose, onInstalled }: InstallPluginDialogProps) {
  const [repo, setRepo] = useState("");
  const [tag, setTag] = useState("");
  const [preview, setPreview] = useState<GithubPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "install" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function onFetch() {
    setError(null);
    setPreview(null);
    setBusy("preview");
    try {
      const p = await api.previewGithubPlugin(repo.trim(), tag.trim() || null);
      setPreview(p);
    } catch (e) {
      setError(errString(e));
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
      onInstalled(info);
      onClose();
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
          <span>Install plugin from GitHub</span>
          <button className="close-x" onClick={onClose} title="Close">
            ×
          </button>
        </header>

        <label className="field">
          <span>Repository</span>
          <input
            type="text"
            placeholder="owner/name"
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            autoFocus
          />
        </label>
        <label className="field">
          <span>Release tag (optional)</span>
          <input
            type="text"
            placeholder="latest"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
          />
        </label>

        <button onClick={onFetch} disabled={!repo.trim() || busy !== null}>
          {busy === "preview" ? "Fetching…" : "Fetch release"}
        </button>

        {preview && (
          <div className="preview">
            <div className="preview-row">
              <span className="muted">Version</span>
              <span>{preview.tag}</span>
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
