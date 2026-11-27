/**
 * 回收站路径与管理的回归锚（2026-11-27 用户需求）：
 *  - 默认位置 = Obsidian 的 `<库根>/.trash`；可配置到库外目录；
 *  - 插件条目镜像在 `<位置>/.vt/external/...`，index 记录原绝对路径；
 *  - 与 Obsidian 共用 .trash 时，管理器同时列出 Obsidian 删除的库内条目；
 *  - 清空自定义目录时不动无关文件。
 *
 * 用内存 fs 驱动，纯逻辑不落盘。
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  __setTrashFsForTest,
  deleteToTrash,
  deleteVaultEntryToCustomTrash,
  emptyTrash,
  isObsidianTrashRoot,
  listObsidianTrashItems,
  listTrashItems,
  obsidianTrashLandingPath,
  obsidianTrashRoot,
  pluginTrashRoot,
  purgeTrashItem,
  resolveTrashRoot,
  restoreFromTrash,
  type TrashFsLike,
} from '../src/features/trashStore';

interface Node {
  name: string;
  dir: boolean;
  mtimeMs: number;
  content?: string;
}

/** 最小内存 fs：只实现 trashStore 用到的表面。 */
class FakeFs implements TrashFsLike {
  nodes = new Map<string, Node>();

  private key(p: string): string {
    return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }

  add(p: string, opts: { dir?: boolean; mtimeMs?: number; content?: string } = {}): void {
    const full = p.replace(/\\/g, '/').replace(/\/+$/, '');
    const parts = full.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const cur = parts.slice(0, i).join('/');
      if (!this.nodes.has(this.key(cur))) {
        this.nodes.set(this.key(cur), {
          name: parts[i - 1],
          dir: i < parts.length || opts.dir === true,
          mtimeMs: opts.mtimeMs ?? 0,
        });
      }
    }
    const node = this.nodes.get(this.key(full))!;
    node.dir = opts.dir === true;
    node.mtimeMs = opts.mtimeMs ?? node.mtimeMs;
    node.content = opts.content;
  }

  existsSync(p: string): boolean {
    return this.nodes.has(this.key(p));
  }

  readFileSync(p: string, _enc: 'utf8'): string {
    const n = this.nodes.get(this.key(p));
    if (!n || n.dir) throw new Error('ENOENT');
    return n.content ?? '';
  }

  writeFileSync(p: string, data: string, _enc: 'utf8'): void {
    this.add(p, { content: data });
  }

  mkdirSync(p: string, _opts: { recursive: true }): void {
    const parts = p.replace(/\\/g, '/').replace(/\/+$/, '').split('/');
    for (let i = 1; i <= parts.length; i++) {
      const n = this.nodes.get(this.key(parts.slice(0, i).join('/')));
      if (n && !n.dir) throw new Error(i < parts.length ? 'ENOTDIR: 上级是文件' : 'EEXIST: 目标是文件');
    }
    this.add(p, { dir: true });
  }

  readdirSync(p: string): string[] {
    const prefix = this.key(p) + '/';
    const out: string[] = [];
    for (const [k, n] of this.nodes) {
      if (!k.startsWith(prefix)) continue;
      if (k.slice(prefix.length).includes('/')) continue;
      out.push(n.name);
    }
    return out;
  }

  renameSync(from: string, to: string): void {
    const fk = this.key(from);
    const node = this.nodes.get(fk);
    if (!node) throw new Error('ENOENT');
    const moved: [string, Node][] = [];
    for (const [k, n] of this.nodes) {
      if (k === fk || k.startsWith(fk + '/')) moved.push([k, n]);
    }
    for (const [k, n] of moved) this.nodes.delete(k);
    for (const [k, n] of moved) {
      this.nodes.set(this.key(to) + k.slice(fk.length), n);
    }
  }

  rmSync(p: string, _opts: { recursive: boolean; force: boolean }): void {
    const fk = this.key(p);
    for (const k of [...this.nodes.keys()]) {
      if (k === fk || k.startsWith(fk + '/')) this.nodes.delete(k);
    }
  }

  statSync(p: string): { isDirectory(): boolean; mtimeMs: number } {
    const n = this.nodes.get(this.key(p));
    if (!n) throw new Error('ENOENT');
    return { isDirectory: () => n.dir, mtimeMs: n.mtimeMs };
  }
}

const VAULT = 'E:\\Vault';

function withFs(): FakeFs {
  const fs = new FakeFs();
  __setTrashFsForTest(fs);
  return fs;
}

afterEach(() => {
  __setTrashFsForTest(null);
});

