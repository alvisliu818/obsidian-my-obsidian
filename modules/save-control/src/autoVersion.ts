/**
 * 写盘自动存版本：任意文本文件**落盘**时自动给它记一个版本副本。
 *
 * 与 autosave（定时/关标签页）互补 —— 那个按时间取样，这个按「写」取样，
 * 于是每次保存（含 Ctrl+S、自动保存、切走落盘、插件写回）都会留一份可恢复
 * 的副本，而不需要人去点「保存版本」。
 *
 * 触发点用 `vault.on("modify")`：Obsidian 自己所有的写盘路径最终都会发这个
 * 事件（编辑器保存、vault.modify、外部改动同步进库）。它是在写盘**之后**发
 * 的，所以记下的是本次写盘后的内容 —— 历史序列里前一条就是写盘前的状态，
 * 「回到编辑前」恢复前一条即可。
 *
 * 边界：
 *   - 只处理允许的扩展名（默认 md，与版本历史同一份 allowedExtensions）。
 *   - 跳过本模块自己的产物（快照目录 / 导出目录 / 预览临时目录）与 .obsidian
 *     配置：**快照写盘本身也可能触发 modify**，不挡住就是无限递归。
 *   - 超过阈值的大文件直接跳过（默认 2MB，快照是全文副本，别把库撑爆）。
 *   - 同一文件的快照串行化：连写时按序执行，不并发写同一个目录。
 */

import { TAbstractFile, TFile } from "obsidian";
import type { SaveControlPlugin } from "./main";
import {
  deleteOldestSnapshotsByName,
  getExportFolderPath,
  getSnapshotRoot,
} from "./storage";
import { VIEW_TYPE_SAVE_HISTORY, SaveHistoryView } from "./ui";

/** 写盘版本的快照名（侧栏里显示的版本标签）。 */
export const ON_WRITE_SNAPSHOT_NAME = "写盘";

/** 单文件超过这个体积就不做副本（字节）。 */
const MAX_AUTO_VERSION_BYTES = 2 * 1024 * 1024;

const MIN_KEEP = 1;
const MAX_KEEP = 50;

export class AutoVersionManager {
  private plugin: SaveControlPlugin;
  private enabled = false;
  private registered = false;
  /** 每个文件一条串行链（path → 进行中的 promise）。 */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(plugin: SaveControlPlugin) {
    this.plugin = plugin;
  }

  /** 注册 modify 监听（只注册一次）；随后由开关决定是否真的记版本。 */
  start(): void {
    this.enabled = true;
    if (this.registered) return; // 事件只挂一次：开关来回切不能重复注册
    this.registered = true;
    this.plugin.registerEvent(
      this.plugin.app.vault.on("modify", (file: TAbstractFile) => {
        void this.enqueue(file);
      }),
    );
  }

  stop(): void {
    this.enabled = false;
  }

  /** 连写不并发：同一文件排队，跨文件互不影响。 */
  private enqueue(file: TAbstractFile): void {
    if (!this.enabled || !this.plugin.settings.versionOnWriteEnabled) return;
    if (!(file instanceof TFile)) return;
    if (!this.plugin.isExtensionAllowed(file.extension)) return;
    if (this.isOwnArtifact(file.path)) return;

    const key = file.path;
    const prev = this.queues.get(key) ?? Promise.resolve();
    const cur = prev
      .then(() => this.saveVersion(file))
      .catch(() => undefined);
    this.queues.set(key, cur);
    void cur.then(() => {
      if (this.queues.get(key) === cur) this.queues.delete(key);
    });
  }

  private async saveVersion(file: TFile): Promise<void> {
    // 已经卸载 / 开关被关掉：排队期间状态可能变了，落地前再确认一次。
    if (!this.enabled || !this.plugin.settings.versionOnWriteEnabled) return;
    // stat 在运行时有（TFile 的公开字段），模块自带的 obsidian 类型桩没声明。
    const size = (file as TFile & { stat?: { size?: number } }).stat?.size ?? 0;
    if (size > MAX_AUTO_VERSION_BYTES) return;

    // 复用 versioning 的写路径：读内容 → 与最新快照比对（同内容不记）→ 落盘。
    const result = await this.plugin.versioning.saveNowForFile(file, ON_WRITE_SNAPSHOT_NAME);
    if (result !== "saved") return;

    await deleteOldestSnapshotsByName(
      this.plugin,
      file.path,
      clampKeep(this.plugin.settings.maxOnWriteVersions),
      ON_WRITE_SNAPSHOT_NAME,
    );
    this.refreshSidebar();
  }

  /**
   * 本模块自己的产物路径（快照/导出/预览临时目录 + .obsidian 配置）。
   * 快照写盘会再次触发 modify，不排除就会自我递归。
   */
  private isOwnArtifact(path: string): boolean {
    const p = path.replace(/\\/g, "/");
    const roots = [
      getSnapshotRoot(this.plugin),
      getExportFolderPath(this.plugin),
      this.plugin.settings.tempVersionFolder,
      // configDir（.obsidian）运行时有，类型桩没声明。
      (this.plugin.app.vault as unknown as { configDir?: string }).configDir,
    ];
    for (const raw of roots) {
      const root = String(raw ?? "").trim().replace(/^\/+|\/+$/g, "");
      if (!root) continue;
      if (p === root || p.startsWith(root + "/")) return true;
    }
    return false;
  }

  private refreshSidebar(): void {
    const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_SAVE_HISTORY);
    for (const leaf of leaves) {
      if (leaf.view instanceof SaveHistoryView) leaf.view.refresh();
    }
  }
}

/** 保留数钳到 1-50（设置面板也按这个范围校验，这里是第二道闸）。 */
export function clampKeep(n: number): number {
  if (!Number.isFinite(n)) return 10;
  return Math.min(MAX_KEEP, Math.max(MIN_KEEP, Math.trunc(n)));
}
