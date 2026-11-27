/**
 * 回收站(思源虚拟文档树 trash.ts 对齐):删除文件的统一可恢复通道。
 *
 * 两种删除方式(设置「删除方式」;与思源同款,无"直接删除"选项——删除必须可恢复):
 *   plugin  移入插件回收站:物理移动到「回收站位置」下,按原路径镜像保留目录结构
 *           (库外文件镜像去掉盘符冒号的绝对路径),index.json 记录原始路径与
 *           删除时间,可在回收站管理器里一键恢复;
 *   system  移入操作系统回收站(此前 external 挂载的既有行为,electron
 *           shell.trashItem,经 extFs.trashEntry)。
 *
 * 回收站位置(设置「回收站位置」):
 *   留空 = 与 Obsidian 共用 `<库根>/.trash`(Obsidian 的本地回收站);
 *   也可配置任意绝对路径(允许库外,如 `D:\Trash\obsidian`)。
 * 插件自己的索引与镜像放在 `<位置>/.vt/` 里,和 Obsidian 的条目互不干扰;
 * Obsidian 不索引 `.trash`,所以放在里面不会被搜索/文件树/图谱看到。
 *
 * vault 挂载:留空(共用 .trash)时走 fileManager.trashFile,尊重库自己的
 * 回收站设置;配了自定义位置时,库内删除也收编到该位置,且与库外文件同一套
 * 插件命名(按原绝对路径镜像),不经过 Obsidian .trash 的扁平命名;移走后显式
 * 触发一次 Obsidian 索引同步(Obsidian 不监听文件系统)。
 * (2026-11-27 用户反馈:此前自定义位置只对库外文件生效)
 * remote 挂载删除仍提交到远端(历史可回溯)。
 */

import { baseOf, dirOf } from './extFs';

export type TrashMode = 'plugin' | 'system';

/** Node fs surface used here; structural so tests can fake it. */
export interface TrashFsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: 'utf8'): string;
  writeFileSync(p: string, data: string, enc: 'utf8'): void;
  mkdirSync(p: string, opts: { recursive: true }): void;
  readdirSync(p: string): string[];
  renameSync(from: string, to: string): void;
  rmSync(p: string, opts: { recursive: boolean; force: boolean }): void;
  /** 跨盘降级用;Node ≥16.7 才有,老内核缺失时报错让用户换 system 模式。 */
  cpSync?(from: string, to: string, opts: { recursive: boolean }): void;
  statSync(p: string): { isDirectory(): boolean; mtimeMs?: number };
}

type Requirer = (id: string) => unknown;

const hooks: { fs?: TrashFsLike; require?: Requirer } = {};

/** Injection point for tests. */
export function __setTrashFsForTest(fs: TrashFsLike | null): void {
  hooks.fs = fs ?? undefined;
}

function nodeRequire(id: string): unknown {
  if (hooks.require) return hooks.require(id);
  const r = (globalThis as { require?: Requirer }).require;
  if (typeof r === 'function') return r(id);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return eval('require')(id);
}

function fsMod(): TrashFsLike {
  if (hooks.fs) return hooks.fs;
  return nodeRequire('fs') as TrashFsLike;
}

const INDEX_FILE = 'index.json';
/** index 上限:只保留最近 500 条(回收站内孤儿文件由「清空」处理)。 */
const MAX_ENTRIES = 500;

function trimTrailing(p: string): string {
  return p.replace(/[\\/]+$/, '');
}

/** 统一正斜杠：库根可能来自 Windows 反斜杠路径，回收站内部一律用 '/' 拼接。 */
function toSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Obsidian 自己的本地回收站根。 */
export function obsidianTrashRoot(vaultBase: string): string {
  return trimTrailing(toSlashes(vaultBase)) + '/.trash';
}

/** 设置里的「回收站位置」→ 实际根目录。留空 = Obsidian 的 .trash。 */
export function resolveTrashRoot(vaultBase: string, configured?: string): string {
  const raw = (configured ?? '').trim();
  if (!raw) return obsidianTrashRoot(vaultBase);
  const absolute = /^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('/');
  return trimTrailing(toSlashes(absolute ? raw : trimTrailing(toSlashes(vaultBase)) + '/' + raw));
}

