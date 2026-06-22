import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Modal } from "../../Modal";
import { JsonEditor } from "../../JsonEditor";

interface CellEditorModalProps {
  columnName: string;
  /** Whether to edit as JSON (syntax-highlighted, with Validate/Format). */
  json: boolean;
  draft: string;
  message: { kind: "error" | "ok"; text: string } | null;
  onDraftChange: (v: string) => void;
  onApply: () => void;
  onSetNull: () => void;
  onCancel: () => void;
}

/** Modal editor for large cell values (text/json/xml), opened on double-click.
 * JSON columns get the syntax-highlighting {@link JsonEditor} (its own
 * Validate/Format actions, quote-normalizing); other types use a plain
 * textarea. ⌘/Ctrl+Enter applies, Esc cancels. */
export function CellEditorModal({
  columnName,
  json,
  draft,
  message,
  onDraftChange,
  onApply,
  onSetNull,
  onCancel,
}: CellEditorModalProps) {
  // Esc cancels, ⌘/Ctrl+Enter applies — shared by both editor variants.
  function onKeyDown(e: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      onApply();
    }
  }

  return (
    <Modal
      className="cell-editor-modal"
      onClose={onCancel}
      title={
        <>
          Edit <code>{columnName}</code>
          {json && <span className="channel-tag">json</span>}
        </>
      }
    >
      {json ? (
        <JsonEditor
          className="cell-editor"
          autoFocus
          value={draft}
          onChange={onDraftChange}
          onKeyDown={onKeyDown}
        />
      ) : (
        <textarea
          className="cell-editor"
          autoFocus
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
      )}
      {message && <div className={"msg " + message.kind}>{message.text}</div>}
      <div className="form-actions cell-editor-actions">
        <span className="spacer" />
        <button onClick={onSetNull} title="Set NULL">
          Set NULL
        </button>
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" onClick={onApply}>
          Apply
        </button>
      </div>
    </Modal>
  );
}
