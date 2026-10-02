/**
 * Native-editor selection context menu (full parity). Right-clicking inside
 * the focused editor rebuilds the menu the native Obsidian editor shows over
 * a CM6 selection, in the same section order:
 *
 *   clipboard (Cut / Copy / Paste / Paste as plain text / Select all)
 *   selection-link (Insert link / Insert external link)
 *   selection.format ("Formatting" submenu: bold, italic, strikethrough,
 *     highlight, code, math, comment, clear)
 *   selection.paragraph ("Paragraph" submenu: bullet/numbered/checklist,
 *     headings 1-6 + none, quote)
 *   selection.insert ("Insert" submenu: footnote, table, callout, rule,
 *     code block, math block)
 *   then `workspace.trigger('editor-menu', menu, editor, view)` so every
 *     plugin's contribution lands exactly as it does natively.
 *
 * Formatting/paragraph actions operate on the block text (our editor keeps
 * `- ` markers implicit, so they are plain text transformations over the
 * selected lines, mirroring the native per-line behavior).
 */

import { Menu, Notice } from 'obsidian';
import {
  redo as cmRedo,
  undo as cmUndo,
  cursorCharLeft,
  cursorCharRight,
  cursorDocEnd,
  cursorDocStart,
  cursorLineEnd,
  cursorLineStart,
  cursorLineDown,
  cursorLineUp,
  deleteLine,
  indentLess,
  indentMore,
  selectAll,
} from '@codemirror/commands';
import { EditorSelection } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type { BlockEditorView } from '../view/BlockEditorView';

type EditorCommand = (view: EditorView) => boolean;

/**
 * swapLineUp/Down are absent from @codemirror/commands 6.11 — same behavior
 * as the native editor's exec("swapLineUp"), for the main selection.
 */
const swapLine =
  (up: boolean): EditorCommand =>
  (view) => {
    const state = view.state;
    const sel = state.selection.main;
    const a = state.doc.lineAt(sel.from);
    const b = state.doc.lineAt(sel.to);
    if (up ? a.number === 1 : b.number === state.doc.lines) return false;
    const neighbor = state.doc.line(up ? a.number - 1 : b.number + 1);
    const blockStr = state.sliceDoc(a.from, b.to);
    // Swapping up moves the block above the neighbor line, shifting every
    // selection point back by the neighbor's length + its newline.
    const delta = (up ? -1 : 1) * (neighbor.length + 1);
    view.dispatch({
      changes: up
        ? { from: neighbor.from, to: b.to, insert: `${blockStr}\n${neighbor.text}` }
        : { from: a.from, to: neighbor.to, insert: `${neighbor.text}\n${blockStr}` },
      selection: { anchor: sel.anchor + delta, head: sel.head + delta },
    });
    return true;
  };

/**
 * The native editor's `exec(name)` runs Obsidian's internal command table,
 * which keeps the CM5-style names (goUp, deleteLine, swapLineUp, indentMore,
 * …) on top of CM6 commands. Same names, same semantics, over our view.
 */
const EXEC_COMMANDS: Record<string, EditorCommand> = {
  goLeft: cursorCharLeft,
  goRight: cursorCharRight,
  goUp: cursorLineUp,
  goDown: cursorLineDown,
  goStart: cursorDocStart,
  goEnd: cursorDocEnd,
  goDocStart: cursorDocStart,
  goDocEnd: cursorDocEnd,
  goLineStart: cursorLineStart,
  goLineEnd: cursorLineEnd,
  deleteLine,
  swapLineUp: swapLine(true),
  swapLineDown: swapLine(false),
  indentMore,
  indentLess,
  selectAll,
};

/** Native `toggleMarkdownFormatting` kinds → marker pairs (bold also has __). */
const MD_FORMAT_SPECS: Record<string, { mark: string; alt?: string }> = {
  bold: { mark: '**', alt: '__' },
  italic: { mark: '*', alt: '_' },
  code: { mark: '`' },
  highlight: { mark: '==' },
  strikethrough: { mark: '~~' },
  comment: { mark: '%%' },
  math: { mark: '$' },
};

