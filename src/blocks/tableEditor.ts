/**
 * Interactive table editing for the block editor.
 *
 * ## Why this exists
 *
 * Obsidian's own table editor is a PRIVATE CM6 extension: it renders as
 * `.cm-embed-block.cm-table-widget.markdown-rendered` with `.table-editor`
 * inside, driven by a block widget that is not reachable through
 * `window.require` (verified by probing a real instance). It cannot be
 * mounted into a foreign editor, so this reimplements the same UX on top of
 * `tableModel.ts`.
 *
 * ## Design
 *
 * The rendered `<table>` produced by MarkdownRenderer is UPGRADED IN PLACE
 * rather than replaced, so every existing style (borders, alignment, column
 * sizing) keeps applying and there is no flash on re-render. We add:
 *   - `contenteditable` cells with plain-text paste (markdown stays valid)
 *   - Tab / Shift+Tab and arrow navigation between cells
 *   - edge behavior: Tab/arrow past the last cell appends a row, arrows past
 *     the last column append one — same as Obsidian
 *   - a header toolbar: add/remove column, alignment, drag to reorder
 *   - row drag handles
 *
 * Every mutation goes through `host.mutate`, so undo, save-debounce and
 * re-render all keep working with no extra bookkeeping here.
 */
import type { BlockEditorView } from '../view/BlockEditorView';
import type { Block } from '../types';
import {
  addColumn,
  addRow,
  editTableInText,
  findTable,
  moveColumn,
  moveRow,
  removeColumn,
  removeRow,
  serializeTable,
  setCell,
  setColumnAlign,
  type AlignKind,
  type BoundTable,
  type ParsedTable,
} from './tableModel';

const CLS = 'lgp-table-editor';

/** Where the caret is inside the table. */
interface Cursor {
  kind: 'header' | 'body';
  row: number;
  col: number;
}

/** Map a DOM cell to its model coordinates. */
function cursorOf(t: BoundTable, cell: HTMLElement): Cursor | null {
  const table = t.root;
  if (!table.contains(cell)) return null;
  const rowEl = cell.parentElement as HTMLTableRowElement | null;
  if (!rowEl) return null;
  const rowIndex = [...table.tBodies[0]?.rows ?? []].indexOf(rowEl as HTMLTableRowElement);
  const col = [...(rowEl.cells ?? [])].indexOf(cell as HTMLTableCellElement);
  if (col < 0) return null;
  if (rowIndex < 0) return { kind: 'header', row: -1, col };
  return { kind: 'body', row: rowIndex, col };
}

/** The cell element for a model coordinate. */
function cellEl(t: BoundTable, cur: Cursor): HTMLTableCellElement | null {
  const table = t.root;
  if (cur.kind === 'header') return (table.tHead?.rows[0]?.cells[cur.col] as HTMLTableCellElement) ?? null;
  const row = table.tBodies[0]?.rows[cur.row];
  return (row?.cells[cur.col] as HTMLTableCellElement) ?? null;
}

export interface TableController {
  /** Detach listeners and remove the toolbar. */
  destroy(): void;
}

/**
 * Make one rendered `<table>` interactive. Returns null when the block has no
 * editable table (nothing to do).
 */