/** 当前回收站是否就是 Obsidian 的 `.trash`(此时管理器同时列出库内删除条目)。 */
export function isObsidianTrashRoot(vaultBase: string, configured?: string): boolean {
  return (
    resolveTrashRoot(vaultBase, configured).replace(/\\/g, '/').toLowerCase() ===
    obsidianTrashRoot(vaultBase).replace(/\\/g, '/').toLowerCase()
  );
}

/** 插件自己的元数据目录(索引 + 库外文件镜像),藏在回收站根下。 */
export function pluginTrashRoot(vaultBase: string, configured?: string): string {
  return resolveTrashRoot(vaultBase, configured) + '/.vt';
}

interface TrashEntry {
  id: string;
  /** 原绝对路径(库外条目),恢复时移回。 */
  origin: string;
  /** 回收站内的完整路径。 */
  trashPath: string;
  isDir: boolean;
  time: number;
}

interface TrashIndex {
  version: number;
  entries: TrashEntry[];
}

let indexCache: TrashIndex | null = null;
let indexCacheRoot = '';

function loadIndex(root: string): TrashIndex {
  if (indexCache && indexCacheRoot === root) return indexCache;
  try {
    const parsed = JSON.parse(fsMod().readFileSync(root + '/' + INDEX_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.entries)) {
      indexCache = { version: 1, entries: parsed.entries };
      indexCacheRoot = root;
      return indexCache;
    }
  } catch {
    // 文件不存在/损坏:从空开始
  }
  indexCache = { version: 1, entries: [] };
  indexCacheRoot = root;
  return indexCache;
}

function saveIndex(root: string): void {
  const f = fsMod();
  f.mkdirSync(root, { recursive: true });
  f.writeFileSync(root + '/' + INDEX_FILE, JSON.stringify(indexCache, null, 2), 'utf8');
}

/**
 * 原路径 → 回收站内的镜像路径:
 *   E:\HOME\X\a.md → <trash>/.vt/external/E/HOME/X/a.md(绝对路径镜像,冒号丢弃)
 * 统一正斜杠便于跨盘符大小写差异时保持结构稳定。
 */
function mirrorPath(origin: string, root: string): string {
  const flat = origin.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1').replace(/^\/+/, '');
  return root + '/external/' + flat;
}

/** 移动文件/目录:同盘 rename 瞬时;跨盘 EXDEV 降级 cp+rm。 */
function moveRecursive(from: string, to: string): void {
  const f = fsMod();
  try {
    f.renameSync(from, to);
    return;
  } catch (e) {
    // EXDEV 之外的重命名失败(目标已存在等)不降级,原样上抛
    const code = (e as { code?: string })?.code;
    if (code !== 'EXDEV') throw e;
  }
  if (!f.cpSync) throw new Error('跨盘移动失败:当前 Node 内核不支持 cpSync,可改用系统回收站模式');
  f.cpSync(from, to, { recursive: true });
  f.rmSync(from, { recursive: true, force: true });
}

function isDirOnDisk(sysPath: string): boolean {
  try {
    return fsMod().statSync(sysPath).isDirectory();
  } catch {
    return false;
  }
}

/** 同名冲突:追加时间后缀,保证"路径尽量不变"且不覆盖已有回收站内容。 */
function resolveCollision(target: string): string {
  if (!fsMod().existsSync(target)) return target;
  return target + ' (回收站 ' + new Date().toISOString().slice(11, 19).replace(/:/g, '') + ')';
}

function restoreStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export interface DeleteResult {
  mode: TrashMode;
  note?: string;
}

/**
 * 统一删除入口(external 挂载):按当前模式把文件移入回收站。
 * 环境不支持回收站时抛错中止——文件保持原样,绝不静默永久删除。
 * 永久删除的兜底(两种模式都失败时的二次确认直删)由调用方的 ConfirmModal 承担,
 * 与既有 deletePermanent 链路一致。
 */