/** Returns false when there is no live editor to act on (caller falls back). */
export function openTextSelectionMenu(ev: MouseEvent, host: BlockEditorView): boolean {
  const view: EditorView | null = host.focusedView ?? host.embedEdit?.view ?? null;
  if (!view) return false;
  ev.preventDefault();
  ev.stopPropagation();
  const menu = new Menu();
  const sel = view.state.selection.main;
  const hasSel = !sel.empty;

  buildClipboardSection(menu, view, hasSel);
  if (!hasSel) {
    triggerEditorMenu(menu, view, host);
    menu.showAtMouseEvent(ev);
    return true;
  }

  // --- selection-link ---
  const selectedText = view.state.sliceDoc(sel.from, sel.to);
  const multiline = /\n/.test(selectedText);
  menu.addItem((item) =>
    item
      .setSection('selection-link')
      .setTitle('Insert link')
      .setIcon('lucide-link')
      .setDisabled(multiline)
      .onClick(() => wrapSelection(view, '[[', ']]')),
  );
  menu.addItem((item) =>
    item
      .setSection('selection-link')
      .setTitle('Insert external link')
      .setIcon('lucide-external-link')
      .setDisabled(multiline)
      .onClick(() => wrapSelection(view, '[', ']()')),
  );

  buildFormattingSubmenu(menu, view);
  buildParagraphSubmenu(menu, view);
  buildInsertSubmenu(menu, view);

  triggerEditorMenu(menu, view, host);
  menu.showAtMouseEvent(ev);
  return true;
}

// ---------------------------------------------------------------------------
// clipboard
// ---------------------------------------------------------------------------

function buildClipboardSection(menu: Menu, view: EditorView, hasSel: boolean): void {
  const selected = () => {
    const s = view.state.selection.main;
    return view.state.sliceDoc(s.from, s.to);
  };
  menu.addItem((item) =>
    item
      .setSection('clipboard')
      .setTitle('Cut')
      .setIcon('lucide-scissors')
      .setDisabled(!hasSel)
      .onClick(() => {
        const s = view.state.selection.main;
        if (s.empty) return;
        void navigator.clipboard.writeText(view.state.sliceDoc(s.from, s.to));
        view.dispatch({
          changes: { from: s.from, to: s.to },
          selection: { anchor: s.from },
          userEvent: 'delete.cut',
        });
      }),
  );
  menu.addItem((item) =>
    item
      .setSection('clipboard')
      .setTitle('Copy')
      .setIcon('lucide-copy')
      .setDisabled(!hasSel)
      .onClick(() => {
        void navigator.clipboard.writeText(selected());
      }),
  );
  menu.addItem((item) =>
    item
      .setSection('clipboard')
      .setTitle('Paste')
      .setIcon('lucide-clipboard-check')
      .onClick(() => void pasteFromClipboard(view, true)),
  );
  menu.addItem((item) =>
    item
      .setSection('clipboard')
      .setTitle('Paste as plain text')
      .setIcon('lucide-clipboard-type')
      .onClick(() => void pasteFromClipboard(view, false)),
  );
  menu.addItem((item) =>
    item
      .setSection('clipboard')
      .setTitle('Select all')
      .setIcon('lucide-box-select')
      .onClick(() => {
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
        view.focus();
      }),
  );
}

async function pasteFromClipboard(view: EditorView, keepPosition: boolean): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    const s = view.state.selection.main;
    view.dispatch({
      changes: { from: s.from, to: s.to, insert: text },
      selection: { anchor: s.from + text.length },
      userEvent: 'input.paste',
    });
    view.focus();
  } catch {
    if (!keepPosition) new Notice('Clipboard is not available');
  }
}

// ---------------------------------------------------------------------------
// selection-link + selection.format
// ---------------------------------------------------------------------------

/** Wrap the selection with a marker pair; unwrap when already wrapped. */
function wrapSelection(view: EditorView, mark: string, markEnd = mark): void {
  const sel = view.state.selection.main;
  const text = view.state.sliceDoc(sel.from, sel.to);
  const before = view.state.sliceDoc(Math.max(0, sel.from - mark.length), sel.from);
  const after = view.state.sliceDoc(sel.to, Math.min(view.state.doc.length, sel.to + markEnd.length));
  if (before === mark && after === markEnd) {
    view.dispatch({
      changes: [
        { from: sel.from - mark.length, to: sel.from },
        { from: sel.to, to: sel.to + markEnd.length },
      ],
      selection: { anchor: sel.from - mark.length, head: sel.from - mark.length + text.length },
      userEvent: 'input.format',
    });
  } else {
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: mark + text + markEnd },
      selection: { anchor: sel.from + mark.length, head: sel.from + mark.length + text.length },
      userEvent: 'input.format',
    });
  }
  view.focus();
}

