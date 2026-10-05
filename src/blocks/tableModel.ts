/**
 * GFM table model: parse, edit, serialize.
 *
 * PURE LOGIC — no DOM, no `obsidian` import — so it can be unit tested under
 * plain node (project rule: anything under test must stay importable).
 *
 * Scope note: Obsidian's own table editor is a PRIVATE CM6 extension
 * (`.cm-table-widget` / `.table-editor`, exposed as a block widget that cannot
 * be reached through `window.require`), so it cannot be reused. This module
 * plus `tableEditor.ts` reimplement the same UX.
 *
 * ## Why the model is offset-based
 *
 * A table can live INSIDE a block's text (a block may hold a paragraph, then a
 * table, then more text). Edits must therefore be expressed as replacements of
 * a source RANGE, not of the whole block text. Every mutation returns
 * `{ text, from, to, insert }` so the caller can splice it into whatever
 * surrounding text exists without this module knowing anything about blocks.
 */

export type AlignKind = 'left' | 'center' | 'right' | null;

export interface TableCell {
  /** Raw cell content, trimmed. May be empty. */
  text: string;
  /** Source column index (0-based). */
  col: number;
}

export interface TableRow {
  kind: 'header' | 'body';
  cells: TableCell[];
  /** Source line index within the block text. */
  line: number;
}

export interface TableAlignRow {
  /** One entry per column. */
  aligns: AlignKind[];
  line: number;
}

export interface ParsedTable {
  header: TableRow;
  aligns: TableAlignRow;
  body: TableRow[];
  /** Source line range [startLine, endLine] inclusive. */
  startLine: number;
  endLine: number;
  /** True when every row had the same number of cells as the header. */
  uniform: boolean;
  /** Column count from the header row. */
  columns: number;
}

/**
 * A parsed table bound to its live DOM `<table>`.
 *
 * Kept separate from ParsedTable so the model stays pure (no DOM) and
 * testable under plain node; only the editor layer adds `root`.
 */
export interface BoundTable extends ParsedTable {
  root: HTMLTableElement;
}

const SEP_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** Split one markdown table row into trimmed cell texts. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  // Split on unescaped pipes only, so `\|` stays inside the cell.
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

/** Read the alignment declared by one `| --- | :--: |` style line. */
export function parseAlignLine(line: string): AlignKind[] {
  return splitRow(line).map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

function isAlignLine(line: string): boolean {
  return /\|/.test(line) && SEP_RE.test(line);
}

/**
 * A table row: either pipe-delimited (`| a | b |`) or bare (`a | b`).
 *
 * The bare form is valid GFM, but only when an align line follows — otherwise
 * any sentence containing a pipe would look like a row. That constraint is
 * enforced by the caller, which only accepts a header when the NEXT line is an
 * align line with a matching column count.
 */
function isRowLine(line: string): boolean {
  if (!line.includes('|')) return false;
  const t = line.trim();
  // Reject a bare pipe character with nothing around it.
  return t.length > 1;
}

/**
 * Find a table inside `text`.
 *
 * Returns null when there is no GFM table. A table needs at least a header row
 * and an alignment row; the alignment row must have the same column count as
 * the header, otherwise markdown does not treat it as a table at all.
 */
export function findTable(text: string): ParsedTable | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    if (!isRowLine(lines[i])) continue;
    if (!isAlignLine(lines[i + 1])) continue;
    const headerCells = splitRow(lines[i]);
    const alignCells = parseAlignLine(lines[i + 1]);
    if (headerCells.length !== alignCells.length) continue;
    if (headerCells.length === 0) continue;

    const body: TableRow[] = [];
    let end = i + 1;
    for (let j = i + 2; j < lines.length; j++) {
      if (!isRowLine(lines[j])) break;
      const cells = splitRow(lines[j]);
      body.push({
        kind: 'body',
        cells: cells.map((t, col) => ({ text: t, col })),
        line: j,
      });
      end = j;
    }

    const columns = headerCells.length;
    const uniform =
      alignCells.length === columns && body.every((r) => r.cells.length === columns);

    return {
      header: {
        kind: 'header',
        cells: headerCells.map((t, col) => ({ text: t, col })),
        line: i,
      },
      aligns: { aligns: alignCells, line: i + 1 },
      body,
      startLine: i,
      endLine: end,
      uniform,
      columns,
    };
  }
  return null;
}