export function enhanceTable(table: HTMLTableElement, b: Block, host: BlockEditorView): TableController | null {
  // Only the FIRST table in a block is made interactive. A block holding two
  // tables is rare, and multi-table editing would need an index-aware model.
  if (findTable(b.text) === null) return null;
  if (table.closest(`.${CLS}`)) return null; // already enhanced (re-render)

  const t: BoundTable = { ...findTable(b.text)!, root: table };
  const wrap = document.createElement('div');
  wrap.className = CLS;
  table.replaceWith(wrap);
  wrap.appendChild(table);

  const cleanups: (() => void)[] = [];
  const on = <K extends keyof HTMLElementEventMap>(
    el: HTMLElement,
    type: K,
    fn: (e: HTMLElementEventMap[K]) => void,
    opts?: AddEventListenerOptions,
  ) => {
    el.addEventListener(type, fn as EventListener, opts);
    cleanups.push(() => el.removeEventListener(type, fn as EventListener, opts));
  };

  // ---------------------------------------------------------------- model
  const model = (): BoundTable => ({ ...(findTable(b.text) ?? t), root: table });

  /** Apply a model mutation to the block and re-render just this table. */
  const apply = (mutate: (x: ParsedTable) => ParsedTable) => {
    host.mutate(() => {
      b.text = editTableInText(b.text, mutate);
    });
  };

  // ------------------------------------------------------------- editing
  table.classList.add(`${CLS}-table`);
  for (const cell of [...table.querySelectorAll('th, td')] as HTMLElement[]) {
    cell.setAttribute('contenteditable', 'true');
    cell.setAttribute('spellcheck', 'false');
    // Obsidian marks numeric/right-aligned cells dir="auto"; keep ours stable
    // but make the editor plain-text so pasted markdown cannot break the row.
    on(cell, 'paste', (e) => {
      const ev = e as ClipboardEvent;
      ev.preventDefault();
      const text = (ev.clipboardData?.getData('text/plain') ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
      document.execCommand('insertText', false, text);
    });
    // Enter inside a cell would create a div and break the row; Obsidian
    // moves to the cell below instead.
    on(cell, 'keydown', (e) => {
      const ke = e as unknown as KeyboardEvent;
      if (ke.key === 'Enter' && !ke.shiftKey) {
        ke.preventDefault();
        const cur = cursorOf(t, cell as HTMLElement);
        if (cur) focusCell({ kind: 'body', row: cur.kind === 'header' ? 0 : cur.row + 1, col: cur.col });
      }
    });
    // Commit on blur so the model is updated even without navigation.
    on(cell, 'blur', () => {
      const cur = cursorOf(t, cell as HTMLElement);
      if (!cur) return;
      // Read the cell's TEXT, never its innerHTML: drag handles and other
      // decorations live in the DOM around the text and must not be persisted
      // into the markdown.
      const value = readCellText(cell as HTMLElement);
      const m = model();
      const existing = cur.kind === 'header' ? m.header.cells[cur.col]?.text : m.body[cur.row]?.cells[cur.col]?.text;
      if (existing === value) return;
      apply((x) => setCell(x, cur, value));
    });
    on(cell, 'mousedown', (e) => {
      // Let Obsidian's block-click handler not steal the focus: we want the
      // cell focused, not the block's CM6 editor.
      const me = e as MouseEvent;
      me.stopPropagation();
      // Focus explicitly. Relying on the browser's default is unreliable for
      // an EMPTY contenteditable: with no text node there is nothing to place
      // a selection in, so the focus can silently fail and the keystrokes go
      // to the document instead of the cell.
      cell.focus();
      // `focus()` alone still leaves the caret unplaced in an empty cell: the
      // browser ends up with the selection on the ELEMENT node rather than a
      // text position, and paints the caret at the document origin — which
      // reads as "the caret is somewhere far above the table". A collapsed
      // range inside the cell gives it a real position to draw at.
      if (readCellText(cell as HTMLElement) === '') {
        placeCaretStart(cell as HTMLElement);
      }
    });
    on(cell, 'click', (e) => {
      (e as MouseEvent).stopPropagation();
    });
    on(cell, 'dblclick', (e) => {
      (e as MouseEvent).stopPropagation();
    });
  }

  function focusCell(cur: Cursor, placeCaretAtEnd = true): boolean {
    const el = cellEl(model(), cur);
    if (!el) return false;
    el.focus();
    // An empty cell needs a caret anchor; `placeCaretEnd` on a cell with no
    // text node leaves the selection on the element and paints nothing.
    if (readCellText(el) === '') placeCaretStart(el);
    else if (placeCaretAtEnd) placeCaretEnd(el);
    scrollIntoViewIfNeeded(el);
    return true;
  }

  function placeCaretEnd(el: HTMLElement): void {
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  function scrollIntoViewIfNeeded(el: HTMLElement): void {
    const r = el.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) el.scrollIntoView({ block: 'nearest' });
  }

  // ---------------------------------------------------------- navigation
  /**
   * Move by one cell, growing the table at the edges (Obsidian parity).
   *
   * `dc !== 0` is HORIZONTAL only (Tab / Shift+Tab walk in row order, wrapping
   * to the next row at the row end); `dr !== 0` is VERTICAL only (arrow keys
   * stay in their column). Only ArrowRight off the last column appends a
   * column, and only Tab off the very last cell appends a row — matching
   * Obsidian, where Tab never widens the table.
   */
  function advance(cur: Cursor, dr: number, dc: number, wrapRows = false): void {
    const m0 = model();
    let { kind, row, col } = cur;

    if (dc !== 0) {
      if (!wrapRows) {
        // Arrow Left/Right: stay in this row. Past the last column → grow it.
        const next = col + dc;
        if (next < 0) return;
        if (next > m0.columns - 1) {
          apply((x) => addColumn(x));
          const created = m0.columns;
          requestAnimationFrame(() => focusCell({ kind, row, col: created }));
          return;
        }
        focusCell({ kind, row, col: next });
        return;
      }
      // Tab / Shift+Tab: walk row-major, wrapping into the next row.
      const rowCount = m0.body.length + 1;
      const flat = kind === 'header' ? 0 : row + 1;
      const step = kind === 'header' ? 0 : col;
      let next = step + dc;
      let nextRow = flat;
      if (next > m0.columns - 1) {
        next = 0;
        nextRow = flat + 1;
      } else if (next < 0) {
        next = m0.columns - 1;
        nextRow = flat - 1;
      }

      if (nextRow < 0) return; // before the header — nowhere to go
      if (nextRow >= rowCount) {
        // Past the final cell → append a row and land in its first column.
        apply((x) => addRow(x));
        const created = m0.body.length;
        requestAnimationFrame(() => focusCell({ kind: 'body', row: created, col: 0 }));
        return;
      }
      if (nextRow === 0) {
        focusCell({ kind: 'header', row: -1, col: next });
      } else {
        focusCell({ kind: 'body', row: nextRow - 1, col: next });
      }
      return;
    }

    if (dr !== 0) {
      const target = row + dr;
      if (target < 0) {
        if (kind === 'body') focusCell({ kind: 'header', row: -1, col });
        return;
      }
      if (target >= m0.body.length) {
        // Below the last row: only ArrowDown grows the table.
        if (dr > 0) {
          apply((x) => addRow(x));
          const created = m0.body.length;
          requestAnimationFrame(() => focusCell({ kind: 'body', row: created, col }));
        }
        return;
      }
      if (kind === 'header' && dr < 0) return; // already at the top
      // From the header, ArrowDown enters the first body row.
      const nextKind: 'header' | 'body' = kind === 'header' ? 'body' : 'body';
      const nextRow = kind === 'header' ? 0 : target;
      focusCell({ kind: nextKind, row: nextRow, col: Math.min(col, model().columns - 1) });
      return;
    }

    focusCell({ kind, row, col });
  }

  // CAPTURE phase, and on the TABLE rather than the wrapper: inside a
  // contenteditable the browser's own Tab handling runs during bubbling and
  // would move focus out of the table before a bubble-phase listener ever
  // sees the key. We must claim it first.
  on(table, 'keydown', (e) => {
    const ke = e as unknown as KeyboardEvent;
    const cell = (ke.target as HTMLElement)?.closest?.('th, td') as HTMLElement | null;
    if (!cell) return;
    const cur = cursorOf(t, cell);
    if (!cur) return;

    if (ke.key === 'Tab') {
      ke.preventDefault();
      ke.stopPropagation();
      advance(cur, 0, ke.shiftKey ? -1 : 1, true);
      return;
    }
    // Arrow navigation only when the caret is at the cell edge, so normal
    // text editing inside a cell still works.
    const atEdge = edgePosition(cell, ke.key);
    if (atEdge) {
      ke.preventDefault();
      ke.stopPropagation();
      const { dr, dc } = atEdge;
      advance(cur, dr, dc);
    }
  }, { capture: true });

  // ------------------------------------------------------------- toolbar
  const bar = document.createElement('div');
  bar.className = `${CLS}-bar`;
  wrap.insertBefore(bar, table);

  const addRowBtn = button(bar, '+ Row', 'Add a row at the end', () => {
    apply((x) => addRow(x));
    requestAnimationFrame(() => focusCell({ kind: 'body', row: model().body.length - 1, col: 0 }));
  });
  const addColBtn = button(bar, '+ Column', 'Add a column at the end', () => {
    apply((x) => addColumn(x));
  });
  void addRowBtn;
  void addColBtn;

  const alignGroup = document.createElement('span');
  alignGroup.className = `${CLS}-align`;
  bar.appendChild(alignGroup);
  const mkAlign = (label: string, title: string, kind: AlignKind) => {
    const btn = button(alignGroup, label, title, () => {
      // Which column? The one the caret is in, else the first.
      const cell = wrap.querySelector('th, td:focus') as HTMLElement | null;
      const cur = cell ? cursorOf(t, cell) : null;
      const col = cur?.col ?? 0;
      apply((x) => setColumnAlign(x, col, kind));
    });
    return btn;
  };
  mkAlign('≡', 'Align left', 'left');
  mkAlign('≡', 'Align center', 'center');
  mkAlign('≡', 'Align right', 'right');
  mkAlign('∅', 'No alignment', null);

  // Drag handles: one per column (header) and one per body row.
  // `bText` gives the ghost the current text (the block may have been edited
  // since the table was rendered).
  const drag = makeDragHandles(t, apply, () => b.text);

  return {
    destroy() {
      for (const fn of cleanups) fn();
      drag();
    },
  };
}

function button(parent: HTMLElement, label: string, title: string, fn: () => void): HTMLButtonElement {
  const btn = parent.createEl('button', { text: label, cls: `${CLS}-btn` });
  btn.title = title;
  btn.type = 'button';
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    fn();
  });
  return btn;
}