function isWrapped(view: EditorView, mark: string, markEnd = mark): boolean {
  const sel = view.state.selection.main;
  return (
    view.state.sliceDoc(Math.max(0, sel.from - mark.length), sel.from) === mark &&
    view.state.sliceDoc(sel.to, Math.min(view.state.doc.length, sel.to + markEnd.length)) === markEnd
  );
}

const FORMAT_MARKS: Array<[string, string, string, string]> = [
  // [title, icon, mark, markEnd]
  ['Bold', 'lucide-bold', '**', '**'],
  ['Italic', 'lucide-italic', '*', '*'],
  ['Strikethrough', 'lucide-strikethrough', '~~', '~~'],
  ['Highlight', 'lucide-highlighter', '==', '=='],
  ['Code', 'lucide-code-2', '`', '`'],
  ['Math', 'lucide-sigma', '$', '$'],
];

function buildFormattingSubmenu(menu: Menu, view: EditorView): void {
  menu.addItem((item) => {
    item.setTitle('Formatting').setIcon('lucide-paintbrush');
    const sub = submenuOf(item);
    if (!sub) return;
    for (const [title, icon, mark, markEnd] of FORMAT_MARKS) {
      sub.addItem((sub2) =>
        sub2
          .setSection('selection.format.basic')
          .setTitle(title)
          .setIcon(icon)
          .setChecked(isWrapped(view, mark, markEnd))
          .onClick(() => wrapSelection(view, mark, markEnd)),
      );
    }
    sub.addItem((sub2) =>
      sub2
        .setSection('selection.format.advanced')
        .setTitle('Comment')
        .setIcon('lucide-percent')
        .setChecked(isWrapped(view, '%%'))
        .onClick(() => wrapSelection(view, '%%')),
    );
    sub.addItem((sub2) =>
      sub2
        .setSection('selection.format.danger')
        .setTitle('Clear formatting')
        .setIcon('lucide-eraser')
        .onClick(() => clearFormatting(view)),
    );
  });
}

/** Strip the known marker pairs hugging (or inside) the selection. */
function clearFormatting(view: EditorView): void {
  let guard = 0;
  for (;;) {
    if (guard++ > 12) break;
    const sel = view.state.selection.main;
    const doc = view.state.doc;
    let changed = false;
    const pairs: Array<[string, string]> = [
      ['**', '**'],
      ['~~', '~~'],
      ['==', '=='],
      ['%%', '%%'],
      ['*', '*'],
      ['`', '`'],
      ['$', '$'],
      ['<u>', '</u>'],
    ];
    for (const [open, close] of pairs) {
      const before = doc.sliceString(Math.max(0, sel.from - open.length), sel.from);
      const after = doc.sliceString(sel.to, Math.min(doc.length, sel.to + close.length));
      if (before === open && after === close) {
        view.dispatch({
          changes: [
            { from: sel.from - open.length, to: sel.from },
            { from: sel.to, to: sel.to + close.length },
          ],
          selection: { anchor: sel.from - open.length, head: sel.from - open.length + (sel.to - sel.from) },
          userEvent: 'input.format',
        });
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }
  view.focus();
}

// ---------------------------------------------------------------------------
// selection.paragraph (per-line transforms)
// ---------------------------------------------------------------------------

function eachSelectedLine(view: EditorView, fn: (line: string, idx: number) => string): void {
  const sel = view.state.selection.main;
  const fromLine = view.state.doc.lineAt(sel.from);
  const toLine = view.state.doc.lineAt(sel.to);
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  let idx = 0;
  for (let n = fromLine.number; n <= toLine.number; n++) {
    const line = view.state.doc.line(n);
    const next = fn(line.text, idx++);
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next });
  }
  if (changes.length > 0) view.dispatch({ changes, userEvent: 'input.format' });
  view.focus();
}

const stripHeading = (line: string): string => line.replace(/^#{1,6} /, '');
const stripListPrefix = (line: string): string =>
  line.replace(/^(\s*)(?:- \[[ xX]\] |- |\d+[.)] |> )?/, '$1');

