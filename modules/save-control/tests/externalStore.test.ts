/**
 * 库外快照存储（externalStore）：save/list/read/delete/去旧/改名目录。
 * 全部走注入的假 fs，不碰真盘。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  __setFsForTest,
  deleteExternalSnapshot,
  deleteOldestExternalAutosaves,
  externalSnapshotFilePath,
  listExternalSnapshots,
  readExternalSnapshot,
  renameExternalSnapshotDir,
  resolveExternalSnapshotRoot,
  saveExternalSnapshot,
  type ExternalFsLike,
} from '../src/externalStore';

function makeFs(): ExternalFsLike & { files: Map<string, string>; dirs: Set<string> } {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/']);
  return {
    files,
    dirs,
    existsSync: (p) => files.has(p) || dirs.has(p.replace(/\/+$/, '')),
    mkdirSync: (p) => {
      dirs.add(p.replace(/\/+$/, ''));
    },
    writeFileSync: (p, data) => {
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
      for (const f of [...files.keys()]) {
        if (f.startsWith(p + '/')) files.delete(f);
      }
      for (const d of [...dirs]) {
        if (d.startsWith(p + '/')) dirs.delete(d);
      }
    },
  };
}

afterEach(() => __setFsForTest(null));

describe('resolveExternalSnapshotRoot', () => {
  it('defaults to the plugin dir under the vault', () => {
    expect(
      resolveExternalSnapshotRoot({ configured: '', vaultBase: 'E:/Vault', pluginDir: '.obsidian/plugins/obsidian-my-obsidian' }),
    ).toBe('E:/Vault/.obsidian/plugins/obsidian-my-obsidian/save-control-snapshots');
  });

  it('uses an absolute configured folder as-is', () => {
    expect(
      resolveExternalSnapshotRoot({ configured: 'D:/snapshots', vaultBase: 'E:/Vault', pluginDir: '.obsidian/plugins/x' }),
    ).toBe('D:/snapshots');
  });

  it('resolves a relative configured folder against the vault base', () => {
    expect(
      resolveExternalSnapshotRoot({ configured: 'snapshots/ext', vaultBase: 'E:/Vault', pluginDir: '.obsidian/plugins/x' }),
    ).toBe('E:/Vault/snapshots/ext');
  });
});

describe('snapshot crud', () => {
  it('saves, lists newest-first, reads and deletes', () => {
    const fs = makeFs();
    __setFsForTest(fs);
    const root = '/root';
    const key = 'ext_E__src_x_abc12345';
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
