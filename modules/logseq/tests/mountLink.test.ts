/**
 * Link creation for mounts: kind selection, refusal on collision, safe naming.
 *
 * The Windows behaviour these encode was measured, not assumed:
 *   - `mklink /J` (junction) is directory-only,
 *   - `mklink /H` (hard link) handles files and needs no privileges,
 *   - `mklink /D` (symlink) fails with "insufficient privilege" on this machine,
 * so the kind must be derived from the target, and the caller must never be
 * allowed to clobber an occupied path (that could destroy a real note).
 */

import { describe, expect, it } from 'vitest';
import {
  __setFsForTest,
  createLink,
  ensureDir,
  isDirectory,
  linkKindFor,
  linkPathTaken,
  linkRootFor,
  linkTargetFor,
  linkVaultPath,
  removeLink,
  safeSegment,
  sameVolume,
  volumeOf,
  type DirentLike,
  type NodeFsLike,
} from '../src/features/extFs';

/**
 * Fake fs recording the directories it was asked to create.
 * `mklink` needs its parent to exist (measured), so that call must be recorded.
 */
function fakeFs(dirs: string[], files: string[]) {
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase();
  const made: string[] = [];
  const base = {
    readdirSync: () => [] as DirentLike[],
    statSync: (p: string) => ({ size: 1, mtimeMs: 1, isDirectory: () => dirs.some((d) => norm(d) === norm(p)) }),
    existsSync: (p: string) => [...dirs, ...files].map(norm).includes(norm(p)),
    readFileSync: () => '',
    writeFileSync: () => undefined,
    lstatSync: (p: string) => ({ isDirectory: () => dirs.some((d) => norm(d) === norm(p)) }),
    realpathSync: (p: string) => p,
    mkdirSync: (p: string) => {
      made.push(norm(p));
      dirs.push(p);
    },
  };
  return { fs: base as unknown as NodeFsLike, made };
}

describe('createLink — the parent folder must be created first', () => {
  it('creates the containing folder before linking, because mklink will not', () => {
    // Measured: mklink into a missing Mounts/ fails with "系统找不到指定的路径",
    // and the plugin's first link attempt silently produced nothing because of
    // exactly this. The folder is not optional.
    const { fs, made } = fakeFs([], ['D:\\ext\\note.md']);
    __setFsForTest(fs);
    try {
      // createLink will still fail at the mklink step (no child_process in the
      // fake), but the mkdir must have happened before that.
      createLink('D:\\ext\\note.md', 'E:\\vault\\Mounts\\note.md');
      expect(made).toContain('e:/vault/mounts');
    } finally {
      __setFsForTest(null);
    }
  });

  it('ensureDir is idempotent — an existing folder is success, not an error', () => {
    const { fs } = fakeFs(['E:\\vault\\Mounts'], []);
    __setFsForTest(fs);
    try {
      expect(ensureDir('E:\\vault\\Mounts')).toEqual({ ok: true });
    } finally {
      __setFsForTest(null);
    }
  });
});

describe('sameVolume — decides whether a FILE can be hard-linked at all', () => {
  it('accepts two paths on the same drive', () => {
    // This is the case that must work: the hard link is the only way to give an
    // external markdown file a real vault path.
    expect(sameVolume('E:\\vault', 'E:\\notes\\a.md')).toBe(true);
    expect(sameVolume('E:/vault', 'E:\\notes\\a.md')).toBe(true);
    expect(sameVolume('d:\\vault', 'D:\\notes')).toBe(true);
  });

  it('rejects a cross-drive pair, where mklink /H fails', () => {
    // Measured: "系统无法将文件复制到不同的磁盘驱动器". A folder junction has no
    // such limit, so this only gates files.
    expect(sameVolume('E:\\vault', 'D:\\notes\\a.md')).toBe(false);
  });

  it('assumes same volume when it cannot tell, rather than blocking the link', () => {
    // A UNC path or a relative one must not be reported as cross-volume: the
    // caller would skip a link that would actually have worked.
    expect(sameVolume('\\\\server\\share', 'D:\\notes')).toBe(true);
    expect(sameVolume('E:\\vault', 'relative\\path')).toBe(true);
    expect(sameVolume('', '')).toBe(true);
  });

  it('volumeOf normalizes both separators and case is compared case-insensitively', () => {
    expect(volumeOf('D:\\a\\b')).toBe('D:');
    expect(volumeOf('d:/a/b')).toBe('d:');
    expect(sameVolume('E:\\v', 'e:\\n')).toBe(true);
  });
});