export async function deleteToTrash(
  abs: string,
  isDir: boolean,
  opts: { mode: TrashMode; vaultBase: string; trashPath?: string },
): Promise<DeleteResult> {
  const f = fsMod();
  if (opts.mode === 'plugin') {
    if (!f.existsSync(abs)) throw new Error(`文件不存在: ${abs}`);
    const root = pluginTrashRoot(opts.vaultBase, opts.trashPath);
    const target = resolveCollision(mirrorPath(abs, root));
    f.mkdirSync(dirOf(target), { recursive: true });
    moveRecursive(abs, target);
    const idx = loadIndex(root);
    idx.entries.unshift({
      id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      origin: abs,
      trashPath: target,
      isDir: isDir || isDirOnDisk(target),
      time: Date.now(),
    });
    if (idx.entries.length > MAX_ENTRIES) idx.entries.length = MAX_ENTRIES;
    saveIndex(root);
    return { mode: 'plugin', note: '已移入回收站(可在「回收站」中恢复)' };
  }
  // system 模式:electron shell.trashItem(extFs.trashEntry;Windows 走系统回收站)
  const { trashEntry } = await import('./extFs');
  const r = await trashEntry(abs);
  if (!r.ok) throw new Error(r.error ?? '移入系统回收站失败');
  return { mode: 'system', note: '已移入系统回收站' };
}

// ===== 库内挂载:自定义位置收编 =====

/** 绝对路径若在库内,返回库内相对路径(恢复后让 Obsidian 重新索引用);库外返回 ''。 */
export function vaultRelOf(vaultBase: string, abs: string): string {
  const base = trimTrailing(toSlashes(vaultBase)).toLowerCase();
  const p = toSlashes(abs);
  if (!base) return '';
  const prefix = base + '/';
  return p.toLowerCase().startsWith(prefix) ? p.slice(prefix.length) : '';
}

/**
 * 库内挂载 + 自定义回收站位置:和库外文件走同一套插件命名——按原绝对路径
 * 镜像到 `<位置>/.vt/external/…`,index.json 记原路径,不经过 Obsidian .trash
 * 的扁平命名(2026-11-27 用户要求)。
 *
 * Obsidian 不监听文件系统,移走文件不会自己从库索引/反链里消失,所以移完
 * 由调用方触发一次索引同步(reconcileRemoved);同步失败不回滚回收站条目,
 * 文件已在回收站里,重载后会自行校正。
 */
export async function deleteVaultEntryToCustomTrash(opts: {
  vaultBase: string;
  /** Obsidian 库内相对路径。 */
  vaultRel: string;
  isDir: boolean;
  trashPath: string;
  /** 文件移走后的库索引同步(app.vault.adapter.update)。 */
  reconcileRemoved: (vaultRel: string) => Promise<void>;
}): Promise<DeleteResult> {
  const f = fsMod();
  const vaultAbs =
    trimTrailing(toSlashes(opts.vaultBase)) + '/' + toSlashes(opts.vaultRel).replace(/^\/+/, '');
  if (!f.existsSync(vaultAbs)) throw new Error(`文件不存在: ${vaultAbs}`);
  const root = pluginTrashRoot(opts.vaultBase, opts.trashPath);
  const target = resolveCollision(mirrorPath(vaultAbs, root));
  f.mkdirSync(dirOf(target), { recursive: true });
  moveRecursive(vaultAbs, target);
  const idx = loadIndex(root);
  idx.entries.unshift({
    id: 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    origin: vaultAbs,
    trashPath: target,
    isDir: opts.isDir || isDirOnDisk(target),
    time: Date.now(),
  });
  if (idx.entries.length > MAX_ENTRIES) idx.entries.length = MAX_ENTRIES;
  saveIndex(root);
  try {
    await opts.reconcileRemoved(opts.vaultRel);
  } catch {
    /* 索引稍后由重载校正;回收站条目保持 */
  }
  return { mode: 'plugin', note: '已移入回收站(可在「回收站」中恢复)' };
}

