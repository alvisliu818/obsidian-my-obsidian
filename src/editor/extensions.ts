/**
 * CM6 extension set for the focused-block editor.
 * Self-bundled CodeMirror 6 鈥?mounted on our own DOM only, never mixed with
 * Obsidian's internal CM6 instance.
 */

import {
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  rectangularSelection,
  crosshairCursor,
  type KeyBinding,
} from '@codemirror/view';
import { EditorState, Prec, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, indentUnit } from '@codemirror/language';
import { autocompletion } from '@codemirror/autocomplete';
import type { BlockEditorView } from '../view/BlockEditorView';
import { commandMenuKeymap, maybeOpenMenu, closeMenu } from '../features/commandMenu';
import {
  handleArrow,
  handleBackspace,
  handleCycleMarker,
  handleEnter,
  handleEscape,
  handleJumpBlock,
  handleMoveBlock,
  handleTab,
} from '../interactions/keymap';

/** Keys we fully own; their defaultKeymap entries are filtered out. */
const OWNED_DEFAULT_KEYS = new Set([
  'Enter',
  'Shift-Enter',
  'Mod-Enter',
  'Tab',
  'Shift-Tab',
  'Backspace',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);

export function createBlockKeymap(host: BlockEditorView): KeyBinding[] {
  return [
    { key: 'Enter', run: (v) => handleEnter(v, host) },
    {
      key: 'Shift-Enter',
      run: (v) => {
        insertNewline(v);
        return true;
      },
    },
    { key: 'Mod-Enter', run: (v) => handleCycleMarker(v, host) },
    { key: 'Ctrl-Enter', run: (v) => handleCycleMarker(v, host) },
    { key: 'Tab', run: (v) => handleTab(v, host, false) },
    { key: 'Shift-Tab', run: (v) => handleTab(v, host, true) },
    { key: 'Backspace', run: (v) => handleBackspace(v, host) },
    { key: 'ArrowUp', run: (v) => handleArrow(v, host, 'up') },
    { key: 'ArrowDown', run: (v) => handleArrow(v, host, 'down') },
    { key: 'ArrowLeft', run: (v) => handleArrow(v, host, 'left') },
    { key: 'ArrowRight', run: (v) => handleArrow(v, host, 'right') },
    { key: 'Mod-Shift-ArrowUp', run: (v) => handleMoveBlock(v, host, -1) },
    { key: 'Mod-Shift-ArrowDown', run: (v) => handleMoveBlock(v, host, 1) },
    { key: 'Alt-ArrowUp', run: (v) => handleJumpBlock(v, host, -1) },
    { key: 'Alt-ArrowDown', run: (v) => handleJumpBlock(v, host, 1) },
    { key: 'Alt-Shift-ArrowUp', run: (v) => handleMoveBlock(v, host, -1) },
    { key: 'Alt-Shift-ArrowDown', run: (v) => handleMoveBlock(v, host, 1) },
    { key: 'Escape', run: (v) => handleEscape(v, host) },
  ];
}

/**
 * Extension set for the in-place embed editor: plain single-block editing with
 * no outline keys. Enter commits the edit and creates a NEW SIBLING BLOCK
 * below the source block (Logseq md parity — see startEmbedEdit/onCommit);
 * Escape / blur just commit. Autocompletion ([[wiki]], #tag, ((ref))) is
 * included; block-model slash commands are filtered out (no outline focus).
 *
 * The commit is deferred to a task: CM6 keeps touching the view right after a
 * key or blur handler returns, so destroying it synchronously is unsafe.
 */
export function createEmbedExtensions(
  host: BlockEditorView,
  onCommit: () => void,
  onCommitAndNew?: () => void,
): Extension[] {
  const commit = (): boolean => {
    window.setTimeout(onCommit, 0);
    return true;
  };
  const commitNew = (): boolean => {
    if (onCommitAndNew) {
      window.setTimeout(onCommitAndNew, 0);
    } else {
      window.setTimeout(onCommit, 0);
    }
    return true;
  };
  return [
    EditorView.lineWrapping,
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    markdown({ base: markdownLanguage, addKeymap: false }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    autocompletion({ override: [...host.autocompleteSources(true)], icons: true, activateOnTyping: true }),
    Prec.high(
      keymap.of([
        { key: 'Enter', run: commitNew },
        { key: 'Escape', run: commit },
        { key: 'Shift-Enter', run: (v) => (insertNewline(v), true) },
      ]),
    ),
    keymap.of(defaultKeymap.filter((k) => k.key !== 'Enter')),
    keymap.of(historyKeymap),
    EditorView.domEventHandlers({
      blur: () => {
        window.setTimeout(onCommit, 0);
        return false;
      },
    }),
  ];
}

export function createEditorExtensions(host: BlockEditorView): Extension[] {
  const blockKeymap = keymap.of(createBlockKeymap(host));
  const filteredDefaults = defaultKeymap.filter((k) => !OWNED_DEFAULT_KEYS.has(k.key ?? ''));

  const ext: Extension[] = [
    EditorView.lineWrapping,
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    rectangularSelection(),
    crosshairCursor(),
    indentUnit.of('    '),
    markdown({ base: markdownLanguage, addKeymap: false }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    // Autocompletion sources ([[wiki]], #tag, ((ref))) — / and < use the
    // self-drawn command menu (CM6 tooltips don't render in this host DOM).
    autocompletion({ override: [...host.autocompleteSources()], icons: true, activateOnTyping: true }),
    // Self-drawn / and < command menus (swallows nav keys while open).
    commandMenuKeymap(),
    // Our block keymap must outrank everything else.
    Prec.high(blockKeymap),
    keymap.of(filteredDefaults),
    keymap.of(historyKeymap),
    // Lifecycle wiring back into the view.
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        host.onFocusedTextChange();
        // Open/refresh the self-drawn / and < menus on trigger chars.
        maybeOpenMenu(u.view, host);
      }
      if (u.focusChanged && !u.view.hasFocus) {
        closeMenu();
        host.onFocusedBlur();
      }
    }),
  ];
  return ext;
}