describe('trash location', () => {
  it('defaults to the vault .trash and keeps plugin data in .vt', () => {
    expect(obsidianTrashRoot(VAULT)).toBe('E:/Vault/.trash');
    expect(resolveTrashRoot(VAULT, '')).toBe('E:/Vault/.trash');
    expect(resolveTrashRoot(VAULT, '  ')).toBe('E:/Vault/.trash');
    expect(pluginTrashRoot(VAULT)).toBe('E:/Vault/.trash/.vt');
    expect(isObsidianTrashRoot(VAULT, '')).toBe(true);
    expect(isObsidianTrashRoot(VAULT, 'E:\\Vault\\.trash\\')).toBe(true);
  });

  it('accepts an absolute trash dir outside the vault', () => {
    expect(resolveTrashRoot(VAULT, 'D:\\Trash\\obsidian\\')).toBe('D:/Trash/obsidian');
    expect(pluginTrashRoot(VAULT, 'D:\\Trash\\obsidian')).toBe('D:/Trash/obsidian/.vt');
    expect(isObsidianTrashRoot(VAULT, 'D:\\Trash\\obsidian')).toBe(false);
  });

  it('resolves a relative trash dir under the vault', () => {
    expect(resolveTrashRoot(VAULT, '.trash2')).toBe('E:/Vault/.trash2');
  });
});

describe('plugin trash entries', () => {
  it('mirrors into <location>/.vt/external and restores to the original path', async () => {
    const fs = withFs();
    fs.add('E:/OUT/docs/a.md', { content: 'hello' });

    const r = await deleteToTrash('E:\\OUT\\docs\\a.md', false, {
      mode: 'plugin',
      vaultBase: VAULT,
      trashPath: 'D:\\Trash\\obsidian',
    });
    expect(r.mode).toBe('plugin');
    expect(fs.existsSync('E:/OUT/docs/a.md')).toBe(false);
    expect(fs.existsSync('D:/Trash/obsidian/.vt/external/E/OUT/docs/a.md')).toBe(true);

    const items = listTrashItems(VAULT, 'D:\\Trash\\obsidian');
    expect(items.map((i) => i.origin)).toEqual(['E:\\OUT\\docs\\a.md']);

    const restored = restoreFromTrash(VAULT, items[0].id, 'D:\\Trash\\obsidian');
    expect(restored.restoredAs).toBe('E:\\OUT\\docs\\a.md');
    expect(fs.readFileSync('E:/OUT/docs/a.md', 'utf8')).toBe('hello');
    expect(listTrashItems(VAULT, 'D:\\Trash\\obsidian')).toEqual([]);
  });

  it('purges one entry from disk', async () => {
    const fs = withFs();
    fs.add('E:/OUT/b.md', { content: 'x' });
    await deleteToTrash('E:\\OUT\\b.md', false, { mode: 'plugin', vaultBase: VAULT });
    const items = listTrashItems(VAULT);
    purgeTrashItem(VAULT, items[0].id);
    expect(listTrashItems(VAULT)).toEqual([]);
    expect(fs.existsSync('E:/Vault/.trash/.vt/external/E/OUT/b.md')).toBe(false);
  });
});

describe('Obsidian .trash entries', () => {
  it('lists vault deletions, descending through live containers', () => {
    const fs = withFs();
    // test/ 在库里仍然存在 → .trash/test 只是更深删除留下的容器，应下钻。
    fs.add('E:/Vault/test', { dir: true });
    fs.add('E:/Vault/.trash/test/untitled.md', { mtimeMs: 30 });
    // media 整个目录被删（库里已无 media）→ 作为一个目录条目。
    fs.add('E:/Vault/.trash/media/a.png', { mtimeMs: 20 });
    fs.add('E:/Vault/.trash/1.md', { mtimeMs: 10 });
    // 插件自己的 .vt 不算 Obsidian 条目。
    fs.add('E:/Vault/.trash/.vt/index.json', { content: '{}' });

    const items = listObsidianTrashItems(VAULT);
    expect(items.map((i) => i.rel)).toEqual(['test/untitled.md', 'media', '1.md']);
    expect(items.find((i) => i.rel === 'media')?.isDir).toBe(true);
    expect(items.find((i) => i.rel === 'test/untitled.md')?.isDir).toBe(false);
  });

  it('returns nothing when the trash lives outside the vault', () => {
    const fs = withFs();
    fs.add('E:/Vault/.trash/1.md', {});
    expect(listObsidianTrashItems(VAULT, 'D:\\Trash')).toEqual([]);
  });
});

