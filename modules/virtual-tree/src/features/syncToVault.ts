/**
 * 「同步到库」——把库外文件/文件夹用 mklink 链接进库内。
 *
 * 与既有「链接到库」的分工（2026-11-10 用户需求）：
 *   - 「链接到库」保持原样：固定落到 `Mounts/`，文件夹 /J、文件 /H。
 *   - 「同步到库」是独立的一套：落到**可配置**的库内文件夹（固定或每次选），
 *     文件夹 /J、同盘文件 /H、**跨盘文件降级为符号链接**，并且记住
 *     「源路径 → 库内相对路径」的映射，才能精确取消同步、不误删真笔记。
 *
 * 三类入口（挂载面板子行、挂载头行、库外标签页右键菜单）共用这里的
 * `syncState` / `syncMenuAction`，避免各自维护一份「已同步」判定。
 *
 * 纯逻辑（键归一化、目标路径、kind 选择、校验）不碰 DOM，可单测；弹窗与
 * Notice 依赖 obsidian，由 e2e 覆盖。
 */

import { Notice, type App } from 'obsidian';
import {
  createLink,
  exists,
  isSyncLinkPresent,
  joinAbs,
  linkVaultPath,
  removeSyncLink,
  safeSegment,
  SYNC_KIND_LABEL,
  syncLinkKindFor,
  type LinkKind,
} from './extFs';
import { SyncTargetModal, VaultFolderPickModal } from '../panels/syncTargetModal';
import { normalizeVaultFolder, type VirtualTreeSettings } from '../types';

/** 同步服务需要的宿主能力；VirtualTreePlugin 本身就满足，不必反向依赖。 */
export interface SyncHost {
  app: App;
  settings: VirtualTreeSettings;
  saveSettings(): Promise<void>;
  refreshMounts(): void;
  vaultBasePath(): string;
  waitForIndex(path: string, timeoutMs?: number): Promise<boolean>;
}

export interface SyncResult {
  ok: boolean;
  error?: string;
  /** 库内相对路径（`Mounts/note.md` 或 `Inbox/note.md`）。 */
  rel?: string;
  kind?: LinkKind;
}

