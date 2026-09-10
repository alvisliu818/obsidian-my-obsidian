/**
 * Focused-block CM6 lifecycle: mount / commit / unmount.
 * One CM6 EditorView at a time, living inside the focused block's content DOM.
 */

import { EditorView } from '@codemirror/view';
import type { BlockEditorView } from '../view/BlockEditorView';
import { createEditorExtensions } from './extensions';
import { expandTemplates, type TemplateContext } from '../features/template';
import type { Block } from '../types';

export type CursorPos = number | 'start' | 'end';

export function mountFocusedEditor(
  parent: HTMLElement,
  block: Block,
  pos: CursorPos,
  host: BlockEditorView,
): EditorView {
  const view = new EditorView({
    doc: block.text,
    parent,
    extensions: createEditorExtensions(host),
  });
  applyCursor(view, pos);
  view.focus();
  return view;
}

export function applyCursor(view: EditorView, pos: CursorPos): void {
  const len = view.state.doc.length;
  let p: number;
  if (pos === 'start') p = 0;
  else if (pos === 'end') p = len;
  else p = Math.max(0, Math.min(pos, len));
  view.dispatch({ selection: { anchor: p } });
}

/**
 * Map a click coordinate (from the pre-focus static render) onto a CM6
 * position after mount; falls back to `fallback`.
 */
export function cursorAtCoords(view: EditorView, x: number, y: number, fallback: CursorPos): number {
  try {
    const p = view.posAtCoords({ x, y });
    if (p !== null) return Math.max(0, Math.min(p, view.state.doc.length));
  } catch {
    /* coords may be off-view right after mount */
  }
  const len = view.state.doc.length;
  if (fallback === 'start') return 0;
  if (fallback === 'end') return len;
  return Math.min(fallback, len);
}

/** Write the editor doc back into the block model (no rendering here). */
export function commitEditorText(view: EditorView, block: Block, ctx?: TemplateContext): boolean {
  // Logseq behavior: <% today %> etc. expand when the edit is committed.
  const text = expandTemplates(view.state.doc.toString(), new Date(), ctx);
  if (text === block.text) return false;
  block.text = text;
  return true;
}
