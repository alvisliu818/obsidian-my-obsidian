/**
 * 保存目标：库内文件与库外文件共用的一套抽象。
 *
 * 上游 save-history 全程只认 vault 相对路径（快照目录、perFileSettings 的键、
 * 事件处理都是）。虚拟文档树里的库外文件没有 vault 路径，于是有这一层：
 *
 *   - vault    目标带 TFile，读写走 vault API，快照落在库内快照文件夹；
 *   - external 目标带绝对路径，读写走 Node fs，快照落在插件目录（或设置指定
 *              的目录）下，以转义 + 哈希的目录名存放。
 *
 * 其余代码（版本历史 UI、自动保存、间隔快照）只面对 SaveTarget，不关心文件
 * 在库里还是库外。
 */

import { App, TFile } from "obsidian";
import {
  MOUNT_FOLDER,
  readExternalText,
  writeExternalText,
} from "../../logseq/src/features/extFs";

export type SaveTargetKind = "vault" | "external";

export interface SaveTarget {
  kind: SaveTargetKind;
  /** 稳定键：库内 = vault 路径；库外 = 规范化后的绝对路径（小写、正斜杠）。 */
  key: string;
  /** 文件名（显示用）。 */
  name: string;
  /** 库内文件。 */
  file?: TFile;
  /** 库外文件的磁盘绝对路径（保留原始大小写与分隔符）。 */
  abs?: string;
  /** 库外文件来自哪个挂载（视图头部路径第一段，显示用）。 */
  mountLabel?: string;
}

/** 库外视图的类型常量（logseq 模块注册的三个）。 */
export const EXTERNAL_VIEW_TYPES = [
  "logseq-external-block",
  "logseq-external-code",
  "logseq-external-file",
] as const;

/** 库外视图暴露给本模块的保存探针（isDirty 是合并时新增的小接口）。 */
export interface ExternalSaveHandle {
  abs: string;
  fileName: string;
  /** 实时查询：缓冲区相对磁盘是否有未落盘的改动。 */
  isDirty(): boolean;
  /** 落盘（块编辑器是 save，其余是 flush；内部自带脏判断，可反复调用）。 */
  save(): Promise<void>;
  /** 这个视图当前对应的保存目标。 */
  target(): SaveTarget;
  /** save-control 接管视图内置自动保存的节奏（存在才可调）。 */
  configureAutoSave?: (opts: { enabled: boolean; delayMs: number }) => void;
}

export function vaultTarget(file: TFile): SaveTarget {
  return { kind: "vault", key: file.path, name: file.name, file };
}

export function externalTarget(abs: string, name?: string, mountLabel?: string): SaveTarget {
  const fileName = name ?? (abs.split(/[\\/]/).pop() ?? abs);
  return {
    kind: "external",
    key: normalizeKey(abs),
    name: fileName,
    abs,
    mountLabel,
  };
}

/** 键的规范化：小写 + 正斜杠，保证大小写/分隔符不同的同一文件是同一个键。 */
export function normalizeKey(abs: string): string {
  return abs.replace(/\\/g, "/").toLowerCase();
}

/** 这个视图是不是库外文件视图（鸭子类型，避免和 logseq 模块形成硬依赖）。
 *  返回的句柄按需查询 isDirty——调用方拿到的是一扇活窗口，不是快照。 */
