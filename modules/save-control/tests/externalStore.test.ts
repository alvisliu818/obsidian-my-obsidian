/**
 * 版本快照存储（externalStore + storage 迁移/寻址）：
 * save/list/read/delete/去旧/改名目录、根解析、路径键、旧快照迁移。
 * 全部走注入的假 fs，不碰真盘。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  __setFsForTest,
  DEFAULT_VERSION_ROOT,
  deleteExternalSnapshot,
  deleteOldestExternalAutosaves,
  externalSnapshotFilePath,
  listExternalSnapshots,
  readExternalSnapshot,
  renameExternalSnapshotDir,
  resolveVersionRoot,
  saveExternalSnapshot,
  type ExternalFsLike,
} from '../src/externalStore';
import { absPathKey, decodeAbsKey } from '../src/targets';
import { getSnapshotDirPath, migrateLegacySnapshots } from '../src/storage';

function makeFs(): ExternalFsLike & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/']);
  // 逐级登记父目录（种子数据用）。
  const addDir = (p: string) => {
    const norm = p.replace(/\/+$/, '');
    if (!norm || norm === '/' || dirs.has(norm)) return;
    dirs.add(norm);
    addDir(norm.slice(0, norm.lastIndexOf('/')) || '/');
  };
  return {
    files,
    dirs,
    existsSync: (p) => files.has(p) || dirs.has(p.replace(/\/+$/, '')),
    mkdirSync: (p) => {
      addDir(p);
    },
    writeFileSync: (p, data) => {
      addDir(p.slice(0, p.lastIndexOf('/')) || '/');
      files.set(p, data);
    },
    readFileSync: (p) => {
      const v = files.get(p);
      if (v === undefined) throw new Error('ENOENT: ' + p);
      return v;
    },
    readdirSync: (p) => {
      const norm = p.replace(/\/+$/, '');
      const out: string[] = [];
      for (const f of files.keys()) {
        const dir = f.slice(0, f.lastIndexOf('/'));
        if (dir === norm) out.push(f.slice(f.lastIndexOf('/') + 1));
      }
      for (const d of dirs) {
        if (d.startsWith(norm + '/') && !d.slice(norm.length + 1).includes('/')) {
          out.push(d.slice(norm.length + 1));
        }
      }
      return out;
    },
    statSync: (p) => ({ isDirectory: () => !files.has(p) }),
    unlinkSync: (p) => {
      files.delete(p);
    },
    renameSync: (from, to) => {
      const fromNorm = from.replace(/\/+$/, '');
      const toNorm = to.replace(/\/+$/, '');
      // 目录本身也要搬（真 fs.rename 对目录如此）
      if (dirs.has(fromNorm)) {
        dirs.delete(fromNorm);
        dirs.add(toNorm);
      }
      for (const [f, v] of [...files]) {
        if (f.startsWith(fromNorm + '/')) {
          files.set(toNorm + f.slice(fromNorm.length), v);
          files.delete(f);
        }
      }
      for (const d of [...dirs]) {
        if (d.startsWith(fromNorm + '/')) {
          dirs.delete(d);
          dirs.add(toNorm + d.slice(fromNorm.length));
        }
      }
    },
    rmSync: (p) => {
      const norm = p.replace(/\/+$/, '');
      dirs.delete(norm); // 真 fs.rmSync recursive 会连 p 本身一起删
      for (const f of [...files.keys()]) {
        if (f.startsWith(norm + '/')) files.delete(f);
      }
      for (const d of [...dirs]) {
        if (d.startsWith(norm + '/')) dirs.delete(d);
      }
    },
  };
}

afterEach(() => __setFsForTest(null));

describe('resolveVersionRoot', () => {
  it('defaults to the Runtime folder outside the vault', () => {
    expect(resolveVersionRoot({ configured: '', vaultBase: 'E:/Vault' })).toBe(DEFAULT_VERSION_ROOT);
    expect(DEFAULT_VERSION_ROOT).toBe('E:/HOME/Runtime/save-control-versions');
  });

  it('uses an absolute configured folder as-is', () => {
    expect(resolveVersionRoot({ configured: 'D:/snapshots', vaultBase: 'E:/Vault' })).toBe('D:/snapshots');
  });

  it('resolves a relative configured folder against the vault base', () => {
    expect(resolveVersionRoot({ configured: 'snapshots/ext', vaultBase: 'E:/Vault' })).toBe('E:/Vault/snapshots/ext');
  });
});

describe('absPathKey', () => {
  it('mirrors a Windows absolute path, drive colon stripped', () => {
    expect(absPathKey('E:\\HOME\\Vault\\notes\\foo.md')).toBe('E/HOME/Vault/notes/foo.md');
    expect(absPathKey('E:/HOME/Vault/notes/foo.md')).toBe('E/HOME/Vault/notes/foo.md');
  });

  it('keeps POSIX absolute paths', () => {
    expect(absPathKey('/home/u/a b.md')).toBe('/home/u/a b.md');
  });

  it('sanitizes characters Windows dir names cannot carry', () => {
    expect(absPathKey('E:/a/b:c*d.md')).toBe('E/a/b_c_d.md');
    expect(absPathKey('E:/a/dir./x.md ')).toBe('E/a/dir/x.md');
  });

  it('decodes back to the absolute path', () => {
    expect(decodeAbsKey('E/HOME/Vault/notes/foo.md')).toBe('E:/HOME/Vault/notes/foo.md');
    expect(decodeAbsKey('/home/u/a.md')).toBe('/home/u/a.md');
  });
});

describe('snapshot crud', () => {
  it('saves, lists newest-first, reads and deletes', () => {
    const fs = makeFs();
    __setFsForTest(fs);
    const root = '/root';
    const key = 'E/Vault/notes/foo.md';
    saveExternalSnapshot(root, key, '2026-10-13T01:00:00.000Z', 'old content', 'autosave');
    saveExternalSnapshot(root, key, '2026-10-13T02:00:00.000Z', 'new content', 'autosave');

    const list = listExternalSnapshots(root, key);
    expect(list).toHaveLength(2);
    expect(list[0].content).toBe('new content');
    expect(list[1].content).toBe('old content');
    expect(list[0].filePath).toBe(externalSnapshotFilePath(root, key, '2026-10-13T02:00:00.000Z'));

    expect(readExternalSnapshot(list[0].filePath)?.content).toBe('new content');

    expect(deleteExternalSnapshot(root, list[0].filePath)).toBe(true);
    expect(listExternalSnapshots(root, key)).toHaveLength(1);
  });

  it('keeps only the newest N autosaves', () => {
    const fs = makeFs();
    __setFsForTest(fs);
    const root = '/root';
    const key = 'k';
    for (let i = 1; i <= 5; i++) {
      saveExternalSnapshot(root, key, `2026-10-13T0${i}:00:00.000Z`, `v${i}`, 'autosave');
    }
    saveExternalSnapshot(root, key, '2026-10-13T06:00:00.000Z', 'manual', 'manual'); // 非 autosave 不计
    deleteOldestExternalAutosaves(root, key, 2);
    const left = listExternalSnapshots(root, key);
    expect(left).toHaveLength(3);
    expect(left.map((s) => s.content)).toEqual(['manual', 'v5', 'v4']);
  });

  it('renames the snapshot dir when the file moves', () => {
    const fs = makeFs();
    __setFsForTest(fs);
    saveExternalSnapshot('/root', 'old-key', '2026-10-13T01:00:00.000Z', 'c', 'manual');
    expect(renameExternalSnapshotDir('/root', 'old-key', 'new-key')).toBe(true);
    expect(listExternalSnapshots('/root', 'old-key')).toHaveLength(0);
    expect(listExternalSnapshots('/root', 'new-key')[0].content).toBe('c');
  });

  it('does not crash on unknown files', () => {
    const fs = makeFs();
    __setFsForTest(fs);
    expect(readExternalSnapshot('/root/none.json')).toBeNull();
    expect(deleteExternalSnapshot('/root', '/root/none.json')).toBe(false);
  });
});

function fakePlugin(opts: { vaultBase: string; snapshotFolder?: string; root?: string }) {
  return {
    app: { vault: { adapter: { getBasePath: () => opts.vaultBase } } },
    settings: {
      snapshotFolder: opts.snapshotFolder ?? '.versions(SH)',
      versionStorageFolder: opts.root ?? '',
    },
  };
}

function seedRecord(fs: ReturnType<typeof makeFs>, file: string, content: string) {
  fs.writeFileSync(file, JSON.stringify({ timestamp: '2026-10-13T01:00:00.000Z', content, name: 'autosave' }), 'utf8');
}

describe('getSnapshotDirPath', () => {
  it('maps a vault-relative path into the version root by absolute path', () => {
    const fs = makeFs();
    __setFsForTest(fs);
    const plugin = fakePlugin({ vaultBase: 'E:\\HOME\\Vault', root: 'E:/VRoot' });
    expect(getSnapshotDirPath(plugin, 'notes/foo.md')).toBe('E:/VRoot/E/HOME/Vault/notes/foo.md');
  });

  it('passes an absolute snapshot dir through', () => {
    const fs = makeFs();
    __setFsForTest(fs);
    const plugin = fakePlugin({ vaultBase: 'E:/HOME/Vault', root: 'E:/VRoot' });
    expect(getSnapshotDirPath(plugin, 'E:/VRoot/Some/Where.md')).toBe('E:/VRoot/Some/Where.md');
  });
});

describe('migrateLegacySnapshots', () => {
  it('moves legacy per-file dirs into the mirrored tree and prunes the legacy shell', async () => {
    const fs = makeFs();
    __setFsForTest(fs);
    seedRecord(fs, 'E:/HOME/Vault/.versions(SH)/notes/foo.md/2026-10-13T01-00-00.000Z.json', 'v1');
    seedRecord(fs, 'E:/HOME/Vault/.versions(SH)/projects/bar.md/2026-10-13T02-00-00.000Z.json', 'v2');

    await migrateLegacySnapshots(
      fakePlugin({ vaultBase: 'E:/HOME/Vault', snapshotFolder: '.versions(SH)', root: 'E:/VRoot' }),
    );

    expect(fs.files.has('E:/VRoot/E/HOME/Vault/notes/foo.md/2026-10-13T01-00-00.000Z.json')).toBe(true);
    expect(fs.files.has('E:/VRoot/E/HOME/Vault/projects/bar.md/2026-10-13T02-00-00.000Z.json')).toBe(true);
    // 旧树已搬空：只剩根（空壳也要被清掉，因为没有 .tmp）
    expect(fs.existsSync('E:/HOME/Vault/.versions(SH)/notes')).toBe(false);
    expect(fs.existsSync('E:/HOME/Vault/.versions(SH)')).toBe(false);
  });

  it('merges into an existing target without overwriting', async () => {
    const fs = makeFs();
    __setFsForTest(fs);
    // 目标里已经有同名快照（上次迁移中断），还有一条新的没搬。
    seedRecord(fs, 'E:/VRoot/E/HOME/Vault/notes/foo.md/2026-10-13T01-00-00.000Z.json', 'migrated');
    seedRecord(fs, 'E:/HOME/Vault/.versions(SH)/notes/foo.md/2026-10-13T01-00-00.000Z.json', 'legacy-old');
    seedRecord(fs, 'E:/HOME/Vault/.versions(SH)/notes/foo.md/2026-10-13T03-00-00.000Z.json', 'legacy-new');

    await migrateLegacySnapshots(
      fakePlugin({ vaultBase: 'E:/HOME/Vault', snapshotFolder: '.versions(SH)', root: 'E:/VRoot' }),
    );

    const keep = JSON.parse(fs.files.get('E:/VRoot/E/HOME/Vault/notes/foo.md/2026-10-13T01-00-00.000Z.json')!);
    expect(keep.content).toBe('migrated'); // 不覆盖
    expect(fs.files.get('E:/VRoot/E/HOME/Vault/notes/foo.md/2026-10-13T03-00-00.000Z.json')).toContain('legacy-new');
    expect(fs.existsSync('E:/HOME/Vault/.versions(SH)')).toBe(false);
  });

  it('leaves the .tmp preview dir and skips nested roots', async () => {
    const fs = makeFs();
    __setFsForTest(fs);
    seedRecord(fs, 'E:/HOME/Vault/.versions(SH)/notes/foo.md/2026-10-13T01-00-00.000Z.json', 'v1');
    fs.writeFileSync('E:/HOME/Vault/.versions(SH)/.tmp/preview_ab12cd.md', 'preview', 'utf8');

    await migrateLegacySnapshots(
      fakePlugin({ vaultBase: 'E:/HOME/Vault', snapshotFolder: '.versions(SH)', root: 'E:/VRoot' }),
    );

    expect(fs.files.get('E:/VRoot/E/HOME/Vault/notes/foo.md/2026-10-13T01-00-00.000Z.json')).toContain('v1');
    expect(fs.files.has('E:/HOME/Vault/.versions(SH)/.tmp/preview_ab12cd.md')).toBe(true);
    expect(fs.existsSync('E:/HOME/Vault/.versions(SH)')).toBe(true); // .tmp 还在
  });
});
