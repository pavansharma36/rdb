import type { WorkspaceFile } from "../../../store";

interface SqlFileListProps {
  files: WorkspaceFile[];
  activeFile: string | null;
  /** The in-progress new-file name, or null when the add input is hidden. */
  newName: string | null;
  onToggleAdd: () => void;
  onNewNameChange: (v: string) => void;
  onSave: () => void;
  onCancelAdd: () => void;
  onLoad: (file: WorkspaceFile) => void;
  onRequestDelete: (name: string) => void;
}

/** The saved-SQL-file list with its inline "new file" name input. */
export function SqlFileList({
  files,
  activeFile,
  newName,
  onToggleAdd,
  onNewNameChange,
  onSave,
  onCancelAdd,
  onLoad,
  onRequestDelete,
}: SqlFileListProps) {
  return (
    <div className="tree-queries">
      <div className="tree-section-head">
        <span className="field-label">SQL files</span>
        <button
          className="tree-add"
          title="Save current SQL as a file"
          onClick={onToggleAdd}
        >
          ＋
        </button>
      </div>
      {newName !== null && (
        <input
          className="tree-name-input"
          autoFocus
          placeholder="file name…"
          value={newName}
          onChange={(e) => onNewNameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSave();
            else if (e.key === "Escape") onCancelAdd();
          }}
          onBlur={onSave}
        />
      )}
      <div className="tree-queries-list">
        {files.length === 0 ? (
          <p className="muted">No SQL files.</p>
        ) : (
          files.map((f) => (
            <div
              key={f.name}
              className={
                "tree-node leaf" + (activeFile === f.name ? " active" : "")
              }
              onClick={() => onLoad(f)}
              title="Load into editor"
            >
              <span className="conn-name">{f.name}.sql</span>
              <button
                className="close-x"
                title="Delete SQL file"
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestDelete(f.name);
                }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
