/**
 * Vault-side scanning for `kind: 'vault'` mounts — the in-vault twin of
 * extFs. The panel's render pipeline speaks one node shape (MountNode), so a
 * vault mount feeds the same pipeline from the vault's OWN index instead of
 * disk readdir: `vault.getAbstractFileByPath` for the root, `TFolder.children`
 * for each layer. No fs access, no async — the vault tree is already in
 * memory, and Obsidian keeps it fresh through its own file watchers.
 *
 * `abs` is filled with the real on-disk path (vault base + rel) so the
 * downstream consumers that genuinely need a disk path (在资源管理器中显示,
 * icon themes keyed by path) work unchanged; everything in-vault goes through
 * the vault API by the REL path.
 */

import { TFile, TFolder, type App, type TAbstractFile } from 'obsidian';
import { isVaultMount, type ExternalMount } from '../types';
import type { CompiledFilter, MountNode } from './mountFilter';
import { dirPruned, entryMatches } from './mountFilter';

// ---------------------------------------------------------------------------
// parent 属性挂载（2026-11-03 用户需求）：笔记 frontmatter 写 `parent:` 时，
// 树里把笔记挂到那篇笔记名下作为**子文档**显示——文件的真实位置不动，纯
// 树形展示（与 attachTo 嵌套挂载同一哲学：文档归库管，位置归树管）。
//
// 计划（ParentPlan）按挂载根缓存：floating = 要从真实目录列表里摘出来的
// 笔记（它们的展示位置在父笔记名下）；childrenOf = 父笔记 → 虚拟子笔记。
// 环（A.parent=B 且 B.parent=A）里的笔记保持原位——挂环上谁都渲染不出来，
// 原位才不会丢行。指向环外某笔记的笔记照常浮动：它的展示终点是一棵
// 原位渲染的笔记，链路每个中间层都浮动，树里逐层嵌套。
// ---------------------------------------------------------------------------

/** 一次 parent 挂载计划：floating 摘出，childrenOf 挂入。 */
export interface ParentPlan {
  /** 从真实所在目录列表摘出的笔记（vault 绝对路径，库内 path 域）。 */
  floating: Set<string>;
  /** 父笔记 vault 路径 → 挂到它名下的子笔记 vault 路径（名称序）。 */
  childrenOf: Map<string, string[]>;
  /** 子笔记 vault 路径 → 它挂到的父笔记 vault 路径（定位用）。 */
  parentOf: Map<string, string>;
}

/** 计划缓存：挂载根路径 → { 数据代, 计划 }。invalidateVaultParentPlans() 换代。 */
const parentPlans = new Map<string, { gen: number; plan: ParentPlan }>();
/** 计划数据代：元数据缓存变动/设置开关时 +1，缓存全部作废。 */
let parentPlanGen = 0;

/** 库内笔记结构/元数据变化后调用：下次取计划时按新索引重建。 */
export function invalidateVaultParentPlans(): void {
  parentPlanGen++;
}

/** frontmatter `parent` 值 → 干净的链接路径（[[..]]、别名、引号都剥掉）。 */
function cleanParentValue(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  let v = raw.trim();
  if (!v) return '';
  // Obsidian 链接属性常写成 "[[Note|alias]]" 或 "[[Note]]"
  const wiki = v.match(/^\[\[([^\]]+)\]\]$/);
  if (wiki) v = wiki[1];
  v = v.split('|')[0].split('#')[0].trim().replace(/^["']|["']$/g, '');
  return v;
}

/**
 * 算一个库内挂载根的 parent 挂载计划。
 *
 * 只认笔记（md）→ 笔记的链接：`getFirstLinkpathDest` 同时吃纯名称、库内
 * 路径和 [[..]] 语法，与 Obsidian 链接解析完全同源。父目标必须是挂载根
 * 之下的 md 文件（挂到根外/挂到文件夹都无从展示，保持原位）。
 */
export function parentPlanOf(app: App, mountPath: string): ParentPlan {
  const gen = parentPlanGen;
  const cached = parentPlans.get(mountPath);
  if (cached && cached.gen === gen) return cached.plan;

  const root = mountPath.replace(/[\\/]+$/, '').replace(/\\/g, '/');
  const underRoot = (p: string): boolean => p === root || p.startsWith(`${root}/`);

  // 逐笔记读 frontmatter.parent，解析成 child → parent 的原始映射
  const raw = new Map<string, string>();
  for (const f of app.vault.getMarkdownFiles()) {
    if (!underRoot(f.path)) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    const target = cleanParentValue(fm?.['parent']);
    if (!target || target === f.path) continue;
    if (/^(?:https?|file|app|obsidian):/i.test(target)) continue;
    const dest = app.metadataCache.getFirstLinkpathDest(target, f.path);
    if (!(dest instanceof TFile) || dest.path === f.path) continue;
    if (!underRoot(dest.path)) continue;
    raw.set(f.path, dest.path);
  }

  // 链路分析：无 parent 的笔记是锚（原位）；沿 parent 链走到锚的链路全员
  // 浮动；走进环的（含环成员本身）一律原位——环成员谁都不渲染出来。
  const floating = new Set<string>();
  const anchored = new Set<string>();
  for (const child of raw.keys()) {
    const seen = new Set<string>([child]);
    let cur: string | undefined = raw.get(child);
    let ok = false;
    while (cur) {
      if (seen.has(cur)) break; // 环：cur（环入口）保持原位
      seen.add(cur);
      const next = raw.get(cur);
      if (!next) {
        ok = true; // 链尾是锚（无 parent 的笔记，原位渲染）
        anchored.add(cur);
        break;
      }
      cur = next;
    }
    if (ok) {
      // 链路上除锚之外的每一层都浮动（挂在自己 parent 名下）
      for (const p of seen) if (raw.has(p)) floating.add(p);
      floating.add(child);
    }
  }

  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const [child, parent] of raw) {
    if (!floating.has(child)) continue;
    parentOf.set(child, parent);
    let list = childrenOf.get(parent);
    if (!list) childrenOf.set(parent, (list = []));
    list.push(child);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => a.localeCompare(b));

  const plan: ParentPlan = { floating, childrenOf, parentOf };
  parentPlans.set(mountPath, { gen, plan });
  return plan;
}

