import { describe, expect, it } from 'vitest';
import {
  constrainTableResizeCount,
  getDistributedTableColumnWidth,
  getTableResizeControlCenter,
  getTableResizeCount,
  isDefaultTableColumnWidth,
  isTableCellContentEmpty,
  isTableResizeControlVisible,
  tableResizeLimits,
  TABLE_DEFAULT_COLUMN_WIDTH,
} from '../src/blocks/tableResizeCore';
import { findTable, growTo } from '../src/blocks/tableModel';

// SiYuan's tableResize.test.ts / tableColumnWidth.test.ts fixtures, converted
// 1:1 from node:test to vitest (siyuan batch 19), plus cases for our two
// additions (tableResizeLimits for ParsedTable, growTo for the commit step).

describe('isTableCellContentEmpty', () => {
  it('ignores editor placeholders and whitespace', () => {
    expect(isTableCellContentEmpty(' \n\u200B\u200D\uFEFF', false)).toBe(true);
  });

  it('keeps text and non-text content', () => {
    expect(isTableCellContentEmpty('content', false)).toBe(false);
    expect(isTableCellContentEmpty('\u2060', false)).toBe(false);
    expect(isTableCellContentEmpty('', true)).toBe(false);
  });
});

describe('getTableResizeCount', () => {
  it('uses the appended item size while growing', () => {
    expect(getTableResizeCount(3, 29, 60, [80, 80, 80])).toBe(3);
    expect(getTableResizeCount(3, 31, 60, [80, 80, 80])).toBe(4);
    expect(getTableResizeCount(3, 91, 60, [80, 80, 80])).toBe(5);
  });

  it('follows existing item boundaries while shrinking', () => {
    expect(getTableResizeCount(4, -19, 60, [40, 50, 60, 40])).toBe(4);
    expect(getTableResizeCount(4, -21, 60, [40, 50, 60, 40])).toBe(3);
    expect(getTableResizeCount(4, -71, 60, [40, 50, 60, 40])).toBe(2);
  });
});

describe('constrainTableResizeCount', () => {
  it('does not shrink past non-empty content', () => {
    expect(constrainTableResizeCount(1, 5, 3, new Set())).toBe(3);
  });

  it('does not split merged cells', () => {
    expect(constrainTableResizeCount(3, 6, 1, new Set([2, 3]))).toBe(4);
    expect(constrainTableResizeCount(1, 6, 1, new Set([2, 3]))).toBe(1);
  });

  it('does not constrain growth', () => {
    expect(constrainTableResizeCount(8, 5, 4, new Set([4]))).toBe(8);
  });
});

describe('getTableResizeControlCenter', () => {
  it('keeps the control after a visible table edge', () => {
    expect(getTableResizeControlCenter(240, 0, 400, 16)).toBe(248);
    expect(getTableResizeControlCenter(240, 0, 400, 16, 10)).toBe(258);
  });

  it('keeps the whole control inside the editor viewport', () => {
    expect(getTableResizeControlCenter(395, 0, 400, 16)).toBe(392);
    expect(getTableResizeControlCenter(450, 0, 400, 16)).toBe(392);
  });
});

describe('isTableResizeControlVisible', () => {
  it('requires enough viewport space for the whole control', () => {
    expect(isTableResizeControlVisible(384, 400, 16)).toBe(true);
    expect(isTableResizeControlVisible(374, 400, 16, 10)).toBe(true);
    expect(isTableResizeControlVisible(384, 400, 16, 10)).toBe(false);
    expect(isTableResizeControlVisible(395, 400, 16)).toBe(false);
    expect(isTableResizeControlVisible(450, 400, 16)).toBe(false);
  });
});

describe('getDistributedTableColumnWidth', () => {
  it('preserves the selected columns total width', () => {
    expect(getDistributedTableColumnWidth([120, 240, 360])).toBe(240);
  });

  it('uses the table default as the minimum width', () => {
    expect(getDistributedTableColumnWidth([])).toBe(TABLE_DEFAULT_COLUMN_WIDTH);
    expect(getDistributedTableColumnWidth([20, 40])).toBe(TABLE_DEFAULT_COLUMN_WIDTH);
  });
});

describe('isDefaultTableColumnWidth', () => {
  it('requires an empty width and the default minimum width', () => {
    expect(isDefaultTableColumnWidth('', '60px')).toBe(true);
    expect(isDefaultTableColumnWidth('120px', '60px')).toBe(false);
    expect(isDefaultTableColumnWidth('', '')).toBe(false);
  });
});

describe('tableResizeLimits (our ParsedTable adaptation)', () => {
  it('keeps rows holding content and the columns they use', () => {
    const limits = tableResizeLimits(['a', 'b'], [['x', ''], ['', '']]);
    // 'b' in the header protects column 2; 'x' keeps body row 1.
    expect(limits).toEqual({ minRows: 1, minColumns: 2 });
  });

  it('protects content in any column across all rows', () => {
    const limits = tableResizeLimits(['', ''], [['', ''], ['', 'tail']]);
    expect(limits).toEqual({ minRows: 2, minColumns: 2 });
  });

  it('protects a header-only column and allows an empty body to go', () => {
    expect(tableResizeLimits(['a', ''], [])).toEqual({ minRows: 0, minColumns: 1 });
  });
});

describe('growTo', () => {
  it('grows columns first so new rows are born with the final width', () => {
    const t = findTable('| a |\n| --- |\n| 1 |')!;
    const grown = growTo(t, 2, 2);
    expect(grown.columns).toBe(2);
    expect(grown.body.length).toBe(2);
    expect(grown.body[1].cells.length).toBe(2);
  });

  it('shrinks trailing rows and columns without touching earlier ones', () => {
    const t = findTable('| a | b | c |\n| --- | --- | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |')!;
    const grown = growTo(t, 1, 1);
    expect(grown.columns).toBe(1);
    expect(grown.body.length).toBe(1);
    expect(grown.body[0].cells[0].text).toBe('1');
  });

  it('is a no-op when the target matches the current size', () => {
    const t = findTable('| a | b |\n| --- | --- |\n| 1 | 2 |')!;
    expect(growTo(t, 1, 2)).toEqual(t);
  });
});
