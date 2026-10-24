/**
 * 写盘自动存版本：任意文本文件**落盘**时自动给它记一个版本副本。
 *
 * 与 autosave（定时/关标签页）互补 —— 那个按时间取样，这个按「写」取样，
 * 于是每次保存（含 Ctrl+S、自动保存、切走落盘、插件写回）都会留一份可恢复
 * 的副本，而不需要人去点「保存版本」。
 *
 * 触发点用 `vault.on("modify")`：Obsidian 自己所有的写盘路径最终都会发这个
 * 事件（编辑器保存、vault.modify、外部改动同步进库）。它是在写盘**之后**发
 * 的，`saveNowForFile` 记下的是本次写盘**后**的内容。
 *
 * 「写盘前」那条（`ON_WRITE_PREVIOUS_NAME`）由本类的**基线缓存**补：文件打开
 * 时取样一次磁盘内容作为基线，每次写盘后把基线推进到新内容。于是第一次写盘
 * 时基线就是磁盘上的旧内容——否则它随写盘被覆盖，历史里永远找不回来
 * （库外文件此前有 onExternalSaved 补记，库内缺的就是这一环，2026-10-24）。
 * 同内容去重保证它只在信息真正新的时候落一条（通常就是该文件的第一条）。
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

/** 写盘**前**那一刻的版本标签：库外文件没有库内的「首次标脏建会话备份」，
 *  历史若从写盘后开始，被编辑前的原始内容就永远丢失——由 onExternalSaved
 *  用写盘方递来的磁盘基线补记。同内容去重使它只在信息真正新的时候落一条
 *  （通常就是该文件的第一条）。 */
export const ON_WRITE_PREVIOUS_NAME = "写盘前";

/** 单文件超过这个体积就不做副本（字节）。 */
const MAX_AUTO_VERSION_BYTES = 2 * 1024 * 1024;

const MIN_KEEP = 1;
const MAX_KEEP = 50;

export class AutoVersionManager {
  private plugin: SaveControlPlugin;
  private enabled = false;
  private registered = false;
  /**
   * 「不保存并关闭」的基线回滚会把磁盘写回会话前的字节 —— 那次写盘触发的
   * modify 不是用户保存，不能记版本（否则丢弃动作自己制造一条新快照）。
   * path → 抑制窗口截止时间；窗口内该路径的 modify 一律跳过。
   */
  private readonly suppressed = new Map<string, number>();
  /** 每个文件一条串行链（path → 进行中的 promise）。 */
  private readonly queues = new Map<string, Promise<void>>();
  /**
   * 写盘前基线（path → 该文件在「本次写盘之前」的内容）。
   * 来源：file-open 时取样磁盘内容；每次写盘后推进到写盘后的内容。
   * Map 的插入顺序即 FIFO 淘汰顺序，上限见 trimBaselines。
   */
  private readonly baselines = new Map<string, string>();

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
    // 基线取样：文件打开那一刻的磁盘内容 = 编辑前的状态。只在没有基线时取，
    // 避免同一个文件来回切标签把基线冲掉（那时磁盘内容已是上次写盘后的）。
    this.plugin.registerEvent(
      this.plugin.app.workspace.on("file-open", (file) => {
        if (file) void this.captureBaseline(file);
      }),
    );
    this.plugin.registerEvent(
      this.plugin.app.vault.on("delete", (file) => {
        this.baselines.delete(file.path);
      }),
    );
  }

  stop(): void {
    this.enabled = false;
  }

  /** 基线回滚写盘前调用：窗口内该路径的 modify 不记版本（回滚≠用户保存）。 */
  suppressNextModify(path: string): void {
    this.suppressed.set(path, Date.now() + 15_000);
  }

  /** 连写不并发：同一文件排队，跨文件互不影响。 */
  private enqueue(file: TAbstractFile): void {
    if (!this.enabled || !this.plugin.settings.versionOnWriteEnabled) return;
    if (!(file instanceof TFile)) return;
    if (!this.plugin.isExtensionAllowed(file.extension)) return;
    if (this.isOwnArtifact(file.path)) return;
    const until = this.suppressed.get(file.path);
    if (until !== undefined) {
      if (Date.now() <= until) return; // 回滚写盘窗口：静默
      this.suppressed.delete(file.path);
    }

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

  /**
   * 基线取样：读磁盘内容存起来。失败（云占位/锁定）就留空——没有基线最多不补
   * 「写盘前」那条，不影响「写盘」版本的记录。
   */
  private async captureBaseline(file: TFile): Promise<void> {
    if (!this.plugin.isExtensionAllowed(file.extension)) return;
    if (this.isOwnArtifact(file.path)) return;
    if (this.baselines.has(file.path)) return;
    const content = await this.plugin.versioning.readCurrentContentForFile(file);
    if (content === null) return;
    this.baselines.set(file.path, content);
    this.trimBaselines();
  }

  /** 基线缓存上限（FIFO 淘汰）：只缓存打开过的文件，防长会话里无限堆积 */
  private trimBaselines(): void {
    const MAX = 200;
    while (this.baselines.size > MAX) {
      const oldest = this.baselines.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.baselines.delete(oldest);
    }
  }

  private async saveVersion(file: TFile): Promise<void> {
    // 已经卸载 / 开关被关掉：排队期间状态可能变了，落地前再确认一次。
    if (!this.enabled || !this.plugin.settings.versionOnWriteEnabled) return;
    // stat 在运行时有（TFile 的公开字段），模块自带的 obsidian 类型桩没声明。
    const size = (file as TFile & { stat?: { size?: number } }).stat?.size ?? 0;
    if (size > MAX_AUTO_VERSION_BYTES) return;

    // ① 先补「写盘前」：用基线（本次写盘之前的内容）记一条，再把基线推进到
    //    当前内容。与最新快照同内容时 saveContentForTarget 会自动判 no_change，
    //    所以连续保存不会堆重复条目——只有信息真的新（通常是首次写盘，磁盘上
    //    的旧内容即将被覆盖）才落盘。
    await this.savePreviousVersion(file);

    // ② 复用 versioning 的写路径：读内容 → 与最新快照比对（同内容不记）→ 落盘。
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
   * 补记「写盘前」版本。基线缺失（文件没被打开过、或首次取样失败）时静默跳过
   * ——宁可少一条，也不能用错的内容冒充写盘前的状态。
   */
  private async savePreviousVersion(file: TFile): Promise<void> {
    const prev = this.baselines.get(file.path);
    const current = await this.plugin.versioning.readCurrentContentForFile(file);
    if (current !== null) {
      this.baselines.set(file.path, current);
      this.trimBaselines();
    }
    if (prev === undefined || current === null || prev === current) return;
    const target = this.plugin.targetForSnapshotPath(file.path);
    if (!target) return;
    const res = await this.plugin.versioning.saveContentForTarget(
      target,
      prev,
      ON_WRITE_PREVIOUS_NAME,
    );
    if (res !== "saved") return;
    await deleteOldestSnapshotsByName(
      this.plugin,
      file.path,
      clampKeep(this.plugin.settings.maxOnWriteVersions),
      ON_WRITE_PREVIOUS_NAME,
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
