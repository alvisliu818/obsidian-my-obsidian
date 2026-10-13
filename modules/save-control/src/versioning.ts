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
import { readTargetContent, writeTargetContent, type SaveTarget } from "./targets";

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
    if (!snapshot?.content) return;
    await writeTargetContent(plugin.app, target, snapshot.content);
  }

  return {
    saveNowForTarget,
    restoreFromTarget,
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