describe('vault mounts with a custom trash location', () => {
  /** 复刻 Obsidian FileSystemAdapter.trashLocal：扁平命名 + " 2" 起的重名后缀。 */
  function fakeTrashLocal(fs: FakeFs): (rel: string) => Promise<void> {
    return async (rel: string) => {
      const src = `E:/Vault/${rel}`;
      fs.add('E:/Vault/.trash', { dir: true });
      const landing = obsidianTrashLandingPath(VAULT, rel);
      fs.renameSync(src, landing);
    };
  }

  it('moves a vault file out of .trash into the configured location', async () => {
    const fs = withFs();
    fs.add('E:/Vault/test/untitled.md', { content: 'v' });

    const r = await deleteVaultEntryToCustomTrash({
      vaultBase: VAULT,
      vaultRel: 'test/untitled.md',
      isDir: false,
      trashPath: 'E:\\HOME\\Runtime\\.trash',
      trashLocally: fakeTrashLocal(fs),
    });

    expect(r.mode).toBe('plugin');
    expect(fs.existsSync('E:/Vault/test/untitled.md')).toBe(false);
    expect(fs.existsSync('E:/Vault/.trash/untitled.md')).toBe(false);
    expect(fs.existsSync('E:/HOME/Runtime/.trash/.vt/external/E/Vault/test/untitled.md')).toBe(true);
    const items = listTrashItems(VAULT, 'E:\\HOME\\Runtime\\.trash');
    expect(items.map((i) => i.origin)).toEqual(['E:/Vault/test/untitled.md']);
  });

  it('follows Obsidian flat naming when the trash already has the same name', async () => {
    const fs = withFs();
    fs.add('E:/Vault/notes/untitled.md', { content: 'new' });
    fs.add('E:/Vault/.trash/untitled.md', { content: 'old' });

    expect(obsidianTrashLandingPath(VAULT, 'notes/untitled.md')).toBe('E:/Vault/.trash/untitled 2.md');
    await deleteVaultEntryToCustomTrash({
      vaultBase: VAULT,
      vaultRel: 'notes/untitled.md',
      isDir: false,
      trashPath: 'D:\\Trash',
      trashLocally: fakeTrashLocal(fs),
    });
    // 旧条目原地不动，新条目被搬进自定义位置
    expect(fs.readFileSync('E:/Vault/.trash/untitled.md', 'utf8')).toBe('old');
    expect(fs.existsSync('D:/Trash/.vt/external/E/Vault/notes/untitled.md')).toBe(true);
  });

  it('keeps the entry in .trash when the custom location is unusable', async () => {
    const fs = withFs();
    fs.add('E:/Vault/a.md', { content: 'a' });
    // 自定义位置是一个已存在的文件 → mkdir 失败
    fs.add('D:/Trash', { content: 'not a dir' });

    const r = await deleteVaultEntryToCustomTrash({
      vaultBase: VAULT,
      vaultRel: 'a.md',
      isDir: false,
      trashPath: 'D:\\Trash',
      trashLocally: fakeTrashLocal(fs),
    });
    expect(r.note).toContain('.trash');
    expect(fs.existsSync('E:/Vault/.trash/a.md')).toBe(true);
  });

  it('aborts without touching the file when Obsidian refuses to trash it', async () => {
    const fs = withFs();
    fs.add('E:/Vault/b.md', { content: 'b' });
    await expect(
      deleteVaultEntryToCustomTrash({
        vaultBase: VAULT,
        vaultRel: 'b.md',
        isDir: false,
        trashPath: 'D:\\Trash',
        trashLocally: () => Promise.reject(new Error('索引只读')),
      }),
    ).rejects.toThrow('索引只读');
    expect(fs.existsSync('E:/Vault/b.md')).toBe(true);
  });
});

describe('emptyTrash', () => {
  it('clears both plugin and Obsidian entries when sharing .trash', async () => {
    const fs = withFs();
    fs.add('E:/OUT/c.md', { content: 'c' });
    await deleteToTrash('E:\\OUT\\c.md', false, { mode: 'plugin', vaultBase: VAULT });
    fs.add('E:/Vault/.trash/test/untitled.md', {});

    emptyTrash(VAULT);
    expect(listTrashItems(VAULT)).toEqual([]);
    expect(listObsidianTrashItems(VAULT)).toEqual([]);
    expect(fs.existsSync('E:/Vault/.trash/.vt/index.json')).toBe(true);
  });

  it('keeps unrelated files in a custom trash dir', async () => {
    const fs = withFs();
    fs.add('E:/OUT/d.md', { content: 'd' });
    await deleteToTrash('E:\\OUT\\d.md', false, {
      mode: 'plugin',
      vaultBase: VAULT,
      trashPath: 'D:\\Trash',
    });
    fs.add('D:/Trash/keep.txt', { content: 'keep' });

    emptyTrash(VAULT, 'D:\\Trash');
    expect(listTrashItems(VAULT, 'D:\\Trash')).toEqual([]);
    expect(fs.readFileSync('D:/Trash/keep.txt', 'utf8')).toBe('keep');
  });
});
