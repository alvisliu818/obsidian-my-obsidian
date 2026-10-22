/**
 * Where nested mounts land in the flattened row list.
 *
 * A mount can now hang on the host's root, on any SUBFOLDER inside it, or on a
 * single FILE inside it (`attachTo` = `hostId/rel`). `flatten` is what turns
 * that configuration into draw order, and it is the piece the feature lives or
 * dies by — so it is tested directly rather than only through the panel.
 *
 * What must hold:
 *   - nested rows come BEFORE the host's own children at that level
 *     (si-yuan: explicit children precede automatic ones)
 *   - they only appear once the host node is expanded
 *   - a FILE node can carry mounts too, even though it has no real children
 *   - nesting is recursive: a nested mount's own nodes can carry more mounts
 */

import { describe, expect, it } from 'vitest';
import { MountPanelView } from '../src/panels/mountPanel';
import type { ExternalMount, LogseqEditorSettings } from '../src/types';
import type { MountNode } from '../src/features/mountFilter';

type Row =
  | { kind: 'mountHead'; mount: ExternalMount; depth: number }
  | { kind: 'node'; node: MountNode; mount: ExternalMount; depth: number };

const node = (name: string, rel: string, isDir: boolean, children: MountNode[] = []): MountNode => ({
  name,
  rel,
  abs: `/host/${rel}`,
  isDir,
  children,
});

function mount(id: string, attachTo?: string): ExternalMount {
  return {
    id,
    path: `D:\\m${id}`,
    label: '',
    include: '',
    exclude: '',
    refreshSeconds: 0,
    enabled: true,
    pinned: false,
    ...(attachTo ? { attachTo } : {}),
  };
}

/** A panel with the given mounts, and nothing else Obsidian needs. */
function panelWith(mounts: ExternalMount[]): MountPanelView {
  const plugin = { settings: { externalMounts: mounts } as unknown as LogseqEditorSettings };
  return new MountPanelView({} as never, plugin as never);
}

function stateOf(tree: MountNode[], open: string[]): ReturnType<typeof panelWith> extends never ? never : object {
  return { open: new Set(open), tree, loaded: new Set(['']), truncated: false, scannedAt: 0 };
}

const describe2 = (rows: Row[]): string[] =>
  rows.map((r) =>
    r.kind === 'mountHead' ? `HEAD:${r.mount.id}@${r.depth}` : `${r.node.isDir ? 'DIR' : 'FILE'}:${r.node.rel}@${r.depth}`,
  );

describe('flatten — nested mounts hang on the host root', () => {
  it('nested rows precede the host’s own children', () => {
    const host = mount('host');
    const child = mount('child', 'host');
    const panel = panelWith([host, child]);
    const state = { open: new Set(['']), tree: [node('a.md', 'a.md', false), node('b.md', 'b.md', false)], loaded: new Set(['']), truncated: false, scannedAt: 0 };
    const rows = (panel as unknown as { flatten(m: ExternalMount, s: unknown): Row[] }).flatten(host, state);

    expect(describe2(rows)).toEqual(['HEAD:child@1', 'FILE:a.md@1', 'FILE:b.md@1']);
  });

  it('does NOT gate on the host’s own collapsed state — renderMount does', () => {
    // This looks wrong until you see the caller: `renderMount` returns early
    // when the host is collapsed, so `flatten` is never reached in that state.
    // Keeping the check out of `flatten` is what lets `consumePendingReveal`
    // flatten a section to measure row offsets regardless of open state.
    const panel = panelWith([mount('host'), mount('child', 'host')]);
    const state = { open: new Set<string>(), tree: [node('a.md', 'a.md', false)], loaded: new Set(['']), truncated: false, scannedAt: 0 };
    const rows = (panel as unknown as { flatten(m: ExternalMount, s: unknown): Row[] }).flatten(mount('host'), state);
    // The nested head is emitted either way; the host's own rows are not,
    // because `walk` starts from `state.tree` and only descends what is open.
    expect(describe2(rows)).toEqual(['HEAD:child@1', 'FILE:a.md@1']);
  });
});

describe('flatten — nested mounts hang on a SUBFOLDER', () => {
  const tree = [node('sub', 'sub', true, [node('inner.md', 'sub/inner.md', false)]), node('top.md', 'top.md', false)];

  it('appears inside the folder, before its real children, one level deeper', () => {
    const host = mount('host');
    const panel = panelWith([host, mount('deep', 'host/sub')]);
    const state = { open: new Set(['', 'sub']), tree, loaded: new Set(['']), truncated: false, scannedAt: 0 };
    const rows = (panel as unknown as { flatten(m: ExternalMount, s: unknown): Row[] }).flatten(host, state);

    expect(describe2(rows)).toEqual(['DIR:sub@1', 'HEAD:deep@2', 'FILE:sub/inner.md@2', 'FILE:top.md@1']);
  });

  it('is hidden until that folder is expanded', () => {
    const panel = panelWith([mount('host'), mount('deep', 'host/sub')]);
    const state = { open: new Set(['']), tree, loaded: new Set(['']), truncated: false, scannedAt: 0 };
    const rows = (panel as unknown as { flatten(m: ExternalMount, s: unknown): Row[] }).flatten(mount('host'), state);
    expect(describe2(rows)).toEqual(['DIR:sub@1', 'FILE:top.md@1']);
  });
});

