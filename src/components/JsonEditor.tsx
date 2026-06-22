import { useCallback, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { CodeEditor } from "./CodeEditor";

const INDENT = "  "; // two spaces per level — matches JSON.stringify(…, 2)

/** Fold macOS "smart quotes" (“ ” ‘ ’) back to straight quotes before parsing.
 *  The OS text-substitution swaps them in as you type, but they're never valid
 *  JSON, so a hand-typed object would fail to parse without this. */
function normalizeQuotes(s: string): string {
  return s.replace(/[“”„‟]/g, '"').replace(/[‘’‚‛]/g, "'");
}

/** Turn a `JSON.parse` SyntaxError into a verbose, line-anchored message.
 *  Engines phrase the location differently — V8 uses `at position N` (and
 *  newer builds add `(line L column C)`), Firefox uses `at line L column C`,
 *  WebKit (Tauri on macOS) often gives no location at all. We pull whatever
 *  offset we can and compute line:column from `src` ourselves so the result is
 *  consistent regardless of engine. */
function describeParseError(err: unknown, src: string): string {
  const raw = err instanceof Error ? err.message : String(err);

  // Prefer an explicit "line L column C" if the engine already gave one.
  const lc = raw.match(/line (\d+) column (\d+)/i);
  if (lc) return `${cleanMessage(raw)} (line ${lc[1]}, column ${lc[2]})`;

  // Otherwise derive line/column from a character offset ("position N").
  const pos = raw.match(/position (\d+)/i);
  if (pos) {
    const offset = Math.min(Number(pos[1]), src.length);
    const before = src.slice(0, offset);
    const line = before.split("\n").length;
    const column = offset - before.lastIndexOf("\n");
    return `${cleanMessage(raw)} (line ${line}, column ${column})`;
  }

  return cleanMessage(raw);
}

/** Strip the engine's own trailing location clause so we don't print it twice
 *  alongside our normalized "(line L, column C)" suffix, and drop V8's noisy
 *  "…" "<source snippet>" is not valid JSON tail. */
function cleanMessage(raw: string): string {
  return raw
    .replace(/,?\s*"[\s\S]*?"\s*is not valid JSON\s*$/i, "")
    .replace(/\s*in JSON at position \d+.*$/i, "")
    .replace(/\s*at line \d+ column \d+.*$/i, "")
    .replace(/\s*\(line \d+ column \d+\).*$/i, "")
    .trim();
}

/** Characters that auto-insert their closing counterpart when typed. */
const PAIRS: Record<string, string> = {
  "{": "}",
  "[": "]",
  "(": ")",
  '"': '"',
};
const CLOSERS = new Set(Object.values(PAIRS));

/** Leading whitespace of the line containing `pos`. */
function lineIndent(value: string, pos: number): string {
  const lineStart = value.lastIndexOf("\n", pos - 1) + 1;
  const line = value.slice(lineStart, pos);
  return line.slice(0, line.length - line.trimStart().length);
}

/** A code-oriented editor for JSON bodies. Wraps the shared {@link CodeEditor}
 *  (highlight.js syntax coloring via the transparent-textarea overlay) and adds
 *  JSON-aware editing on top:
 *  - Tab / Shift+Tab indent or outdent (the whole selection when multi-line).
 *  - Enter keeps the current indent, deepens it after an open brace/bracket,
 *    and splits a `{|}` / `[|]` pair onto its own indented line.
 *  - Typing `{`, `[`, `(`, or `"` inserts the matching closer; typing a closer
 *    right before its auto-inserted twin just steps over it; Backspace between
 *    an empty pair deletes both.
 *  A Format (pretty-print with 2-space indent, folding smart quotes) and
 *  Validate (syntax check) action overlay the bottom-left of the editor
 *  surface, with inline pass/fail feedback.
 *  `onKeyDown` is invoked before the editor's own handling, so a host can layer
 *  on shortcuts (Esc to cancel, ⌘/Ctrl+Enter to apply); if the host calls
 *  preventDefault the editor skips its own logic for that key.
 *  Everything funnels through `onChange`, so the parent stays the source of
 *  truth (no internal state, value stays controlled). */
export function JsonEditor({
  value,
  onChange,
  placeholder,
  className,
  autoFocus = false,
  onKeyDown: onKeyDownExtra,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  onKeyDown?: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
}) {
  // Inline status from Format/Validate; cleared on the next edit. `ok` drives
  // the message color (valid → success, invalid → error).
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(
    null,
  );

  const emit = useCallback(
    (next: string) => {
      setStatus(null);
      onChange(next);
    },
    [onChange],
  );
  /** Apply a new value and reposition the caret in one shot. React won't have
   *  re-rendered yet when this returns, so we set the textarea's value and
   *  selection imperatively and then notify the parent. */
  const apply = useCallback(
    (
      el: HTMLTextAreaElement,
      next: string,
      selStart: number,
      selEnd = selStart,
    ) => {
      el.value = next;
      el.setSelectionRange(selStart, selEnd);
      emit(next);
    },
    [emit],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
      // Let the host handle the event first (e.g. Esc/⌘Enter); if it takes the
      // key with preventDefault, don't also apply the editor's own logic.
      onKeyDownExtra?.(e);
      if (e.defaultPrevented) return;

      const el = e.currentTarget;
      const { selectionStart: start, selectionEnd: end, value: v } = el;
      const selected = v.slice(start, end);

      if (e.key === "Tab") {
        e.preventDefault();
        // Multi-line selection: indent/outdent every line it touches.
        if (selected.includes("\n")) {
          const lineStart = v.lastIndexOf("\n", start - 1) + 1;
          const block = v.slice(lineStart, end);
          if (e.shiftKey) {
            const outdented = block.replace(
              new RegExp(`^( {1,${INDENT.length}}|\t)`, "gm"),
              "",
            );
            const removed = block.length - outdented.length;
            apply(
              el,
              v.slice(0, lineStart) + outdented + v.slice(end),
              Math.max(lineStart, start - Math.min(INDENT.length, start - lineStart)),
              end - removed,
            );
          } else {
            const indented = block.replace(/^/gm, INDENT);
            const added = indented.length - block.length;
            apply(
              el,
              v.slice(0, lineStart) + indented + v.slice(end),
              start + INDENT.length,
              end + added,
            );
          }
          return;
        }
        // No multi-line selection: Tab inserts an indent, Shift+Tab removes one.
        if (e.shiftKey) {
          const lineStart = v.lastIndexOf("\n", start - 1) + 1;
          const before = v.slice(lineStart, start);
          const strip = before.endsWith(INDENT)
            ? INDENT.length
            : before.endsWith("\t")
              ? 1
              : 0;
          if (strip === 0) return;
          apply(
            el,
            v.slice(0, start - strip) + v.slice(start),
            start - strip,
          );
        } else {
          apply(el, v.slice(0, start) + INDENT + v.slice(end), start + INDENT.length);
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        const indent = lineIndent(v, start);
        const prev = v[start - 1];
        const nextCh = v[end];
        // Between a freshly opened pair, e.g. `{|}` — expand to:
        //   {
        //     |
        //   }
        if (
          (prev === "{" && nextCh === "}") ||
          (prev === "[" && nextCh === "]")
        ) {
          const inner = "\n" + indent + INDENT;
          const tail = "\n" + indent;
          apply(
            el,
            v.slice(0, start) + inner + tail + v.slice(end),
            start + inner.length,
          );
          return;
        }
        // After an opening brace/bracket, deepen the indent one level.
        const deeper = prev === "{" || prev === "[" ? INDENT : "";
        const insert = "\n" + indent + deeper;
        apply(el, v.slice(0, start) + insert + v.slice(end), start + insert.length);
        return;
      }

      // Backspace between an empty auto-pair removes both characters.
      if (e.key === "Backspace" && start === end && start > 0) {
        const prev = v[start - 1];
        const nextCh = v[start];
        if (prev && PAIRS[prev] === nextCh) {
          e.preventDefault();
          apply(el, v.slice(0, start - 1) + v.slice(start + 1), start - 1);
        }
        return;
      }

      // Typing a closer right before its matching auto-inserted twin: step over
      // it instead of inserting a duplicate.
      if (CLOSERS.has(e.key) && start === end && v[start] === e.key) {
        e.preventDefault();
        apply(el, v, start + 1);
        return;
      }

      // Auto-close brackets/quotes. For a selection, wrap it.
      const closer = PAIRS[e.key];
      if (closer) {
        // A quote right before an identical quote is a closer step-over, handled
        // above; here we only open a fresh pair.
        if (e.key === '"' && v[start] === '"' && start === end) return;
        e.preventDefault();
        apply(
          el,
          v.slice(0, start) + e.key + selected + closer + v.slice(end),
          start + 1,
          start + 1 + selected.length,
        );
        return;
      }
    },
    [apply, onKeyDownExtra],
  );

  /** Parse the current value, returning the error message on failure. */
  const parseError = useCallback((): string | null => {
    if (!value.trim()) return "Empty body";
    const src = normalizeQuotes(value);
    try {
      JSON.parse(src);
      return null;
    } catch (e) {
      return describeParseError(e, src);
    }
  }, [value]);

  /** Reformat with 2-space indentation (folding smart quotes first). No-op
   *  (with an error message) if the body isn't valid JSON. */
  const format = useCallback(() => {
    if (!value.trim()) return;
    const src = normalizeQuotes(value);
    try {
      const pretty = JSON.stringify(JSON.parse(src), null, 2);
      if (pretty !== value) emit(pretty);
      setStatus({ ok: true, message: "Formatted" });
    } catch (e) {
      setStatus({ ok: false, message: describeParseError(e, src) });
    }
  }, [value, emit]);

  const validate = useCallback(() => {
    const err = parseError();
    setStatus(err ? { ok: false, message: err } : { ok: true, message: "Valid JSON" });
  }, [parseError]);

  return (
    <div className="curlui-json-editor">
      <CodeEditor
        language="json"
        className={className}
        value={value}
        onChange={emit}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoFocus={autoFocus}
      />
      <div className="curlui-json-toolbar">
        <button type="button" onClick={format} title="Pretty-print (2-space indent)">
          Format
        </button>
        <button type="button" onClick={validate} title="Check JSON syntax">
          Validate
        </button>
        {status && (
          <span
            className={"curlui-json-status " + (status.ok ? "is-ok" : "is-err")}
            title={status.message}
          >
            {status.message}
          </span>
        )}
      </div>
    </div>
  );
}