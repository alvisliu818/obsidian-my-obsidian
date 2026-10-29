import { describe, expect, it } from 'vitest';
import { expandExpr, expandTemplates, formatDate, parseVarLines } from '../src/features/template';

const NOW = new Date(2026, 8, 9, 14, 30, 5); // 2026-09-09 14:30:05 local

describe('formatDate', () => {
  it('expands all tokens', () => {
    expect(formatDate('YYYY-MM-DD', NOW)).toBe('2026-09-09');
    expect(formatDate('HH:mm:ss', NOW)).toBe('14:30:05');
    expect(formatDate('YYYY/MM/DD HH:mm', NOW)).toBe('2026/09/09 14:30');
  });

  it('pads single digits', () => {
    expect(formatDate('MM-DD', new Date(2026, 0, 5))).toBe('01-05');
  });
});

describe('expandExpr', () => {
  it('date words', () => {
    expect(expandExpr('today', NOW)).toBe('2026-09-09');
    expect(expandExpr('yesterday', NOW)).toBe('2026-09-08');
    expect(expandExpr('tomorrow', NOW)).toBe('2026-09-10');
  });

  it('time words', () => {
    expect(expandExpr('now', NOW)).toBe('2026-09-09 14:30');
    expect(expandExpr('time', NOW)).toBe('14:30');
    expect(expandExpr('current time', NOW)).toBe('14:30');
  });

  it('custom formats via |', () => {
    expect(expandExpr('today | YYYY/MM/DD', NOW)).toBe('2026/09/09');
    expect(expandExpr('time | HH:mm:ss', NOW)).toBe('14:30:05');
  });

  it('case-insensitive and whitespace-tolerant', () => {
    expect(expandExpr('  TODAY  ', NOW)).toBe('2026-09-09');
  });

  it('returns null on unknown expressions', () => {
    expect(expandExpr('date-picker', NOW)).toBeNull();
    expect(expandExpr('bogus command', NOW)).toBeNull();
    expect(expandExpr('', NOW)).toBeNull();
  });

  it('current page from context', () => {
    expect(expandExpr('current page', NOW, { currentPage: 'Home' })).toBe('Home');
    expect(expandExpr('current page', NOW)).toBeNull(); // no context → untouched
  });

  it('custom variables from context', () => {
    const ctx = { vars: { author: 'alvis', status: 'draft' } };
    expect(expandExpr('author', NOW, ctx)).toBe('alvis');
    expect(expandExpr('AUTHOR', NOW, ctx)).toBe('alvis'); // keys lowercase
    expect(expandExpr('unknown', NOW, ctx)).toBeNull();
    // built-ins win over vars
    expect(expandExpr('today', NOW, { vars: { today: 'nope' } })).toBe('2026-09-09');
  });
});

describe('parseVarLines', () => {
  it('parses name = value lines', () => {
    expect(parseVarLines('author = alvis\nstatus=draft')).toEqual({
      author: 'alvis',
      status: 'draft',
    });
  });

  it('skips malformed lines and lowercases keys', () => {
    expect(parseVarLines('Name = X\nnovalue\n=A\n  key  =  v  ')).toEqual({ name: 'X', key: 'v' });
  });

  it('empty input', () => {
    expect(parseVarLines('')).toEqual({});
  });
});

describe('expandTemplates', () => {
  it('expands inline', () => {
    expect(expandTemplates('due <% today %>', NOW)).toBe('due 2026-09-09');
  });

  it('multiple expressions', () => {
    expect(expandTemplates('<% yesterday %> → <% tomorrow %>', NOW)).toBe('2026-09-08 → 2026-09-10');
  });

  it('leaves unknown expressions untouched', () => {
    expect(expandTemplates('x <% whatever %> y', NOW)).toBe('x <% whatever %> y');
  });

  it('handles empty / no-op text', () => {
    expect(expandTemplates('plain text', NOW)).toBe('plain text');
    expect(expandTemplates('', NOW)).toBe('');
  });

  it('month rollover', () => {
    const edge = new Date(2026, 7, 31); // 2026-08-31
    expect(expandTemplates('<% tomorrow %>', edge)).toBe('2026-09-01');
  });
});
