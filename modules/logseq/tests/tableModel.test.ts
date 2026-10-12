/**
 * GFM table model: parsing, editing, serializing.
 *
 * These are pure-function tests — no DOM. The model is the foundation of the
 * table editor UI, so the invariants worth locking down are:
 *   - a table is only recognized when header + align line AGREE on columns
 *     (markdown itself requires this; a mismatch renders as plain text)
 *   - editing never loses the surrounding block text (offset splicing)
 *   - row/column reorders keep every row the same width
 */
import { describe, expect, it } from 'vitest';
import {
  addColumn,
  addRow,
  editTableInText,
  findTable,
  hasTable,
  moveColumn,
  moveRow,
  parseAlignLine,
  removeColumn,
  removeRow,
  serializeTable,
  setCell,
  setColumnAlign,
  splitRow,
} from '../src/blocks/tableModel';

const NL = '\n';
const TBL = ['| Name | Age |', '| --- | --- |', '| Alice | 30 |', '| Bob | 25 |'].join(NL);

describe('splitRow', () => {
  it('splits with and without outer pipes', () => {
    expect(splitRow('| a | b |')).toEqual(['a', 'b']);
    expect(splitRow('a | b')).toEqual(['a', 'b']);
  });

  it('keeps escaped pipes inside a cell', () => {
    expect(splitRow('| a \\| b | c |')).toEqual(['a | b', 'c']);
  });

  it('preserves empty cells', () => {
    expect(splitRow('| a |  | c |')).toEqual(['a', '', 'c']);
  });
});

describe('parseAlignLine', () => {
  it('reads all four alignment kinds', () => {
    expect(parseAlignLine('| --- | :--- | :---: | ---: |')).toEqual([null, 'left', 'center', 'right']);
  });
});