/**
 * Which arrow key means "leave this cell", if any.
 *
 * Returns null while the caret is mid-text, so arrows still move the caret
 * inside a cell. Uses a Range hit-test because a cell can wrap to several
 * visual lines and "first line" is not "top of the cell".
 */
function edgePosition(cell: HTMLElement, key: string): { dr: number; dc: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!cell.contains(range.startContainer)) return null;
  // Only act for a collapsed caret.
  if (!range.collapsed) return null;

  const rects = range.getClientRects();
  const last = rects[rects.length - 1];
  const first = rects[0];
  if (!last || !first) return null;

  // A single-line cell: left/right decide by caret offset.
  const cellRect = cell.getBoundingClientRect();
  const singleLine = cell.scrollHeight <= cell.clientHeight + 2;

  if (key === 'ArrowRight') {
    if (singleLine) {
      const offset = caretOffset(cell);
      return offset >= textLength(cell) ? { dr: 0, dc: 1 } : null;
    }
    return Math.abs(last.right - cellRect.right) < 2 ? { dr: 0, dc: 1 } : null;
  }
  if (key === 'ArrowLeft') {
    if (singleLine) {
      return caretOffset(cell) <= 0 ? { dr: 0, dc: -1 } : null;
    }
    return Math.abs(first.left - cellRect.left) < 2 ? { dr: 0, dc: -1 } : null;
  }
  if (key === 'ArrowDown') {
    return Math.abs(last.bottom - cellRect.bottom) < 2 ? { dr: 1, dc: 0 } : null;
  }
  if (key === 'ArrowUp') {
    return Math.abs(first.top - cellRect.top) < 2 ? { dr: -1, dc: 0 } : null;
  }
  return null;
}

