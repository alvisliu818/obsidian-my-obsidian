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

import { Platform, TFile, TFolder, type App, type TAbstractFile } from 'obsidian';
import { isVaultMount, vaultRelPath, type ExternalMount } from '../types';
import type { CompiledFilter, MountNode } from './mountFilter';
import { dirPruned, entryMatches } from './mountFilter';
import { fsMod, joinAbs, type DirentLike } from './extFs';

// ---------------------------------------------------------------------------
// 库内挂载路径归一。挂载根 `path` 是库内相对路径；内置的库根挂载（mountPanel
// render 里的 __vault_root__）path 为 ''（= 库根），所有 `${mount.path}/${rel}`
// 形式的手拼在这里统一收口——空基名直接返回 rel 本身，绝不产出 `/notes` 这种
// 带首斜杠的路径（getAbstractFileByPath 不认）。
// ---------------------------------------------------------------------------

/** 虚拟子行 rel 的库内绝对路径前缀。文件型挂载根（如把单篇笔记 `!.md`
 *  挂成根）下，子文档在库内别处、并非根节点的后代，无法用相对根的路径
 *  表达；这类子行 rel 以 `/` 开头，去掉前缀即为库内相对路径。 */
const VAULT_ABS_REL = '/';

/** 库内挂载内 `rel` 对应的 vault 相对路径（挂载根为库根时 rel 原样返回）。
 *  以 `/` 开头的 rel 是文件型挂载根下的虚拟子行，直接剥掉前缀返回库内路径
 *  （否则会误拼成 `!.md/notes/x.md`）。 */
export function vaultJoinPath(mount: ExternalMount, rel: string): string {
  if (rel.startsWith(VAULT_ABS_REL)) return rel.slice(VAULT_ABS_REL.length);
  const base = vaultRelPath(mount.path);
  return base && rel ? `${base}/${rel}` : base || rel;
}

// ---------------------------------------------------------------------------
// parent 属性挂载（2026-11-03 用户需求）：笔记 frontmatter 写 `parent:` 时，
// 树里把笔记挂到那篇笔记名下作为**子文档**显示——文件的真实位置不动，纯
// 树形展示（与 attachTo 嵌套挂载同一哲学：文档归库管，位置归树管）。
//
// 计划（ParentPlan）按挂载根缓存：floating = 带 parent 属性、要额外挂到父
// 笔记名下的笔记；childrenOf = 父笔记 → 虚拟子笔记。2026-11-23 用户要求
// 「parent 自动挂载要有，原位置也要保留」——floating 笔记不再从真实目录
// 摘出，而是两处都显示（真实目录原位 + 父笔记名下虚拟子行）。
// 环（A.parent=B 且 B.parent=A）里的笔记不生成虚拟挂载——挂环上谁都渲染
// 不出来；它们仍原位显示（本来就保留）。指向环外某笔记的笔记照常挂：
// 它的展示终点是一棵原位渲染的笔记，链路每个中间层都挂，树里逐层嵌套。
// ---------------------------------------------------------------------------

