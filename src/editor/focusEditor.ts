/**
 * Focused-block CM6 lifecycle: mount / commit / unmount.
 * One CM6 EditorView at a time, living inside the focused block's content DOM.
 */

import { EditorView } from '@codemirror/view';
import { closeCompletion, completionStatus } from '@codemirror/autocomplete';
import type { BlockEditorView } from '../view/BlockEditorView';
import { createEditorExtensions } from './extensions';
import { expandTemplates, type TemplateContext } from '../features/template';
import {
  applyBlockProps,
  blockEditorDoc,
  editableProps,
  propsShallowEqual,
  splitPropLines,
  syncFrontmatterProps,
  type Block,
} from '../types';

export type CursorPos = number | 'start' | 'end';

export function mountFocusedEditor(
  parent: HTMLElement,
  block: Block,
  pos: CursorPos,
  host: BlockEditorView,
): EditorView {
  const view = new EditorView({
    // Properties ride along as `key:: value` lines under the text (Logseq
    // editor parity); commit splits them back out.
    doc: blockEditorDoc(block),
    parent,
    extensions: createEditorExtensions(host, block),
  });
  // Debug handle for e2e verification (harmless): lets page-context probes
  // reach this editor's CM6 state (doc text, selection) from the DOM node.
  (view.dom as HTMLElement & { __lgView?: EditorView }).__lgView = view;
  // Real Escape keystrokes never reach CM6's keymap inside Obsidian's host
  // DOM (a capture-phase handler marks them handled first, so the keymap
  // dispatch skips the defaultPrevented event). Catch Escape in the CAPTURE
  // phase here and COMMIT synchronously. The completion state can still be
  // "pending" right after typing (the accept pass runs ~75ms later), so gate
  // on nothing: Esc always lands the edit, closing any popup en route.
  // Blurring alone races with Obsidian's focus management (hasFocus may stay
  // true, so the blur-commit path never fires and the edit never lands).
  const escHandler = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape' || e.repeat) return;
    // The NATIVE slash-command suggest is showing: Esc belongs to it (hides
    // the popup via its keymap scope) — do not commit the edit.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const es = (window as any).app?.workspace?.editorSuggest;
    if (es?.isShowingSuggestion?.()) return;
    e.preventDefault();
    e.stopPropagation();
    // A VISIBLE popup (active) means the first Esc just closes it — native
    // behavior. 'pending' is the accept-pass tail with no popup on screen
    // and MUST fall through to the commit (gating on it was the bug that
    // made Esc silently drop edits typed right before it).
    if (completionStatus(view.state) === 'active') {
      closeCompletion(view);
      return;
    }
    closeCompletion(view);
    view.contentDOM.blur();
    host.commitViewNow(view, block);
  };
  view.dom.addEventListener('keydown', escHandler, true);
  // The native slash-menu suggest requires the triggering keyboard event.
  view.dom.addEventListener(
    'keydown',
    (e) => {
      (window as unknown as { __lastKeyEvent?: KeyboardEvent }).__lastKeyEvent = e;
    },
    true,
  );
  applyCursor(view, pos);
  view.focus();
  // Electron/CDP background windows drop the initial focus; re-assert on
  // the next frames so the editor stays in editing state (Enter parity).
  requestAnimationFrame(() => {
    if (!view.hasFocus) view.focus();
    setTimeout(() => {
      if (!view.hasFocus && view.dom.isConnected) view.focus();
    }, 60);
  });
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
 * Place the caret AND scroll it into view. After the static→raw-text swap
 * the block's height collapses (rendered images/code become one line each),
 * so a caret placed at the click's mapped position can sit far off-screen
 * (usually above) — the "cursor disappears" effect. 'nearest' scrolls the
 * MINIMUM needed to show the caret (zero when already visible), avoiding a
 * jarring page jump on tall blocks.
 */
export function applyCursorAndScroll(view: EditorView, pos: number): void {
  const p = Math.max(0, Math.min(pos, view.state.doc.length));
  view.dispatch({
    selection: { anchor: p },
    effects: EditorView.scrollIntoView(p, { y: 'nearest' }),
  });
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
  // Logseq behavior: <% today %> etc. expand when the edit is committed, and
  // the trailing `key:: value` lines become block properties.
  const raw = expandTemplates(view.state.doc.toString(), new Date(), ctx);
  // Obsidian-format page properties: the whole doc IS the frontmatter body —
  // no Logseq prop extraction; the raw lines round-trip verbatim and the
  // props map re-syncs from simple `key: value` lines.
  if (block.frontmatter) {
    if (raw === block.text) return false;
    block.text = raw
      .split('\n')
      .map((l) => {
        const m = /^([A-Za-z][A-Za-z0-9_-]*)::\s*(.*)$/.exec(l);
        return m ? `${m[1]}: ${m[2]}` : l;
      })
      .join('\n');
    syncFrontmatterProps(block);
    return true;
  }
  const { text, props } = splitPropLines(raw);
  if (text === block.text && propsShallowEqual(editableProps(block), props)) return false;
  block.text = text;
  applyBlockProps(block, props);
  return true;
}