describe('linkKindFor — pick the link Windows will actually accept', () => {
  it('uses a junction for a directory', () => {
    __setFsForTest(fakeFs(['D:\\ext\\folder'], []).fs);
    try {
      expect(linkKindFor('D:\\ext\\folder')).toBe('junction');
    } finally {
      __setFsForTest(null);
    }
  });

  it('uses a hard link for a file, because a junction cannot represent one', () => {
    __setFsForTest(fakeFs([], ['D:\\ext\\note.md']).fs);
    try {
      expect(linkKindFor('D:\\ext\\note.md')).toBe('hardlink');
    } finally {
      __setFsForTest(null);
    }
  });
});

describe('createLink — refuse rather than clobber', () => {
  it('reports the source as missing instead of throwing', () => {
    __setFsForTest(fakeFs([], []).fs);
    try {
      const r = createLink('D:\\nope', 'E:\\vault\\Mounts\\nope');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/源路径不存在/);
    } finally {
      __setFsForTest(null);
    }
  });

  it('refuses when the destination is occupied — a real note may live there', () => {
    // Both sides must exist, so the collision is what actually fails.
    __setFsForTest(fakeFs(['E:\\vault\\Mounts'], ['E:\\vault\\Mounts\\taken.md', 'D:\\ext\\note.md']).fs);
    try {
      const r = createLink('D:\\ext\\note.md', 'E:\\vault\\Mounts\\taken.md');
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/已被占用/);
      expect(linkPathTaken('E:\\vault\\Mounts\\taken.md')).toBe(true);
    } finally {
      __setFsForTest(null);
    }
  });
});

describe('link paths — visible folder, never dot-prefixed', () => {
  it('puts links under Mounts/ at the vault root', () => {
    // Dot-prefixed parents are NOT indexed by Obsidian (measured), so this
    // path is load-bearing, not cosmetic.
    expect(linkRootFor('E:\\vault', 'abc')).toBe('E:\\vault\\Mounts\\abc');
    expect(linkTargetFor('E:\\vault', 'abc', 'note.md')).toBe('E:\\vault\\Mounts\\note.md');
  });

  it('builds the vault-relative path Obsidian needs to open a link', () => {
    expect(linkVaultPath('inbox')).toBe('Mounts/inbox');
    expect(linkVaultPath('inbox', 'sub/a.md')).toBe('Mounts/inbox/sub/a.md');
  });
});

describe('safeSegment — names that are legal path segments', () => {
  it('replaces characters Windows forbids in a path', () => {
    expect(safeSegment('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j');
  });

  it('never returns an empty segment', () => {
    expect(safeSegment('   ')).toBe('mount');
    expect(safeSegment('')).toBe('mount');
  });

  it('keeps CJK and spaces intact', () => {
    expect(safeSegment('我的 笔记')).toBe('我的 笔记');
  });
});

describe('removeLink — removing a link must not touch the original', () => {
  it('is a no-op when the path is already gone', () => {
    __setFsForTest(fakeFs([], []).fs);
    try {
      expect(removeLink('E:\\vault\\Mounts\\gone.md')).toEqual({ ok: true });
    } finally {
      __setFsForTest(null);
    }
  });

  it('isDirectory distinguishes the two removal commands', () => {
    __setFsForTest(fakeFs(['E:\\vault\\Mounts\\d'], []).fs);
    try {
      expect(isDirectory('E:\\vault\\Mounts\\d')).toBe(true);
      expect(isDirectory('E:\\vault\\Mounts\\f.md')).toBe(false);
    } finally {
      __setFsForTest(null);
    }
  });
});
