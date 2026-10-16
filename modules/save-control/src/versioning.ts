/**
 * 版本操作：读目标当前内容 → 与最新快照比对 → 写快照；恢复 = 内容写回目标。
 *
 * 上游只认 vault TFile；合并后核心是 **target 版**（库内/库外统一，targets.ts
 * 的 readTargetContent/writeTargetContent 已按目标类型路由 vault API 与
 * Node fs）。`saveNowForFile` / `restoreFromSnapshot` 保留上游签名供 ui.ts
 * 原样调用——file 可能是库外句柄（path = 快照目录），经
 * plugin.targetForSnapshotPath 还原成目标再走 target 版。
 */

import { TFile } from "obsidian";
import { SaveControlPlugin } from "./main";
import { saveSnapshotContent, listSnapshotsForFile, readSnapshotContent, SnapshotRecord } from "./storage";
import { readTargetContent, writeTargetContent, EXTERNAL_VIEW_TYPES, normalizeKey, type SaveTarget } from "./targets";

export function setupVersioning(plugin: SaveControlPlugin) {
  async function saveNowForTarget(target: SaveTarget, name: string): Promise<"saved" | "no_change"> {
    if (!target) return "no_change";
    const content = await readTargetContent(plugin.app, target);
    if (content === null) return "no_change";

    const snapshotPath = plugin.snapshotPathFor(target);
    const snapshots = await listSnapshotsForFile(plugin, snapshotPath);
    const nonPreRestore = snapshots.filter(s => s.name !== "pre-restore");

    if (nonPreRestore.length > 0) {
      const latest = nonPreRestore[0];
      const latestContent = await readSnapshotContent(plugin, latest.filePath);
      if (latestContent && latestContent.content === content) {
        return "no_change";
      }
    }

    const timestamp = new Date().toISOString();
    await saveSnapshotContent(plugin, snapshotPath, timestamp, content, name);
    return "saved";
  }

  async function restoreFromTarget(target: SaveTarget, snapshot: SnapshotRecord) {
    if (!target) return;
    // 空字符串也是合法版本（原 `!snapshot?.content` 会把空版本静默吞掉）。
    const content = snapshot?.content;
    if (typeof content !== "string") return;
    await writeTargetContent(plugin.app, target, content);
    syncOpenEditorsAfterRestore(target, content);
  }

  /**
   * 目标感知的「当前内容」读取：库内走 vault.read，库外走 Node fs。
   *
   * 库外句柄的 path 是快照目录（绝对路径），`app.vault.read` 对它必然抛错——
   * ui.ts 恢复前的 pre-restore 备份读取必须走这里，否则恢复静默失败。
   */
  async function readCurrentContentForFile(file: TFile): Promise<string | null> {
    if (!file) return null;
    const target = plugin.targetForSnapshotPath(file.path);
    if (!target) return null;
    return readTargetContent(plugin.app, target);
  }

  /**
   * 恢复后的实时同步：磁盘已写回，但打开中的编辑器还抱着旧缓冲——
   *
   *   - 库内：自动保存持有队列里的待保存内容会在下个节拍把旧缓冲写回磁盘
   *     （恢复被整个覆盖回去）；脏编辑器在 Obsidian 眼里也不「干净」，不会
   *     因 vault.modify 自动重载。
   *   - 库外：视图自己的脏缓冲同样会被调度器/内置定时器写回。
   *
   * 所以恢复后必须：丢弃待保存状态 + 让打开的编辑器重载磁盘内容。
   */
  function syncOpenEditorsAfterRestore(target: SaveTarget, content: string): void {
    if (target.kind === "vault" && target.file) {
      const path = target.file.path;
      plugin.autosaveController?.discardPath(path);
      // 会话基线一并作废：磁盘已是恢复后的内容，「不保存并关闭」的回滚语义
      // 不再指向恢复前的字节。
      plugin.autosaveController?.clearSessionBaseline(path);
      plugin.app.workspace.iterateAllLeaves((leaf) => {
        const view = leaf.view as {
          file?: { path?: string };
          setViewData?: (data: string, clear: boolean) => void;
          getViewData?: () => string;
          data?: string;
        };
        if (view.file?.path !== path) return;
        if (typeof view.setViewData !== "function" || typeof view.getViewData !== "function") return;
        // 干净的编辑器 Obsidian 会自己重载；只有仍抱旧缓冲的才需要推。
        if (view.getViewData() === content) return;
        view.setViewData(content, false);
        view.data = content;
      });
      return;
    }
    if (!target.abs) return;
    const key = normalizeKey(target.abs);
    plugin.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as {
        getViewType?: () => string;
        abs?: string;
        reload?: () => void;
        blockEditor?: { reload?: () => void };
      };
      const type = typeof view.getViewType === "function" ? view.getViewType() : "";
      if (!EXTERNAL_VIEW_TYPES.includes(type as (typeof EXTERNAL_VIEW_TYPES)[number])) return;
      if (normalizeKey(String(view.abs ?? "")) !== key) return;
      if (typeof view.reload === "function") {
        view.reload();
        return;
      }
      // 块编辑器 shell（logseq-external-block）：真正的编辑器托管在里面。
      view.blockEditor?.reload?.();
    });
  }

  return {
    saveNowForTarget,
    restoreFromTarget,
    readCurrentContentForFile,
    saveNowForFile: async (file: TFile, name: string): Promise<"saved" | "no_change"> => {
      if (!file) return "no_change";
      if (!plugin.isExtensionAllowed(file.extension)) return "no_change";
      const target = plugin.targetForSnapshotPath(file.path);
      if (!target) return "no_change";
      return saveNowForTarget(target, name);
    },
    restoreFromSnapshot: async (file: TFile, snapshot: SnapshotRecord) => {
      if (!file) return;
      if (!plugin.isExtensionAllowed(file.extension)) return;
      const target = plugin.targetForSnapshotPath(file.path);
      if (!target) return;
      return restoreFromTarget(target, snapshot);
    },
  };
}
