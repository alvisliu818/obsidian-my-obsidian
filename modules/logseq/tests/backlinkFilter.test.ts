import { describe, expect, it } from 'vitest';
import {
  clearRefFilter,
  countRefValues,
  filterRefValues,
  filterRefs,
  fuzzyMatchRef,
  isRefFilterActive,
  matchesRefFilter,
  refFilterFrom,
  refFilterState,
  toggleRefFilter,
} from '../src/features/backlinkFilter';

const F = (includes: string[] = [], excludes: string[] = []) => ({ includes, excludes });

describe('matchesRefFilter (Logseq matches-filters?)', () => {
  it('passes everything when no filter is set', () => {
    expect(matchesRefFilter(['a'], F())).toBe(true);
    expect(matchesRefFilter(['a'], undefined)).toBe(true);
  });

  it('include is AND — every included value must be present', () => {
    const refs = ['alpha', 'beta', 'gamma'];
    expect(matchesRefFilter(refs, F(['alpha']))).toBe(true);
    expect(matchesRefFilter(refs, F(['alpha', 'beta']))).toBe(true);
    // AND, not OR: carrying only one of the two is not enough.
    expect(matchesRefFilter(['alpha'], F(['alpha', 'beta']))).toBe(false);
    expect(matchesRefFilter(['alpha', 'delta'], F(['alpha', 'beta']))).toBe(false);
  });

  it('exclude is NONE — any excluded value hides the reference', () => {
    expect(matchesRefFilter(['alpha', 'beta'], F([], ['beta']))).toBe(false);
    expect(matchesRefFilter(['alpha', 'beta'], F([], ['gamma']))).toBe(true);
    expect(matchesRefFilter(['alpha', 'beta'], F([], ['beta', 'gamma']))).toBe(false);
  });

  it('applies include and exclude together', () => {
    expect(matchesRefFilter(['a', 'b', 'c'], F(['a', 'b'], ['c']))).toBe(false);
    expect(matchesRefFilter(['a', 'b', 'd'], F(['a', 'b'], ['c']))).toBe(true);
  });
});

describe('filterRefs', () => {
  const entries = [
    { text: 'one', refs: ['alpha'] },
    { text: 'two', refs: ['alpha', 'beta'] },
    { text: 'three', refs: ['gamma'] },
  ];

  it('returns the input untouched when inactive', () => {
    expect(filterRefs(entries, F())).toEqual(entries);
    expect(filterRefs(entries, clearRefFilter())).toHaveLength(3);
  });

  it('keeps order and drops non-matching references', () => {
    expect(filterRefs(entries, F(['alpha'])).map((e) => e.text)).toEqual(['one', 'two']);
    expect(filterRefs(entries, F([], ['alpha'])).map((e) => e.text)).toEqual(['three']);
    expect(filterRefs(entries, F(['alpha'], ['beta'])).map((e) => e.text)).toEqual(['one']);
  });

  it('can legitimately filter everything out', () => {
    expect(filterRefs(entries, F(['nothing-here']))).toEqual([]);
  });
});

describe('toggleRefFilter', () => {
  it('a plain click includes a fresh value', () => {
    expect(toggleRefFilter(F(), 'Alpha')).toEqual(F(['alpha']));
  });

  it('Shift-click excludes a fresh value', () => {
    expect(toggleRefFilter(F(), 'Alpha', true)).toEqual(F([], ['alpha']));
  });

  it('clicking a pinned value removes it, whichever list it is in', () => {
    expect(toggleRefFilter(F(['alpha']), 'alpha')).toEqual(F());
    expect(toggleRefFilter(F([], ['alpha']), 'alpha', true)).toEqual(F());
    // Shift-click on an INCLUDED value also removes (Logseq ref-button: add? false).
    expect(toggleRefFilter(F(['alpha']), 'alpha', true)).toEqual(F());
  });

  it('values are normalized and sorted, so state is stable', () => {
    const f = toggleRefFilter(toggleRefFilter(F(), 'zeta'), 'Alpha');
    expect(f.includes).toEqual(['alpha', 'zeta']);
  });
});

describe('refFilterState', () => {
  it('maps include/exclude combinations to Logseq\'s four funnel colors', () => {
    expect(refFilterState(F())).toBe('none');
    expect(refFilterState(F(['a']))).toBe('include');
    expect(refFilterState(F([], ['a']))).toBe('exclude');
    expect(refFilterState(F(['a'], ['b']))).toBe('both');
  });

  it('isRefFilterActive agrees', () => {
    expect(isRefFilterActive(F())).toBe(false);
    expect(isRefFilterActive(F([], ['b']))).toBe(true);
  });
});

describe('refFilterFrom (settings sanitize)', () => {
  it('defaults to an empty filter for junk data', () => {
    expect(refFilterFrom(undefined)).toEqual(F());
    expect(refFilterFrom(null)).toEqual(F());
    expect(refFilterFrom('nope')).toEqual(F());
    expect(refFilterFrom({ includes: 'x', excludes: 3 })).toEqual(F());
  });

  it('keeps valid values, deduped and lowercased', () => {
    expect(refFilterFrom({ includes: ['Alpha', 'alpha', ''], excludes: ['Beta'] })).toEqual(F(['alpha'], ['beta']));
  });
});

describe('countRefValues', () => {
  const entries = [
    { refs: ['alpha', 'beta', 'notes/journal.md'] },
    { refs: ['alpha', 'notes/journal.md'] },
    { refs: ['alpha'] },
  ];

  it('orders by frequency, then alphabetically', () => {
    expect(countRefValues(entries)).toEqual([
      { key: 'alpha', count: 3 },
      { key: 'notes/journal.md', count: 2 },
      { key: 'beta', count: 1 },
    ]);
  });

  it('skips excluded values (the page being viewed)', () => {
    const values = countRefValues(entries, { exclude: ['notes/journal.md'] });
    expect(values.map((v) => v.key)).toEqual(['alpha', 'beta']);
  });

  it('counts a value once per reference, not once per occurrence', () => {
    expect(countRefValues([{ refs: ['x', 'x'] }])).toEqual([{ key: 'x', count: 1 }]);
  });

  it('honors the limit, keeping the most frequent', () => {
    expect(countRefValues(entries, { limit: 2 }).map((v) => v.key)).toEqual([
      'alpha',
      'notes/journal.md',
    ]);
  });
});

describe('filterRefValues', () => {
  const values = [
    { key: 'alpha', count: 3 },
    { key: 'beta', count: 2 },
    { key: 'gamma', count: 1 },
  ];

  it('hides pinned values from the candidate list', () => {
    expect(filterRefValues(values, F(['alpha']), '').map((v) => v.key)).toEqual(['beta', 'gamma']);
    expect(filterRefValues(values, F([], ['beta']), '').map((v) => v.key)).toEqual(['alpha', 'gamma']);
  });

  it('narrows by the search box, case-insensitively', () => {
    expect(filterRefValues(values, F(), 'mm').map((v) => v.key)).toEqual(['gamma']);
    expect(filterRefValues(values, F(), 'a').map((v) => v.key)).toEqual(['alpha', 'beta', 'gamma']);
    expect(filterRefValues(values, F(), 'zzz')).toEqual([]);
  });
});

describe('fuzzyMatchRef', () => {
  it('matches subsequences case-insensitively, empty query matches all', () => {
    expect(fuzzyMatchRef('', 'anything')).toBe(true);
    expect(fuzzyMatchRef('ag', 'Alpha-Gamma')).toBe(true);
    expect(fuzzyMatchRef('ga', 'alpha')).toBe(false); // order matters
  });
});