function buildParagraphSubmenu(menu: Menu, view: EditorView): void {
  menu.addItem((item) => {
    item.setTitle('Paragraph').setIcon('lucide-pilcrow');
    const sub = submenuOf(item);
    if (!sub) return;

    sub.addItem((s2) =>
      s2.setSection('selection.paragraph.list').setTitle('Bullet list').setIcon('lucide-list').onClick(() =>
        eachSelectedLine(view, (line) =>
          /^- /.test(line) ? stripListPrefix(line) : '- ' + stripListPrefix(line),
        ),
      ),
    );
    sub.addItem((s2) =>
      s2.setSection('selection.paragraph.list').setTitle('Numbered list').setIcon('lucide-list-ordered').onClick(() =>
        eachSelectedLine(view, (line, i) => {
          if (/^\d+[.] |^\d+[)] /.test(line)) return stripListPrefix(line);
          return `${i + 1}. ` + stripListPrefix(line);
        }),
      ),
    );
    sub.addItem((s2) =>
      s2.setSection('selection.paragraph.list').setTitle('Checklist').setIcon('lucide-check-square').onClick(() =>
        eachSelectedLine(view, (line) => {
          if (/^- \[[ xX]\] /.test(line)) return stripListPrefix(line);
          if (/^- /.test(line)) return line.replace(/^- /, '- [ ] ');
          return '- [ ] ' + stripListPrefix(line);
        }),
      ),
    );

    const sel = view.state.selection.main;
    const fromLine = view.state.doc.lineAt(sel.from);
    const toLine = view.state.doc.lineAt(sel.to);
    for (let level = 1; level <= 6; level++) {
      const headingRe = new RegExp(`^#{${level}} `);
      const uniform =
        fromLine.number === toLine.number ? headingRe.test(fromLine.text) : false;
      sub.addItem((s2) =>
        s2
          .setSection('selection.paragraph.heading')
          .setTitle(`Heading ${level}`)
          .setIcon(`lucide-heading-${level}`)
          .setChecked(uniform)
          .onClick(() =>
            eachSelectedLine(view, (line) => (line.trim() ? `${'#'.repeat(level)} ` + stripHeading(line) : line)),
          ),
      );
    }
    sub.addItem((s2) =>
      s2
        .setSection('selection.paragraph.heading')
        .setTitle('No heading')
        .setIcon('lucide-text')
        .onClick(() => eachSelectedLine(view, stripHeading)),
    );
    sub.addItem((s2) =>
      s2.setSection('selection.paragraph.block').setTitle('Quote').setIcon('lucide-quote').onClick(() =>
        eachSelectedLine(view, (line) => (/^> /.test(line) ? line.replace(/^> /, '') : '> ' + line)),
      ),
    );
  });
}

// ---------------------------------------------------------------------------
// selection.insert
// ---------------------------------------------------------------------------

function buildInsertSubmenu(menu: Menu, view: EditorView): void {
  const insert = (text: string, caretOffset: number): void => {
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + caretOffset },
      userEvent: 'input.insert',
    });
    view.focus();
  };
  menu.addItem((item) => {
    item.setTitle('Insert').setIcon('lucide-list-plus');
    const sub = submenuOf(item);
    if (!sub) return;
    sub.addItem((s2) =>
      s2.setSection('selection.insert.basic').setTitle('Footnote').setIcon('lucide-file-signature').onClick(() => insert('[^1]', 4)),
    );
    sub.addItem((s2) =>
      s2
        .setSection('selection.insert.basic')
        .setTitle('Table')
        .setIcon('lucide-table')
        .onClick(() => insert('| A | B | C |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |', 2)),
    );
    sub.addItem((s2) =>
      s2
        .setSection('selection.insert.basic')
        .setTitle('Callout')
        .setIcon('lucide-quote')
        .onClick(() => insert('> [!note] Title\n> Content', 17)),
    );
    sub.addItem((s2) =>
      s2.setSection('selection.insert.basic').setTitle('Horizontal rule').setIcon('lucide-minus').onClick(() => insert('---', 3)),
    );
    sub.addItem((s2) =>
      s2.setSection('selection.insert.advanced').setTitle('Code block').setIcon('lucide-code').onClick(() => insert('```\n\n```', 4)),
    );
    sub.addItem((s2) =>
      s2.setSection('selection.insert.advanced').setTitle('Math block').setIcon('lucide-sigma-square').onClick(() => insert('$$\n\n$$', 3)),
    );
  });
}

// ---------------------------------------------------------------------------
// editor-menu event (plugin contributions) via a native Editor adapter
// ---------------------------------------------------------------------------

