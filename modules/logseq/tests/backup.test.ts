/**
 * Backup pure helpers: flat filename encoding, round-trip path recovery,
 * per-file pruning plan. (Tests target the obsidian-free module.)
 */

import { describe, it, expect } from 'vitest';
import {
  backupPrefix,
  backupFileName,
  originalPathOf,
  prunePlan,
  BACKUPS_PER_FILE,
} from '../src/core/backupPure';

describe('backup helpers', () => {
  it('flattens paths and restores the original', () => {
    expect(backupPrefix('a/b/c.md')).toBe('a--b--c.md');
    expect(originalPathOf('a--b--c.md-123456.md')).toBe('a/b/c.md');
    expect(originalPathOf('plain.md-123456.md')).toBe('plain.md');
    expect(originalPathOf('unrelated.txt')).toBe('');
  });

  it('round-trips windows separators', () => {
    expect(backupPrefix('a\\b.md')).toBe('a--b.md');
    expect(originalPathOf(backupFileName('a\\b.md', 0))).toBe('a/b.md');
  });

  it('backupFileName embeds HHmmss', () => {
    const d = new Date(2026, 4, 6, 7, 8, 9);
    expect(backupFileName('p/q.md', d.getTime())).toBe('p--q.md-070809.md');
  });

  it('prunePlan keeps the newest N per original file and never touches foreign files', () => {
    const entries = [];
    for (let i = 0; i < BACKUPS_PER_FILE + 3; i++) {
      entries.push({ name: `a--b.md-${String(i).padStart(6, '0')}.md`, mtime: i });
    }
    entries.push({ name: 'other.md-000001.md', mtime: 99 });
    entries.push({ name: 'random.txt', mtime: 100 }); // foreign file — ignored
    const doomed = prunePlan(entries);
    expect(doomed).toHaveLength(3);
    expect(doomed).toEqual([
      'a--b.md-000000.md',
      'a--b.md-000001.md',
      'a--b.md-000002.md',
    ]);
  });

  it('prunePlan on few entries deletes nothing', () => {
    expect(prunePlan([{ name: 'x.md-000001.md', mtime: 1 }])).toHaveLength(0);
  });
});
