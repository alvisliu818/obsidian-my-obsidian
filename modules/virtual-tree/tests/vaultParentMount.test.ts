/**
 * parent 属性挂载（2026-11-03 用户需求）：frontmatter 写 `parent:` 的笔记
 * 从真实目录列表摘出、挂到目标笔记名下作为虚拟子文档。
 *
 * 这里打的是 plan 的纯逻辑（浮动判定 / 环处理 / 链式嵌套）和 vaultScanLayer
 * 的两个消费面（目录层摘出、笔记层挂入），vault/metadataCache 全部用假件——
 * TFile/TFolder 用 obsidian-stub 的类，instanceof 判定与运行时同构。
 */

import { afterEach, describe, expect, it } from 'vitest';
import { TFile, TFolder } from 'obsidian';
import type { App, TAbstractFile } from 'obsidian';
import {
  invalidateVaultParentPlans,
  parentPlanOf,
  vaultScanLayer,
} from '../src/features/vaultFs';
import { compileFilter, EMPTY_FILTER } from '../src/features/mountFilter';
import type { ExternalMount } from '../src/types';

function tfile(path: string): TFile {
  return Object.assign(new TFile(), {
    path,
    name: path.split('/').pop()!,
    stat: { size: 10, mtime: 1 },
  }) as TFile;
}

function tfolder(path: string, children: TAbstractFile[]): TFolder {
  const f = Object.assign(new TFolder(), {
    path,
    name: path.split('/').pop()!,
    children,
  }) as unknown as TFolder;
  return f;
}

/**
 * 假 App：`files` 描述库内 md（key = 库内路径，value = frontmatter `parent`
 * 原始值；null = 没写）。链接解析同 Obsidian 规则的常见子集：全路径 →
 * 路径 + '.md' → 唯一同名（去扩展名）文件。目录树由文件路径推导，
 * `getAbstractFileByPath` 文件/文件夹都能给。
 */
function fakeApp(files: Record<string, string | null>): {
  app: App;
  setParent(path: string, v: string | null): void;
} {
  const parentOf = new Map<string, string | null>(Object.entries(files));
  const paths = Object.keys(files);
  const byPath = new Map<string, TAbstractFile>(paths.map((p) => [p, tfile(p)]));
  const byStem = new Map<string, string[]>();
  for (const p of paths) {
    // Obsidian 链接解析的第三档：按 basename（去扩展名）唯一命中
    const stem = (p.split('/').pop() ?? '').replace(/\.md$/i, '');
    byStem.set(stem, [...(byStem.get(stem) ?? []), p]);
  }
  // 文件路径推导目录：每个前缀目录建 TFolder，子项 = 直接孩子
  for (const p of paths) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!byPath.has(dir)) byPath.set(dir, tfolder(dir, []));
    }
  }
  for (const p of paths) {
    const parts = p.split('/');
    const parent = parts.slice(0, -1).join('/');
    if (parent) {
      const pf = byPath.get(parent) as TFolder;
      pf.children.push(byPath.get(p)!);
    }
  }
  const resolve = (linkpath: string): TFile | null => {
    const clean = linkpath.trim();
    const hit = byPath.get(clean) ?? byPath.get(`${clean}.md`);
    if (hit instanceof TFile) return hit;
    const stems = byStem.get(clean.replace(/\.md$/i, ''));
    return stems && stems.length === 1 ? (byPath.get(stems[0]) as TFile) : null;
  };
  const app = {
    vault: {
      getMarkdownFiles: () => paths.map((p) => byPath.get(p) as TFile),
      getAbstractFileByPath: (p: string) => byPath.get(p) ?? null,
    },
    metadataCache: {
      getFileCache: (file: TFile) => ({ frontmatter: { parent: parentOf.get(file.path) ?? undefined } }),
      getFirstLinkpathDest: resolve,
    },
  } as unknown as App;
  return { app, setParent: (path, v) => parentOf.set(path, v) };
}

const mount = { kind: 'vault', id: 'm1', path: 'root', label: 'root' } as unknown as ExternalMount;
const f = compileFilter(EMPTY_FILTER);

afterEach(() => invalidateVaultParentPlans());

