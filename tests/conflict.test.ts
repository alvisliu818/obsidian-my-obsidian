import { describe, expect, it } from 'vitest';
import { collapseDiff, lineDiff, type DiffLine } from '../src/features/lineDiff';

describe('lineDiff', () => {
  it('identical inputs are all same', () => {
    const d = lineDiff('a\nb\nc', 'a\nb\nc');
    expect(d).toEqual([
      { type: 'same', text: 'a' },
      { type: 'same', text: 'b' },
      { type: 'same', text: 'c' },
    ]);
  });

  it('pure insertion', () => {
    const d = lineDiff('a\nb', 'a\nx\nb');
    expect(d).toEqual([
      { type: 'same', text: 'a' },
      { type: 'add', text: 'x' },
      { type: 'same', text: 'b' },
    ]);
  });

  it('pure deletion', () => {
    const d = lineDiff('a\nx\nb', 'a\nb');
    expect(d).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'x' },
      { type: 'same', text: 'b' },
    ]);
  });

  it('modification yields del then add', () => {
    const d = lineDiff('a\nold\nb', 'a\nnew\nb');
    expect(d).toEqual([
      { type: 'same', text: 'a' },
      { type: 'del', text: 'old' },
      { type: 'add', text: 'new' },
      { type: 'same', text: 'b' },
    ]);
  });

  it('empty vs content', () => {
    const d = lineDiff('', 'x');
    expect(d).toEqual([
      { type: 'del', text: '' },
      { type: 'add', text: 'x' },
    ]);
  });

  it('round-trips: applying del/add reproduces both sides', () => {
    const a = ['-', '- todo', '\t- kid', 'text', '#tag'].join('\n');
    const b = ['-', '- done', 'text', 'extra', '#tag'].join('\n');
    const d = lineDiff(a, b);
    const mine = d.filter((l) => l.type !== 'add').map((l) => l.text).join('\n');
    const disk = d.filter((l) => l.type !== 'del').map((l) => l.text).join('\n');
    expect(mine).toBe(a);
    expect(disk).toBe(b);
  });

  it('degrades to wholesale replace past the cap', () => {
    const big = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n');
    const d = lineDiff(big, big, 10);
    expect(d.filter((l) => l.type === 'del')).toHaveLength(20);
    expect(d.filter((l) => l.type === 'add')).toHaveLength(20);
  });
});

describe('collapseDiff', () => {
  const same = (text: string): { type: 'same'; text: string } => ({ type: 'same', text });

  it('short same-runs are kept', () => {
    const rows = collapseDiff([
      { type: 'add', text: 'x' },
      same('a'),
      same('b'),
      { type: 'del', text: 'y' },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(['add', 'same', 'same', 'del']);
  });

  it('long runs collapse into gap rows with counts', () => {
    const lines: DiffLine[] = [
      { type: 'add', text: 'x' },
      ...Array.from({ length: 10 }, (_, i) => same(`s${i}`)),
      { type: 'del', text: 'y' },
    ];
    const rows = collapseDiff(lines);
    // add + 3 context + gap(4) + 3 context + del
    expect(rows.map((r) => r.kind)).toEqual([
      'add',
      'same',
      'same',
      'same',
      'gap',
      'same',
      'same',
      'same',
      'del',
    ]);
    expect(rows.find((r) => r.kind === 'gap')?.count).toBe(4);
  });

  it('leading and trailing gaps are collapsed', () => {
    const rows = collapseDiff([
      ...Array.from({ length: 8 }, (_, i) => same(`head${i}`)),
      { type: 'add' as const, text: 'x' },
      ...Array.from({ length: 8 }, (_, i) => same(`tail${i}`)),
    ]);
    expect(rows[0].kind).toBe('gap');
    expect(rows[0].count).toBe(5); // 8 - 3 context
    expect(rows[rows.length - 1].kind).toBe('gap');
    expect(rows[rows.length - 1].count).toBe(5);
  });

  it('all-same input collapses to a single gap', () => {
    const rows = collapseDiff(Array.from({ length: 12 }, () => same('s')));
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('gap');
    expect(rows[0].count).toBe(12);
  });
});
