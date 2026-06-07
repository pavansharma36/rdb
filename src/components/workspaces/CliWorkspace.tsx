import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen } from "@tauri-apps/api/event";
import { ptySpawn, ptyWrite, ptyResize, ptySnapshot } from "../../api";
import type { ConnectionId } from "../../api";
import {
  listWorkspaceFiles,
  saveWorkspaceFile,
  deleteWorkspaceFile,
  type WorkspaceFile,
} from "../../store";
import { WorkspaceFileList } from "./WorkspaceFileList";
import { ConfirmDialog } from "../Modal";
import "@xterm/xterm/css/xterm.css";

interface Props {
  connectionId: ConnectionId;
  /** Stable saved-profile id; scopes saved scripts to this profile. */
  savedId: string;
}

/** Scripts are stored as `.sh` workspace files (vs `.sql` for RDBMS). */
const SCRIPT_EXT = "sh";

export function CliWorkspace({ connectionId, savedId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLTextAreaElement>(null);
  // The PTY writer is the live terminal: "Run" pipes a script into ssh's stdin.
  const writeToPty = useRef<(text: string) => void>(() => {});

  // Saved scripts for this profile, the editor buffer, and the active file.
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [script, setScript] = useState("");
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [newName, setNewName] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // ----- Terminal lifecycle -----
  //
  // The ssh PTY lives in the Tauri host (PtyManager) and outlives this
  // component, so the session survives unmount/remount (switching connections).
  // On mount we (idempotently) ensure the PTY is running, subscribe to its
  // output, and replay the host's retained scrollback so the terminal repaints
  // its history. On unmount we only tear down the xterm + listener — never the
  // PTY. The session is closed only on explicit disconnect (see App.disconnect,
  // which calls ptyClose).
  useEffect(() => {
    if (!containerRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"Cascadia Code", "JetBrains Mono", Menlo, monospace',
      allowTransparency: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();

    const onData = term.onData((data) => {
      const bytes = Array.from(new TextEncoder().encode(data));
      ptyWrite(connectionId, bytes).catch(() => {});
    });

    // Expose a writer so "Run" can pipe a script's text into the PTY.
    writeToPty.current = (text: string) => {
      const bytes = Array.from(new TextEncoder().encode(text));
      ptyWrite(connectionId, bytes).catch(() => {});
    };

    let disposed = false;
    const eventName = `pty://output/${connectionId}`;
    let unlisten: (() => void) | undefined;

    // Subscribe to live output first, then replay scrollback, so we never miss
    // bytes that arrive between the snapshot and the subscription.
    listen<number[]>(eventName, (event) => {
      term.write(new Uint8Array(event.payload));
    })
      .then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        unlisten = fn;
        // Ensure the PTY exists (idempotent), then repaint retained history.
        return ptySpawn(connectionId)
          .then(() => ptySnapshot(connectionId))
          .then((bytes) => {
            if (!disposed && bytes.length) {
              term.write(new Uint8Array(bytes));
            }
          });
      })
      .catch((e: unknown) => {
        if (!disposed) term.writeln(`\r\n\x1b[31mSSH error: ${e}\x1b[0m`);
      });

    const ro = new ResizeObserver(() => {
      fit.fit();
      ptyResize(connectionId, term.cols, term.rows).catch(() => {});
    });
    ro.observe(containerRef.current);

    return () => {
      disposed = true;
      onData.dispose();
      unlisten?.();
      ro.disconnect();
      term.dispose();
      writeToPty.current = () => {};
      // Intentionally NOT closing the PTY here: the host keeps the ssh session
      // alive so a remount (or switching back) reattaches to it.
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ----- Saved scripts -----
  useEffect(() => {
    listWorkspaceFiles(savedId, SCRIPT_EXT)
      .then(setFiles)
      .catch(() => setFiles([]));
  }, [savedId]);

  function loadFile(f: WorkspaceFile) {
    setActiveFile(f.name);
    setScript(f.content);
  }

  // Autosave the active script ~800ms after the last keystroke. No-op when
  // nothing's loaded or the content already matches what's on disk.
  useEffect(() => {
    if (!activeFile) return;
    const stored = files.find((f) => f.name === activeFile);
    if (!stored || stored.content === script) return;
    const t = setTimeout(() => {
      saveWorkspaceFile(savedId, activeFile, script, SCRIPT_EXT)
        .then(() =>
          setFiles((prev) =>
            prev.map((f) =>
              f.name === activeFile ? { ...f, content: script } : f,
            ),
          ),
        )
        .catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [script, activeFile, files, savedId]);

  async function saveNew() {
    const name = (newName ?? "").trim();
    if (!name) {
      setNewName(null);
      return;
    }
    await saveWorkspaceFile(savedId, name, script, SCRIPT_EXT);
    setFiles(await listWorkspaceFiles(savedId, SCRIPT_EXT));
    setActiveFile(name);
    setNewName(null);
  }

  async function confirmDelete() {
    const name = pendingDelete;
    if (!name) return;
    await deleteWorkspaceFile(savedId, name, SCRIPT_EXT);
    setFiles(await listWorkspaceFiles(savedId, SCRIPT_EXT));
    if (activeFile === name) {
      setActiveFile(null);
      setScript("");
    }
    setPendingDelete(null);
  }

  /** Pipe a script's text into the SSH terminal (with a trailing newline so the
   * shell executes the final line). */
  function runScript(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return;
    const body = text.endsWith("\n") ? text : text + "\n";
    writeToPty.current(body);
  }

  /** The current selection in the editor, or null if nothing is selected. */
  function selectedText(): string | null {
    const ta = editorRef.current;
    if (!ta) return null;
    const { selectionStart, selectionEnd } = ta;
    if (selectionStart === selectionEnd) return null;
    return ta.value.slice(selectionStart, selectionEnd);
  }

  /** The full line the cursor sits on (newlines stripped at the boundaries). */
  function cursorLine(): string {
    const ta = editorRef.current;
    if (!ta) return "";
    const v = ta.value;
    const pos = ta.selectionStart;
    const start = v.lastIndexOf("\n", pos - 1) + 1;
    const endNl = v.indexOf("\n", pos);
    const end = endNl === -1 ? v.length : endNl;
    return v.slice(start, end);
  }

  /** Run button: run the selection if any, else the whole script. */
  function runSelectionOrAll() {
    runScript(selectedText() ?? script);
  }

  /** Ctrl/Cmd+Enter: run the selection if any, else the line the cursor is on. */
  function runSelectionOrLine() {
    runScript(selectedText() ?? cursorLine());
  }

  // True while the active script has edits not yet flushed to disk by autosave.
  const unsaved =
    activeFile != null &&
    files.find((f) => f.name === activeFile)?.content !== script;

  return (
    <div className="workspace cli-workspace">
      <div className="cli-top">
        <div className="cli-scripts">
          <WorkspaceFileList
            files={files}
            activeFile={activeFile}
            newName={newName}
            onToggleAdd={() => setNewName(newName === null ? "" : null)}
            onNewNameChange={setNewName}
            onSave={saveNew}
            onCancelAdd={() => setNewName(null)}
            onLoad={loadFile}
            onRequestDelete={setPendingDelete}
            onRun={(f) => runScript(f.content)}
            label="Scripts"
            ext={SCRIPT_EXT}
            addTitle="Save current script as a file"
            emptyText="No scripts."
          />
        </div>
        <div className="cli-editor">
          <div className="cli-editor-head">
            <span className="editor-file-name">
              {activeFile ? `${activeFile}.sh` : "Script"}
            </span>
            {activeFile && (
              <span className="muted cli-save-status">
                {unsaved ? "Saving…" : "Saved"}
              </span>
            )}
            <div className="cli-editor-actions">
              <button
                className="primary"
                title="Run selection, or whole script (Cmd/Ctrl+Enter runs the current line)"
                disabled={!script.trim()}
                onClick={runSelectionOrAll}
              >
                ▶ Run
              </button>
            </div>
          </div>
          <textarea
            ref={editorRef}
            className="cli-editor-area"
            value={script}
            placeholder="# Write a shell script, then Run to pipe it into the SSH session…"
            spellCheck={false}
            onChange={(e) => setScript(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                runSelectionOrLine();
              }
            }}
          />
        </div>
      </div>
      <div ref={containerRef} className="cli-terminal" />
      {pendingDelete && (
        <ConfirmDialog
          title="Delete script"
          message={`Delete "${pendingDelete}.sh"? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}