describe('parentPlanOf', () => {
  it('基础：parent 指到的笔记收子，子笔记浮动', () => {
    const { app } = fakeApp({
      'root/P.md': null,
      'root/inbox/c.md': '[[P]]',
    });
    const plan = parentPlanOf(app, 'root');
    expect(plan.floating.has('root/inbox/c.md')).toBe(true);
    expect(plan.childrenOf.get('root/P.md')).toEqual(['root/inbox/c.md']);
    expect(plan.parentOf.get('root/inbox/c.md')).toBe('root/P.md');
  });

  it('纯名称 / 库内路径 / [[..]] 三种写法都解析', () => {
    const { app } = fakeApp({
      'root/P.md': null,
      'root/a.md': 'P',
      'root/b.md': 'P.md',
      'root/c.md': '[[P]]',
    });
    const plan = parentPlanOf(app, 'root');
    for (const k of ['root/a.md', 'root/b.md', 'root/c.md']) {
      expect(plan.floating.has(k)).toBe(true);
    }
    expect(plan.childrenOf.get('root/P.md')).toEqual(['root/a.md', 'root/b.md', 'root/c.md']);
  });

  it('目标不存在 / 指向自己 → 保持原位', () => {
    const { app } = fakeApp({
      'root/a.md': '[[不存在]]',
      'root/b.md': 'b',
    });
    const plan = parentPlanOf(app, 'root');
    expect(plan.floating.size).toBe(0);
    expect(plan.childrenOf.size).toBe(0);
  });

  it('链式：A→B→C 逐层嵌套，C 原位', () => {
    const { app } = fakeApp({
      'root/C.md': null,
      'root/B.md': '[[C]]',
      'root/A.md': '[[B]]',
    });
    const plan = parentPlanOf(app, 'root');
    expect(plan.floating.has('root/A.md')).toBe(true);
    expect(plan.floating.has('root/B.md')).toBe(true);
    expect(plan.childrenOf.get('root/C.md')).toEqual(['root/B.md']);
    expect(plan.childrenOf.get('root/B.md')).toEqual(['root/A.md']);
  });

  it('环：互指双方原位，不浮动不丢行', () => {
    const { app } = fakeApp({
      'root/A.md': '[[B]]',
      'root/B.md': '[[A]]',
    });
    const plan = parentPlanOf(app, 'root');
    expect(plan.floating.size).toBe(0);
    expect(plan.childrenOf.size).toBe(0);
  });

  it('链子落进环里也整体保守原位（环内无锚，挂上去渲染不出）', () => {
    const { app } = fakeApp({
      'root/A.md': '[[B]]',
      'root/B.md': '[[C]]',
      'root/C.md': '[[B]]',
    });
    const plan = parentPlanOf(app, 'root');
    expect(plan.floating.size).toBe(0);
  });

  it('挂载根之外的父目标不认（无从展示）', () => {
    const { app } = fakeApp({
      'root/a.md': '[[outside]]',
      'outside.md': null,
    });
    const plan = parentPlanOf(app, 'root');
    expect(plan.floating.size).toBe(0);
  });

  it('invalidate 后按新元数据重建', () => {
    const { app, setParent } = fakeApp({ 'root/P.md': null, 'root/c.md': null });
    expect(parentPlanOf(app, 'root').floating.size).toBe(0);
    setParent('root/c.md', '[[P]]');
    invalidateVaultParentPlans();
    expect(parentPlanOf(app, 'root').floating.has('root/c.md')).toBe(true);
  });
});

describe('vaultScanLayer 的两个消费面', () => {
  const notes = (): Record<string, string | null> => ({
    'root/P.md': null,
    'root/inbox/c.md': '[[P]]',
    'root/inbox/plain.md': null,
  });

  it('目录层：浮动笔记从真实列表摘出，其余照常', () => {
    const { app } = fakeApp(notes());
    const plan = parentPlanOf(app, 'root');
    const inboxLayer = vaultScanLayer(app, mount, 'inbox', 'E:/base', f, plan);
    expect(inboxLayer.map((n) => n.name)).toEqual(['plain.md']);
  });

  it('笔记层：挂到它名下的虚拟子文档按 md 行返回', () => {
    const { app } = fakeApp(notes());
    const plan = parentPlanOf(app, 'root');
    const layer = vaultScanLayer(app, mount, 'P.md', 'E:/base', f, plan);
    expect(layer.map((n) => n.rel)).toEqual(['inbox/c.md']);
    expect(layer[0].isDir).toBe(false);
    expect(layer[0].abs).toBe('E:/base/root/inbox/c.md');
  });

  it('计划为 null（开关关闭）时：目录层不摘、笔记层无子', () => {
    const { app } = fakeApp(notes());
    const inboxLayer = vaultScanLayer(app, mount, 'inbox', 'E:/base', f, null);
    expect(inboxLayer.map((n) => n.name).sort()).toEqual(['c.md', 'plain.md']);
    expect(vaultScanLayer(app, mount, 'P.md', 'E:/base', f, null)).toEqual([]);
  });
});