/**
 * A native `Editor`-shaped adapter over the CM6 view so plugins listening on
 * the `editor-menu` workspace event operate on the block editor's selection.
 * Unimplemented members resolve to no-ops (returning null) instead of
 * crashing the contributor.
 */
export function createEditorAdapter(view: EditorView, host?: BlockEditorView): Record<string, unknown> {
  const offToPos = (offset: number): { line: number; ch: number } => {
    const line = view.state.doc.lineAt(Math.max(0, Math.min(offset, view.state.doc.length)));
    return { line: line.number - 1, ch: offset - line.from };
  };
  const posToOff = (pos: { line: number; ch: number }): number => {
    const n = Math.max(1, Math.min(pos.line + 1, view.state.doc.lines));
    const line = view.state.doc.line(n);
    return Math.max(line.from, Math.min(line.from + pos.ch, line.to));
  };
  const replaceSel = (text: string): string => {
    const s = view.state.selection.main;
    view.dispatch({
      changes: { from: s.from, to: s.to, insert: text },
      selection: { anchor: s.from + text.length },
      userEvent: 'input.paste',
    });
    return text;
  };
  // Native-editor command support: Obsidian's editor:insert-table /
  // :insert-horizontal-rule / :toggle-bold / … editorCallbacks call Editor
  // methods; each below is ported from the native implementation operating
  // on the live CM6 state.
  const execCommand = (name: string): void => {
    const cmd = EXEC_COMMANDS[name];
    if (cmd) cmd(view);
  };
  const insertBlock = (open: string, close: string): void => {
    const state = view.state;
    const changes: Array<{ from: number; insert: string }> = [];
    for (const r of state.selection.ranges) {
      changes.push({ from: state.doc.lineAt(r.from).from, insert: `${open}\n` });
      changes.push({ from: state.doc.lineAt(r.to).to, insert: `\n${close}` });
    }
    const shift = open.length + 1;
    view.dispatch({
      changes,
      selection: EditorSelection.create(
        state.selection.ranges.map((r) => EditorSelection.range(r.anchor + shift, r.head + shift)),
      ),
    });
  };
  /** Toggle a marker pair around the selection / word under the caret. */
  const toggleMarkerPair = (mark: string, alt?: string): void => {
    const state = view.state;
    const sel = state.selection.main;
    const word = sel.empty ? state.wordAt(sel.head) : null;
    const probe = word ?? sel;
    const wrappedWith = (m: string): boolean => {
      if (state.doc.sliceString(Math.max(0, probe.from - m.length), probe.from) !== m) return false;
      if (state.doc.sliceString(probe.to, Math.min(state.doc.length, probe.to + m.length)) !== m) return false;
      // A single-char marker hugging a double-char one (the '*' inside '**')
      // is not a toggle hit — native resolves this via the syntax tree.
      if (m.length === 1) {
        if (state.doc.sliceString(Math.max(0, probe.from - 2), probe.from - 1) === m) return false;
        if (state.doc.sliceString(probe.to + 1, Math.min(state.doc.length, probe.to + 2)) === m) return false;
      }
      return true;
    };
    for (const m of alt ? [mark, alt] : [mark]) {
      if (wrappedWith(m)) {
        view.dispatch({
          changes: [
            { from: probe.from - m.length, to: probe.from },
            { from: probe.to, to: probe.to + m.length },
          ],
          selection: {
            anchor: probe.from - m.length,
            head: probe.from - m.length + (probe.to - probe.from),
          },
          userEvent: 'input.format',
        });
        return;
      }
    }
    if (word) {
      view.dispatch({
        changes: {
          from: word.from,
          to: word.to,
          insert: mark + state.sliceDoc(word.from, word.to) + mark,
        },
        selection: {
          anchor: word.from + mark.length,
          head: word.from + mark.length + (word.to - word.from),
        },
        userEvent: 'input.format',
      });
      return;
    }
    if (sel.empty) {
      // No word under the caret: drop an empty pair, caret inside.
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: mark + mark },
        selection: { anchor: sel.from + mark.length },
        userEvent: 'input.format',
      });
      return;
    }
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: mark + state.sliceDoc(sel.from, sel.to) + mark },
      selection: {
        anchor: sel.from + mark.length,
        head: sel.from + mark.length + (sel.to - sel.from),
      },
      userEvent: 'input.format',
    });
  };
  const selectedLineNumbers = (): [number, number] => {
    const sel = view.state.selection.main;
    return [view.state.doc.lineAt(sel.from).number, view.state.doc.lineAt(sel.to).number];
  };
  const base: Record<string, unknown> = {
    // Marks this as OUR adapter — the native slash suggest only triggers for
    // block editors (the native editor keeps its own slash menu).
    __blockEditorAdapter: true,
    getValue: () => view.state.doc.toString(),
    setValue: (text: string) =>
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    getSelection: () => {
      const s = view.state.selection.main;
      return view.state.sliceDoc(s.from, s.to);
    },
    getSelections: () => [view.state.selection.ranges.map((r) => view.state.sliceDoc(r.from, r.to))],
    replaceSelection: replaceSel,
    replaceSelections: (texts: string[]) => texts.map((t) => replaceSel(t)),
    getCursor: (mode?: string) => {
      const s = view.state.selection.main;
      const offset =
        mode === 'from' || mode === 'anchor'
          ? s.from
          : mode === 'to' || mode === 'head'
            ? s.to
            : s.head;
      return offToPos(offset);
    },
    listCursors: () => view.state.selection.ranges.map((r) => offToPos(r.head)),
    setCursor: (line: number, ch = 0) => {
      const off = posToOff({ line, ch });
      view.dispatch({ selection: { anchor: off } });
      view.focus();
    },
    setSelection: (from: { line: number; ch: number }, to: { line: number; ch: number }) =>
      view.dispatch({ selection: { anchor: posToOff(from), head: posToOff(to) } }),
    getLine: (n: number) => view.state.doc.line(Math.max(1, Math.min(n + 1, view.state.doc.lines))).text,
    setLine: (n: number, text: string) => {
      const line = view.state.doc.line(Math.max(1, Math.min(n + 1, view.state.doc.lines)));
      view.dispatch({ changes: { from: line.from, to: line.to, insert: text } });
    },
    lineCount: () => view.state.doc.lines,
    lastLine: () => view.state.doc.lines - 1,
    getRange: (from: { line: number; ch: number }, to: { line: number; ch: number }) =>
      view.state.sliceDoc(posToOff(from), posToOff(to)),
    setRange: (from: { line: number; ch: number }, to: { line: number; ch: number }, text: string) =>
      view.dispatch({ changes: { from: posToOff(from), to: posToOff(to), insert: text } }),
    replaceRange: (text: string, from: { line: number; ch: number }, to?: { line: number; ch: number }) =>
      view.dispatch({
        changes: { from: posToOff(from), to: to ? posToOff(to) : posToOff(from), insert: text },
      }),
    offsetToPos: offToPos,
    posToOffset: posToOff,
    // The raw CM6 view — plugins commonly reach for `editor.cm` (e.g. to
    // compute caret coordinates for their own popups: Highlightr & friends).
    cm: view,
    // Same shape as the native Editor: an offset-based coordinate lookup.
    // Accepts both an offset and an EditorPosition (the native Editor
    // signature) — the slash-menu system positions its popup with the latter.
    coordsAtPos: (pos: number | { line: number; ch: number }) => {
      const offset =
        typeof pos === 'number'
          ? pos
          : (() => {
              const n = Math.max(1, Math.min(pos.line + 1, view.state.doc.lines));
              const line = view.state.doc.line(n);
              return Math.max(line.from, Math.min(line.from + pos.ch, line.to));
            })();
      return view.coordsAtPos(Math.max(0, Math.min(offset, view.state.doc.length)));
    },
    // Native Editor has no `cursorCoords`; the native CM6 does, same shape.
    cursorCoords: () => view.coordsAtPos(view.state.selection.main.head),
    // Plugins often guard their menu actions on editor focus — but by the
    // time their click handler runs, focus is on the menu itself. Report
    // "focused" while the block editor still holds this live edit session.
    hasFocus: () =>
      view.hasFocus || (host ? host.focusedView === view || host.embedEdit?.view === view : false),
    undo: () => cmUndo(view),
    redo: () => cmRedo(view),
    setSelections: (sels: Array<{ anchor: { line: number; ch: number }; head?: { line: number; ch: number } }>) => {
      const first = sels[0];
      if (!first) return;
      view.dispatch({
        selection: { anchor: posToOff(first.anchor), head: posToOff(first.head ?? first.anchor) },
      });
    },
    isEditable: () => true,
    editable: true,
    wordRangeAt: (pos: { line: number; ch: number }) => {
      const off = posToOff(pos);
      const word = view.state.wordAt(off);
      return word ? { from: offToPos(word.from), to: offToPos(word.to) } : null;
    },
    focus: () => view.focus(),
    blur: () => view.contentDOM.blur(),
    getDoc: () => null,
    wordAt: () => null,
    getClickableTokenAt: () => null,
    // --- Obsidian editor commands (native slash menu / command palette) ---
    // editor:insert-table — native port: append the table at line end (or
    // after a blank line when the current line is empty), caret in cell 1.
    insertTable: () => {
      const sel = view.state.selection.main;
      const line = view.state.doc.lineAt(sel.anchor);
      let at = sel.anchor;
      let nl = '\n';
      if (line.text.length) {
        at = line.to;
        nl = '\n\n';
      }
      view.dispatch({
        changes: [{ from: at, insert: `${nl}|     |     |\n| --- | --- |\n|     |     |\n` }],
        selection: { anchor: at + nl.length + 1 },
      });
    },
    // editor:insert-horizontal-rule — native port: 1 newline at column 0,
    // 2 otherwise, so the `---` never joins existing text.
    insertHorizontalRule: () => {
      const state = view.state;
      view.dispatch(
        state.changeByRange((range) => {
          const col = range.from - state.doc.lineAt(range.from).from;
          const ins = '\n'.repeat(col > 0 ? 2 : 1) + '---\n';
          return {
            range: EditorSelection.cursor(range.from + ins.length),
            changes: [{ from: range.from, to: range.to, insert: ins }],
          };
        }),
      );
    },
    // editor:insert-footnote — native numbers via the saved file's metadata
    // cache; the live doc scan gives the same numbering without a save.
    insertFootnote: () => {
      const state = view.state;
      const text = state.doc.toString();
      let n = 1;
      while (n < 999 && new RegExp(`\\[\\^${n}\\]`).test(text)) n++;
      const ref = `[^${n}]`;
      const sel = state.selection.main;
      const trailing = (text.slice(sel.to).match(/\n*$/) ?? [''])[0].length;
      const gap = '\n'.repeat(2 - Math.min(trailing, 2));
      view.dispatch({
        changes: [
          { from: sel.from, insert: ref },
          { from: state.doc.length, insert: `${gap}${ref}: \n` },
        ],
        selection: { anchor: sel.from + ref.length },
      });
    },
    insertBlock,
    insertCodeblock: () => insertBlock('```', '```'),
    insertMathBlock: () => insertBlock('$$', '$$'),
    insertCallout: () => {
      const state = view.state;
      const sel = state.selection.main;
      const fromLine = state.doc.lineAt(sel.from);
      const toLine = state.doc.lineAt(sel.to);
      const beforeCursor = fromLine.text.slice(0, sel.from - fromLine.from).trim();
      if (sel.from !== sel.to || beforeCursor) {
        // Quote the affected lines into a callout (native branch A).
        let head = '> [!NOTE]\n> ';
        if (fromLine.number > 1 && state.doc.line(fromLine.number - 1).text) head = `\n${head}`;
        const changes: Array<{ from: number; insert: string }> = [
          { from: fromLine.from, insert: head },
        ];
        for (let n = fromLine.number + 1; n <= toLine.number; n++) {
          changes.push({ from: state.doc.line(n).from, insert: '> ' });
        }
        if (toLine.number < state.doc.lines && state.doc.line(toLine.number + 1).text) {
          changes.push({ from: state.doc.line(toLine.number + 1).from, insert: '\n' });
        }
        const headerStart = fromLine.from + (head.startsWith('\n') ? 1 : 0);
        view.dispatch({ changes, selection: { anchor: headerStart + 4, head: headerStart + 8 } });
      } else {
        // Fresh callout below the cursor (native branch B); the selection
        // lands on the [!NOTE] token so the type can be retyped.
        view.dispatch({
          changes: { from: sel.from, to: sel.to, insert: '\n> [!NOTE] Title\n> Contents\n' },
          selection: { anchor: sel.from + 5, head: sel.from + 9 },
        });
      }
    },
    toggleMarkdownFormatting: (kind: string) => {
      const spec = MD_FORMAT_SPECS[kind];
      if (spec) toggleMarkerPair(spec.mark, spec.alt);
    },
    toggleComment: () => toggleMarkerPair('%%'),
    toggleBlockquote: () => {
      const state = view.state;
      const [fromN, toN] = selectedLineNumbers();
      let add = false;
      for (let n = fromN; n <= toN; n++) {
        if (!state.doc.line(n).text.startsWith('>')) {
          add = true;
          break;
        }
      }
      const changes: Array<{ from: number; to?: number; insert: string }> = [];
      for (let n = fromN; n <= toN; n++) {
        const line = state.doc.line(n);
        if (add) {
          changes.push({ from: line.from, insert: '> ' });
        } else {
          const m = line.text.match(/^>(?:[ \t]|$)/);
          if (m) changes.push({ from: line.from, to: line.from + m[0].length, insert: '' });
        }
      }
      if (changes.length > 0) view.dispatch({ changes, userEvent: 'input.format' });
    },
    setHeading: (level: number) => {
      const state = view.state;
      const [fromN, toN] = selectedLineNumbers();
      // Native sP = /^([>\s]*)(#{1,6} )?(.*)/ — the marker group is optional,
      // so plain lines get the new prefix inserted at the line start (that is
      // what makes the mobile H1–H6 buttons work on ordinary text).
      const changes: Array<{ from: number; to?: number; insert: string }> = [];
      for (let n = fromN; n <= toN; n++) {
        const line = state.doc.line(n);
        const m = line.text.match(/^([>\s]*)(#{1,6} )?(.*)$/);
        if (!m) continue;
        const from = line.from + m[1].length;
        const to = from + (m[2]?.length ?? 0);
        const insert = level === 0 ? '' : `${'#'.repeat(level)} `;
        if (to > from || insert) changes.push({ from, to, insert });
      }
      if (changes.length > 0) view.dispatch({ changes, userEvent: 'input.format' });
    },
    exec: execCommand,
    indentList: () => execCommand('indentMore'),
    unindentList: () => execCommand('indentLess'),
    somethingSelected: () => !view.state.selection.main.empty,
    transaction: () => null,
    editorEl: view.contentDOM,
    containerEl: view.dom,
  };
  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return () => null;
    },
  });
}