/** 一次 parent 挂载计划：floating 两处显示，childrenOf 挂入。 */
export interface ParentPlan {
  /** 带 parent 属性、额外挂到父笔记名下的笔记（vault 绝对路径，库内 path 域）。
   *  它们在真实目录里照常保留——floating 只表示"多一处展示"，不再摘出。 */
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
  // Obsidian 属性 UI 的 link 属性可能存成数组（多值）——取第一项
  if (Array.isArray(raw)) raw = raw[0];
  if (typeof raw !== 'string') return '';
  let v = raw.trim();
  if (!v) return '';
  // 先剥首尾引号：手写 YAML 的 link 值可能带引号（`- "[[!]]"`），某些解析路径
  // 会把引号连同 wiki 语法一起吐出来。剥引号后再匹配 [[..]]，否则 `"[[!]]"`
  // 会跳过 wiki 分支、留下未解析的 `[[!]]`，getFirstLinkpathDest 找不到目标。
  v = v.replace(/^["']|["']$/g, '').trim();
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

  // 根挂载（mountPath='' 或 '/'）= 整库都是挂载域。
  const root = vaultRelPath(mountPath);
  const underRoot = (p: string): boolean => !root || p === root || p.startsWith(`${root}/`);
  // 文件型挂载根（如把单篇笔记 `!.md` 挂成根）：整库都是它的潜在展示域——
  // 子文档（parent 值指向根笔记的）来自库内任何位置，父目标也可能是库内别处
  // 的中间笔记（链式：A.parent=根笔记，B.parent=A）。两者都不能用 `root/`
  // 前缀过滤，否则 B→A 这条边被丢、链断在第二层（2026-11-23 用户实报：
  // 掌柜智库.parent=大模型、大模型.parent=!，掌柜智库挂不到大模型下）。
  // 为了防止无关 parent 关系串入，链路分析里额外要求链必须走到根笔记。
  const rootIsFile = !!root && app.vault.getAbstractFileByPath(root) instanceof TFile;

  // 逐笔记读 frontmatter.parent，解析成 child → parent 的原始映射
  const raw = new Map<string, string>();
  for (const f of app.vault.getMarkdownFiles()) {
    if (!rootIsFile && !underRoot(f.path)) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    const target = cleanParentValue(fm?.['parent']);
    if (!target || target === f.path) continue;
    if (/^(?:https?|file|app|obsidian):/i.test(target)) continue;
    const dest = app.metadataCache.getFirstLinkpathDest(target, f.path);
    if (!(dest instanceof TFile) || dest.path === f.path) continue;
    if (!rootIsFile && !underRoot(dest.path)) continue;
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
      // 文件型挂载根：链必须走到根笔记才算有效展示链；只走到某个与根无关的
      // 锚（库里别处的 parent 关系）不算——否则这些无关笔记会被算进计划。
      if (rootIsFile && cur === root) {
        ok = true;
        anchored.add(cur);
        break;
      }
      const next = raw.get(cur);
      if (!next) {
        // 文件夹根：链尾是锚（无 parent 的笔记，原位渲染）
        if (!rootIsFile) {
          ok = true;
          anchored.add(cur);
        }
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

/** 挂载内 `rel`（相对挂载根）对应的库内 TAbstractFile；不存在返回 null。
 * 挂载根为库根（path 归一后为 ''）且 rel 为空时返回库根 TFolder。 */
export function vaultNodeAt(app: App, mount: ExternalMount, rel = ''): TAbstractFile | null {
  const vaultPath = vaultJoinPath(mount, rel);
  if (!vaultPath || vaultPath === '/') return app.vault.getRoot();
  return app.vault.getAbstractFileByPath(vaultPath) ?? null;
}

/** 挂载根的解析结果：单个文件 / 文件夹 / 不存在。 */
export type VaultRoot =
  | { kind: 'file'; file: TFile }
  | { kind: 'folder'; folder: TFolder }
  | { kind: 'missing' };

export function vaultRootOf(app: App, mount: ExternalMount): VaultRoot {
  if (!isVaultMount(mount)) return { kind: 'missing' };
  const node = vaultNodeAt(app, mount);
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
 * `plan`（parent 属性挂载计划，开关关闭时传 null）：`rel` 指向一篇 md 笔记
 * 时返回挂到它名下的虚拟子笔记——文件节点由此变成可展开容器（与嵌套挂载
 * 同一套面板机制）。带 parent 的笔记**原位照常保留**（2026-11-23 用户要求
 * 两处都显示），不再从真实目录层摘出。
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
    const mountBase = vaultRelPath(mount.path);
    // 文件型挂载根：子文档不在根路径之下，rel 用 `/` 前缀编码库内绝对路径
    // （vaultJoinPath 会剥前缀还原），否则 slice 会把 notes/x.md 截坏、打开
    // 又误拼成 `!.md/notes/x.md`。文件夹挂载根保持原有相对 rel 语义。
    const fileRoot = !!mountBase && app.vault.getAbstractFileByPath(mountBase) instanceof TFile;
    for (const childPath of plan.childrenOf.get(node.path) ?? []) {
      const child = app.vault.getAbstractFileByPath(childPath);
      if (!(child instanceof TFile)) continue;
      const childRel = fileRoot
        ? `${VAULT_ABS_REL}${child.path}`
        : mountBase ? child.path.slice(mountBase.length + 1) : child.path;
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
    // 带 parent 的笔记原位保留（2026-11-23 用户：parent 挂载+原位两处都要），
    // 不再从真实目录摘出——摘出会让用户误以为文件「消失」。父笔记名下的
    // 虚拟子行是额外一处展示，两者 rel 相同、指向同一真实文件。
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
 * 磁盘 readdir 一层，回填 vault 索引缺失项（**不过滤**，rel = 库内绝对路径）。
 *
 * Obsidian 的文件索引会剔除路径中任一以 `.` 开头的段（`.obsidian`、`.git`、
 * `.trash` …），`TFolder.children` 因此完全看不到它们。2026-11-27 用户实报
 * 「虚拟文档树里 Obsidian/ObsidianNotes 的内容打不开」：`ObsidianNotes` 下
 * 只有一个 `.obsidian`，索引里就是 0 个子项，树里必然展开为空。
 *
 * 同步是硬要求：异步回来时 MountState 可能已被库结构事件换掉，补层会丢
 * （2026-11-27 实测踩过）。移动端没有 Node fs，返回空——隐藏项按桌面能力提供。
 */
export function vaultMissingChildren(app: App, folderRel: string): MountNode[] {
  if (!Platform.isDesktopApp) return [];
  const base = vaultAbsOf(app, '');
  const dirAbs = folderRel ? joinAbs(base, folderRel) : base;
  let items: DirentLike[];
  try {
    items = fsMod().readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: MountNode[] = [];
  for (const item of items) {
    const name = item.name;
    if (!name) continue;
    const full = folderRel ? `${folderRel}/${name}` : name;
    // 索引里已有 → 交给 vault 索引那条路，避免同一项出现两次
    if (app.vault.getAbstractFileByPath(full)) continue;
    const abs = joinAbs(base, full);
    let isDir = item.isDirectory();
    if (!isDir && item.isSymbolicLink()) {
      // 指向目录的软链按目录处理（Windows junction 常见）
      try {
        isDir = fsMod().statSync(abs).isDirectory?.() === true;
      } catch {
        /* 断链：按文件处理 */
      }
    }
    const node: MountNode = { name, rel: full, abs, isDir, children: [] };
    if (!isDir) {
      try {
        const st = fsMod().statSync(abs);
        node.size = st.size;
        node.mtime = st.mtimeMs;
      } catch {
        /* 读不到 stat 就空着 */
      }
    }
    out.push(node);
  }
  return out;
}

/**
 * 库内挂载：把「磁盘上有、vault 索引里没有」的隐藏项转成挂载内 rel 的一层。
 *
 * 只回填索引缺失项——索引里有的条目仍走 vault API（打开/重命名/删除语义
 * 不变），回填项只承诺「看得见 + 能打开」（打开由面板交给库外文件路由）。
 */
export function vaultScanHiddenLayer(
  app: App,
  mount: ExternalMount,
  rel: string,
  f: CompiledFilter,
): MountNode[] {
  const dirVault = vaultJoinPath(mount, rel);
  const out: MountNode[] = [];
  for (const node of vaultMissingChildren(app, dirVault)) {
    const childRel = rel ? `${rel}/${node.name}` : node.name;
    if (node.isDir ? dirPruned(childRel, f) : !entryMatches(childRel, f)) continue;
    out.push({ ...node, rel: childRel });
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
  const vaultPath = vaultJoinPath(mount, rel);
  return (plan.childrenOf.get(vaultPath)?.length ?? 0) > 0;
}
