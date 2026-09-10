/**
 * Block-level keyboard interaction handlers (Logseq behavior).
 * Each handler receives the CM6 view of the focused block plus the host view;
 * returning true consumes the key (prevents CM6 default), false falls through.
 */

import type { EditorView } from '@codemirror/view';
import { insertNewline, insertTab } from '@codemirror/commands';
import type { BlockEditorView } from '../view/BlockEditorView';
import {
  indent,
  mergeWithPrev,
  moveBlockVertically,
  nextVisible,
  outdent,
  prevVisible,
  splitBlock,
} from '../core/treeOps';
import { cycleMarker } from '../core/treeOps';
import type { Block } from '../types';

function focusedBlock(host: BlockEditorView): Block | null {
  return host.focusedBlock;
}

/** Selection with deleted-range applied: returns resulting text + caret offset. */
function deleteSelection(view: EditorView): { text: string; offset: number } {
  const sel = view.state.selection.main;
  const text = view.state.doc.toString();
  if (sel.empty) return { text, offset: sel.head };
  return { text: text.slice(0, sel.from) + text.slice(sel.to), offset: sel.from };
}

/** Enter: split block at caret; tail becomes a new sibling below. */
export function handleEnter(view: EditorView, host: BlockEditorView): boolean {
  const b = focusedBlock(host);
  if (!b) return false;
  if (b.kind === 'raw') {
    insertNewline(view); // raw content: plain line break inside the text
    return true;
  }
  const { text, offset } = deleteSelection(view);
  const parent = b.parent;
  let nb: Block | null = null;
  host.mutate(
    () => {
      b.text = text;
      nb = splitBlock(b, offset);
    },
    () => ({ lists: [parent] }),
  );
  // Children stay with the head block (Logseq behavior); caret goes to new block.
  const target = nb as Block | null;
  if (target) host.focusBlock(target, 0);
  return true;
}

/** Tab / Shift+Tab: indent / outdent the whole block. */
export function handleTab(view: EditorView, host: BlockEditorView, shift: boolean): boolean {
  const b = focusedBlock(host);
  if (!b) return false;
  if (b.kind === 'raw') {
    if (!shift) insertTab(view); // raw content: literal indentation
    return true;
  }
  const offset = view.state.selection.main.head;
  const oldParent = b.parent;
  host.mutate(
    () => {
      if (shift) outdent(b);
      else indent(b);
    },
    // Rebuild both the old and the new sibling list of b.
    () => ({ lists: [oldParent, b.parent] }),
  );
  host.focusBlock(b, Math.min(offset, b.text.length));
  return true;
}

function atFirstVisualLine(view: EditorView): boolean {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  if (line.from === 0 && line.to >= view.state.doc.length) return true;
  const headTop = view.coordsAtPos(head)?.top;
  const lineTop = view.coordsAtPos(line.from)?.top;
  if (headTop === undefined || lineTop === undefined) return true;
  return Math.abs(headTop - lineTop) < 2;
}

function atLastVisualLine(view: EditorView): boolean {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  if (line.from === 0 && line.to >= view.state.doc.length) return true;
  const headBottom = view.coordsAtPos(head)?.bottom;
  const lineBottom = view.coordsAtPos(line.to)?.bottom;
  if (headBottom === undefined || lineBottom === undefined) return true;
  return Math.abs(headBottom - lineBottom) < 2;
}

/** Arrow keys: cross-block caret movement at block boundaries. */
export function handleArrow(view: EditorView, host: BlockEditorView, dir: 'up' | 'down' | 'left' | 'right'): boolean {
  const b = focusedBlock(host);
  if (!b) return false;
  const roots = host.visibleRoots;
  const sel = view.state.selection.main;
  const textLen = view.state.doc.length;

  if (dir === 'up') {
    if (b.kind === 'raw' && !atFirstVisualLine(view)) return false;
    if (!atFirstVisualLine(view)) return false;
    const prev = prevVisible(roots, b);
    if (!prev) return true; // consume: nothing above
    host.focusBlock(prev, 'end');
    return true;
  }
  if (dir === 'down') {
    if (!atLastVisualLine(view)) return false;
    const next = nextVisible(roots, b);
    if (!next) return true;
    host.focusBlock(next, 0);
    return true;
  }
  if (dir === 'left') {
    if (!sel.empty || sel.head !== 0) return false;
    const prev = prevVisible(roots, b);
    if (!prev) return true;
    host.focusBlock(prev, 'end');
    return true;
  }
  // right
  if (!sel.empty || sel.head !== textLen) return false;
  const next = nextVisible(roots, b);
  if (!next) return true;
  host.focusBlock(next, 0);
  return true;
}

/** Backspace at position 0: merge into previous visible block. */
export function handleBackspace(view: EditorView, host: BlockEditorView): boolean {
  const b = focusedBlock(host);
  if (!b) return false;
  const sel = view.state.selection.main;
  if (!sel.empty) return false;
  if (sel.head !== 0) return false;
  if (b.kind === 'raw') return true; // nothing before caret in raw block
  const roots = host.visibleRoots;
  const prev = prevVisible(roots, b);
  if (!prev) return true; // first block: consume, nothing to merge
  const joinOffset = prev.text.length;
  const { text } = deleteSelection(view); // no-op (empty selection)
  void text;
  const parent = b.parent;
  host.mutate(
    () => {
      b.text = view.state.doc.toString();
      mergeWithPrev(roots, b);
    },
    () => ({ lists: [parent] }),
  );
  host.focusBlock(prev, Math.min(joinOffset, prev.text.length));
  return true;
}

/** Ctrl/Cmd+Enter: cycle TODO → DOING → DONE → none. */
export function handleCycleMarker(view: EditorView, host: BlockEditorView): boolean {
  const b = focusedBlock(host);
  if (!b || b.kind === 'raw') return false;
  const offset = view.state.selection.main.head;
  const text = view.state.doc.toString();
  host.mutate(
    () => {
      b.text = text;
      cycleMarker(b);
    },
    () => ({ subtree: b }),
  );
  host.focusBlock(b, Math.min(offset, b.text.length));
  return true;
}

/** Ctrl/Cmd+Shift+ArrowUp/Down: move block up/down. */
export function handleMoveBlock(view: EditorView, host: BlockEditorView, dir: -1 | 1): boolean {
  const b = focusedBlock(host);
  if (!b || b.kind === 'raw') return false;
  const offset = view.state.selection.main.head;
  const text = view.state.doc.toString();
  const roots = host.visibleRoots;
  let ok = false;
  host.mutate(
    () => {
      b.text = text;
      ok = moveBlockVertically(roots, b, dir);
    },
    // Nothing moved → nothing to re-render.
    () => (ok ? { lists: [b.parent] } : {}),
  );
  if (ok) host.focusBlock(b, Math.min(offset, b.text.length));
  return true;
}

/** Alt+ArrowUp/Down: jump to the previous/next block regardless of caret line. */
export function handleJumpBlock(view: EditorView, host: BlockEditorView, dir: -1 | 1): boolean {
  const b = focusedBlock(host);
  if (!b) return false;
  void view; // caret position intentionally ignored
  const roots = host.visibleRoots;
  const target = dir === -1 ? prevVisible(roots, b) : nextVisible(roots, b);
  if (!target) return true; // consume at document edges
  host.focusBlock(target, dir === -1 ? 'end' : 0);
  return true;
}

/** Escape: commit + leave the block (Logseq exits editing). */
export function handleEscape(view: EditorView, _host: BlockEditorView): boolean {
  void _host;
  view.contentDOM.blur();
  return true;
}