/** True when `text` contains a GFM table anywhere. */
export function hasTable(text: string): boolean {
  return findTable(text) !== null;
}

/** Escape a cell value for markdown output. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function renderRow(cells: TableCell[], pad: number): string {
  const out: string[] = [];
  for (let i = 0; i < pad; i++) out.push(escapeCell(cells[i]?.text ?? ''));
  return `| ${out.join(' | ')} |`;
}

function renderAlign(aligns: AlignKind[], pad: number): string {
  const out: string[] = [];
  for (let i = 0; i < pad; i++) {
    switch (aligns[i] ?? null) {
      case 'center':
        out.push(':---:');
        break;
      case 'right':
        out.push('---:');
        break;
      case 'left':
        out.push(':---');
        break;
      default:
        out.push('---');
    }
  }
  return `| ${out.join(' | ')} |`;
}

/** Serialize a table back to markdown lines. */
export function serializeTable(t: ParsedTable): string {
  const pad = Math.max(
    t.columns,
    t.aligns.aligns.length,
    ...t.body.map((r) => r.cells.length),
    1,
  );
  const lines = [
    renderRow(t.header.cells, pad),
    renderAlign(t.aligns.aligns, pad),
    ...t.body.map((r) => renderRow(r.cells, pad)),
  ];
  return lines.join('\n');
}

/**
 * Replace the table's source range inside `text` with `replacement`.
 *
 * The range covers the table's lines and the newline that ENDS its last line,
 * but nothing beyond. Getting this wrong eats the blank line that separated
 * the table from what followed, and the table then fuses with the next
 * paragraph (both render wrong).
 */
export function spliceTable(
  text: string,
  t: ParsedTable,
  replacement: string,
): { text: string; from: number; to: number } {
  const lines = text.split('\n');
  const from = offsetOfLine(lines, t.startLine);
  const lastLine = t.endLine;
  if (lastLine + 1 >= lines.length) {
    // Table is the last thing in the text: no trailing newline of its own to
    // preserve, and adding one would change the text.
    return { text: text.slice(0, from) + replacement, from, to: text.length };
  }
  // Otherwise consume exactly the newline that ends the last table line, so a
  // blank separator line after the table survives.
  const to = offsetOfLine(lines, lastLine + 1);
  return { text: text.slice(0, from) + replacement + '\n' + text.slice(to), from, to };
}

/** Character offset where line `n` starts. */
export function offsetOfLine(lines: string[], n: number): number {
  let off = 0;
  for (let i = 0; i < n && i < lines.length; i++) off += lines[i].length + 1;
  return off;
}

// ---------------------------------------------------------------- edits
//
// Each edit returns a NEW table plus a patch describing the source change, so
// the caller can apply it to arbitrary surrounding text.

export interface TablePatch {
  /** Full replacement text for the table's source range. */
  table: string;
  from: number;
  to: number;
}

/** Coordinates inside the table. */
export interface CellRef {
  kind: 'header' | 'body';
  /** Row index within `body` (ignored for the header). */
  row: number;
  col: number;
}

function cloneTable(t: ParsedTable): ParsedTable {
  return {
    ...t,
    header: { ...t.header, cells: t.header.cells.map((c) => ({ ...c })) },
    aligns: { ...t.aligns, aligns: [...t.aligns.aligns] },
    body: t.body.map((r) => ({ ...r, cells: r.cells.map((c) => ({ ...c })) })),
  };
}

function rowOf(t: ParsedTable, ref: CellRef): TableRow {
  return ref.kind === 'header' ? t.header : t.body[ref.row];
}

/** Set one cell's text. */
export function setCell(t: ParsedTable, ref: CellRef, value: string): ParsedTable {
  const next = cloneTable(t);
  const row = rowOf(next, ref);
  if (!row) return next;
  while (row.cells.length <= ref.col) row.cells.push({ text: '', col: row.cells.length });
  row.cells[ref.col] = { text: value, col: ref.col };
  next.columns = Math.max(next.columns, row.cells.length);
  return next;
}

