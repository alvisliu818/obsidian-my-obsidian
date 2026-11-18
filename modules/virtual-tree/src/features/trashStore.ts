/**
 * 插件回收站(思源虚拟文档树 trash.ts 对齐):删除文件的统一可恢复通道。
 *
 * 两种模式(设置「删除方式」;与思源同款,无"直接删除"选项——删除必须可恢复):
 *   plugin  移入插件回收站:物理移动到 `<库根>/.vt-trash/` 下,按原路径镜像保留
 *           目录结构(库外文件镜像去掉盘符冒号的绝对路径),index.json 记录原始
 *           路径与删除时间,可在回收站管理器里一键恢复;
 *   system  移入操作系统回收站(此前 external 挂载的既有行为,electron
 *           shell.trashItem,经 extFs.trashEntry)。
 *
 * 回收站根放库根下、以点前缀命名(`.vt-trash`):Obsidian 不索引点文件(搜索/
 * 文件树/图谱全部不可见),又不依赖库外某个可能不存在的目录。
 *
 * 与思源版差异:思源有桌面/移动双后端;Obsidian 桌面 only,一律走 Node fs。
 * vault 挂载不进这里——fileManager.trashFile 尊重库的回收站设置,Obsidian
 * 自己的 .trash 就是它的管理器;remote 挂载删除仍提交到远端(历史可回溯)。
 */

import { baseOf, dirOf } from './extFs';

export type TrashMode = 'plugin' | 'system';

/** Node fs surface used here; structural so tests can fake it. */
export interface TrashFsLike {
  existsSync(p: string): boolean;
  readFileSync(p: string, enc: 'utf8'): string;
  writeFileSync(p: string, data: string, enc: 'utf8'): void;
  mkdirSync(p: string, opts: { recursive: true }): void;
  renameSync(from: string, to: string): void;
  rmSync(p: string, opts: { recursive: boolean; force: boolean }): void;
  /** 跨盘降级用;Node ≥16.7 才有,老内核缺失时报错让用户换 system 模式。 */
  cpSync?(from: string, to: string, opts: { recursive: boolean }): void;
  statSync(p: string): { isDirectory(): boolean };
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

/** 插件回收站物理根。 */
export function pluginTrashRoot(vaultBase: string): string {
  return vaultBase.replace(/[\\/]+$/, '') + '/.vt-trash';
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
 *   E:\HOME\X\a.md → <trash>/external/E/HOME/X/a.md(绝对路径镜像,冒号丢弃)
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
  opts: { mode: TrashMode; vaultBase: string },
): Promise<DeleteResult> {
  const f = fsMod();
  if (opts.mode === 'plugin') {
    if (!f.existsSync(abs)) throw new Error(`文件不存在: ${abs}`);
    const root = pluginTrashRoot(opts.vaultBase);
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
    return { mode: 'plugin', note: '已移入插件回收站(可在回收站中恢复)' };
  }
  // system 模式:electron shell.trashItem(extFs.trashEntry;Windows 走系统回收站)
  const { trashEntry } = await import('./extFs');
  const r = await trashEntry(abs);
  if (!r.ok) throw new Error(r.error ?? '移入系统回收站失败');
  return { mode: 'system', note: '已移入系统回收站' };
}

// ===== 回收站管理(对话框用) =====

export interface TrashListItem {
  id: string;
  origin: string;
  isDir: boolean;
  time: number;
}

/** 列出仍在磁盘上的回收站条目(index 里记录但文件已被手动清理的跳过)。 */
export function listTrashItems(vaultBase: string): TrashListItem[] {
  const idx = loadIndex(pluginTrashRoot(vaultBase));
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
export function restoreFromTrash(vaultBase: string, id: string): { origin: string; restoredAs: string } {
  const root = pluginTrashRoot(vaultBase);
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
export function purgeTrashItem(vaultBase: string, id: string): void {
  const root = pluginTrashRoot(vaultBase);
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

/** 清空插件回收站:删除整个回收站目录内容并重置 index。 */
export function emptyPluginTrash(vaultBase: string): void {
  const root = pluginTrashRoot(vaultBase);
  const f = fsMod();
  if (f.existsSync(root)) {
    f.rmSync(root, { recursive: true, force: true });
  }
  indexCache = { version: 1, entries: [] };
  indexCacheRoot = root;
  saveIndex(root);
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