describe('flatten — nested mounts hang on a FILE', () => {
  // A file has no real children, but with mounts under it it becomes a
  // container: the rows appear when the file row is expanded.
  const tree = [node('note.md', 'note.md', false), node('other.md', 'other.md', false)];

  it('the file acts as a container when expanded', () => {
    const panel = panelWith([mount('host'), mount('onfile', 'host/note.md')]);
    const state = { open: new Set(['', 'note.md']), tree, loaded: new Set(['']), truncated: false, scannedAt: 0 };
    const rows = (panel as unknown as { flatten(m: ExternalMount, s: unknown): Row[] }).flatten(mount('host'), state);

    expect(describe2(rows)).toEqual(['FILE:note.md@1', 'HEAD:onfile@2', 'FILE:other.md@1']);
  });

  it('collapsed file shows nothing extra', () => {
    const panel = panelWith([mount('host'), mount('onfile', 'host/note.md')]);
    const state = { open: new Set(['']), tree, loaded: new Set(['']), truncated: false, scannedAt: 0 };
    const rows = (panel as unknown as { flatten(m: ExternalMount, s: unknown): Row[] }).flatten(mount('host'), state);
    expect(describe2(rows)).toEqual(['FILE:note.md@1', 'FILE:other.md@1']);
  });
});

describe('flatten — nesting is recursive', () => {
  it('a nested mount’s own node can carry yet another mount', () => {
    // host -> child (on root) -> grandchild (on child/sub)
    const childTree = [node('sub', 'sub', true, [])];
    const panel = panelWith([mount('host'), mount('child', 'host'), mount('grand', 'child/sub')]);

    // `flatten` reads the child's own tree through scan(), which needs a real
    // fs; stub it so the child contributes a tree with a `sub` folder.
    (panel as unknown as { states: Map<string, unknown> }).states = new Map([
      ['child', { open: new Set(['', 'sub']), tree: childTree, loaded: new Set(['']), truncated: false, scannedAt: 0 }],
    ]);

    const state = { open: new Set(['']), tree: [node('host.md', 'host.md', false)], loaded: new Set(['']), truncated: false, scannedAt: 0 };
    const rows = (panel as unknown as { flatten(m: ExternalMount, s: unknown): Row[] }).flatten(mount('host'), state);

    expect(describe2(rows)).toEqual(['HEAD:child@1', 'DIR:sub@2', 'HEAD:grand@3', 'FILE:host.md@1']);
  });
});

describe('flatten — a plain folder with NO nested mounts still descends', () => {
  // 回归:8cc0db9b 曾把 descend 放在 `nested.length === 0 → continue` 之后,
  // 于是没有挂嵌套挂载的普通文件夹被整棵藏掉——点击展开时 caret 翻转、
  // loadLayer 也读了盘,却一个子行都不织(实测:挂载项子目录打不开)。
  const tree = [
    node('sub', 'sub', true, [
      node('inner.md', 'sub/inner.md', false),
      node('deep', 'sub/deep', true, [node('x.md', 'sub/deep/x.md', false)]),
    ]),
    node('top.md', 'top.md', false),
  ];

  it('shows the real children of an expanded folder, recursively', () => {
    const panel = panelWith([mount('host')]);
    const state = { open: new Set(['', 'sub', 'sub/deep']), tree, loaded: new Set(['']), truncated: false, scannedAt: 0 };
    const rows = (panel as unknown as { flatten(m: ExternalMount, s: unknown): Row[] }).flatten(mount('host'), state);

    expect(describe2(rows)).toEqual(['DIR:sub@1', 'FILE:sub/inner.md@2', 'DIR:sub/deep@2', 'FILE:sub/deep/x.md@3', 'FILE:top.md@1']);
  });

  it('hides them again while collapsed', () => {
    const panel = panelWith([mount('host')]);
    const state = { open: new Set(['']), tree, loaded: new Set(['']), truncated: false, scannedAt: 0 };
    const rows = (panel as unknown as { flatten(m: ExternalMount, s: unknown): Row[] }).flatten(mount('host'), state);

    expect(describe2(rows)).toEqual(['DIR:sub@1', 'FILE:top.md@1']);
  });
});
