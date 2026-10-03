/**
 * DOM caret overlay for the outline editors.
 *
 * The browser's native caret does not reliably paint in this context:
 * Obsidian's CM theme scopes `caret-color: transparent !important` onto
 * `.cm-content` (its own editors draw a custom caret that never renders in
 * ours), the workspace layer sets `user-select: none` across the ancestor
 * chain (an EMPTY focused editable then paints no caret at all), and at a
 * line start the 1px caret hides inside the first CJK glyph's stroke.
 *
 * One singleton bar follows the selection head while one of our editors is
 * focused (rAF-driven, so scrolling keeps it pinned); `mix-blend-mode:
 * difference` makes it visible over any background, glyphs included. The
 * bar is hidden whenever the selection is non-empty (the native selection
 * highlight takes over) or the view loses focus.
 */

import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

let overlay: HTMLDivElement | null = null;
let raf = 0;
let activeView: EditorView | null = null;

function ensureOverlay(): HTMLDivElement {
  if (!overlay) {
    overlay = document.body.createEl('div');
    overlay.className = 'lgp-caret-overlay';
  }
  return overlay;
}

function hide(): void {
  if (overlay) overlay.style.display = 'none';
  if (raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
  activeView = null;
}

function paint(view: EditorView): void {
  const sel = view.state.selection.main;
  if (!view.hasFocus || !sel.empty) {
    hide();
    return;
  }
  let coords;
  try {
    coords = view.coordsAtPos(sel.head);
  } catch {
    hide();
    return;
  }
  if (!coords || (!coords.top && !coords.bottom)) {
    hide();
    return;
  }
  const el = ensureOverlay();
  el.style.display = 'block';
  el.style.left = `${coords.left - 0.5}px`;
  el.style.top = `${coords.top}px`;
  el.style.height = `${Math.max(coords.bottom - coords.top, 12)}px`;
}

function startLoop(view: EditorView): void {
  if (activeView === view && raf) return;
  activeView = view;
  if (!raf) {
    const loop = () => {
      if (!activeView) {
        raf = 0;
        return;
      }
      paint(activeView);
      if (!activeView) {
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }
}

export function caretOverlay(): Extension {
  return ViewPlugin.fromClass(
    class {
      view: EditorView;
      constructor(view: EditorView) {
        this.view = view;
        if (view.hasFocus) startLoop(view);
      }
      update(u: ViewUpdate) {
        if (u.focusChanged || u.selectionSet || u.docChanged || u.viewportChanged) {
          if (u.view.hasFocus) startLoop(u.view);
          else if (activeView === u.view) hide();
        }
      }
      destroy() {
        if (activeView === this.view) hide();
      }
    },
  );
}
