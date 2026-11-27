/**
 * 强制重扫后，已展开的层必须重读——否则展开中的文件夹 children 全空，
 * caret 还朝下、内容没了，看起来就像整棵被折叠（新建文件/重扫中招）。
 *
 * 用真实临时目录：reloadOpenLayers 走面板的 loadLayer → extFs 的 node fs，
 * 伪造 fs 反而绕开被测路径。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MountPanelView } from '../src/panels/mountPanel';
import type { MountNode } from '../src/features/mountFilter';
import type { ExternalMount, VirtualTreeSettings } from '../src/types';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

function makeTree(): string {
  const root = mkdtempSync(join(tmpdir(), 'mount-reload-'));
  dirs.push(root);
  mkdirSync(join(root, 'a', 'b'), { recursive: true });
  writeFileSync(join(root, 'a', 'b', 'x.md'), '');
  writeFileSync(join(root, 'a', 'top.md'), '');
  return root;
}

function panelWith(mounts: ExternalMount[]): MountPanelView {
  const plugin = { settings: { externalMounts: mounts } as unknown as VirtualTreeSettings };
  return new MountPanelView({} as never, plugin as never);
}

function mountOf(path: string): ExternalMount {
  return { id: 'm', path, label: '', include: '', exclude: '', refreshSeconds: 0, enabled: true, pinned: false };
}

function findNode(list: MountNode[], rel: string): MountNode | null {
  for (const n of list) {
    if (n.rel === rel) return n;
    if (n.isDir) {
      const hit = findNode(n.children, rel);
      if (hit) return hit;
    }
  }
  return null;
}

type ScanFn = (m: ExternalMount, force?: boolean) => {
  open: Set<string>;
  tree: MountNode[];
  loaded: Set<string>;
};

describe('reloadOpenLayers — 强制重扫后已展开的层必须重读', () => {
  it('scan(force) 保留 open 但只重读根层；reload 后深层 children 恢复', () => {
    const root = makeTree();
    const mount = mountOf(root);
    const panel = panelWith([mount]);
    const scan = (panel as unknown as { scan: ScanFn }).scan.bind(panel);
    const reload = (panel as unknown as { reloadOpenLayers(m: ExternalMount, s: unknown): void }).reloadOpenLayers.bind(
      panel,
    );

    // 先模拟一次已展开的会话：根 + a + a/b 都打开
    const st1 = scan(mount, true);
    st1.open.add('a');
    st1.open.add('a/b');
    reload(mount, st1);
    expect(findNode(st1.tree, 'a')?.children.map((c) => c.name)).toEqual(['b', 'top.md']);
    expect(findNode(st1.tree, 'a/b')?.children.map((c) => c.name)).toEqual(['x.md']);

    // 强制重扫：open 保留，但树只剩根层 → 深层根本不在树里（回归现场）
    const st2 = scan(mount, true);
    expect(st2.open.has('a/b')).toBe(true);
    expect(findNode(st2.tree, 'a/b')).toBeNull();

    // 修复路径：按深度重读已展开的层，树恢复，无需用户再点一次
    reload(mount, st2);
    expect(findNode(st2.tree, 'a')?.children.map((c) => c.name)).toEqual(['b', 'top.md']);
    expect(findNode(st2.tree, 'a/b')?.children.map((c) => c.name)).toEqual(['x.md']);
  });

  it('open 里只有深层 rel（父层已折叠）时，祖先链补齐后深层仍能挂上', () => {
    const root = makeTree();
    const mount = mountOf(root);
    const panel = panelWith([mount]);
    const scan = (panel as unknown as { scan: ScanFn }).scan.bind(panel);
    const reload = (panel as unknown as { reloadOpenLayers(m: ExternalMount, s: unknown): void }).reloadOpenLayers.bind(
      panel,
    );

    // 折叠 a 只删自己、子项 a/b 的记忆仍在 open（toggleNode 语义）
    const st = scan(mount, true);
    expect(st.open.size).toBe(0);
    st.open.add('a/b');

    // 旧实现直接 loadLayer('a/b')：父 a 的 children 还是空，findNodes 找不到，
    // 结果被丢但 loaded 已置位 → 之后再展开 a/b 永远空白，只能重启。
    reload(mount, st);
    expect(findNode(st.tree, 'a')?.children.map((c) => c.name)).toEqual(['b', 'top.md']);
    expect(findNode(st.tree, 'a/b')?.children.map((c) => c.name)).toEqual(['x.md']);
  });

  it('挂载点暂不存在时不占用 loaded，后续能重试', () => {
    const root = makeTree();
    const mount = mountOf(root);
    const panel = panelWith([mount]);
    const scan = (panel as unknown as { scan: ScanFn }).scan.bind(panel);
    const loadLayer = (
      panel as unknown as { loadLayer(m: ExternalMount, rel: string, s: unknown): void }
    ).loadLayer.bind(panel);

    const st = scan(mount, true);
    // 父目录不存在：这一层不该留下 loaded 标记，否则父目录出现后也不会重读
    loadLayer(mount, 'ghost/x', st);
    expect(st.loaded.has('ghost/x')).toBe(false);

    // 正常路径仍会留下标记（它是真的加载过）
    loadLayer(mount, 'a', st);
    expect(st.loaded.has('a')).toBe(true);
    expect(findNode(st.tree, 'a')?.children.map((c) => c.name)).toEqual(['b', 'top.md']);
  });
});
