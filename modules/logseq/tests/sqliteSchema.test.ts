/**
 * Schema + sync planning for the SQLite secondary index (pure logic).
 */

import { describe, expect, it } from 'vitest';
import {
  SCHEMA_SQL,
  SCHEMA_VERSION,
  hashText,
  isPlanEmpty,
  planSync,
  planWork,
  type IndexedFileRow,
} from '../src/index/sqliteSchema';

const row = (path: string, mtime: number, size: number): IndexedFileRow => ({
  path,
  mtime,
  size,
  hash: 0,
  blocks: 1,
});

describe('schema', () => {
  it('declares every table the index writes', () => {
    for (const t of ['files', 'blocks', 'props', 'tags', 'links', 'refs', 'page_props', 'meta']) {
      expect(SCHEMA_SQL.some((s) => s.includes(`CREATE TABLE IF NOT EXISTS ${t}`))).toBe(true);
    }
  });

  it('is idempotent so re-opening a snapshot is cheap', () => {
    for (const sql of SCHEMA_SQL) {
      expect(sql.includes('IF NOT EXISTS')).toBe(true);
    }
  });

  it('records a version so an old database forces a rebuild', () => {
    expect(SCHEMA_VERSION).toBeGreaterThan(0);
  });
});

describe('planSync', () => {
  it('splits the vault into added / changed / removed / unchanged', () => {
    const plan = planSync(
      [
        { path: 'a.md', mtime: 10, size: 1 },
        { path: 'b.md', mtime: 99, size: 7 }, // mtime moved: edited outside Obsidian
        { path: 'c.md', mtime: 5, size: 5 },
      ],
      [row('a.md', 10, 1), row('b.md', 10, 7), row('d.md', 3, 3)],
    );
    expect(plan.added).toEqual(['c.md']);
    expect(plan.changed).toEqual(['b.md']);
    expect(plan.removed).toEqual(['d.md']);
    expect(plan.unchanged).toBe(1);
    expect(planWork(plan)).toBe(2);
  });

  it('treats a size change as a change even when mtime is identical', () => {
    const plan = planSync([{ path: 'a.md', mtime: 1, size: 9 }], [row('a.md', 1, 8)]);
    expect(plan.changed).toEqual(['a.md']);
  });

  it('is empty for an untouched vault', () => {
    const vault = [{ path: 'a.md', mtime: 1, size: 2 }];
    expect(isPlanEmpty(planSync(vault, [row('a.md', 1, 2)]))).toBe(true);
  });

  it('starts from scratch when the database is empty', () => {
    const plan = planSync([{ path: 'a.md', mtime: 1, size: 2 }], []);
    expect(plan.added).toEqual(['a.md']);
    expect(isPlanEmpty(plan)).toBe(false);
  });

  it('a rename is a removal plus an addition', () => {
    const plan = planSync([{ path: 'new.md', mtime: 4, size: 2 }], [row('old.md', 4, 2)]);
    expect(plan.added).toEqual(['new.md']);
    expect(plan.removed).toEqual(['old.md']);
  });
});

describe('hashText', () => {
  it('is stable and content sensitive', () => {
    expect(hashText('hello')).toBe(hashText('hello'));
    expect(hashText('hello')).not.toBe(hashText('hellp'));
  });

  it('returns an unsigned 32-bit value', () => {
    for (const s of ['', 'a', 'journal 2026-01-01', '\u4e2d\u6587']) {
      const h = hashText(s);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});
