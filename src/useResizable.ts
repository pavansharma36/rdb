// Reusable horizontal drag-to-resize handle.
//
// Generalizes the outer sidebar's resize logic (see `startSidebarResize` in
// App.tsx) so workspace tree panels can share it. `onChange` fires live during
// the drag (update local width state); `onCommit` fires once on mouseup (good
// place to persist the final width).

import type React from "react";

/** Min/max width (px) for a workspace's resizable tree / scripts panel. */
export const TREE_MIN = 160;
export const TREE_MAX = 560;

interface ResizableOptions {
  /** Current width in CSS px (the drag starts from here). */
  width: number;
  /** Clamp bounds in CSS px. */
  min: number;
  max: number;
  /** Live width during the drag. */
  onChange: (width: number) => void;
  /** Final width on mouseup (e.g. to persist). */
  onCommit: (width: number) => void;
}

/** Returns an `onMouseDown` to attach to a resize-handle element. The handle
 *  sits to the right of the panel, so dragging right widens it. */
export function useResizable({
  width,
  min,
  max,
  onChange,
  onCommit,
}: ResizableOptions): { onMouseDown: (e: React.MouseEvent) => void } {
  function onMouseDown(e: React.MouseEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    let last = startWidth;
    function onMove(ev: MouseEvent) {
      last = Math.min(max, Math.max(min, startWidth + ev.clientX - startX));
      onChange(last);
    }
    function onUp() {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      onCommit(last);
    }
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
  }
  return { onMouseDown };
}
