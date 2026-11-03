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
 */
export function vaultScanLayer(
  app: App,
  mount: ExternalMount,
  rel: string,
  base: string,
  f: CompiledFilter,
): MountNode[] {
  const node = vaultNodeAt(app, mount, rel);
  if (!(node instanceof TFolder)) return [];
  const out: MountNode[] = [];
  for (const child of node.children) {
    const childRel = rel ? `${rel}/${child.name}` : child.name;
    const isDir = child instanceof TFolder;
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