// ===== 回收站管理(对话框用) =====

export interface TrashListItem {
  id: string;
  origin: string;
  isDir: boolean;
  time: number;
}

/** 列出仍在磁盘上的插件回收站条目(index 里记录但文件已被手动清理的跳过)。 */
export function listTrashItems(vaultBase: string, configured?: string): TrashListItem[] {
  const idx = loadIndex(pluginTrashRoot(vaultBase, configured));
  const f = fsMod();
  const out: TrashListItem[] = [];
  for (const e of idx.entries) {
    try {
      if (!f.existsSync(e.trashPath)) continue;
    } catch {
      continue;
    }
    out.push({ id: e.id, origin: e.origin, isDir: e.isDir, time: e.time });
  }
  return out;
}

/** 恢复:移回原位;原位已存在同名时不覆盖,恢复为「xxx (恢复 yyyy-MM-dd HHmmss)」。 */
export function restoreFromTrash(
  vaultBase: string,
  id: string,
  configured?: string,
): { origin: string; restoredAs: string } {
  const root = pluginTrashRoot(vaultBase, configured);
  const idx = loadIndex(root);
  const i = idx.entries.findIndex((e) => e.id === id);
  if (i < 0) throw new Error('记录不存在或已被恢复');
  const e = idx.entries[i];
  const f = fsMod();
  if (!f.existsSync(e.trashPath)) throw new Error('回收站内的文件已不存在(可能被手动清理)');
  let dest = e.origin;
  if (f.existsSync(dest)) {
    const sep = dest.includes('\\') ? '\\' : '/';
    const dir = dirOf(dest);
    dest = dir + sep + baseOf(dest) + ' (恢复 ' + restoreStamp() + ')';
  }
  f.mkdirSync(dirOf(dest), { recursive: true });
  moveRecursive(e.trashPath, dest);
  idx.entries.splice(i, 1);
  saveIndex(root);
  return { origin: e.origin, restoredAs: dest };
}

/** 彻底删除单条(真正从磁盘删除回收站内的副本)。 */
export function purgeTrashItem(vaultBase: string, id: string, configured?: string): void {
  const root = pluginTrashRoot(vaultBase, configured);
  const idx = loadIndex(root);
  const i = idx.entries.findIndex((e) => e.id === id);
  if (i < 0) return;
  try {
    fsMod().rmSync(idx.entries[i].trashPath, { recursive: true, force: true });
  } finally {
    idx.entries.splice(i, 1);
    saveIndex(root);
  }
}

/**
 * 清空回收站:插件条目全部彻底删除;当前根是 Obsidian 的 `.trash` 时,
 * 库内删除的条目也一并清掉(只动 .trash 的内容,不碰自定义目录里的其他文件)。
 */
export function emptyTrash(vaultBase: string, configured?: string): void {
  const f = fsMod();
  const root = pluginTrashRoot(vaultBase, configured);
  const idx = loadIndex(root);
  for (const e of idx.entries) {
    try {
      f.rmSync(e.trashPath, { recursive: true, force: true });
    } catch {
      /* 已不存在就算了 */
    }
  }
  if (isObsidianTrashRoot(vaultBase, configured)) {
    const shared = obsidianTrashRoot(vaultBase);
    try {
      for (const name of f.readdirSync(shared)) {
        if (name === '.vt') continue;
        f.rmSync(shared + '/' + name, { recursive: true, force: true });
      }
    } catch {
      /* .trash 不存在/读不了:无事可清 */
    }
  }
  f.rmSync(root, { recursive: true, force: true });
  indexCache = { version: 1, entries: [] };
  indexCacheRoot = root;
  saveIndex(root);
}

// ===== Obsidian 库内回收站(.trash)条目 =====

export interface ObsidianTrashItem {
  /** `.trash` 内的相对路径;恢复目标 = `<库根>/<rel>`。 */
  rel: string;
  isDir: boolean;
  time: number;
}

