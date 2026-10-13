/**
 * 库外文件的自动保存调度器。
 *
 * 上游 autosave-control 的控制器通过给 MarkdownView/TextFileView 打补丁来
 * 延迟 Obsidian 自己的保存——那套对库外视图完全无效（它们是 ItemView，不
 * 走 Obsidian 的保存管线）。于是库外这边自己来，语义对齐：
 *
 *   - 编辑停止 saveDelaySeconds 后落盘（驱动视图的 save/flush）；
 *   - 待保存计数喂给同一个状态栏指示器（与库内合并显示）；
 *   - 落盘成功后按 autosaveInterval 的语义由 AutosaveManager 决定要不要
 *     记一个版本快照（那边统一管两类文件的间隔快照）；
 *   - 退出前冲刷（workspace 的 quit 事件）。
 *
 * 脏状态的发现靠轮询（500ms）：三类库外视图的编辑事件形态各不相同（块编辑器
 * 自绘、CodeMirror、双击编辑的 textarea），轮询是唯一通吃的做法，而且顺带
 * 供养了标签页圆点（tabUnsavedDot）。
 */

import type { WorkspaceLeaf } from "obsidian";
import { asExternalSaveHandle, type ExternalSaveHandle } from "./targets";
import type { SaveControlPlugin } from "./main";

const POLL_MS = 500;

interface PendingEntry {
  handle: ExternalSaveHandle;
  /** 第一次发现脏的时刻；距上次落盘安静超过 delay 才写。 */
  dirtySince: number;
  lastWriteAt: number;
}

export class ExternalSaveScheduler {
  private timer: number | null = null;
  private readonly pending = new Map<string, PendingEntry>();
  private onCountChange: ((n: number) => void) | null = null;
  /** 已下发的接管配置（按 abs），值变了才重复调用视图。 */
  private readonly configuredAutoSave = new Map<string, string>();

  constructor(private readonly plugin: SaveControlPlugin) {}

  setPendingSaveCountChangeHandler(handler: (n: number) => void): void {
    this.onCountChange = handler;
  }

  start(): void {
    this.stop();
    this.timer = window.setInterval(() => this.tick(), POLL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.pending.clear();
  }

  /** 设置变化（延时改了）后调用：安静期从头算，接管配置下个 tick 重发。 */
  refresh(): void {
    for (const entry of this.pending.values()) entry.dirtySince = Date.now();
    this.configuredAutoSave.clear();
  }

  /** 待保存的库外文件名（状态栏提示用）。 */
  getPendingNames(): string[] {
    return [...this.pending.values()].map((e) => e.handle.fileName);
  }

  getPendingCount(): number {
    return this.pending.size;
  }

  private tick(): void {
    const now = Date.now();
    const delayMs = Math.max(1, this.plugin.settings.saveDelaySeconds) * 1000;
    const seen = new Set<string>();

    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      const handle = asExternalSaveHandle(leaf.view);
      if (!handle) return;
      const key = handle.abs.toLowerCase();
      seen.add(key);
      // 接管视图内置自动保存的节奏（配置变了才下发）——本模块是唯一权威，
      // 视图自己的 debounce 否则会和这里的调度抢跑。
      const cfg = `${this.plugin.settings.autosaveEnabled}:${delayMs}`;
      if (handle.configureAutoSave && this.configuredAutoSave.get(key) !== cfg) {
        handle.configureAutoSave({ enabled: this.plugin.settings.autosaveEnabled, delayMs });
        this.configuredAutoSave.set(key, cfg);
      }
      if (!handle.isDirty()) {
        // 不脏了：视图自己落盘过（内置自动保存/手动保存）——撤掉待保存标记。
        if (this.pending.delete(key)) this.emit();
        return;
      }
      const existing = this.pending.get(key);
      if (!existing) {
        this.pending.set(key, { handle, dirtySince: now, lastWriteAt: now });
        this.emit();
        return;
      }
      existing.handle = handle;
      if (now - existing.dirtySince >= delayMs) {
        void this.flushKey(key);
      }
    });

    // 叶子关了（视图没了）：撤掉对应的待保存标记。
    for (const key of [...this.pending.keys()]) {
      if (!seen.has(key)) {
        this.pending.delete(key);
        this.emit();
      }
    }
  }

  /** 立即落盘一个库外文件（退出冲刷/关标签页用）。 */
  async flushKey(key: string): Promise<void> {
    const entry = this.pending.get(key);
    if (!entry) return;
    try {
      await entry.handle.save();
    } catch (e) {
      console.error("[save-control] external flush failed", entry.handle.abs, e);
      return;
    }
    this.pending.delete(key);
    this.emit();
  }

  /** 冲刷全部待保存的库外文件（退出/关窗）。 */
  async flushAll(): Promise<void> {
    for (const key of [...this.pending.keys()]) {
      await this.flushKey(key);
    }
  }

  /** 某个叶子是否有待保存的库外更改。 */
  isLeafUnsaved(leaf: WorkspaceLeaf): boolean {
    const handle = asExternalSaveHandle(leaf.view);
    if (!handle) return false;
    return handle.isDirty() || this.pending.has(handle.abs.toLowerCase());
  }

  private emit(): void {
    this.onCountChange?.(this.pending.size);
  }
}
