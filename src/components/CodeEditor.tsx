import { useMemo } from "react";
import hljs from "highlight.js/lib/core";
import sql from "highlight.js/lib/languages/sql";
import bash from "highlight.js/lib/languages/bash";
import json from "highlight.js/lib/languages/json";

// Only register the languages the workspace editors actually use, so the bundle
// stays small (the full highlight.js ships ~190 grammars).
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("json", json);

export type CodeLanguage = "sql" | "bash" | "json";

interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  language: CodeLanguage;
  /** Applied to the wrapper for per-editor sizing (e.g. "code", "cli-editor-area"). */
  className?: string;
  placeholder?: string;
  spellCheck?: boolean;
  /** Forwarded to the inner <textarea> (CliWorkspace reads its selection). */
  textareaRef?: React.Ref<HTMLTextAreaElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLTextAreaElement>;
  autoFocus?: boolean;
}

/**
 * A syntax-highlighting code editor built with the standard transparent-textarea
 * overlay: a highlighted <pre><code> sits behind a real <textarea> whose own text
 * is transparent (only its caret/selection show). The textarea remains the
 * interactive element, so native selection, keydown handlers, and controlled
 * value/onChange behavior are unchanged — callers keep their autosave and
 * run-selection logic. The two layers share identical typography/box metrics
 * (see .code-editor in styles.css) so glyphs line up exactly.
 */
export function CodeEditor({
  value,
  onChange,
  language,
  className,
  placeholder,
  spellCheck = false,
  textareaRef,
  onKeyDown,
  autoFocus,
}: CodeEditorProps) {
  const html = useMemo(() => {
    // highlight.js escapes its input, so the result is safe to inject. Append a
    // newline when the value lacks a trailing one so the highlighted block's
    // height matches the textarea's (which always reserves a final empty line).
    const src = value.endsWith("\n") ? value + " " : value;
    return hljs.highlight(src, { language }).value;
  }, [value, language]);

  // Keep the highlighted layer scrolled in lockstep with the textarea.
  function syncScroll(e: React.UIEvent<HTMLTextAreaElement>) {
    const pre = e.currentTarget.previousElementSibling as HTMLElement | null;
    if (pre) {
      pre.scrollTop = e.currentTarget.scrollTop;
      pre.scrollLeft = e.currentTarget.scrollLeft;
    }
  }

  return (
    <div className={"code-editor" + (className ? " " + className : "")}>
      <pre className="code-editor-highlight" aria-hidden="true">
        <code
          className={`hljs language-${language}`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </pre>
      <textarea
        ref={textareaRef}
        className="code-editor-input"
        value={value}
        placeholder={placeholder}
        spellCheck={spellCheck}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}