/** 库内相对路径在磁盘上的绝对路径（FileSystemAdapter.getBasePath + rel）。 */
export function vaultAbsOf(app: App, vaultRel: string): string {
  const adapter = app.vault.adapter as unknown as {
    basePath?: string;
    getBasePath?: () => string;
  };
  const base = (adapter.basePath ?? adapter.getBasePath?.() ?? '').replace(/[\\/]+$/, '');
  return base ? `${base}/${vaultRel}` : vaultRel;
}

/** 挂载内 `rel`（相对挂载根）对应的库内 TAbstractFile；不存在返回 null。 */
export function vaultNodeAt(app: App, mount: ExternalMount, rel = ''): TAbstractFile | null {
  const vaultPath = rel ? `${mount.path}/${rel}` : mount.path;
  return app.vault.getAbstractFileByPath(vaultPath) ?? null;
}

/** 挂载根的解析结果：单个文件 / 文件夹 / 不存在。 */
export type VaultRoot =
  | { kind: 'file'; file: TFile }
  | { kind: 'folder'; folder: TFolder }
  | { kind: 'missing' };

export function vaultRootOf(app: App, mount: ExternalMount): VaultRoot {
  if (!isVaultMount(mount)) return { kind: 'missing' };
  const node = app.vault.getAbstractFileByPath(mount.path);
  if (node instanceof TFile) return { kind: 'file', file: node };
  if (node instanceof TFolder) return { kind: 'folder', folder: node };
  return { kind: 'missing' };
}

/**
 * 列挂载内 `rel` 这一层（不递归）的子项，套用挂载自己的 include/exclude
 * 过滤（与库外 loadLayer 同一套纯函数），产出面板同款 MountNode。
 *
 * `base` 是库根的磁盘绝对路径（vaultAbsOf 的基数），由调用方传入以避免
 * 每个 child 都重读 adapter。TFolder 没有文件 stat，size/mtime 仅文件有。
 *
 * `plan`（parent 属性挂载计划，开关关闭时传 null）：目录层摘掉浮动笔记
 * （它们的展示位在父笔记名下）；`rel` 指向一篇 md 笔记时返回挂到它名下的
 * 虚拟子笔记——文件节点由此变成可展开容器（与嵌套挂载同一套面板机制）。
 */
export function vaultScanLayer(
  app: App,
  mount: ExternalMount,
  rel: string,
  base: string,
  f: CompiledFilter,
  plan: ParentPlan | null = null,
): MountNode[] {
  const node = vaultNodeAt(app, mount, rel);
  if (node instanceof TFile) {
    // parent 属性挂载的虚拟子层：挂到这篇笔记名下的子文档（md 行，懒展开）
    if (!plan) return [];
    const out: MountNode[] = [];
    for (const childPath of plan.childrenOf.get(node.path) ?? []) {
      const child = app.vault.getAbstractFileByPath(childPath);
      if (!(child instanceof TFile)) continue;
      const childRel = child.path.slice(mount.path.length + 1);
      if (!entryMatches(childRel, f)) continue;
      out.push({
        name: child.name,
        rel: childRel,
        abs: base ? `${base}/${child.path}` : child.path,
        isDir: false,
        size: child.stat.size,
        mtime: child.stat.mtime,
        children: [],
      });
    }
    return out;
  }
  if (!(node instanceof TFolder)) return [];
  const out: MountNode[] = [];
  for (const child of node.children) {
    const childRel = rel ? `${rel}/${child.name}` : child.name;
    const isDir = child instanceof TFolder;
    // 浮动笔记从真实目录列表摘出——它已挂到父笔记名下，两处都列会重复
    if (!isDir && plan?.floating.has(child.path)) continue;
    if (isDir ? dirPruned(childRel, f) : !entryMatches(childRel, f)) continue;
    const tf = child instanceof TFile ? child : null;
    out.push({
      name: child.name,
      rel: childRel,
      abs: base ? `${base}/${child.path}` : child.path,
      isDir,
      size: tf?.stat.size,
      mtime: tf?.stat.mtime,
      children: [],
    });
  }
  return out;
}

/**
 * 面板渲染判断用：这篇库内笔记（或库内挂载根 rel='' 的文件夹层）名下有
 * 没有 parent 属性挂来的虚拟子文档。文件行靠它决定要不要补展开三角。
 */
export function vaultHasVirtualChildren(
  mount: ExternalMount,
  rel: string,
  plan: ParentPlan | null,
): boolean {
  if (!plan) return false;
  const vaultPath = rel ? `${mount.path}/${rel}` : mount.path;
  return (plan.childrenOf.get(vaultPath)?.length ?? 0) > 0;
}
