import { Modal } from "../../Modal";

interface CellEditorModalProps {
  columnName: string;
  /** Whether to show the JSON Validate/Format helpers. */
  json: boolean;
  draft: string;
  message: { kind: "error" | "ok"; text: string } | null;
  onDraftChange: (v: string) => void;
  onValidate: () => void;
  onFormat: () => void;
  onApply: () => void;
  onSetNull: () => void;
  onCancel: () => void;
}

/** Modal editor for large cell values (text/json/xml), opened on double-click.
 * For JSON columns it offers Validate/Format. ⌘/Ctrl+Enter applies, Esc cancels. */
export function CellEditorModal({
  columnName,
  json,
  draft,
  message,
  onDraftChange,
  onValidate,
  onFormat,
  onApply,
  onSetNull,
  onCancel,
}: CellEditorModalProps) {
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
      <textarea
        className="cell-editor"
        autoFocus
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            onApply();
          }
        }}
      />
      {message && <div className={"msg " + message.kind}>{message.text}</div>}
      <div className="form-actions cell-editor-actions">
        {json && (
          <>
            <button onClick={onValidate}>Validate JSON</button>
            <button onClick={onFormat}>Format</button>
          </>
        )}
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
