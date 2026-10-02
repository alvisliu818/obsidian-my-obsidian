/**
 * CM6 extension set for the focused-block editor.
 * Self-bundled CodeMirror 6 鈥?mounted on our own DOM only, never mixed with
 * Obsidian's internal CM6 instance.
 */

import {
  EditorView,
  keymap,
  tooltips,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  rectangularSelection,
  crosshairCursor,
  Decoration,
  ViewPlugin,
  type DecorationSet,
  type KeyBinding,
  type ViewUpdate,
} from '@codemirror/view';
import { EditorState, Prec, RangeSetBuilder, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, insertNewline } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { syntaxHighlighting, defaultHighlightStyle, indentUnit } from '@codemirror/language';
import {
  acceptCompletion,
  autocompletion,
  closeCompletion,
  completionStatus,
  moveCompletionSelection,
} from '@codemirror/autocomplete';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { editorInfoField, editorLivePreviewField } from 'obsidian';
import type { BlockEditorView } from '../view/BlockEditorView';
import type { Block } from '../types';
import { commandMenuKeymap, maybeOpenMenu, closeMenu } from '../features/commandMenu';
import { syncActiveBlockEditor } from '../interactions/textSelectionMenu';
import { livePreviewExtension } from './livePreview';
import { mathSyntax } from './mathSyntax';
import { BLOCK_PROP_LINE_RE } from '../types';

/**
 * Third-party editor extensions (registerEditorExtension — latex-suite,
 * outliner, editing-toolbar, …) run in the outline editor exactly like in
 * the native one, so users' plugins keep working here. Also includes
 * Obsidian's exported editor StateFields: third-party plugins read them via
 * state.field() and an ABSENT field throws, killing their views.
 *
 * editorLivePreviewField defaults to false (the native editor flips it with
 * an internal StateEffect we cannot access) — but the outline editor is
 * ALWAYS live preview, so its `create` is patched to report true. Plugins
 * like latex-suite gate their live math preview on it.
 */
function thirdPartyEditorExtensions(): Extension[] {
  const lpf = editorLivePreviewField as unknown as { create: (st: unknown) => boolean };
  if (lpf && typeof lpf.create === 'function') {
    lpf.create = () => true;
  }
  const exts: Extension[] = [editorInfoField as unknown as Extension, editorLivePreviewField as unknown as Extension];
  const ws = (window as unknown as { app?: { workspace?: { editorExtensions?: unknown[] } } }).app?.workspace;
  if (Array.isArray(ws?.editorExtensions)) {
    exts.push(...(ws!.editorExtensions as Extension[]));
  }
  // Debug handle for e2e verification of third-party plugin integration.
  (window as unknown as { __lgDebug?: unknown }).__lgDebug = {
    editorLivePreviewField,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    tooltips: (v: any) => v.state.facet(tooltips),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    facetCount: (v: any, f: any) => v.state.facet(f).length,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pluginsOf: (v: any) => v.state.facet((EditorView as any).viewPlugin).map((p: any) => String(p && p.id)),
  };
  return exts;
}

/**
 * Dim the trailing `key:: value` property lines inside the editor — they are
 * properties, not body text (Logseq editor parity). Only the trailing run is
 * decorated: that is exactly the range commit() extracts into block props.
 */
const propLineDeco = Decoration.line({ class: 'cm-prop-line' });

function buildPropLineDecos(view: EditorView): DecorationSet {
  const doc = view.state.doc;
  const froms: number[] = [];
  for (let i = doc.lines; i >= 1; i--) {
    const line = doc.line(i);
    if (!BLOCK_PROP_LINE_RE.test(line.text)) break;
    froms.push(line.from);
  }
  if (froms.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  for (const from of froms.reverse()) builder.add(from, from, propLineDeco);
  return builder.finish();
}

const propLineHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildPropLineDecos(view);
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged) this.decorations = buildPropLineDecos(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);
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
 * While a CM6 completion popup is active, nav/commit keys belong to it. This
 * must sit ABOVE the block keymap (Prec.high would otherwise swallow
 * ArrowUp/Down/Enter/Tab/Escape for block navigation — the completion keymap
 * that autocompletion() installs runs at default precedence).
 */
