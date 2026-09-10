/**
 * CM6 extension set for the focused-block editor.
 * Self-bundled CodeMirror 6 — mounted on our own DOM only, never mixed with
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
    // Autocompletion sources ([[wiki]], #tag, ((ref)), /slash) — provided by host.
    autocompletion({ override: host.autocompleteSources(), icons: true, activateOnTyping: true }),
    // Our block keymap must outrank everything else.
    Prec.high(blockKeymap),
    keymap.of(filteredDefaults),
    keymap.of(historyKeymap),
    // Lifecycle wiring back into the view.
    EditorView.updateListener.of((u) => {
      if (u.docChanged) host.onFocusedTextChange();
      if (u.focusChanged && !u.view.hasFocus) host.onFocusedBlur();
    }),
  ];
  return ext;
}
