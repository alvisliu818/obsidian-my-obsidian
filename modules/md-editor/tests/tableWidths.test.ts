import { describe, expect, it } from 'vitest';
import {
  applyColumnWidths,
  clampColumnWidth,
  clearColumnWidth,
  isEmptyWidths,
  parseTableWidths,
  serializeTableWidths,
  withColumnWidth,
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
} from '../src/blocks/tableWidths';
import { parseDocument } from '../src/core/parser';
import { serializeBlock } from '../src/core/serializer';

/**
 * Hand-rolled table stand-in — no jsdom.
 *
 * (The suite runs under plain node: jsdom is not resolvable in this module's
 * vitest install, which is ALSO why three pre-existing `@vitest-environment
 * jsdom` test files error out during full runs — recorded as a known gap,
 * not expanded here.) The width appliers only touch `tHead`/`tBodies` rows,
 * their `cells`, and per-cell `style.width/maxWidth` + `removeProperty`, so a
 * minimal object graph covers them exactly.
 */
interface FakeCell {
  style: {
    width: string;
    maxWidth: string;
    removeProperty(k: string): void;
  };
}

function fakeCell(): FakeCell {
  const store = new Map<string, string>();
  return {
    style: {
      get width() {
        return store.get('width') ?? '';
      },
      set width(v: string) {
        store.set('width', v);
      },
      get maxWidth() {
        return store.get('max-width') ?? '';
      },
      set maxWidth(v: string) {
        store.set('max-width', v);
      },
      removeProperty(k: string) {
        store.delete(k);
      },
    },
  };
}

function fakeRow(cells: FakeCell[]) {
  return { cells: cells as unknown as HTMLTableCellElement[] };
}

/** header cells + one tBody whose `cols`-cell rows mirror the given widths. */
function makeTable(headerCells: number, bodyRowCount: number, cols: number): HTMLTableElement {
  const head = fakeRow(Array.from({ length: headerCells }, fakeCell));
  const body = Array.from({ length: bodyRowCount }, () =>
    fakeRow(Array.from({ length: cols }, fakeCell)),
  );
  return { tHead: { rows: [head] }, tBodies: [{ rows: body }] } as unknown as HTMLTableElement;
}

const cellStyle = (table: HTMLTableElement, section: 'head' | 'body', row: number, col: number) =>
  ((section === 'head'
    ? (table.tHead!.rows[row].cells[col] as unknown as FakeCell)
    : (table.tBodies[0]!.rows[row].cells[col] as unknown as FakeCell)
  ).style as unknown as { width: string; maxWidth: string });

describe('clampColumnWidth', () => {
  it('floors at the SiYuan default and caps at the image-resize ceiling', () => {
    expect(clampColumnWidth(10)).toBe(MIN_COLUMN_WIDTH);
    expect(clampColumnWidth(60)).toBe(60);
    expect(clampColumnWidth(123.6)).toBe(124);
    expect(clampColumnWidth(9999)).toBe(MAX_COLUMN_WIDTH);
    expect(clampColumnWidth(-5)).toBe(MIN_COLUMN_WIDTH);
  });
});

describe('parseTableWidths / serializeTableWidths', () => {
  it('parses a stored list positionally: invalid entries become 0', () => {
    expect(parseTableWidths('120, 80, 240')).toEqual([120, 80, 240]);
    // Dropping would shift later widths onto the wrong columns.
    expect(parseTableWidths('120,abc,80')).toEqual([120, 0, 80]);
    expect(parseTableWidths('120')).toEqual([120]);
  });

  it('returns null for absent or entirely invalid values', () => {
    expect(parseTableWidths(undefined)).toBe(null);
    expect(parseTableWidths('')).toBe(null);
    expect(parseTableWidths('abc, xyz')).toBe(null);
    expect(parseTableWidths('0, -3')).toBe(null);
  });

  it('round-trips through serialize, holes included', () => {
    const w = [120, 80, 240];
    expect(parseTableWidths(serializeTableWidths(w))).toEqual(w);
    expect(serializeTableWidths([120, 0, 240])).toBe('120, , 240');
    expect(parseTableWidths(serializeTableWidths([120, 0, 240]))).toEqual([120, 0, 240]);
  });
});

describe('withColumnWidth / isEmptyWidths', () => {
  it('fills sparse lists and overwrites existing entries', () => {
    expect(withColumnWidth(null, 2, 90)).toEqual([0, 0, 90]);
    expect(withColumnWidth([120], 0, 91.4)).toEqual([91]);
    expect(withColumnWidth([120, 80], 1, 240)).toEqual([120, 240]);
  });

  it('detects an all-unset list so the prop key can be dropped', () => {
    expect(isEmptyWidths([0, 0])).toBe(true);
    expect(isEmptyWidths([120])).toBe(false);
    expect(isEmptyWidths(null)).toBe(true);
    expect(isEmptyWidths(undefined)).toBe(true);
  });
});

describe('applyColumnWidths / clearColumnWidth', () => {
  it('pins every cell of the stored columns, leaves later columns free', () => {
    const table = makeTable(3, 2, 3);
    applyColumnWidths(table, [120, 80]);
    expect(cellStyle(table, 'head', 0, 0).width).toBe('120px');
    expect(cellStyle(table, 'head', 0, 0).maxWidth).toBe('120px');
    expect(cellStyle(table, 'head', 0, 1).width).toBe('80px');
    expect(cellStyle(table, 'head', 0, 2).width).toBe('');
    // body rows get the same treatment (the header alone would not pin the
    // column under auto layout).
    expect(cellStyle(table, 'body', 0, 0).width).toBe('120px');
    expect(cellStyle(table, 'body', 1, 1).maxWidth).toBe('80px');
    expect(cellStyle(table, 'body', 1, 2).width).toBe('');
  });

  it('clears one column without touching others', () => {
    const table = makeTable(2, 1, 2);
    applyColumnWidths(table, [120, 80]);
    clearColumnWidth(table, 0);
    expect(cellStyle(table, 'head', 0, 0).width).toBe('');
    expect(cellStyle(table, 'head', 0, 1).width).toBe('80px');
    expect(cellStyle(table, 'body', 0, 0).width).toBe('');
    expect(cellStyle(table, 'body', 0, 1).width).toBe('80px');
  });
});

describe('block prop round-trip (list-form table)', () => {
  // The persistence substrate: a props line after a list-form table must
  // re-attach to the block WITHOUT entering its text (probed during batch 20
  // recon; raw-form tables deliberately do NOT get the drag affordance).
  it('parses the prop into props, keeping the table text clean', () => {
    const doc = parseDocument('- | a | b |\n    | 1 | 2 |\n    table-widths:: 120, 80\n');
    const b = doc.blocks[0]!;
    expect(b.kind).toBe('list');
    expect(b.text).toBe('| a | b |\n  | 1 | 2 |');
    expect(b.props['table-widths']).toBe('120, 80');
  });

  it('serializes back to a byte-stable shape', () => {
    const doc = parseDocument('- | a | b |\n    | 1 | 2 |\n    table-widths:: 120, 80\n');
    const out = serializeBlock(doc.blocks[0]!, 0);
    const again = parseDocument(out);
    expect(again.blocks[0]!.props['table-widths']).toBe('120, 80');
    expect(again.blocks[0]!.text).toBe('| a | b |\n  | 1 | 2 |');
  });
});