function completionYieldKeymap(): Extension {
  const popupActive = (v: EditorView): boolean => completionStatus(v.state) === 'active';
  const nav =
    (forward: boolean, by?: 'page') =>
    (v: EditorView): boolean =>
      popupActive(v) && moveCompletionSelection(forward, by)(v);
  return Prec.highest(
    keymap.of([
      { key: 'ArrowUp', run: nav(false) },
      { key: 'ArrowDown', run: nav(true) },
      { key: 'PageUp', run: nav(false, 'page') },
      { key: 'PageDown', run: nav(true, 'page') },
      { key: 'Enter', run: (v) => popupActive(v) && acceptCompletion(v) },
      { key: 'Tab', run: (v) => popupActive(v) && acceptCompletion(v) },
      { key: 'Escape', run: (v) => popupActive(v) && closeCompletion(v) },
    ]),
  );
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
  onTab?: (shift: boolean) => boolean,
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
  const tabKeymap: Extension[] = onTab
    ? [
        keymap.of([
          { key: 'Tab', run: () => onTab(false) },
          { key: 'Shift-Tab', run: () => onTab(true) },
        ]),
      ]
    : [];
  return [
    ...tabKeymap,
    EditorView.lineWrapping,
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    markdown({ base: markdownLanguage, addKeymap: false, extensions: [mathSyntax()] }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    propLineHighlighter,
    livePreviewExtension,
    autocompletion({ override: [...host.autocompleteSources(true)], icons: true, activateOnTyping: true }),
    completionYieldKeymap(),
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

export function createEditorExtensions(host: BlockEditorView, block?: Block): Extension[] {
  const blockKeymap = keymap.of(createBlockKeymap(host));
  const filteredDefaults = defaultKeymap.filter((k) => !OWNED_DEFAULT_KEYS.has(k.key ?? ''));

  // Live preview is always on; the block menu's "Source mode" mounts this
  // block's editor WITHOUT it for one raw-source edit session, and the status
  // bar's page-wide source mode does the same for EVERY block.
  const livePreview =
    block && (host.sourceModeBlock === block || host.pageSourceMode) ? [] : [livePreviewExtension];

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
    markdown({ base: markdownLanguage, addKeymap: false, extensions: [mathSyntax()] }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    propLineHighlighter,
    ...livePreview,
    // Autocompletion sources ([[wiki]], #tag, ((ref)) — / and < use the
    // self-drawn command menu in the main editor).
    autocompletion({ override: [...host.autocompleteSources()], icons: true, activateOnTyping: true }),
    // Completion popups win nav/commit keys while open (must precede the
    // self-drawn-menu and block keymaps in precedence).
    completionYieldKeymap(),
    // Self-drawn / and < command menus (swallows nav keys while open).
    commandMenuKeymap(),
    // Our block keymap must outrank everything else.
    Prec.high(blockKeymap),
    keymap.of(filteredDefaults),
    keymap.of(historyKeymap),
    // Community plugins' editor extensions (latex-suite snippets & live math
    // preview, …) — lowest precedence so the outline's own behavior wins.
    ...thirdPartyEditorExtensions(),
    // Lifecycle wiring back into the view.
    EditorView.updateListener.of((u) => {
      if (u.docChanged) {
        host.onFocusedTextChange();
        // Open/refresh the self-drawn / and < menus on trigger chars.
        maybeOpenMenu(u.view, host);
      }
      if (u.focusChanged) {
        // Native-editor parity: the live editor registers itself as
        // workspace.activeEditor so editorCallback commands / plugins
        // resolve to the block editor's selection.
        if (u.view.hasFocus) syncActiveBlockEditor(host.app, host, u.view);
      }
      if (u.focusChanged && !u.view.hasFocus) {
        closeMenu();
        host.onFocusedBlur();
      }
    }),
  ];
  return ext;
}