export function asExternalSaveHandle(view: unknown): ExternalSaveHandle | null {
  if (!view || typeof view !== "object") return null;
  const v = view as {
    getViewType?: () => string;
    abs?: unknown;
    fileName?: unknown;
    mountLabel?: unknown;
    isDirty?: unknown;
    save?: unknown;
    flush?: unknown;
  };
  const type = typeof v.getViewType === "function" ? v.getViewType() : "";
  if (!EXTERNAL_VIEW_TYPES.includes(type as (typeof EXTERNAL_VIEW_TYPES)[number])) return null;
  if (typeof v.abs !== "string" || !v.abs) return null;
  const save = typeof v.save === "function" ? (v.save as () => Promise<void>).bind(v)
    : typeof v.flush === "function" ? (v.flush as () => Promise<void>).bind(v)
      : null;
  if (!save) return null;
  const fileName = typeof v.fileName === "string" && v.fileName ? v.fileName : v.abs.split(/[\\/]/).pop() ?? v.abs;
  const mountLabel = typeof v.mountLabel === "string" ? v.mountLabel : "";
  const handle: ExternalSaveHandle = {
    abs: v.abs,
    fileName,
    isDirty: () => (typeof v.isDirty === "function" ? (v.isDirty as () => boolean).call(v) : false),
    save: async () => {
      await save();
    },
    target: () => externalTarget(v.abs as string, fileName, mountLabel),
  };
  const configure = (
    v as { configureAutoSave?: (o: { enabled: boolean; delayMs: number }) => void }
  ).configureAutoSave;
  if (typeof configure === "function") {
    handle.configureAutoSave = (opts) => configure.call(v, opts);
  }
  return handle;
}

/**
 * 当前活动标签页对应的目标。
 *
 * 库内：workspace.getActiveFile()。库外：最近活动叶子的视图是三个库外视图之一。
 *
 * 注意不能用 `app.workspace.activeLeaf`（已废弃，点击侧边栏面板时指向侧边栏
 * 或为 null —— File History 面板就在侧边栏，点它的按钮会把目标清成 null）。
 * getMostRecentLeaf 稳定返回主区最近活动的叶子：面板聚焦时目标不变。
 */
export function resolveActiveTarget(app: App, opts: { skipVaultPrefixes?: string[] } = {}): SaveTarget | null {
  const leaf = app.workspace.getMostRecentLeaf?.();
  if (leaf) {
    const handle = asExternalSaveHandle(leaf.view);
    if (handle) return handle.target();
  }
  const file = app.workspace.getActiveFile();
  if (!file) return null;
  for (const prefix of opts.skipVaultPrefixes ?? []) {
    if (prefix && file.path.startsWith(prefix + "/")) return null;
  }
  return vaultTarget(file);
}

/** 读目标当前的磁盘内容；库外走 fs，读不到返回 null。 */
export async function readTargetContent(app: App, target: SaveTarget): Promise<string | null> {
  if (target.kind === "vault" && target.file) {
    try {
      return await app.vault.read(target.file);
    } catch {
      return null;
    }
  }
  if (!target.abs) return null;
  try {
    return readExternalText(target.abs);
  } catch {
    return null;
  }
}

/** 把内容写回目标（恢复版本用）；库外走 fs。 */
export async function writeTargetContent(app: App, target: SaveTarget, content: string): Promise<void> {
  if (target.kind === "vault" && target.file) {
    await app.vault.modify(target.file, content);
    return;
  }
  if (!target.abs) throw new Error("库外目标缺少绝对路径");
  writeExternalText(target.abs, content);
}

/**
 * 快照存储键：库内直接用 vault 路径（与上游布局完全一致，老快照接着用）；
 * 库外是绝对路径，不能当文件夹名，转义成 `盘符_路径` 再补 8 位哈希——
 * 可读enough以便人工排查，又不会因为大小写或个别字符撞车。
 */
export function snapshotKeyFor(target: SaveTarget): string {
  if (target.kind === "vault") return target.key;
  const raw = target.abs ?? target.key;
  const escaped = raw
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 120);
  return `ext_${escaped}_${hash8(raw)}`;
}

/** 稳定的小哈希（FNV-1a 变体），只用于目录名去撞，不用于安全。 */
export function hash8(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 库外视图的挂载文件夹（logseq 的 MOUNT_FOLDER）： minted handle 的 path 前缀，
 *  用来识别“这是库外文件的合成 TFile”，避免版本历史把它当库内文件。 */
export const EXTERNAL_HANDLE_PATH_PREFIX = `${MOUNT_FOLDER}/`;

/** 这个 TFile 是不是 logseq 为库外文件 mint 的合成句柄。 */
export function isExternalHandle(file: { path: string } | null): boolean {
  if (!file) return false;
  return file.path.startsWith(EXTERNAL_HANDLE_PATH_PREFIX);
}
