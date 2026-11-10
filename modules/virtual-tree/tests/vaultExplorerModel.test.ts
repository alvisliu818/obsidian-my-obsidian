/**
 * 虚拟文件浏览器的纯模型：排序 / 展平（懒展开）/ 查询 / 定位展开集 / 改名重指。
 *
 * 内存设计锚点：折叠态展平只产生顶层行（55k 文件的库也不多建一个对象）；
 * 查询态才走全树。每条断言都是这个契约的回归锚。
 */

import { describe, expect, it } from 'vitest';
import {
  vxAncestorFolders,
  vxCompare,
  vxExpandedForReveal,
  vxFlatten,
  vxIndexOf,
  vxRepathExpanded,
  vxSortChildren,
  type VxNode,
  type VxSortOrder,
} from '../src/vaultExplorer/model';

interface DirSpec {
  vxdir: true;
  name: string;
  kids: Spec[];
  mtime?: number;
}
interface FileSpec {
  name: string;
  mtime?: number;
}
type Spec = DirSpec | FileSpec;

const isDirSpec = (s: Spec): s is DirSpec => (s as DirSpec).vxdir === true;

/** Build a lazy node tree from specs. `built` counts children accesses —
 * the flatten contract says collapsed subtrees are NEVER walked. */
function build(specs: Spec[], built: { n: number } = { n: 0 }, base = ''): VxNode[] {
  return specs.map((spec) => {
    const path = base ? `${base}/${spec.name}` : spec.name;
    if (isDirSpec(spec)) {
      return {
        path,
        name: spec.name,
        isDir: true,
        get children() {
          built.n++;
          return build(spec.kids, built, path);
        },
      };
    }
    return { path, name: spec.name, isDir: false, children: null };
  });
}

const mtimeOf = (node: VxNode): number | undefined => {
  // 测试树里用名字编码 mtime：`f1@10` 形式取 @ 后数字。保持纯数据。
  const at = node.name.lastIndexOf('@');
  return at === -1 ? undefined : Number(node.name.slice(at + 1));
};

const noMtime = (): number | undefined => undefined;

const tree: Spec[] = [
  { vxdir: true, name: 'b-folder', kids: [{ name: 'inner.md' }] },
  { name: 'a-file.md' },
  { vxdir: true, name: 'A-folder', kids: [{ name: 'deep.txt' }, { name: 'z.md' }] },
  { name: 'c-file.md' },
];

const expanded = (paths: string[]): Set<string> => new Set(paths);

describe('vxCompare / vxSortChildren', () => {
  it('folders always precede files regardless of name order', () => {
    const nodes = build(tree);
    const sorted = vxSortChildren(nodes, 'alphabetical', noMtime);
    expect(sorted.map((n) => n.name)).toEqual(['A-folder', 'b-folder', 'a-file.md', 'c-file.md']);
  });

  it('alphabeticalReverse reverses within each class', () => {
    const nodes = build(tree);
    const sorted = vxSortChildren(nodes, 'alphabeticalReverse', noMtime);
    expect(sorted.map((n) => n.name)).toEqual(['b-folder', 'A-folder', 'c-file.md', 'a-file.md']);
  });

  it('byModifiedTime sorts files newest-first, folders stay by name', () => {
    const nodes = build([
      { name: 'old.md@10' },
      { name: 'new.md@99' },
      { name: 'mid.md@50' },
      { vxdir: true, name: 'z-dir', kids: [] },
      { vxdir: true, name: 'a-dir', kids: [] },
    ]);
    const sorted = vxSortChildren(nodes, 'byModifiedTime', mtimeOf);
    expect(sorted.map((n) => n.name)).toEqual(['a-dir', 'z-dir', 'new.md@99', 'mid.md@50', 'old.md@10']);
  });

  it('byModifiedTimeReverse sorts files oldest-first', () => {
    const nodes = build([{ name: 'old.md@10' }, { name: 'new.md@99' }]);
    const sorted = vxSortChildren(nodes, 'byModifiedTimeReverse', mtimeOf);
    expect(sorted.map((n) => n.name)).toEqual(['old.md@10', 'new.md@99']);
  });

  it('vxCompare puts folders first independent of sort order', () => {
    const [dir, file] = build([{ vxdir: true, name: 'z', kids: [] }, { name: 'a.md' }]);
    for (const order of Object.keys({ alphabetical: 1, alphabeticalReverse: 1, byModifiedTime: 1, byModifiedTimeReverse: 1 }) as VxSortOrder[]) {
      expect(vxCompare(dir, file, order)).toBeLessThan(0);
    }
  });

  it('digit runs compare numerically like the native explorer (260817 after 99)', () => {
    // BaiduSyncdisk 回归锚：原生排序把 260817 排在 99-Attachment 之后,
    // 纯字节序(localeCompare 无 numeric)会把它插到 20-Diary 和 30-Reading 之间。
    const names = ['20-Diary', '260817', '30-Reading', '99-Attachment', '98-fonts'];
    const nodes = build(names.map((name) => ({ vxdir: true, name, kids: [] })));
    const sorted = vxSortChildren(nodes, 'alphabetical', noMtime);
    expect(sorted.map((n) => n.name)).toEqual([
      '20-Diary',
      '30-Reading',
      '98-fonts',
      '99-Attachment',
      '260817',
    ]);
  });
});