function textLength(el: HTMLElement): number {
  return (el.textContent ?? '').length;
}

/**
 * The cell's user-typed text, excluding any editor chrome.
 *
 * `innerText` would include decorations (drag handles) and would be affected by
 * CSS; this walks only text nodes that are not inside a `.lgp-table-editor-*`
 * subtree, which is exactly the content the model should store.
 */
function readCellText(cell: HTMLElement): string {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let out = '';
  let node = walker.nextNode() as Text | null;
  while (node) {
    const parent = node.parentElement;
    const isChrome = !!parent?.closest(`.${CLS}-col-handle, .${CLS}-row-handle, .${CLS}-bar`);
    if (!isChrome) out += node.data;
    node = walker.nextNode() as Text | null;
  }
  // The zero-width space is a caret anchor, never content — strip it (and any
  // other invisible formatting char) so it can never reach the markdown.
  return out.replace(/[\u200b-\u200f\ufeff]/g, '').replace(/\s*\n\s*/g, ' ').trim();
}

function caretOffset(el: HTMLElement): number {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return 0;
  const range = sel.getRangeAt(0).cloneRange();
  range.selectNodeContents(el);
  range.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return range.toString().length;
}

/**
 * Put the caret at the start of an EMPTY cell so it is actually painted.
 *
 * An empty contenteditable has no text node, and the browser will not draw a
 * caret at an element-level selection: measured, the selection sat on the TH
 * element itself and the caret rect came back `{x:0, y:0}` — i.e. drawn at the
 * document origin, which looks like the caret escaped the table entirely.
 *
 * A zero-width space is used as the anchor. It is invisible, it is not part of
 * the cell's value (`readCellText` strips it), and it gives the caret a real
 * text position to render at. It is removed as soon as the user types, so no
 * stray character can survive into the markdown.
 */
