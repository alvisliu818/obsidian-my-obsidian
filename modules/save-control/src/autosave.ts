/**
 * 间隔快照（上游 save-history 的 AutosaveManager）。
 *
 * tick 语义：对**当前活动目标**（库内 TFile 或库外视图，targets.ts）按其
 * per-file/全局间隔记一个 "autosave" 版本。库外目标先冲刷缓冲区再快照——
 * 读盘内容只有落盘后才是最新的。
 */

import type { SaveControlPlugin } from "./main";
import type { setupVersioning } from "./versioning";
import { VIEW_TYPE_SAVE_HISTORY, SaveHistoryView } from "./ui";
import { deleteOldestAutosaves } from "./storage";
import type { SaveTarget } from "./targets";

type Versioning = ReturnType<typeof setupVersioning>;

export class AutosaveManager {
  private plugin: SaveControlPlugin;
  private versioning: Versioning;
  private intervalId: number | null = null;
  private lastAutosaveByFile: Map<string, number> = new Map();
  private readonly TIMER_TOLERANCE_MS = 500;

  constructor(plugin: SaveControlPlugin, versioning: Versioning) {
    this.plugin = plugin;
    this.versioning = versioning;
  }

  private gcd(a: number, b: number): number {
    a = Math.abs(a);
    b = Math.abs(b);
    while (b) {
      [a, b] = [b, a % b];
    }
    return a;
  }

  start() {
    this.stop();

    let interval = this.plugin.settings.autosaveInterval;
    for (const per of Object.values(this.plugin.settings.perFileSettings)) {
      if (per.autosaveInterval !== undefined && per.autosaveInterval > 0) {
        if (interval <= 0) {
          interval = per.autosaveInterval;
        } else {
          interval = this.gcd(interval, per.autosaveInterval);
        }
      }
    }
    if (interval <= 0) return;

    const ms = interval * 60 * 1000;
    const id = window.setInterval(() => this.onTick(), ms);
    this.intervalId = id;
    this.plugin.registerInterval(id);
  }

  stop() {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  restart() {
    this.stop();
    this.lastAutosaveByFile.clear();
    this.start();
  }

  /** 关标签页/切走时的快照。target 来自主插件的 target 层（库内外皆可）。 */
  async saveOnTabClose(target: SaveTarget) {
    if (!target) return;
    if (!this.plugin.getEffectiveAutosaveOnTabClose(target.key)) return;
    // 库外：先落盘（磁盘内容才是快照的素材）。
    if (target.kind === "external") {
      const handle = this.plugin.findExternalHandleByKey(target.key);
      if (handle) {
        try {
          await handle.save();
        } catch {
          // 落盘失败就按磁盘现状快照，不中断
        }
      }
    }
    const result = await this.versioning.saveNowForTarget(target, "autosave");
    if (result === "saved") {
      await this.enforceMaxAutosaves(target.key);
    }
    this.refreshSidebar();
  }

  private onTick() {
    const target = this.plugin.getActiveTarget();
    if (!target) return;

    const effectiveInterval = this.plugin.getEffectiveAutosaveInterval(target.key);
    if (effectiveInterval <= 0) return;

    const now = Date.now();
    const intervalMs = effectiveInterval * 60 * 1000;
    const lastSave = this.lastAutosaveByFile.get(target.key);

    if (lastSave !== undefined && now - lastSave + this.TIMER_TOLERANCE_MS < intervalMs) return;

    this.lastAutosaveByFile.set(target.key, now);
    void (async () => {
      // 库外：先冲刷缓冲区再快照；库内读盘即最新。
      if (target.kind === "external") {
        const handle = this.plugin.findExternalHandleByKey(target.key);
        if (handle?.isDirty()) {
          try {
            await handle.save();
          } catch {
            // 同上，快照磁盘现状
          }
        }
      }
      const result = await this.versioning.saveNowForTarget(target, "autosave");
      if (result === "saved") {
        await this.enforceMaxAutosaves(target.key);
      }
      this.refreshSidebar();
    })().catch(() => {});
  }

  private refreshSidebar() {
    const leaves = this.plugin.app.workspace.getLeavesOfType(VIEW_TYPE_SAVE_HISTORY);
    for (const leaf of leaves) {
      if (leaf.view instanceof SaveHistoryView) {
        leaf.view.refresh();
      }
    }
  }

  private async enforceMaxAutosaves(snapshotPath: string) {
    const max = this.plugin.getEffectiveMaxAutosaveVersions(snapshotPath);
    if (max <= 0) return;
    await deleteOldestAutosaves(this.plugin, snapshotPath, max);
  }
}