describe('vxFlatten', () => {
  it('collapsed vault emits only top-level rows and never walks subtrees', () => {
    const built = { n: 0 };
    const roots = build(tree, built);
    const rows = vxFlatten(roots, expanded([]), 'alphabetical', noMtime);
    expect(rows.map((r) => r.name)).toEqual(['A-folder', 'b-folder', 'a-file.md', 'c-file.md']);
    expect(rows.every((r) => r.depth === 0)).toBe(true);
    // 关键契约：折叠目录的 children 访问器一次都不该被读。
    expect(built.n).toBe(0);
  });

  it('expanded folders contribute their children at depth+1', () => {
    const built = { n: 0 };
    const roots = build(tree, built);
    const rows = vxFlatten(roots, expanded(['A-folder']), 'alphabetical', noMtime);
    expect(rows.map((r) => r.path)).toEqual([
      'A-folder',
      'A-folder/deep.txt',
      'A-folder/z.md',
      'b-folder',
      'a-file.md',
      'c-file.md',
    ]);
    expect(rows[1].depth).toBe(1);
    expect(rows[3].depth).toBe(0);
    // 只展开了 A-folder：b-folder 的 children 仍没被碰。
    expect(built.n).toBe(1);
  });

  it('nested expansion walks only the open branch', () => {
    const roots = build([
      { vxdir: true, name: 'p', kids: [{ vxdir: true, name: 'q', kids: [{ name: 'x.md' }] }, { name: 'y.md' }] },
      { name: 'top.md' },
    ]);
    const rows = vxFlatten(roots, expanded(['p', 'p/q']), 'alphabetical', noMtime);
    expect(rows.map((r) => r.path)).toEqual(['p', 'p/q', 'p/q/x.md', 'p/y.md', 'top.md']);
    expect(rows.map((r) => r.depth)).toEqual([0, 1, 2, 1, 0]);
  });

  it('query mode walks everything and returns matches across depths', () => {
    const built = { n: 0 };
    const roots = build(tree, built);
    const rows = vxFlatten(roots, expanded([]), 'alphabetical', noMtime, 'file');
    expect(rows.map((r) => r.path)).toEqual(['a-file.md', 'c-file.md']);
    // 查询态允许走全树（collapsed 访问器被读不算 bug）。
    expect(built.n).toBeGreaterThanOrEqual(1);
  });

  it('query matches are case-insensitive and sorted by path', () => {
    const roots = build([{ vxdir: true, name: 'Notes', kids: [{ name: 'Zeta.md' }, { name: 'alpha.md' }] }]);
    const rows = vxFlatten(roots, expanded([]), 'alphabetical', noMtime, 'ZET');
    expect(rows.map((r) => r.path)).toEqual(['Notes/Zeta.md']);
  });
});

describe('vxAncestorFolders / vxExpandedForReveal', () => {
  it('returns nearest-first ancestor chain without the root', () => {
    expect(vxAncestorFolders('a/b/c.md')).toEqual(['a/b', 'a']);
    expect(vxAncestorFolders('top.md')).toEqual([]);
  });

  it('reveal expands exactly the ancestors and keeps the rest', () => {
    const current = expanded(['unrelated', 'a']);
    const next = vxExpandedForReveal('a/b/c.md', current);
    expect(next.has('a/b')).toBe(true);
    expect(next.has('a')).toBe(true);
    expect(next.has('unrelated')).toBe(true);
    // 不改原集合（视图状态不可变更替）。
    expect(current.has('a/b')).toBe(false);
  });
});

describe('vxIndexOf / vxRepathExpanded', () => {
  const rows = vxFlatten(build(tree), expanded(['A-folder']), 'alphabetical', noMtime);

  it('finds a row by path and returns -1 for absent paths', () => {
    expect(vxIndexOf(rows, 'A-folder/z.md')).toBe(2);
    expect(vxIndexOf(rows, 'missing.md')).toBe(-1);
  });

  it('rename repoints the folder and its expanded descendants', () => {
    const current = expanded(['p', 'p/q', 'p/q/r', 'other']);
    const next = vxRepathExpanded(current, 'p', 'renamed');
    expect([...next].sort()).toEqual(['other', 'renamed', 'renamed/q', 'renamed/q/r'].sort());
    expect(current.has('p')).toBe(true); // 原集合不动
  });

  it('rename only touches the matching prefix', () => {
    const next = vxRepathExpanded(expanded(['paradox', 'p/inner']), 'p', 'q');
    expect([...next].sort()).toEqual(['paradox', 'q/inner']);
  });
});