/** Windows 路径大小写/分隔符不敏感，映射键统一成小写反斜杠。 */
export function syncKey(abs: string): string {
  return abs.replace(/\//g, '\\').replace(/[\\/]+$/, '').toLowerCase();
}

/** 库根 + 库内相对文件夹 + 链接名 → 磁盘绝对路径与库内相对路径。 */
export function syncTargetFor(
  vaultBase: string,
  folderRel: string,
  linkName: string,
): { abs: string; rel: string; name: string } {
  const name = safeSegment(linkName) || 'mount';
  const rel = folderRel ? `${folderRel}/${name}` : name;
  return { abs: joinAbs(vaultBase, rel), rel, name };
}

/**
 * 当前是否已同步：必须**同时**有记录、链接还在、且形状确实是个链接。
 *
 * 只查 `Mounts/<name>` 存在是不够的——固定目录可配置，同名路径也可能被用户
 * 换成一篇真笔记；那种情况下菜单必须回到「同步到库」而不是让人误删。
 */
export function syncState(host: SyncHost, abs: string): boolean {
  const rel = (host.settings.syncLinks ?? {})[syncKey(abs)];
  if (!rel) return false;
  const base = host.vaultBasePath();
  if (!base) return false;
  // recorded=false：宁可因 nlink 信息缺失而判成「未同步」（此时创建链接会
  // 撞名报错），也不能因为一条旧记录就把用户后来放进去的真笔记当链接删掉。
  return isSyncLinkPresent(joinAbs(base, rel), false);
}

/** 建立一次同步（不弹窗、不弹提示；调用方负责 UI）。 */
export async function performSync(
  host: SyncHost,
  sourceAbs: string,
  isDir: boolean,
  folderRel: string,
  linkName: string,
): Promise<SyncResult> {
  const base = host.vaultBasePath();
  if (!base) return { ok: false, error: '无法获取库根路径' };
  const folder = normalizeVaultFolder(folderRel);
  if (folder === null) {
    return { ok: false, error: '目标目录必须是库内相对路径（不能是绝对路径、.. 或隐藏目录）' };
  }
  if (!exists(sourceAbs)) return { ok: false, error: '源路径不存在' };
  const target = syncTargetFor(base, folder, linkName);
  if (exists(target.abs)) return { ok: false, error: `目标位置已被占用：${target.rel}` };

  const kind = syncLinkKindFor(sourceAbs, base, isDir);
  const r = createLink(sourceAbs, target.abs, { kind });
  if (!r.ok) {
    const hint =
      kind === 'symlink'
        ? '（跨盘符号链接需要 Windows 开发者模式或管理员权限；也可改为同步整个文件夹，目录联接 /J 支持跨盘）'
        : '';
    return { ok: false, error: `${r.error ?? '未知错误'}${hint}` };
  }

  // 记录是我们自己写的，取消同步时据此定位链接，也据此区分真笔记。
  const map = host.settings.syncLinks ?? (host.settings.syncLinks = {});
  map[syncKey(sourceAbs)] = target.rel;
  try {
    await host.saveSettings();
  } catch (e) {
    console.error('syncToVault: settings save failed', e);
  }
  host.refreshMounts();

  // 文件同步完直接在库里打开（与「链接到库」同款体验）；文件夹只提示，
  // openLinkText 对目录没有意义。索引还没跟上时交给 Notice 说明。
  if (!isDir && (await host.waitForIndex(target.rel))) {
    await host.app.workspace.openLinkText(target.rel, '', false);
  }
  return { ok: true, rel: target.rel, kind };
}

/** 取消同步：只删链接，删除前确认它不是库内真笔记；外部源文件不受影响。 */
export async function cancelSync(host: SyncHost, abs: string): Promise<SyncResult> {
  const base = host.vaultBasePath();
  if (!base) return { ok: false, error: '无法获取库根路径' };
  const map = host.settings.syncLinks ?? {};
  const key = syncKey(abs);
  const rel = map[key];
  if (!rel) return { ok: false, error: '没有找到同步记录' };
  const r = removeSyncLink(joinAbs(base, rel), { recorded: true });
  if (!r.ok) return { ok: false, error: r.error };
  delete map[key];
  try {
    await host.saveSettings();
  } catch (e) {
    console.error('syncToVault: settings save failed', e);
  }
  host.refreshMounts();
  return { ok: true, rel };
}

/** 右键菜单入口：已同步就取消，否则按设置决定固定目录还是每次选。 */
export function syncMenuAction(host: SyncHost, abs: string, name: string, isDir: boolean): void {
  if (syncState(host, abs)) {
    void cancelSync(host, abs).then((r) => {
      if (!r.ok) new Notice(`取消同步失败：${r.error ?? '未知错误'}`);
      else new Notice(`已取消同步（外部文件未受影响）：${r.rel}`);
    });
    return;
  }
  const mode = (host.settings.syncTargetMode ?? 'fixed') as 'fixed' | 'prompt';
  const fixed = host.settings.syncTargetFolder ?? 'Mounts';
  if (mode === 'prompt') {
    new SyncTargetModal(host.app, {
      initialFolder: fixed,
      initialName: safeSegment(name),
      isDir,
      onSubmit: (pick) => void applySync(host, abs, isDir, pick.folder, pick.name),
    }).open();
  } else {
    void applySync(host, abs, isDir, fixed, safeSegment(name));
  }
}

async function applySync(
  host: SyncHost,
  abs: string,
  isDir: boolean,
  folder: string,
  name: string,
): Promise<void> {
  const r = await performSync(host, abs, isDir, folder, name);
  if (!r.ok) {
    new Notice(`同步到库失败：${r.error ?? '未知错误'}`);
    return;
  }
  new Notice(`已同步到库：${r.rel}（${SYNC_KIND_LABEL[r.kind ?? 'hardlink']}）`);
}

// ------------------------------------------------------------------
// 取消链接（库内一侧 / 库外一侧）
// ------------------------------------------------------------------

/** 库内某个磁盘路径是不是 mklink 链接（junction / symlink / hardlink）。 */
export function isVaultLink(absPath: string): boolean {
  return isSyncLinkPresent(absPath, false);
}

/**
 * 从「库内一侧」取消链接：库内文件树（原生 file-explorer 与虚拟树）右键
 * 一个已经链接进库的文件/文件夹时用。只知道库内相对路径，不知道外部源在哪，
 * 所以按 value 反查同步记录一并清掉；绝不删库内真笔记。
 */
export async function unlinkVaultEntry(host: SyncHost, rel: string): Promise<SyncResult> {
  const base = host.vaultBasePath();
  if (!base) return { ok: false, error: '无法获取库根路径' };
  const clean = rel.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!clean) return { ok: false, error: '库根不能取消链接' };
  const abs = joinAbs(base, clean);
  if (!isVaultLink(abs)) return { ok: false, error: '这不是 mklink 链接，未删除' };
  const r = removeSyncLink(abs, { recorded: false });
  if (!r.ok) return { ok: false, error: r.error };
  const map = host.settings.syncLinks ?? {};
  for (const [k, v] of Object.entries(map)) {
    if (v === clean) delete map[k];
  }
  try {
    await host.saveSettings();
  } catch (e) {
    console.error('syncToVault: settings save failed', e);
  }
  host.refreshMounts();
  return { ok: true, rel: clean };
}

/** 旧的「链接到库」是否仍在（已同步的交给「取消同步到库」，避免重复项）。 */
export function linkedState(host: SyncHost, sourceAbs: string, name: string): boolean {
  if (syncState(host, sourceAbs)) return false;
  const base = host.vaultBasePath();
  if (!base) return false;
  return isVaultLink(joinAbs(base, linkVaultPath(safeSegment(name))));
}

/**
 * 从「库外一侧」取消链接到库内：一个源可能同时有「同步到库」记录和旧的
 * Mounts/ 链接，一次点完都清掉，避免菜单里留着看似已取消的链接。
 */
export async function unlinkBySource(host: SyncHost, sourceAbs: string, name: string): Promise<SyncResult> {
  const removed: string[] = [];
  if (syncState(host, sourceAbs)) {
    const r = await cancelSync(host, sourceAbs);
    if (!r.ok) return r;
    if (r.rel) removed.push(r.rel);
  }
  const oldRel = linkVaultPath(safeSegment(name));
  const r2 = await unlinkVaultEntry(host, oldRel);
  if (r2.ok && r2.rel && !removed.includes(r2.rel)) removed.push(r2.rel);
  // 同步记录本来就在 Mounts/<name> 时，上一步已经把它删了，这里只是扑空。
  else if (!r2.ok && removed.length === 0) return r2;
  if (removed.length === 0) return { ok: false, error: '没有找到链接' };
  return { ok: true, rel: removed.join('、') };
}

/** 设置页「固定一个文件夹」用的库内文件夹选择器。 */
export function pickVaultFolder(app: App, onPick: (folder: string, name: string) => void): void {
  new VaultFolderPickModal(app, {
    title: '选择库内文件夹',
    onPick: (p) => onPick(p.folder, p.name),
  }).open();
}
