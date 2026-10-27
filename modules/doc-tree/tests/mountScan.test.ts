/**
 * The external scanner — the part that walks a folder OUTSIDE the vault.
 *
 * Tested against a fake `fs` rather than real directories: the behaviour worth
 * pinning down is the pruning contract (do not descend into an excluded folder)
 * and the bound (a mount of `/` must not hang the file explorer), and both are
 * pure control flow over the dirent list.
 */

import { describe, expect, it } from 'vitest';
import { scanExternal, __setFsForTest, type DirentLike, type NodeFsLike } from '../src/features/extFs';

function dirent(name: string, dir: boolean): DirentLike {
  return { name, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => false };
}

/** A tiny in-memory tree: path -> dir entries. */
function fakeFs(tree: Record<string, DirentLike[]>): NodeFsLike {
  const isDirPath = (p: string): boolean => {
    // A path is a directory when some listing contains it as a prefix.
    for (const [dir, items] of Object.entries(tree)) {
      if (items.some(() => dir.replace(/\\/g, '/').startsWith(p.replace(/\\/g, '/') + '/'))) return true;
    }
    return Object.keys(tree).some((k) => k.replace(/\\/g, '/') === p.replace(/\\/g, '/'));
  };
  return {
    readdirSync: (p: string) => {
      const key = Object.keys(tree).find((k) => k === p || k.replace(/\\/g, '/') === p.replace(/\\/g, '/'));
      if (!key) throw new Error('ENOENT: ' + p);
      return tree[key];
    },
    statSync: (p: string) => ({ size: 10, mtimeMs: 5, isDirectory: () => isDirPath(p) }),
    existsSync: (p: string) => Object.keys(tree).some((k) => k.replace(/\\/g, '/') === p.replace(/\\/g, '/')) || isDirPath(p),
    readFileSync: () => '',
    writeFileSync: () => undefined,
    lstatSync: (p: string) => ({ isDirectory: () => isDirPath(p) }),
    realpathSync: (p: string) => p,
  };
}

const TREE = {
  'D:\\m': [dirent('a.md', false), dirent('b.txt', false), dirent('sub', true), dirent('node_modules', true)],
  'D:\\m\\sub': [dirent('c.md', false), dirent('d.png', false)],
  'D:\\m\\node_modules': [dirent('pkg', true)],
  'D:\\m\\node_modules\\pkg': [dirent('index.js', false)],
};

describe('scanExternal — walking a folder outside the vault', () => {
  it('lists files and directories with absolute paths', () => {
    __setFsForTest(fakeFs(TREE));
    try {
      const { entries } = scanExternal('D:\\m', { shouldEnterDir: () => true, keepFile: () => true });
      const files = entries.filter((x) => !x.isDir).map((x) => x.rel).sort();
      expect(files).toEqual(['a.md', 'b.txt', 'node_modules/pkg/index.js', 'sub/c.md', 'sub/d.png']);
      // Every entry carries a usable absolute path.
      const md = entries.find((x) => x.rel === 'sub/c.md')!;
      expect(md.abs).toBe('D:\\m\\sub\\c.md');
    } finally {
      __setFsForTest(null);
    }
  });

  it('does not descend into a directory the filter rejects', () => {
    __setFsForTest(fakeFs(TREE));
    try {
      // The whole subtree is pruned, so nothing from node_modules is listed —
      // not even the directory row itself.
      const { entries } = scanExternal('D:\\m', {
        shouldEnterDir: (rel) => rel !== 'node_modules',
        keepFile: () => true,
      });
      expect(entries.some((x) => x.rel.includes('node_modules'))).toBe(false);
    } finally {
      __setFsForTest(null);
    }
  });

  it('applies the file filter without affecting which folders are entered', () => {
    __setFsForTest(fakeFs(TREE));
    try {
      const { entries } = scanExternal('D:\\m', {
        shouldEnterDir: () => true,
        keepFile: (rel) => rel.endsWith('.md'),
      });
      const files = entries.filter((x) => !x.isDir).map((x) => x.rel).sort();
      expect(files).toEqual(['a.md', 'sub/c.md']);
      // The folder rows are still there — the tree needs them to nest under.
      expect(entries.filter((x) => x.isDir).map((x) => x.rel).sort()).toEqual(['node_modules', 'node_modules/pkg', 'sub']);
    } finally {
      __setFsForTest(null);
    }
  });

  it('stops at the limit and reports truncation instead of hanging', () => {
    __setFsForTest(fakeFs(TREE));
    try {
      const { entries, truncated } = scanExternal('D:\\m', {
        shouldEnterDir: () => true,
        keepFile: () => true,
        limit: 2,
      });
      expect(truncated).toBe(true);
      expect(entries.length).toBeLessThanOrEqual(2);
    } finally {
      __setFsForTest(null);
    }
  });

  it('stops descending past the depth limit', () => {
    __setFsForTest(fakeFs(TREE));
    try {
      // depth 0 = the mount root. With depth: 0 its own files are listed but no
      // folder is entered, so nothing nested can appear.
      const { entries } = scanExternal('D:\\m', {
        shouldEnterDir: () => true,
        keepFile: () => true,
        depth: 0,
      });
      expect(entries.filter((x) => !x.isDir).map((x) => x.rel).sort()).toEqual(['a.md', 'b.txt']);
      // The folder rows are still listed; we just did not walk into them.
      expect(entries.filter((x) => x.isDir).map((x) => x.rel).sort()).toEqual(['node_modules', 'sub']);
    } finally {
      __setFsForTest(null);
    }
  });

  it('returns nothing (not an error) for a path that does not exist', () => {
    __setFsForTest(fakeFs(TREE));
    try {
      const r = scanExternal('Z:\\gone', { shouldEnterDir: () => true, keepFile: () => true });
      expect(r.entries).toEqual([]);
      expect(r.truncated).toBe(false);
    } finally {
      __setFsForTest(null);
    }
  });
});