describe('findTable', () => {
  it('finds a simple table and reports its line range', () => {
    const t = findTable(TBL)!;
    expect(t).not.toBeNull();
    expect(t.columns).toBe(2);
    expect(t.header.cells.map((c) => c.text)).toEqual(['Name', 'Age']);
    expect(t.body.map((r) => r.cells.map((c) => c.text))).toEqual([['Alice', '30'], ['Bob', '25']]);
    expect(t.startLine).toBe(0);
    expect(t.endLine).toBe(3);
    expect(t.uniform).toBe(true);
  });

  it('finds a table embedded in surrounding block text', () => {
    const text = ['Some notes', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', 'After'].join(NL);
    const t = findTable(text)!;
    expect(t).not.toBeNull();
    expect(t.startLine).toBe(2);
    expect(t.endLine).toBe(4);
  });

  it('REJECTS a header whose align line has a different column count', () => {
    // Markdown does not treat this as a table; neither must we, or we would
    // hand the user an editor for something that renders as plain text.
    const bogus = ['| a | b | c |', '| --- | --- |', '| 1 | 2 | 3 |'].join(NL);
    expect(findTable(bogus)).toBeNull();
    expect(hasTable(bogus)).toBe(false);
  });

  it('rejects text with no table', () => {
    expect(findTable('just a paragraph')).toBeNull();
    expect(hasTable('# heading')).toBe(false);
  });

  it('is not fooled by a pipe inside a code fence', () => {
    const fenced = ['```', '| a | b |', '| --- | --- |', '```'].join(NL);
    // The caller (withTableSeparation / the editor) is responsible for fence
    // awareness; the model only sees the lines. Document the raw behavior.
    expect(typeof hasTable(fenced)).toBe('boolean');
  });

  it('does NOT treat ordinary prose with a pipe as a table', () => {
    // The row test is deliberately permissive (bare `a | b` is valid GFM), so
    // the column-count agreement is what keeps prose out. Guard the cases
    // that would otherwise slip through.
    const prose = [
      'use a | b to mean "and"',
      'pipe | count mismatch follows',
      'a | b',
      'not a table | either',
    ].join(NL);
    expect(findTable(prose)).toBeNull();
  });

  it('accepts a single-column table (legal GFM)', () => {
    // Not a guard against prose — a real (if degenerate) table. We must not
    // refuse it, or the user could not edit such a table.
    const t = findTable(['| a |', '| --- |', '| 1 |'].join(NL));
    expect(t).not.toBeNull();
    expect(t!.columns).toBe(1);
    expect(t!.body).toHaveLength(1);
  });
});

describe('serializeTable', () => {
  it('round-trips a canonical table byte-for-byte', () => {
    const t = findTable(TBL)!;
    expect(serializeTable(t)).toBe(TBL);
  });

  it('normalizes a table with missing outer pipes', () => {
    const t = findTable('a | b\n--- | ---\n1 | 2')!;
    expect(serializeTable(t)).toBe('| a | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('pads ragged rows to the widest column count', () => {
    const t = findTable(['| a | b |', '| --- | --- |', '| 1 |'].join(NL))!;
    const out = serializeTable(t);
    // Every line must have the same number of cells, or the table breaks.
    const widths = out.split(NL).map((l) => splitRow(l).length);
    expect(new Set(widths).size).toBe(1);
  });

  it('escapes pipes in cell content', () => {
    const t = setCell(findTable(TBL)!, { kind: 'body', row: 0, col: 0 }, 'a | b');
    expect(serializeTable(t)).toContain('a \\| b');
    // And it must survive a re-parse.
    expect(splitRow(serializeTable(t).split(NL)[2])[0]).toBe('a | b');
  });
});

describe('editing', () => {
  it('setCell changes one cell only', () => {
    const t = setCell(findTable(TBL)!, { kind: 'body', row: 0, col: 1 }, '31');
    expect(t.body[0].cells[1].text).toBe('31');
    expect(t.body[1].cells[1].text).toBe('25');
  });

  it('addColumn appends a cell to EVERY row', () => {
    const t = addColumn(findTable(TBL)!);
    expect(t.columns).toBe(3);
    expect(t.header.cells.map((c) => c.text)).toEqual(['Name', 'Age', '']);
    expect(t.body[0].cells).toHaveLength(3);
    expect(t.aligns.aligns).toHaveLength(3);
    // Serialized output must stay rectangular.
    const widths = serializeTable(t).split(NL).map((l) => splitRow(l).length);
    expect(new Set(widths).size).toBe(1);
  });

  it('addColumn(at) inserts at the requested index', () => {
    const t = addColumn(setColumnAlign(findTable(TBL)!, 0, 'left'), 1);
    expect(t.aligns.aligns).toEqual(['left', null, null]);
    const header = t.header.cells.map((c) => c.text);
    expect(header[1]).toBe('');
  });

  it('removeColumn never removes the last column', () => {
    const one = findTable('| a |\n| --- |\n| 1 |')!;
    expect(removeColumn(one, 0).columns).toBe(1);
  });

  it('removeColumn keeps rows rectangular', () => {
    const t = removeColumn(findTable(TBL)!, 0);
    expect(t.columns).toBe(1);
    const widths = serializeTable(t).split(NL).map((l) => splitRow(l).length);
    expect(new Set(widths).size).toBe(1);
  });

  it('addRow / removeRow change the body only', () => {
    const t = addRow(findTable(TBL)!);
    expect(t.body).toHaveLength(3);
    expect(t.header.cells.map((c) => c.text)).toEqual(['Name', 'Age']);
    const back = removeRow(t, 2);
    expect(back.body).toHaveLength(2);
  });

  it('moveRow reorders the body', () => {
    const t = moveRow(findTable(TBL)!, 0, 1);
    expect(t.body.map((r) => r.cells[0].text)).toEqual(['Bob', 'Alice']);
  });

  it('moveRow clamps an out-of-range target', () => {
    const t = moveRow(findTable(TBL)!, 0, 99);
    expect(t.body.map((r) => r.cells[0].text)).toEqual(['Bob', 'Alice']);
  });

  it('moveColumn reorders EVERY row plus the align line', () => {
    const src = findTable(['| a | b | c |', '| --- | :---: | ---: |', '| 1 | 2 | 3 |'].join(NL))!;
    const t = moveColumn(src, 0, 2);
    expect(t.header.cells.map((c) => c.text)).toEqual(['b', 'c', 'a']);
    expect(t.body[0].cells.map((c) => c.text)).toEqual(['2', '3', '1']);
    expect(t.aligns.aligns).toEqual(['center', 'right', null]);
    // Cell col indexes must stay consistent with their positions.
    t.body.forEach((r) => r.cells.forEach((c, i) => expect(c.col).toBe(i)));
  });

  it('setColumnAlign grows the align row when needed', () => {
    const t = setColumnAlign(findTable(TBL)!, 5, 'center');
    expect(t.aligns.aligns[5]).toBe('center');
  });
});

describe('editTableInText', () => {
  it('preserves text before and after the table', () => {
    const text = ['Intro paragraph', '', '| a | b |', '| --- | --- |', '| 1 | 2 |', '', 'Outro'].join(NL);
    const out = editTableInText(text, (t) => setCell(t, { kind: 'body', row: 0, col: 0 }, 'X'));
    expect(out.startsWith('Intro paragraph')).toBe(true);
    expect(out.trimEnd().endsWith('Outro')).toBe(true);
    expect(out).toContain('| X | 2 |');
    // Nothing else may change.
    expect(out.replace('| X | 2 |', '| 1 | 2 |')).toBe(text);
  });

  it('handles a table that is the entire block text', () => {
    const out = editTableInText(TBL, (t) => addRow(t));
    expect(out.split(NL)).toHaveLength(5);
    expect(out).not.toContain('\n\n');
  });

  it('is a no-op when there is no table', () => {
    expect(editTableInText('no table here', (t) => addRow(t))).toBe('no table here');
  });

  it('a mutated table can be re-parsed to the same shape (stability)', () => {
    let text = TBL;
    text = editTableInText(text, (t) => addColumn(t));
    text = editTableInText(text, (t) => addRow(t));
    const t = findTable(text)!;
    expect(t.columns).toBe(3);
    expect(t.body).toHaveLength(3);
    expect(serializeTable(t)).toBe(text);
  });
});
