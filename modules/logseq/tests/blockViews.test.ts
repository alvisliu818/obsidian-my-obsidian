/**
 * Block views: a `view::` property on a parent block decides how its children
 * are presented (table / cards / tabs). Pure view-model logic, no DOM.
 */

import { describe, expect, it } from 'vitest';
import {
  buildBlockView,
  isViewBlock,
  viewColumns,
  viewKindOf,
  type ViewChild,
} from '../src/features/blockViews';

const child = (text: string, props: Record<string, string> = {}, hasChildren = false): ViewChild => ({
  text,
  props,
  marker: null,
  hasChildren,
});

describe('viewKindOf', () => {
  it('reads the three view kinds', () => {
    expect(viewKindOf({ view: 'table' })).toBe('table');
    expect(viewKindOf({ view: 'cards' })).toBe('cards');
    expect(viewKindOf({ view: 'tabs' })).toBe('tabs');
  });

  it('accepts aliases and loose casing/whitespace', () => {
    expect(viewKindOf({ view: ' Cards ' })).toBe('cards');
    expect(viewKindOf({ view: 'card' })).toBe('cards');
    expect(viewKindOf({ view: 'TAB' })).toBe('tabs');
    expect(viewKindOf({ view: 'grid' })).toBe('table');
  });

  it('falls back to table for an unknown name — never renders nothing', () => {
    expect(viewKindOf({ view: 'kanban-please' })).toBe('table');
  });

  it('is null without a view property, or when it is empty', () => {
    expect(viewKindOf({})).toBeNull();
    expect(viewKindOf({ view: '' })).toBeNull();
    expect(viewKindOf({ view: '   ' })).toBeNull();
  });
});

describe('isViewBlock', () => {
  it('is true for any non-empty view value, false otherwise', () => {
    expect(isViewBlock({ view: 'table' })).toBe(true);
    expect(isViewBlock({ view: 'nonsense' })).toBe(true);
    expect(isViewBlock({ view: '' })).toBe(false);
    expect(isViewBlock({ author: 'x' })).toBe(false);
  });
});

describe('viewColumns', () => {
  const children = [
    child('Dune', { author: 'Herbert' }),
    child('Solaris', { year: '1961', author: 'Lem' }),
  ];

  it('collects every prop in FIRST-SEEN order, not sorted', () => {
    // author comes first because Dune declares it first.
    expect(viewColumns(children)).toEqual(['author', 'year']);
  });

  it('excludes editor-owned and view-config props', () => {
    const cols = viewColumns([
      child('a', { id: 'x', collapsed: 'true', style: 'color: red', view: 'table', viewColumns: '', keep: '1' }),
    ]);
    expect(cols).toEqual(['keep']);
  });

  it('honors an explicit view-columns order and subset', () => {
    expect(viewColumns(children, { 'view-columns': 'year, author' })).toEqual(['year', 'author']);
    expect(viewColumns(children, { 'view-columns': 'author' })).toEqual(['author']);
  });

  it('ignores blank entries and duplicates in view-columns', () => {
    expect(viewColumns(children, { 'view-columns': ' year , ,year, author ' })).toEqual(['year', 'author']);
  });

  it('prefers an explicit list even when a column has no data', () => {
    // A column with no values still shows (so the header is stable).
    expect(viewColumns([child('a', {})], { 'view-columns': 'author' })).toEqual(['author']);
  });

  it('returns nothing when no child has props', () => {
    expect(viewColumns([child('a'), child('b')])).toEqual([]);
  });

  it('reads the config props case- and dash-insensitively', () => {
    expect(viewKindOf({ View: 'cards' })).toBe('cards');
    expect(viewKindOf({ VIEW: 'Tabs' })).toBe('tabs');
    expect(viewColumns(children, { 'View-Columns': 'year' })).toEqual(['year']);
    expect(viewColumns([child('a', { Author: 'x', viewColumns: 'y', id: 'z' })])).toEqual(['Author']);
  });
});

describe('buildBlockView', () => {
  const children = [
    child('Dune', { author: 'Herbert' }),
    child('Solaris', { author: 'Lem', year: '1961' }),
  ];

  it('is null without a view property (caller falls back to the list)', () => {
    expect(buildBlockView({}, children)).toBeNull();
  });

  it('builds one record per child, in order, carrying its childIndex', () => {
    const m = buildBlockView({ view: 'table' }, children)!;
    expect(m.kind).toBe('table');
    expect(m.columns).toEqual(['author', 'year']);
    expect(m.records.map((r) => r.title)).toEqual(['Dune', 'Solaris']);
    expect(m.records.map((r) => r.childIndex)).toEqual([0, 1]);
  });

  it('fills missing values with an empty string, never undefined', () => {
    const m = buildBlockView({ view: 'table' }, children)!;
    expect(m.records[0].values).toEqual({ author: 'Herbert', year: '' });
  });

  it('an empty children list still yields a usable model (empty state)', () => {
    const m = buildBlockView({ view: 'cards' }, [])!;
    expect(m.kind).toBe('cards');
    expect(m.records).toEqual([]);
    expect(m.columns).toEqual([]);
  });

  it('the cap limits RECORDS but keeps all columns', () => {
    const many = Array.from({ length: 10 }, (_, i) => child(`c${i}`, { n: String(i), extra: 'e' }));
    const m = buildBlockView({ view: 'table' }, many, 3)!;
    expect(m.records).toHaveLength(3);
    // Columns come from ALL children, so the cap never drops a header.
    expect(m.columns).toEqual(['n', 'extra']);
  });

  it('a zero or negative cap yields no records but keeps columns', () => {
    const m = buildBlockView({ view: 'table' }, children, 0)!;
    expect(m.records).toEqual([]);
    expect(m.columns).toEqual(['author', 'year']);
  });

  it('carries the child marker and hasChildren flag through', () => {
    const m = buildBlockView({ view: 'tabs' }, [child('t', {}, true)])!;
    expect(m.records[0].child.hasChildren).toBe(true);
  });
});
