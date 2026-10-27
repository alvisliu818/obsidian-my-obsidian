/**
 * 虚拟文档树的复制粘贴：uniqueCopyName / copyEntry。
 *
 * 全部走注入的假 fs（in-memory 树），不碰真盘。copyFileSync 是复制专用的
 * 可选接口——文本接口会把二进制文件写坏，所以这里验证它被用到、以及目录
 * 递归与撞名序号的逻辑。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { __setFsForTest, copyEntry, uniqueCopyName, type NodeFsLike } from '../src/features/extFs';

interface FakeNode {
  dir: boolean;
  /** 文件内容（复制时只记名字，内容不搬——copyFileSync 语义）。 */
  content?: string;
  children: Map<string, FakeNode>;
}

function makeFs(root: FakeNode) {
  const calls: string[] = [];
  const find = (p: string): FakeNode | null => {
    const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
    let cur: FakeNode = root;
    for (const part of parts) {
      if (!cur.dir) return null;
      const next = cur.children.get(part);
      if (!next) return null;
      cur = next;
    }
    return cur;
  };
  const parentOf = (p: string): { parent: FakeNode | null; name: string } => {
    const parts = p.replace(/\\/g, '/').split('/').filter(Boolean);
    const name = parts.pop() ?? '';
    return { parent: find(parts.join('/')), name };
  };
  const fs: NodeFsLike & { copyFileSync(from: string, to: string): void } = {
    readdirSync: (p) => {
      const n = find(p);
      return [...(n?.children.keys() ?? [])].map((name) => ({
        name,
        isDirectory: () => n!.children.get(name)!.dir,
        isFile: () => !n!.children.get(name)!.dir,
        isSymbolicLink: () => false,
      })) as never;
    },
    statSync: (p) => {
      const n = find(p);
      if (!n) throw new Error('ENOENT: ' + p);
      return { isDirectory: () => n.dir, size: n.content?.length ?? 0, mtimeMs: 1 };
    },
    existsSync: (p) => !!find(p),
    readFileSync: () => '',
    writeFileSync: () => {},
    lstatSync: (p) => ({ isDirectory: () => !!find(p)?.dir }),
    realpathSync: (p) => p,
    mkdirSync: (p) => {
      calls.push(`mkdir:${p.replace(/\\/g, '/')}`);
      const { parent, name } = parentOf(p);
      parent?.children.set(name, { dir: true, children: new Map() });
    },
    copyFileSync: (from, to) => {
      calls.push(`copy:${from.replace(/\\/g, '/')}=>${to.replace(/\\/g, '/')}`);
      const src = find(from);
      const { parent, name } = parentOf(to);
      if (!parent || !parent.dir) throw new Error('ENOENT dest dir');
      parent.children.set(name, { dir: !!src?.dir && false, content: src?.content ?? '', children: new Map() });
    },
    renameSync: () => {},
    unlinkSync: () => {},
    rmSync: () => {},
  };
  return { fs, calls };
}

afterEach(() => __setFsForTest(null));

function tree(): FakeNode {
  const root: FakeNode = { dir: true, children: new Map() };
  const src = { dir: true, children: new Map<string, FakeNode>() };
  src.children.set('a.md', { dir: false, content: 'hello', children: new Map() });
  src.children.set('sub', {
    dir: true,
    children: new Map([['b.md', { dir: false, content: 'x', children: new Map() }]]),
  });
  root.children.set('src', src);
  root.children.set('dst', { dir: true, children: new Map() });
  return root;
}

describe('uniqueCopyName', () => {
  it('keeps the name when free', () => {
    const root = tree();
    const { fs } = makeFs(root);
    __setFsForTest(fs);
    expect(uniqueCopyName('/dst', 'a.md')).toBe('a.md');
  });

  it('appends 2, 3… on collisions, keeping the extension', () => {
    const root = tree();
    const { fs } = makeFs(root);
    __setFsForTest(fs);
    root.children.get('dst')!.children.set('a.md', { dir: false, content: '', children: new Map() });
    expect(uniqueCopyName('/dst', 'a.md')).toBe('a 2.md');
    root.children.get('dst')!.children.set('a 2.md', { dir: false, content: '', children: new Map() });
    expect(uniqueCopyName('/dst', 'a.md')).toBe('a 3.md');
  });

  it('handles extension-less names', () => {
    const root = tree();
    const { fs } = makeFs(root);
    __setFsForTest(fs);
    root.children.get('dst')!.children.set('Dockerfile', { dir: false, content: '', children: new Map() });
    expect(uniqueCopyName('/dst', 'Dockerfile')).toBe('Dockerfile 2');
  });
});

describe('copyEntry', () => {
  it('copies a file with copyFileSync and reports the target', () => {
    const root = tree();
    const { fs, calls } = makeFs(root);
    __setFsForTest(fs);
    const r = copyEntry('/src/a.md', '/dst');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('/dst/a.md');
    expect(r.count).toBe(1);
    expect(calls).toContain('copy:/src/a.md=>/dst/a.md');
  });

  it('copies a folder recursively (mkdir per dir, copy per file)', () => {
    const root = tree();
    const { fs, calls } = makeFs(root);
    __setFsForTest(fs);
    const r = copyEntry('/src/sub', '/dst');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('/dst/sub');
    expect(r.count).toBe(1);
    expect(calls).toContain('mkdir:/dst/sub');
    expect(calls).toContain('copy:/src/sub/b.md=>/dst/sub/b.md');
  });

  it('auto-renames on collision', () => {
    const root = tree();
    const { fs } = makeFs(root);
    __setFsForTest(fs);
    root.children.get('dst')!.children.set('a.md', { dir: false, content: '', children: new Map() });
    const r = copyEntry('/src/a.md', '/dst');
    expect(r.ok).toBe(true);
    expect(r.target).toBe('/dst/a 2.md');
  });

  it('refuses to copy a folder into its own subtree', () => {
    const root = tree();
    const { fs } = makeFs(root);
    __setFsForTest(fs);
    const r = copyEntry('/src', '/src/sub');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('自己');
  });

  it('errors on missing source or destination', () => {
    const root = tree();
    const { fs } = makeFs(root);
    __setFsForTest(fs);
    expect(copyEntry('/nope', '/dst').ok).toBe(false);
    expect(copyEntry('/src/a.md', '/nope').ok).toBe(false);
  });

  it('reports a clear error when the fs cannot copy files', () => {
    const root = tree();
    const { fs } = makeFs(root);
    const noCopy = fs as NodeFsLike;
    delete (noCopy as { copyFileSync?: unknown }).copyFileSync;
    __setFsForTest(noCopy);
    const r = copyEntry('/src/a.md', '/dst');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('不支持复制');
  });
});