function triggerEditorMenu(menu: Menu, view: EditorView, host: BlockEditorView): void {
  try {
    const adapter = createEditorAdapter(view, host);
    // `view` is wrapped so plugins reaching for `view.editor` (the native
    // MarkdownView shape) land on the adapter instead of undefined.
    const viewArg = new Proxy(host, {
      get(target, prop) {
        if (prop === 'editor') return adapter;
        const value = Reflect.get(target, prop as string);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    host.app.workspace.trigger('editor-menu', menu, adapter, viewArg);
  } catch {
    // A misbehaving contributor must not kill the menu.
  }
}

// ---------------------------------------------------------------------------
// workspace.activeEditor parity
// ---------------------------------------------------------------------------

/**
 * The native editor registers itself as `workspace.activeEditor` on focus and
 * clears it on blur — the command system (`editorCallback`) and many plugins
 * resolve the working editor through it. Mirror that for the block editor:
 * while one of its CM6 views is live, `activeEditor` is a pseudo-MarkdownView
 * whose `.editor` is the adapter.
 */
export function syncActiveBlockEditor(app: { workspace: unknown }, host: BlockEditorView, view: EditorView): void {
  const adapter = createEditorAdapter(view, host);
  const pseudo = {
    __blockEditorPseudo: true,
    __host: host,
    editor: adapter,
    cm: view,
    file: host.file,
    getMode: () => 'source',
    getViewType: () => 'markdown',
  };
  (app.workspace as { activeEditor?: unknown }).activeEditor = pseudo;
}

export function clearActiveBlockEditor(app: { workspace: unknown }): void {
  const ws = app.workspace as { activeEditor?: unknown };
  // Only clear when it is still ours (never clobber a native editor's value).
  const current = ws.activeEditor as { __blockEditorPseudo?: boolean } | null | undefined;
  if (current && typeof current === 'object' && current.__blockEditorPseudo) {
    ws.activeEditor = null;
  }
}

/**
 * MenuItem.setSubmenu() is not in the public d.ts but is stable in the
 * runtime API; fall back to nothing (the parent item stays inert) when it
 * ever disappears.
 */
function submenuOf(item: unknown): Menu | null {
  const sub = (item as { setSubmenu?: () => Menu }).setSubmenu?.();
  return sub instanceof Menu ? sub : null;
}
