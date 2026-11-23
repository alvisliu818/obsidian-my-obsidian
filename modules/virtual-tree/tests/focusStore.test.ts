import { describe, expect, it } from 'vitest';
import { focusTargetBelow, nodeVisibleUnderFocus, type FocusTarget } from '../src/features/focusStore';

const t = (rel: string, ancestors: string[], isDir = false): FocusTarget => ({
  mountId: 'm1',
  rel,
  ancestors,
  isDir,
});

describe('nodeVisibleUnderFocus', () => {
  describe('无聚集目标', () => {
    it('返回 true（不过滤；跨挂载隐藏由渲染层处理）', () => {
      expect(nodeVisibleUnderFocus([], 'm1', 'A/x.md', ['A'])).toBe(true);
    });
  });

  // 树：A/、B/(x.md y.md z.md sub/)、C/；在 B/x.md 上聚集
  // B/x.md 的祖先链 = ['B']
  describe('聚集 B/x.md → 目标/子树/兄弟/兄弟子树/祖先链', () => {
    const focus = [t('B/x.md', ['B'])];
    const vis = (rel: string, ancestors: string[]): boolean =>
      nodeVisibleUnderFocus(focus, 'm1', rel, ancestors);

    it('目标自身可见', () => {
      expect(vis('B/x.md', ['B'])).toBe(true);
    });
    it('祖先链 B/ 可见', () => {
      expect(vis('B', [])).toBe(true);
    });
    it('兄弟（同直接父 B）可见，含异类型文件夹', () => {
      expect(vis('B/y.md', ['B'])).toBe(true);
      expect(vis('B/z.md', ['B'])).toBe(true);
      expect(vis('B/sub', ['B'])).toBe(true);
    });
    it('兄弟的子树可见（目标父 B 在祖先链里）', () => {
      expect(vis('B/y.md/child', ['B', 'B/y.md'])).toBe(true);
      expect(vis('B/sub/deep/file.md', ['B', 'B/sub', 'B/sub/deep'])).toBe(true);
    });
    it('目标的子树可见', () => {
      expect(vis('B/x.md/child.md', ['B', 'B/x.md'])).toBe(true);
    });
    it('其他分支 A/ C/ 隐藏', () => {
      expect(vis('A', [])).toBe(false);
      expect(vis('A/k.md', ['A'])).toBe(false);
      expect(vis('C/k.md', ['C'])).toBe(false);
    });
  });

  it('多目标：命中任一即可见', () => {
    const focus = [t('B/x.md', ['B']), t('A/a.md', ['A'])];
    const vis = (rel: string, ancestors: string[]): boolean =>
      nodeVisibleUnderFocus(focus, 'm1', rel, ancestors);
    expect(vis('B/x.md', ['B'])).toBe(true);
    expect(vis('A/a.md', ['A'])).toBe(true);
    expect(vis('A/b.md', ['A'])).toBe(true);
    expect(vis('C/c.md', ['C'])).toBe(false);
  });

  // 虚拟子行：rel 是库内路径，大模型.md 与 掌柜智库.md 路径同级，但树里
  // 掌柜智库是大模型的子（parent 挂载链）。 ancestors 捕捉真实树关系。
  describe('虚拟子行（rel 带 / 前缀）：按树祖先链判定', () => {
    // 在 掌柜智库.md 上聚集：rel='/notes/掌柜智库.md'，祖先=['/notes/大模型.md']
    const focus = [{ ...t('/notes/掌柜智库.md', ['/notes/大模型.md']), mountId: 'mf' }];
    const vis = (rel: string, ancestors: string[]): boolean =>
      nodeVisibleUnderFocus(focus, 'mf', rel, ancestors);

    it('目标自身可见', () => {
      expect(vis('/notes/掌柜智库.md', ['/notes/大模型.md'])).toBe(true);
    });
    it('目标祖先 大模型.md 可见（路径前缀无法识别的父子关系）', () => {
      expect(vis('/notes/大模型.md', [])).toBe(true);
    });
    it('兄弟（同为大模型.md 的子）可见', () => {
      expect(vis('/notes/其他子.md', ['/notes/大模型.md'])).toBe(true);
    });
    it('兄弟的子树可见', () => {
      expect(vis('/notes/其他子.md/deep', ['/notes/大模型.md', '/notes/其他子.md'])).toBe(true);
    });
    it('无关虚拟分支隐藏', () => {
      expect(vis('/other/x.md', ['/other'])).toBe(false);
    });
  });

  it('在 大模型.md 上聚集：其子 掌柜智库 作为目标子树可见', () => {
    const focus = [{ ...t('/notes/大模型.md', []), mountId: 'mf' }];
    const vis = (rel: string, ancestors: string[]): boolean =>
      nodeVisibleUnderFocus(focus, 'mf', rel, ancestors);
    expect(vis('/notes/大模型.md', [])).toBe(true);
    expect(vis('/notes/掌柜智库.md', ['/notes/大模型.md'])).toBe(true); // 目标子树
    expect(vis('/notes/other.md', [])).toBe(true); // 兄弟
  });

  // 'subtree'（设置「聚焦方式」= 仅目标与子树）：父级与兄弟都不上屏
  describe('subtree 模式：只留目标与子树', () => {
    // 树：A/、B/(x.md y.md sub/)、C/；在 B/x.md 上聚集，祖先链 = ['B']
    const focus = [t('B/x.md', ['B'])];
    const vis = (rel: string, ancestors: string[]): boolean =>
      nodeVisibleUnderFocus(focus, 'm1', rel, ancestors, 'subtree');

    it('目标自身可见', () => {
      expect(vis('B/x.md', ['B'])).toBe(true);
    });
    it('目标的子树可见', () => {
      expect(vis('B/x.md/child.md', ['B', 'B/x.md'])).toBe(true);
      expect(vis('B/x.md/deep/f.md', ['B', 'B/x.md', 'B/x.md/deep'])).toBe(true);
    });
    it('目标的父级（祖先链）不展示', () => {
      expect(vis('B', [])).toBe(false);
    });
    it('兄弟及其子树不展示', () => {
      expect(vis('B/y.md', ['B'])).toBe(false);
      expect(vis('B/sub/deep/file.md', ['B', 'B/sub', 'B/sub/deep'])).toBe(false);
    });
    it('其他分支隐藏', () => {
      expect(vis('A', [])).toBe(false);
      expect(vis('C/k.md', ['C'])).toBe(false);
    });
  });

  describe('focusTargetBelow：找到需要下潜穿过的祖先', () => {
    const focus = [t('B/x.md', ['B', 'B/deep'])];
    it('目标祖先返回 true（不展示但要下潜）', () => {
      expect(focusTargetBelow(focus, 'm1', 'B')).toBe(true);
      expect(focusTargetBelow(focus, 'm1', 'B/deep')).toBe(true);
    });
    it('目标自身/其他节点返回 false', () => {
      expect(focusTargetBelow(focus, 'm1', 'B/x.md')).toBe(false);
      expect(focusTargetBelow(focus, 'm1', 'A')).toBe(false);
    });
    it('挂载不匹配返回 false', () => {
      expect(focusTargetBelow(focus, 'm2', 'B')).toBe(false);
    });
  });
});
