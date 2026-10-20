/**
 * save-control 的合并设置项。
 *
 * 两个上游插件的设置在这里合成一张表，另加四个开关（模块的总开关在宿主
 * 「My Obsidian」设置页里，这里是模块内部的分项开关）：
 *
 *   - autosaveEnabled       自动保存（延迟落盘 + 状态栏指示）
 *   - versionHistoryEnabled 版本历史（快照、侧栏、命令、文件菜单）
 *   - externalFilesEnabled  库外文件（虚拟文档树挂载的文件）支持
 *   - statusIndicatorEnabled 状态栏待保存指示器
 *
 * 命名尽量保留两边的原字段，方便从旧插件的数据里迁移。
 */

export type GroupByMode = "none" | "day" | "week" | "month" | "year";
export type Language = "system" | "en" | "ru" | "es";
export type PreviewMode = "modal" | "tab";

/** 按文件覆盖的项（键 = 库内 vault 路径或库外绝对路径）。 */
export interface PerFileSettings {
  autosaveInterval?: number;
  autosaveOnTabClose?: boolean;
  maxAutosaveVersions?: number;
  groupBy?: GroupByMode;
}

export interface SaveControlSettings {
  // ---- 开关 ----
  autosaveEnabled: boolean;
  versionHistoryEnabled: boolean;
  externalFilesEnabled: boolean;
  statusIndicatorEnabled: boolean;
  /** 关闭有未保存更改的标签页前提示（保存 / 不保存 / 取消）。 */
  promptUnsavedOnClose: boolean;

  // ---- 自动保存（上游 obsidian-autosave-control） ----
  /** 上游字段名保留：true = 完全禁用自动保存（旧数据里它等于 autosaveEnabled=false）。 */
  disableAutoSave: boolean;
  saveDelaySeconds: number;
  deferWorkspaceLayoutSaves: boolean;
  workspaceLayoutSaveDelaySeconds: number;
  savedStatusColor: string;
  pendingStatusColor: string;
  statusIconSizePx: number;

  // ---- 版本历史（上游 save-history） ----
  groupBy: GroupByMode;
  collapsedGroups: Record<string, boolean>;
  language: Language;
  snapshotFolder: string;
  exportFolder: string;
  tempVersionFolder: string;
  autosaveInterval: number;
  autosaveOnTabClose: boolean;
  maxAutosaveVersions: number;
  allowedExtensions: string;
  /** 写盘自动存版本：任意文本文件落盘时自动留一个版本副本。 */
  versionOnWriteEnabled: boolean;
  /** 每个文件最多保留多少个「写盘」版本（1-50，越界按边界钳制）。 */
  maxOnWriteVersions: number;
  previewMode: PreviewMode;
  perFileSettings: Record<string, PerFileSettings>;

  // ---- 库外文件 ----
  /**
   * 库外文件快照的根目录。空 = 插件目录下的 save-control-snapshots；
   * 绝对路径按原样用；相对路径相对库根解析。
   */
  externalSnapshotFolder: string;
}

export const DEFAULT_SETTINGS: SaveControlSettings = {
  // 开关：默认全开——库外文件支持与本模块合并后新增的能力默认启用。
  autosaveEnabled: true,
  versionHistoryEnabled: true,
  externalFilesEnabled: true,
  statusIndicatorEnabled: true,
  promptUnsavedOnClose: true,

  disableAutoSave: false,
  saveDelaySeconds: 10,
  deferWorkspaceLayoutSaves: false,
  workspaceLayoutSaveDelaySeconds: 60,
  savedStatusColor: "#32cd32",
  pendingStatusColor: "#00bfff",
  statusIconSizePx: 16,

  groupBy: "day",
  collapsedGroups: {},
  language: "system",
  snapshotFolder: ".versions(SH)",
  exportFolder: "Exported versions",
  tempVersionFolder: "Preview",
  autosaveInterval: 0,
  autosaveOnTabClose: false,
  maxAutosaveVersions: 0,
  allowedExtensions: "",
  previewMode: "modal",
  versionOnWriteEnabled: true,
  maxOnWriteVersions: 10,
  perFileSettings: {},

  externalSnapshotFolder: "",
};

/**
 * 合并加载：把旧插件的设置搬过来。
 *
 * 宿主给每个模块一片独立的数据切片，所以从旧插件 data.json 迁移是一次性的：
 * 两个上游字段表并集，缺省值兜底；`disableAutoSave` 折叠进 `autosaveEnabled`。
 */
export function mergeLegacySettings(
  base: SaveControlSettings,
  ...sources: Array<Partial<SaveControlSettings> | null | undefined>
): SaveControlSettings {
  const out: SaveControlSettings = { ...base };
  for (const src of sources) {
    if (!src) continue;
    for (const [key, value] of Object.entries(src)) {
      if (value === undefined || value === null) continue;
      if (!(key in out)) continue;
      // 只有类型一致才搬：上游改过字段语义时不硬搬。
      if (typeof value !== typeof out[key as keyof SaveControlSettings]) continue;
      (out as unknown as Record<string, unknown>)[key] = value;
    }
  }
  // disableAutoSave 与 autosaveEnabled 是同一件事的两种写法；任何一边说“关”，
  // 就都关。
  if (out.disableAutoSave) out.autosaveEnabled = false;
  if (!out.autosaveEnabled) out.disableAutoSave = true;
  return out;
}