const ZWSP = '\u200b';

function placeCaretStart(cell: HTMLElement): void {
  // Reuse an existing zero-width space if we put one there before.
  const existing = [...cell.childNodes].filter(
    (n): n is Text => n.nodeType === Node.TEXT_NODE,
  );
  let anchor = existing.find((n) => n.data === ZWSP);
  if (!anchor) {
    const created = document.createTextNode(ZWSP);
    // Before the drag handle, so it never becomes part of the value ordering.
    cell.insertBefore(created, cell.firstChild);
    anchor = created;
  }
  const range = document.createRange();
  range.setStart(anchor, 0);
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * Column and row drag handles.
 *
 * ## Why POINTER events, not HTML5 drag-and-drop
 *
 * The first version used `draggable=true` + dragstart/dragover/drop. It never
 * fired, for two independent reasons:
 *   1. the handles were EMPTY absolutely-positioned divs with no width/height,
 *      so they collapsed to 0x0 — nothing to grab, no :hover, no hit test
 *      (`elementFromPoint` returned the TH underneath);
 *   2. native HTML5 DnD is unreliable inside a contenteditable region — the
 *      browser starts a text drag instead.
 * Pointer events (pointerdown/pointermove/pointerup) sidestep both, and give
 * us the live drop-target highlighting Obsidian shows.
 *
 * ## Why handles live INSIDE their cell
 *
 * A handle must be a child of the cell it belongs to so CSS can position it
 * against that cell (the previous version appended handles to <table> and
 * computed fixed pixel offsets once, which went stale on any relayout).
 * It is safe as a child because it carries NO text node (its glyph comes from a
 * CSS `::before`) and it is `contenteditable="false"`, so it can never become
 * part of the cell's value — `readCellText` also filters these subtrees.
 */
function makeDragHandles(
  t: BoundTable,
  apply: (fn: (x: ParsedTable) => ParsedTable) => void,
  bText: () => string,
  onDragStateChange?: (dragging: boolean) => void,
): () => void {
  const disposers: (() => void)[] = [];
  const table = t.root;

  type Axis = 'col' | 'row';
  interface DragState {
    axis: Axis;
    from: number;
  }
  let drag: DragState | null = null;
  /**
   * The floating preview that follows the cursor during a drag.
   *
   * Native HTML5 drag images can't be used (we are on pointer events, and they
   * are unreliable inside contenteditable), so this is a plain element
   * positioned with `position: fixed` and moved on every pointermove.
   */
  let ghost: HTMLElement | null = null;

  /**
   * Which row/column the pointer is over.
   *
   * Uses `document.elementFromPoint` and walks up to the owning `tr` / `th` —
   * NOT a bounding-rect scan. Rect math looked equivalent but was wrong: the
   * handles are absolutely positioned inside their cells, so a handle's center
   * can easily fall inside the *next* row's box (measured: handle centers
   * mapped to row indices 1, 2, -1 for three rows). Hit-testing asks the
   * browser what is actually under the cursor, which is the question we
   * actually want to ask.
   */
  const indexAt = (x: number, y: number, axis: Axis): number => {
    const el = document.elementFromPoint(x, y);
    if (!el) return -1;
    if (axis === 'col') {
      const cell = el.closest('th, td');
      if (!cell || !table.contains(cell)) return -1;
      const cells = [...(table.tHead?.rows[0]?.cells ?? [])];
      return cells.indexOf(cell as HTMLTableCellElement);
    }
    const tr = el.closest('tbody tr');
    if (!tr || !table.contains(tr)) return -1;
    return [...(table.tBodies[0]?.rows ?? [])].indexOf(tr as HTMLTableRowElement);
  };

  /**
   * Fallback for a release that lands outside every row/column (e.g. the user
   * drops past the last row). Uses rect math deliberately — here it is only a
   * "which edge is nearest" decision, not an identity mapping.
   */
  const nearestIndex = (x: number, y: number, axis: Axis, count: number): number => {
    if (count <= 0) return -1;
    const list: DOMRect[] =
      axis === 'col'
        ? [...(table.tHead?.rows[0]?.cells ?? [])].map((c) => c.getBoundingClientRect())
        : [...(table.tBodies[0]?.rows ?? [])].map((tr) => tr.getBoundingClientRect());
    let best = -1;
    let bestDist = Infinity;
    for (const [i, r] of list.entries()) {
      const cx = Math.max(r.left, Math.min(x, r.right));
      const cy = Math.max(r.top, Math.min(y, r.bottom));
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    return best;
  };

  const clearDropMarks = (): void => {
    for (const sel of [`.${CLS}-drop-before`, `.${CLS}-drop-after`, `.${CLS}-lifted`, `.${CLS}-landed-cell`]) {
      table.querySelectorAll(sel).forEach((e) => e.classList.remove(sel.slice(1)));
    }
  };

  /**
   * Resolve a drop target.
   *
   * Returns -1 when the pointer is OUTSIDE the table, which cancels the drop:
   * releasing the handle off the table must leave the table untouched, not
   * snap the row/column back to the nearest edge. A release inside the table
   * but in the gap between rows/columns still resolves to the nearest one, so
   * slightly-off drops feel forgiving instead of dead.
   */
  const resolveTarget = (x: number, y: number, axis: Axis): number => {
    const r = table.getBoundingClientRect();
    // A little slack around the table so a release just past the border still
    // counts as "inside" — but far enough that clearly-outside drops cancel.
    const slack = 24;
    if (x < r.left - slack || x > r.right + slack || y < r.top - slack || y > r.bottom + slack) return -1;
    const exact = indexAt(x, y, axis);
    if (exact >= 0) return exact;
    const count = axis === 'col' ? (table.tHead?.rows[0]?.cells.length ?? 0) : (table.tBodies[0]?.rows.length ?? 0);
    return nearestIndex(x, y, axis, count);
  };

  /**
   * Show where the row/column will land.
   *
   * Deliberately mirrors the block drag-and-drop already in this project
   * (`interactions/dnd.ts` + the `drop-before` / `drop-after` styles): a thin
   * accent LINE drawn with a `::before` / `::after` pseudo-element, placed on
   * the near or far edge of the target depending on the drag direction. That
   * is Obsidian's own visual language, so tables and blocks feel like one
   * system — and the line reads as "it will be inserted here" instead of the
   * "this box is selected" look an outline gives.
   *
   * The source row/column dims at the same time, which is what tells the user
   * the item left its old slot.
   */
  const markDrop = (axis: Axis, index: number, source: number): void => {
    clearDropMarks();
    const sourceEl =
      axis === 'col'
        ? table.tHead?.rows[0]?.cells[source]
        : table.tBodies[0]?.rows[source];
    sourceEl?.classList.add(`${CLS}-lifted`);
    if (index < 0) return;

    // Direction decides which edge the line hugs: dragging down/right puts the
    // marker on the far side of the target, dragging up/left on the near side.
    const forward = index >= source;
    const cls = `${CLS}-drop-${forward ? 'after' : 'before'}`;
    if (axis === 'col') {
      // The marker is painted by the cell's ::after, so the class goes on the
      // cells — a <tr> cannot render pseudo-elements either.
      for (const cell of [...(table.tHead?.rows[0]?.cells ?? [])]) {
        if (cell === table.tHead?.rows[0]?.cells[index]) cell.classList.add(cls);
      }
      return;
    }
    const row = table.tBodies[0]?.rows[index];
    if (!row) return;
    for (const td of [...row.children]) td.classList.add(cls);
  };

  /**
   * Build the floating preview that follows the cursor.
   *
   * The ghost is a MINIATURE OF THE ACTUAL ROW OR COLUMN — a real `<table>`
   * with every cell, not a text summary. That is what makes the drag legible:
   * you see the whole thing you grabbed, with its real column count and content
   * layout, exactly as it will land.
   *
   * `position: fixed` + clientX/clientY means no layout is disturbed and no
   * scroll offset has to be compensated.
   */
  const ensureGhost = (axis: Axis, index: number): HTMLElement => {
    if (ghost) return ghost;
    ghost = document.createElement('div');
    ghost.className = `${CLS}-ghost`;
    const t = findTable(bText());
    if (!t) {
      ghost.textContent = axis === 'col' ? 'Column' : 'Row';
      document.body.appendChild(ghost);
      return ghost;
    }

    const mini = document.createElement('table');
    mini.className = `${CLS}-ghost-table`;

    if (axis === 'col') {
      // The whole COLUMN: header cell + every body cell, in order.
      const head = mini.createEl('thead').createEl('tr');
      head.createEl('th', { text: t.header.cells[index]?.text ?? '' });
      const body = mini.createEl('tbody');
      for (const row of t.body) {
        const tr = body.createEl('tr');
        tr.createEl('td', { text: row.cells[index]?.text ?? '' });
      }
    } else {
      // The whole ROW: every cell, in column order, in a SINGLE row. A body
      // row has no header, so rendering it twice (as th and td) would show
      // the same values duplicated.
      const r = t.body[index];
      const cells = r ? r.cells : [];
      const body = mini.createEl('tbody');
      const tr = body.createEl('tr');
      for (let c = 0; c < t.columns; c++) {
        tr.createEl('td', { text: cells[c]?.text ?? '' });
      }
    }
    ghost.appendChild(mini);
    document.body.appendChild(ghost);
    return ghost;
  };

  const moveGhost = (x: number, y: number, valid: boolean): void => {
    if (!ghost) return;
    ghost.style.left = `${x + 12}px`;
    ghost.style.top = `${y + 12}px`;
    ghost.classList.toggle(`${CLS}-ghost-invalid`, !valid);
  };

  /**
   * Briefly highlight the row/column that just landed.
   *
   * `apply()` re-renders the block, which REPLACES the table element — the
   * captured `table` reference is stale by the time the new DOM exists (looking
   * it up on the old node silently found nothing, so the flash never fired).
   * So the lookup goes through the document, scoped to the wrapper that is
   * still in place, and waits two frames for the render to land.
   */
  const flashLanded = (axis: Axis, index: number): void => {
    // `apply()` re-renders the block, which replaces the ENTIRE wrapper — so a
    // captured `scope` (or the `table` itself) is stale by the time the new DOM
    // exists. The block's own wrapper is the only stable handle, and the
    // re-render is synchronous inside `apply`, so by the time the first frame
    // runs the new table is already in the document.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const live = document.querySelector(`.${CLS}-table`);
        const el =
          axis === 'col'
            ? live?.querySelector('thead tr')?.children[index]
            : live?.querySelectorAll('tbody tr')[index];
        if (!el) return;
        const cells = axis === 'row' ? [...el.children] : [el];
        // Force a reflow so the class actually starts the animation rather than
        // being coalesced away.
        void (el as HTMLElement).offsetWidth;
        for (const c of cells) c.classList.add(`${CLS}-landed-cell`);
        window.setTimeout(() => {
          for (const c of cells) c.classList.remove(`${CLS}-landed-cell`);
        }, 700);
      });
    });
  };

  const finish = (): void => {
    drag = null;
    clearDropMarks();
    table.classList.remove(`${CLS}-dragging`);
    table.querySelectorAll(`.${CLS}-handle.dragging`).forEach((e) => e.classList.remove('dragging'));
    ghost?.remove();
    ghost = null;
    document.body.classList.remove(`${CLS}-cursor`);
    onDragStateChange?.(false);
  };

  const mkHandle = (axis: Axis, index: number, cell: HTMLElement, title: string): HTMLElement => {
    const h = document.createElement('div');
    h.className = `${CLS}-${axis}-handle`;
    h.title = title;
    h.setAttribute('contenteditable', 'false');
    // Not focusable and not selectable: the handle is a pure mouse affordance.
    h.setAttribute('tabindex', '-1');
    h.setAttribute('aria-hidden', 'true');
    cell.appendChild(h);

    on(h, 'pointerdown', (e) => {
      const ev = e as PointerEvent;
      // Only the primary button starts a reorder.
      if (ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      drag = { axis, from: index };
      h.classList.add('dragging');
      table.classList.add(`${CLS}-dragging`);
      // Suppress text selection for the whole gesture, and show a grab cursor
      // even when the pointer wanders off the small handle.
      document.body.classList.add(`${CLS}-cursor`);
      ensureGhost(axis, index);
      moveGhost(ev.clientX, ev.clientY, true);
      h.setPointerCapture?.(ev.pointerId);
      onDragStateChange?.(true);
    });

    on(h, 'pointermove', (ev) => {
      if (!drag || drag.axis !== axis) return;
      const pe = ev as PointerEvent;
      pe.preventDefault();
      pe.stopPropagation();
      const to = resolveTarget(pe.clientX, pe.clientY, axis);
      markDrop(axis, to, drag.from);
      // The ghost turns red-ish while outside, so cancelling is predictable.
      moveGhost(pe.clientX, pe.clientY, to >= 0);
    });

    on(h, 'pointerup', (ev) => {
      if (!drag || drag.axis !== axis) return;
      const pe = ev as PointerEvent;
      pe.preventDefault();
      pe.stopPropagation();
      const to = resolveTarget(pe.clientX, pe.clientY, axis);
      const from = drag.from;
      finish();
      // to < 0 means the handle was released OUTSIDE the table: cancel and
      // leave the data untouched. to === from means no move.
      if (to < 0 || to === from) return;
      apply((x) => (axis === 'col' ? moveColumn(x, from, to) : moveRow(x, from, to)));
      flashLanded(axis, to);
    });

    on(h, 'pointercancel', () => finish());
    // A drag that ends outside any handle still has to clean up.
    on(h, 'lostpointercapture', () => finish());
    disposers.push(() => h.remove());
    return h;
  };

  // Column handles, one per header cell. Each is centred on its column, which
  // requires a per-column offset: the handles are children of the cells, and
  // columns vary in width, so a single CSS value cannot align them all.
  const headerRow = table.tHead?.rows[0];
  if (headerRow) {
    [...headerRow.cells].forEach((cell, col) => {
      const h = mkHandle('col', col, cell, 'Drag to reorder this column');
      h.classList.add(`${CLS}-col-handle-align`);
    });
  }

  // Row handles, one per body row, anchored to the first cell.
  for (const [rowIndex, tr] of [...(table.tBodies[0]?.rows ?? [])].entries()) {
    const first = tr.cells[0];
    if (!first) continue;
    mkHandle('row', rowIndex, first, 'Drag to reorder this row');
  }

  /**
   * Centre the handles that hang outside the table.
   *
   * They live inside their cell but are positioned with a negative offset
   * (into the wrapper's padding gutter). Their horizontal position therefore
   * depends on the column width, which is only known after layout — so it is
   * computed here and recomputed on resize.
   */
  const alignHandles = (): void => {
    const headerCells = [...(table.tHead?.rows[0]?.cells ?? [])];
    headerCells.forEach((cell) => {
      const h = cell.querySelector(`.${CLS}-col-handle`) as HTMLElement | null;
      if (!h) return;
      // Half the handle's width, from the cell's left edge.
      h.style.left = `${Math.max(0, cell.offsetWidth / 2 - h.offsetWidth / 2)}px`;
    });
  };
  alignHandles();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => alignHandles());
    ro.observe(table);
    disposers.push(() => ro.disconnect());
  }

  // A pointerup anywhere ends the drag cleanly (e.g. released over the toolbar).
  on(table, 'pointerup', () => finish());
  on(table, 'pointercancel', () => finish());

  function on(el: HTMLElement, type: string, fn: (e: Event) => void): void {
    el.addEventListener(type, fn);
    disposers.push(() => el.removeEventListener(type, fn));
  }

  return () => {
    finish();
    for (const d of disposers) d();
  };
}

/** Remove a row (exposed for the context menu). */
export function deleteRowAt(b: Block, row: number): string {
  return editTableInText(b.text, (x) => removeRow(x, row));
}

/** Remove a column (exposed for the context menu). */
export function deleteColumnAt(b: Block, col: number): string {
  return editTableInText(b.text, (x) => removeColumn(x, col));
}

/** Re-serialize a table (used after an external edit). */
export function reserialize(b: Block): string {
  const t = findTable(b.text);
  return t ? editTableInText(b.text, () => t) : b.text;
}

export { serializeTable };
