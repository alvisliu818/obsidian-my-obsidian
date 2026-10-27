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
import { isMemoPayload } from './inlineMemo';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';
import {
  INLINE_FORMAT_MARKS,
  INLINE_NODE_MARKS,
  formatNodeAt,
  formatNodesIntersecting,
  inlineFormatsAcross,
  normalizeMark,
} from './inlineFormats';
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
import type { BlockRenderHost } from '../blocks/renderHost';
import { capturePasteInsertPosition, isPasteInsertPositionAlive, type PasteInsertPosition } from '../features/insertPosition';

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
export function openTextSelectionMenu(ev: MouseEvent, host: BlockRenderHost): boolean {
  const view: EditorView | null = host.focusedView ?? host.embedEdit?.view ?? null;
  if (!view) return false;
  ev.preventDefault();
  ev.stopPropagation();
  const menu = new Menu();
  const sel = view.state.selection.main;
  const hasSel = !sel.empty;
  // 思源 upload/insertPosition.ts：异步工作前捕获插入位（菜单打开时焦点
  // 还在编辑器上），点击后读剪贴板回来验活；embed 会话验活退化为 CM 连通性。
  const embedSession = host.embedEdit?.view === view;
  const capPos = capturePasteInsertPosition(host, view);
  const cap: PasteCapture | null =
    capPos && capPos.view === view
      ? { pos: capPos, from: sel.from, to: sel.to, embed: embedSession }
      : null;

  buildClipboardSection(menu, view, host, cap, hasSel);
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

function buildClipboardSection(
  menu: Menu,
  view: EditorView,
  host: BlockRenderHost,
  cap: PasteCapture | null,
  hasSel: boolean,
): void {
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
      .onClick(() => void pasteFromClipboard(host, view, cap, true)),
  );
  menu.addItem((item) =>
    item
      .setSection('clipboard')
      .setTitle('Paste as plain text')
      .setIcon('lucide-clipboard-type')
      .onClick(() => void pasteFromClipboard(host, view, cap, false)),
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

/** 菜单粘贴的捕获：插入位骨架 + 替换区间（打开菜单时刻的选区）。 */
interface PasteCapture {
  pos: PasteInsertPosition;
  from: number;
  to: number;
  embed: boolean;
}

async function pasteFromClipboard(
  host: BlockRenderHost,
  view: EditorView,
  cap: PasteCapture | null,
  keepPosition: boolean,
): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    // 验活（insertPosition.ts 骨架）：无法稳定捕获、捕获的是另一个 CM、
    // CM 已被 blur 提交链卸载、或焦点块被重建掉——都不做不确定的插入。
    if (!cap || cap.pos.view !== view) return;
    const alive = cap.embed ? view.dom.isConnected : isPasteInsertPositionAlive(host, cap.pos);
    if (!alive) return;
    const len = view.state.doc.length;
    const from = Math.min(cap.from, len);
    const to = Math.min(cap.to, len);
    view.dispatch({
      changes: { from, to, insert: text },
      selection: { anchor: from + text.length },
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
export function wrapSelection(view: EditorView, mark: string, markEnd = mark): void {
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

/**
 * Inline memo toggle (SiYuan InlineMemo.ts parity, batch 27): wrap the
 * selection in `((...))`, or unwrap when the selection spans exactly one memo
 * pair. Guards: an exact `((uuid))` selection is a BLOCK REF — the memo
 * button leaves it alone; a selection flush against a half pair (`(m` / `o)`)
 * would only produce garbage — also left alone. UUID / paren / newline
 * payloads never get wrapped.
 */
export function memoToggleSelection(view: EditorView): void {
  const sel = view.state.selection.main;
  const text = view.state.sliceDoc(sel.from, sel.to);
  if (text === '') return;
  const before = view.state.sliceDoc(Math.max(0, sel.from - 2), sel.from);
  const after = view.state.sliceDoc(sel.to, Math.min(view.state.doc.length, sel.to + 2));
  if (before === '((' && after === '))') {
    if (isMemoPayload(text)) wrapSelection(view, '((', '))');
    return;
  }
  if (before.endsWith('(') || after.startsWith(')')) return;
  if (!isMemoPayload(text)) return;
  wrapSelection(view, '((', '))');
}

/**
 * Whether a click on `mark` would unwrap (batch 28: syntax-tree truth).
 * Kept for call-site compatibility; `markEnd` is ignored — the tree resolves
 * the pair by node type, not by hugging strings.
 */
export function isWrapped(view: EditorView, mark: string, _markEnd = mark): boolean {
  return activeMarksAt(view).includes(normalizeMark(mark));
}

/**
 * 当前选区上「点击会命中解包」的标记集（批次 28 语法树正解，思源
 * inlineFormat.ts 交集口径：probe 触及的每个文本段求类型交集）。空选区沿用
 * word 探测（点击动作同 probe），词探测失败退化光标点判定（resolveInner 偏
 * 左向上）。返回规范形式（bold 无论 ** 或 __ 都归 '**'）。
 */
export function activeMarksAt(view: EditorView): string[] {
  const state = view.state;
  const sel = state.selection.main;
  const word = sel.empty ? state.wordAt(sel.head) : null;
  const probe = word ?? sel;
  if (probe.to > probe.from) return inlineFormatsAcross(state, [probe]);
  // 词探测失败（光标在空白/标点上）：光标点判定——思源 collapsed range 在
  // 格式内按钮照样亮（DOM 语义），对应树上 resolveInner(-1) 向上收集。
  const found = new Set<string>();
  let node: SyntaxNode | null = syntaxTree(state).resolveInner(sel.head, -1);
  while (node) {
    const mark = INLINE_NODE_MARKS[node.name];
    if (mark) found.add(mark);
    node = node.parent;
  }
  return INLINE_FORMAT_MARKS.filter((m) => found.has(m));
}

/**
 * Toggle a marker pair around the selection / word under the caret (native
 * Obsidian `toggleMarkdownFormatting` parity; shared by the right-click menu
 * and the floating format toolbar).
 *
 * Batch 28: the unwrap side is resolved via the syntax tree — when the probe
 * sits inside a format node of the requested type the WHOLE node unwraps
 * (marks stripped at the node edges, selection mapped back), not just when
 * markers hug the probe exactly. Same interrogation as activeMarksAt, so the
 * lit button always describes what clicking will do.
 */
export function toggleMarkerPairFor(view: EditorView, mark: string, alt?: string): void {
  const state = view.state;
  const sel = state.selection.main;
  const word = sel.empty ? state.wordAt(sel.head) : null;
  const probe = word ?? sel;
  for (const m of alt ? [mark, alt] : [mark]) {
    const node = formatNodeAt(state, probe.from, probe.to, m);
    if (node) {
      // 实测标记长（__ 与 ** 同型节点但都是 2；$ 是 1）。
      const first = node.firstChild;
      const mLen = first ? first.to - first.from : normalizeMark(m).length;
      // 选区不手动指定：CM 按 changes 自动映射旧选区（删除区内 assoc -1
      // 落到删除点），光标在内容/标记内/词中间的解包语义全部自然成立。
      view.dispatch({
        changes: [
          { from: node.from, to: node.from + mLen },
          { from: node.to - mLen, to: node.to },
        ],
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
}

export const FORMAT_MARKS: Array<[string, string, string, string]> = [
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
    for (const [title, icon, mark] of FORMAT_MARKS) {
      const alt = title === 'Bold' ? '__' : title === 'Italic' ? '_' : undefined;
      sub.addItem((sub2) =>
        sub2
          .setSection('selection.format.basic')
          .setTitle(title)
          .setIcon(icon)
          .setChecked(isWrapped(view, mark))
          .onClick(() => toggleMarkerPairFor(view, mark, alt)),
      );
    }
    sub.addItem((sub2) =>
      sub2
        .setSection('selection.format.basic')
        .setTitle('Comment')
        .setIcon('lucide-percent')
        .setChecked(isWrapped(view, '%%'))
        .onClick(() => toggleMarkerPairFor(view, '%%')),
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
export function clearFormatting(view: EditorView): void {
  // Batch 28 树清理：选区相交的每个格式节点的首尾标记全删（思源/原生
  // "clear" 语义——选区内的格式无论是否紧贴都清掉），一次 dispatch。
  const sel = view.state.selection.main;
  if (!sel.empty) {
    const nodes = formatNodesIntersecting(view.state, sel.from, sel.to);
    if (nodes.length > 0) {
      const changes: Array<{ from: number; to: number }> = [];
      for (const node of nodes) {
        const first = node.firstChild;
        const mLen = first ? first.to - first.from : 1;
        changes.push({ from: node.from, to: node.from + mLen });
        changes.push({ from: node.to - mLen, to: node.to });
      }
      changes.sort((a, b) => a.from - b.from);
      view.dispatch({ changes, userEvent: 'input.format' });
    }
  }
  let guard = 0;
  for (;;) {
    if (guard++ > 12) break;
    const cur = view.state.selection.main;
    const doc = view.state.doc;
    let changed = false;
    const pairs: Array<[string, string]> = [
      ['<u>', '</u>'],
    ];
    for (const [open, close] of pairs) {
      const before = doc.sliceString(Math.max(0, cur.from - open.length), cur.from);
      const after = doc.sliceString(cur.to, Math.min(doc.length, cur.to + close.length));
      if (before === open && after === close) {
        view.dispatch({
          changes: [
            { from: cur.from - open.length, to: cur.from },
            { from: cur.to, to: cur.to + close.length },
          ],
          selection: { anchor: cur.from - open.length, head: cur.from - open.length + (cur.to - cur.from) },
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
export function createEditorAdapter(view: EditorView, host?: BlockRenderHost): Record<string, unknown> {
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
  const toggleMarkerPair = (mark: string, alt?: string): void => toggleMarkerPairFor(view, mark, alt);
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

function triggerEditorMenu(menu: Menu, view: EditorView, host: BlockRenderHost): void {
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
export function syncActiveBlockEditor(app: { workspace: unknown }, host: BlockRenderHost, view: EditorView): void {
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