/**
 * 列出 Obsidian `.trash` 里由 Obsidian 管理的条目(仅当回收站根就是 .trash)。
 *
 * Obsidian 的本地回收站按库内相对路径镜像存放,所以 `<库根>/<rel>` 就是恢复
 * 目标。目录的两种来源无法直接区分(整目录删除 vs 目录内某文件删除),用
 * 「库里同名目录是否仍存在」判断:存在说明这是更深删除留下的外层容器,继续
 * 下钻;不存在则是整个目录被删,作为一个目录条目列出。
 */
export function listObsidianTrashItems(vaultBase: string, configured?: string): ObsidianTrashItem[] {
  if (!isObsidianTrashRoot(vaultBase, configured)) return [];
  const f = fsMod();
  const root = obsidianTrashRoot(vaultBase);
  if (!f.existsSync(root)) return [];
  const out: ObsidianTrashItem[] = [];
  const walk = (dirRel: string): void => {
    const dir = dirRel ? root + '/' + dirRel : root;
    let names: string[];
    try {
      names = f.readdirSync(dir) as string[];
    } catch {
      return;
    }
    for (const name of names) {
      if (!dirRel && name === '.vt') continue;
      const rel = dirRel ? dirRel + '/' + name : name;
      const full = root + '/' + rel;
      let st: { isDirectory(): boolean; mtimeMs?: number };
      try {
        st = f.statSync(full) as { isDirectory(): boolean; mtimeMs?: number };
      } catch {
        continue;
      }
      const live = trimTrailing(toSlashes(vaultBase)) + '/' + rel;
      if (st.isDirectory() && isDirOnDisk(live)) {
        walk(rel);
        continue;
      }
      out.push({ rel, isDir: st.isDirectory(), time: st.mtimeMs ?? 0 });
    }
  };
  walk('');
  out.sort((a, b) => b.time - a.time);
  return out;
}

/** 恢复一条 Obsidian 回收站条目:`.trash/<rel>` → `<库根>/<rel>`,冲突加后缀。 */
export function restoreObsidianTrashItem(vaultBase: string, rel: string): { restoredAs: string } {
  const f = fsMod();
  const root = obsidianTrashRoot(vaultBase);
  const src = root + '/' + rel;
  if (!f.existsSync(src)) throw new Error('回收站内的条目已不存在(可能被手动清理)');
  let dest = trimTrailing(toSlashes(vaultBase)) + '/' + rel;
  if (f.existsSync(dest)) {
    const sep = dest.includes('\\') ? '\\' : '/';
    dest = dirOf(dest) + sep + baseOf(dest) + ' (恢复 ' + restoreStamp() + ')';
  }
  f.mkdirSync(dirOf(dest), { recursive: true });
  moveRecursive(src, dest);
  pruneEmptyParents(root, rel);
  return { restoredAs: dest };
}

/** 彻底删除一条 Obsidian 回收站条目。 */
export function purgeObsidianTrashItem(vaultBase: string, rel: string): void {
  const f = fsMod();
  const root = obsidianTrashRoot(vaultBase);
  f.rmSync(root + '/' + rel, { recursive: true, force: true });
  pruneEmptyParents(root, rel);
}

/** 移走条目后清掉 .trash 里因此变空的外层容器目录(不动 .trash 根)。 */
function pruneEmptyParents(root: string, rel: string): void {
  const f = fsMod();
  let dirRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  while (dirRel) {
    const full = root + '/' + dirRel;
    try {
      if ((f.readdirSync(full) as string[]).length > 0) return;
      f.rmSync(full, { recursive: true, force: true });
    } catch {
      return;
    }
    dirRel = dirRel.includes('/') ? dirRel.slice(0, dirRel.lastIndexOf('/')) : '';
  }
}

/** 供显示用:条目名(原路径的最后一段)。 */
export function trashItemName(origin: string): string {
  return baseOf(origin);
}

/** 纯函数:格式化删除时间(列表展示)。 */
export function trashTimeText(time: number): string {
  const d = new Date(time);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