/** Append a column; every row gets a new empty cell. */
export function addColumn(t: ParsedTable, at?: number): ParsedTable {
  const next = cloneTable(t);
  const col = at ?? next.columns;
  const push = (row: TableRow) => {
    if (col < row.cells.length) row.cells.splice(col, 0, { text: '', col });
    else {
      while (row.cells.length < col) row.cells.push({ text: '', col: row.cells.length });
      row.cells.push({ text: '', col });
    }
    row.cells.forEach((c, i) => (c.col = i));
  };
  push(next.header);
  next.body.forEach(push);
  next.aligns.aligns.splice(col, 0, null);
  next.columns += 1;
  return next;
}

/** Remove a column (never the last one). */
export function removeColumn(t: ParsedTable, col: number): ParsedTable {
  if (t.columns <= 1 || col < 0 || col >= t.columns) return t;
  const next = cloneTable(t);
  next.header.cells.splice(col, 1);
  next.body.forEach((r) => r.cells.splice(col, 1));
  next.aligns.aligns.splice(col, 1);
  next.header.cells.forEach((c, i) => (c.col = i));
  next.body.forEach((r) => r.cells.forEach((c, i) => (c.col = i)));
  next.columns -= 1;
  return next;
}

/** Append a body row filled with empty cells. */
export function addRow(t: ParsedTable): ParsedTable {
  const next = cloneTable(t);
  const cells = [];
  for (let c = 0; c < next.columns; c++) cells.push({ text: '', col: c });
  next.body.push({ kind: 'body', cells, line: next.endLine + 1 });
  next.endLine += 1;
  return next;
}

/** Remove a body row. */
export function removeRow(t: ParsedTable, row: number): ParsedTable {
  if (row < 0 || row >= t.body.length) return t;
  const next = cloneTable(t);
  next.body.splice(row, 1);
  return next;
}

/** Set a column's alignment. */
export function setColumnAlign(t: ParsedTable, col: number, align: AlignKind): ParsedTable {
  const next = cloneTable(t);
  while (next.aligns.aligns.length <= col) next.aligns.aligns.push(null);
  next.aligns.aligns[col] = align;
  return next;
}

/** Move a body row from one index to another (drag reorder). */
export function moveRow(t: ParsedTable, from: number, to: number): ParsedTable {
  if (from === to) return t;
  if (from < 0 || from >= t.body.length) return t;
  const next = cloneTable(t);
  const clamped = Math.max(0, Math.min(next.body.length - 1, to));
  const [row] = next.body.splice(from, 1);
  next.body.splice(clamped, 0, row);
  return next;
}

/** Move a column from one index to another (drag reorder). */
export function moveColumn(t: ParsedTable, from: number, to: number): ParsedTable {
  if (from === to) return t;
  if (from < 0 || from >= t.columns) return t;
  const next = cloneTable(t);
  const clamped = Math.max(0, Math.min(next.columns - 1, to));

  const take = <T>(arr: T[], i: number) => arr.splice(i, 1)[0];
  next.header.cells.splice(clamped, 0, take(next.header.cells, from));
  next.body.forEach((r) => r.cells.splice(clamped, 0, take(r.cells, from)));
  next.aligns.aligns.splice(clamped, 0, take(next.aligns.aligns, from));
  next.header.cells.forEach((c, i) => (c.col = i));
  next.body.forEach((r) => r.cells.forEach((c, i) => (c.col = i)));
  return next;
}

/**
 * Apply an edit to a table inside `text`, returning the new block text.
 *
 * `mutate` receives a cloned table and returns it (or the same one mutated).
 */
export function editTableInText(
  text: string,
  mutate: (t: ParsedTable) => ParsedTable,
): string {
  const t = findTable(text);
  if (!t) return text;
  const next = mutate(t);
  if (next === t) return text;
  return spliceTable(text, t, serializeTable(next)).text;
}
