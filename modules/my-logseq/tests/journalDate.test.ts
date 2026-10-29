/**
 * Journal-date pure helpers: token formatting, strict name matching,
 * calendar-safe day math. (Logseq md journal navigation parity.)
 */

import { describe, it, expect } from 'vitest';
import {
  formatDateTokens,
  journalDateOf,
  journalNameMatcher,
  addDays,
  looksLikeJournal,
} from '../src/core/journalDate';

describe('journalDate', () => {
  it('formats Logseq-style tokens', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5);
    expect(formatDateTokens('YYYY-MM-DD', d)).toBe('2026-01-02');
    expect(formatDateTokens('YYYY_MM_DD', d)).toBe('2026_01_02');
    expect(formatDateTokens('YYYYMMDD', d)).toBe('20260102');
    expect(formatDateTokens('YYYY-[MM]-DD HH:mm', d)).toBe('2026-[01]-02 03:04');
    expect(formatDateTokens('no tokens here', d)).toBe('no tokens here');
  });

  it('parses journal names strictly (default format)', () => {
    expect(journalDateOf('2026-01-02')?.getTime()).toBe(new Date(2026, 0, 2).getTime());
    expect(journalDateOf('2026-1-2')).toBeNull(); // not zero-padded
    expect(journalDateOf('2026-13-02')).toBeNull(); // impossible month
    expect(journalDateOf('2026-02-31')).toBeNull(); // impossible day
    expect(journalDateOf('Home')).toBeNull();
    expect(journalDateOf('2026-01-02-journal')).toBeNull(); // suffix not allowed
  });

  it('parses alternative formats (compact, underscored)', () => {
    expect(journalDateOf('20260102', 'YYYYMMDD')?.getTime()).toBe(new Date(2026, 0, 2).getTime());
    expect(journalDateOf('2026_01_02', 'YYYY_MM_DD')?.getTime()).toBe(new Date(2026, 0, 2).getTime());
  });

  it('matcher requires a full date (Y+M+D)', () => {
    expect(journalNameMatcher('YYYY-MM-DD')).not.toBeNull();
    expect(journalNameMatcher('YYYY-MM')).toBeNull();
    expect(journalNameMatcher('MM-DD')).toBeNull();
  });

  it('addDays crosses month and year boundaries', () => {
    expect(formatDateTokens('YYYY-MM-DD', addDays(new Date(2026, 0, 31), 1))).toBe('2026-02-01');
    expect(formatDateTokens('YYYY-MM-DD', addDays(new Date(2026, 0, 1), -1))).toBe('2025-12-31');
    expect(formatDateTokens('YYYY-MM-DD', addDays(new Date(2028, 1, 28), 1))).toBe('2028-02-29'); // leap year
  });

  it('looksLikeJournal accepts default and compact formats', () => {
    expect(looksLikeJournal('2026-01-02')).toBe(true);
    expect(looksLikeJournal('20260102')).toBe(true);
    expect(looksLikeJournal('2026-01-02', 'YYYYMMDD')).toBe(false);
    expect(looksLikeJournal('not-a-journal')).toBe(false);
  });
});
