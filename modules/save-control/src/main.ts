/**
 * save-control —— 两个上游插件合并成一个模块：
 *
 *   - save-history（Sevoni, MIT）：文件版本历史——快照、恢复、对比、导入导出、
 *     按文件的自动保存间隔与版本数上限；
 *   - obsidian-autosave-control（mihasm, MIT）：自动保存节奏控制——编辑停止
 *     N 秒后才落盘、待保存状态指示、退出/关窗前的冲刷。
 *
 * 合并后新增的能力：
 *   1. **库外文件**（虚拟文档树挂载的文件）：上游两边都只认 vault 相对路径，
 *      本模块通过 `targets.ts` 的 SaveTarget 抽象把库内/库外统一起来——库外
 *      快照落在插件目录（或设置指定目录）下，读写走 Node fs，版本历史界面与
 *      自动保存对两类文件一视同仁；
 *   2. **标签页未保存圆点 + 关闭提示**：Obsidian 原生不给自定义视图标未保存
 *      状态，本模块轮询各标签页的待保存状态，在标签页状态区画圆点，关闭有
 *      未保存更改的标签页前弹出「保存 / 不保存 / 取消」（可用开关关掉）。
 *
 * 开关（都在设置页）：autosaveEnabled / versionHistoryEnabled /
 * externalFilesEnabled / statusIndicatorEnabled / promptUnsavedOnClose；
 * 模块总开关在宿主「My Obsidian」设置页。
 */

import { Notice, Plugin, TAbstractFile, TFile, TFolder, Menu, MenuItem, EventRef } from "obsidian";
import {
  DEFAULT_SETTINGS,
  mergeLegacySettings,
  type SaveControlSettings,
  type PerFileSettings,
  type GroupByMode,
} from "./settings";
import { setupVersioning } from "./versioning";
import { registerCommands, SaveHistoryView, PreviewTabView, VIEW_TYPE_SAVE_HISTORY, VIEW_TYPE_PREVIEW } from "./ui";
import { SaveControlSettingTab } from "./settingsTab";
import { setLanguage, translate } from "./locale";
import {
  getSnapshotDirPath,
  renameSnapshotFolder,
  removeEmptyParentDirs,
  deleteSnapshotDirForFile,
  listSnapshotsForFile,
  saveSnapshotContent,
  ensureExportDir,
  getExportFolderPath,
} from "./storage";
import { AutosaveManager } from "./autosave";
import { AutoSaveController } from "./autosave/AutoSaveController";
import { SaveStatusIndicator } from "./autosave-ui/StatusIndicator";
import { ExternalSaveScheduler } from "./externalScheduler";
import { UnsavedDotMonitor } from "./tabUnsavedDot";
import { resolveExternalSnapshotRoot } from "./externalStore";
import {
  asExternalSaveHandle,
  externalTarget,
  isExternalHandle,
  normalizeKey,
  resolveActiveTarget,
  snapshotKeyFor,
  vaultTarget,
  type SaveTarget,
} from "./targets";
import { renameExternalSnapshotDir } from "./externalStore";
import { extOfName } from "./fileKind";

export type { SaveControlSettings, PerFileSettings, GroupByMode };
export { VIEW_TYPE_SAVE_HISTORY, VIEW_TYPE_PREVIEW };

/** 库外文件被改名/删除时由 logseq 模块广播的事件名（软依赖，见 targets.ts）。 */
export const EVENT_EXTERNAL_RENAMED = "logseq:external-renamed";
export const EVENT_EXTERNAL_DELETED = "logseq:external-deleted";

/** 轮询待保存状态的间隔（圆点与关闭提示都靠它，别调太勤）。 */
const UNSAVED_POLL_MS = 500;

export class SaveControlPlugin extends Plugin {
  settings: SaveControlSettings = DEFAULT_SETTINGS;
  autosaveManager: AutosaveManager | null = null;
  /** 延迟落盘控制器（上游 autosave-control 的本体，管库内文件）。 */
  autosaveController: AutoSaveController | null = null;
  /** 库外文件的自动保存调度器（本模块新增）。 */
  externalScheduler: ExternalSaveScheduler | null = null;
  /** 标签页未保存圆点（本模块新增）。 */
  unsavedDots: UnsavedDotMonitor | null = null;
  versioning!: ReturnType<typeof setupVersioning>;
  saveStatusIndicator: SaveStatusIndicator | null = null;
  tempVersionFiles: Map<string, string> = new Map();
  private lastActiveTarget: SaveTarget | null = null;
  private tabCloseEventRef: EventRef | null = null;
  /** 库外目标的登记表：快照目录(绝对路径) → 目标（getActiveTarget 时登记）。 */
  private readonly externalTargets = new Map<string, SaveTarget>();
  /** 铸造过的合成 TFile 句柄缓存（按快照目录）。 */
  private readonly handleCache = new Map<string, TFile>();
  private runtimeCleanup: (() => void) | null = null;

  // ------------------------------------------------------------------
  // 生命周期
  // ------------------------------------------------------------------

  async onload(): Promise<void> {
    await this.loadSettings();

    this.versioning = setupVersioning(this);

    if (this.settings.versionHistoryEnabled) {
      this.registerView(VIEW_TYPE_SAVE_HISTORY, (leaf) => new SaveHistoryView(leaf, this, this.versioning));
      this.registerView(VIEW_TYPE_PREVIEW, (leaf) => new PreviewTabView(leaf, this));
      registerCommands(this, this.versioning);
      this.addRibbonIcon("history", translate("viewTitle"), () => {
        void (async () => {
          let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SAVE_HISTORY)[0];
          if (!leaf) {
            const rightLeaf = this.app.workspace.getRightLeaf(false);
            if (rightLeaf) {
              leaf = rightLeaf;
              await leaf.setViewState({ type: VIEW_TYPE_SAVE_HISTORY, active: true });
            }
          }
          if (leaf) this.app.workspace.revealLeaf(leaf);
        })();
      });
    }

    // 自动保存：上游控制器管库内（延迟 Obsidian 自己的保存），本模块的调度器
    // 管库外（驱动三个库外视图落盘）。两者共用状态栏的待保存计数。
    // 控制器与调度器无条件常驻：它们同时承载关闭提示、丢弃回滚、configureAutoSave
    // 下发——autosaveEnabled=false 只是「持有模式」（不自动落盘），不是「模块下线」；
    // 之前把机制整个关掉，库外编辑器回落到自带 2s 防抖，编辑期间就把磁盘写脏了。
    this.autosaveController = new AutoSaveController(this.app, () => this.settings, {
      // 关标签页提示：库内看待保存队列，库外看视图脏状态。
      describeUnsaved: (leaf) => this.describeLeafUnsaved(leaf),
      flushLeaf: (leaf) => this.flushLeafUnsaved(leaf),
      discardLeaf: (leaf) => this.discardLeafUnsaved(leaf),
      promptOnClose: () => this.settings.promptUnsavedOnClose,
    });
    this.autosaveController.setPendingSaveCountChangeHandler(() => this.emitPendingCount());
    this.autosaveController.enable();
    if (this.settings.autosaveEnabled) {
      this.autosaveManager = new AutosaveManager(this, this.versioning);
      this.autosaveManager.start();
    }
    // 退出前冲刷库外的待保存更改（库内的由控制器自己的 quit 处理）。退出即写：
    // 静默丢弃会丢数据；持有语义只约束「后台自动写」，不约束显式退出。
    this.registerEvent(
      this.app.workspace.on("quit", () => {
        void this.externalScheduler?.flushAll();
      }),
    );
    if (this.settings.externalFilesEnabled) {
      this.externalScheduler = new ExternalSaveScheduler(this);
      this.externalScheduler.setPendingSaveCountChangeHandler(() => this.emitPendingCount());
      this.externalScheduler.start();
    }

    if (this.settings.statusIndicatorEnabled) {
      this.saveStatusIndicator = new SaveStatusIndicator(this);
      this.saveStatusIndicator.attach();
      this.saveStatusIndicator.setPendingNoteNamesProvider(() => this.getPendingNoteNames());
      this.applyStatusColors();
      this.applyStatusIconSize();
    }

    // 标签页圆点：库外看视图脏状态，库内看控制器的待保存队列。
    this.unsavedDots = new UnsavedDotMonitor(this.app, {
      vaultPending: () => this.autosaveController?.getPendingPaths() ?? [],
    });
    this.unsavedDots.start(UNSAVED_POLL_MS);

    this.registerTabCloseListener();

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        void this.cleanupTempVersionFiles();
      }),
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => {
        void this.cleanupTempVersionFiles();
      }),
    );

    // 库外文件的改名/删除：logseq 的窗格菜单操作成功后广播，快照目录与按文件
    // 设置跟着迁移/清理（软依赖：事件没人广播时什么都不发生）。事件名是自定义
    // 的，Workspace 的公开事件类型里没有——走一次结构化 cast。
    const workspaceEvents = this.app.workspace as unknown as {
      on: (name: string, cb: (...args: unknown[]) => void) => EventRef;
    };
    this.registerEvent(
      workspaceEvents.on(EVENT_EXTERNAL_RENAMED, (...args: unknown[]) => {
        const [oldAbs, newAbs] = args as [string, string];
        this.onExternalRenamed(oldAbs, newAbs);
      }),
    );
    this.registerEvent(
      workspaceEvents.on(EVENT_EXTERNAL_DELETED, (...args: unknown[]) => {
        this.onExternalDeleted(args[0] as string);
      }),
    );

    this.restoreTempVersionFiles();
    this.registerVaultEventHandlers();
    this.registerFileMenuItems();

    this.addSettingTab(new SaveControlSettingTab(this.app, this));

    this.runtimeCleanup = () => {
      this.unsavedDots?.stop();
      this.externalScheduler?.stop();
      this.autosaveController?.disable();
      this.autosaveManager?.stop();
      this.saveStatusIndicator?.detach();
    };
    const globalState = window as typeof window & { __scRuntimeCleanup?: (() => void) | null };
    globalState.__scRuntimeCleanup?.();
    globalState.__scRuntimeCleanup = this.runtimeCleanup;
  }

  onunload() {
    this.unregisterTabCloseListener();
    this.autosaveManager?.stop();
    this.runtimeCleanup?.();
    const globalState = window as typeof window & { __scRuntimeCleanup?: (() => void) | null };
    if (globalState.__scRuntimeCleanup === this.runtimeCleanup) {
      globalState.__scRuntimeCleanup = null;
    }
    this.runtimeCleanup = null;
    void this.cleanupAllTempFiles();
  }

  /** 状态栏提示用的未保存名单（库内 + 库外）。 */
  getPendingNoteNames(): string[] {
    return [
      ...(this.autosaveController?.getPendingNoteNames() ?? []),
      ...(this.externalScheduler?.getPendingNames() ?? []),
    ];
  }

  /** 待保存总数（库内队列 + 库外调度器），喂给状态栏。 */
  private emitPendingCount(): void {
    const n = (this.autosaveController?.getPendingPaths().length ?? 0) + (this.externalScheduler?.getPendingCount() ?? 0);
    this.saveStatusIndicator?.setPendingSaveCount(n);
  }

  /** 关标签页提示用：这个叶子有没有未保存更改（有则返回显示名）。 */
  private describeLeafUnsaved(leaf: { view?: unknown }): string | null {
    const handle = asExternalSaveHandle(leaf.view);
    if (handle) return handle.isDirty() ? handle.fileName : null;
    const path = (leaf.view as { file?: { path?: string } } | null)?.file?.path ?? "";
    if (path && (this.autosaveController?.getPendingPaths() ?? []).includes(path)) {
      return (leaf.view as { file?: { name?: string } })?.file?.name ?? path;
    }
    return null;
  }

  /** 「保存并关闭」：库外落盘，库内冲刷待保存队列。 */
  private async flushLeafUnsaved(leaf: { view?: unknown }): Promise<void> {
    const handle = asExternalSaveHandle(leaf.view);
    if (handle) {
      try {
        await handle.save();
      } catch (e) {
        console.error("[save-control] flush on close failed", handle.abs, e);
      }
      return;
    }
    const path = (leaf.view as { file?: { path?: string } } | null)?.file?.path ?? "";
    if (path) {
      await this.autosaveController?.flushPath(path);
      // 显式保存：会话基线作废——之后「不保存并关闭」不能回滚这次保存。
      this.autosaveController?.clearSessionBaseline(path);
    }
  }

  /**
   * 「不保存并关闭」：丢掉待保存项，并叫停视图卸载时自己的落盘。
   *
   * 块编辑器（logseq 模块）的 onUnloadFile / 库外 shell 的 onClose 都会无条件
   * save()——库内走 TextFileView.save 直写库（save-control 只包了
   * MarkdownView.save，拦不到它），库外把 externalDirty 内容写回文件。丢弃
   * 决定之后它们再写盘，「不保存」就完全失效了。所以除了丢队列/回滚基线，
   * 还要按鸭子类型通知视图本身：实现了 discardPendingChanges 的视图在卸载
   * 时不得再 save。
   */
  private discardLeafUnsaved(leaf: { view?: unknown }): void {
    const view = leaf.view as
      | { discardPendingChanges?: () => void; blockEditor?: { discardPendingChanges?: () => void } | null }
      | null;
    view?.discardPendingChanges?.();
    // 库外 shell：真正的编辑器是托管在里面的块编辑器（ExternalBlockView）。
    view?.blockEditor?.discardPendingChanges?.();
    // 拆卸过程中框架可能再触发 requestSave：shouldHoldSave 一看缓冲区还是脏的
    // 就会重新入队，定时器随后照样落盘——丢弃决定被整个绕过。标记进
    // discardedViews 后，requestSave 包装器会最先拦掉这些调用。
    this.autosaveController?.markViewDiscarded(leaf.view);
    const handle = asExternalSaveHandle(leaf.view);
    if (handle) return; // 库外：没有要丢的队列状态，拆掉即丢弃
    const path = (leaf.view as { file?: { path?: string } } | null)?.file?.path ?? "";
    if (path) void this.autosaveController?.discardAndRevertPath(path);
  }

  // ------------------------------------------------------------------
  // 目标层：库内 TFile 与库外绝对路径共用一套接口
  // ------------------------------------------------------------------

  /** 当前活动标签页对应的保存目标（库外文件受 externalFilesEnabled 门控）。 */
  getActiveTarget(skipTempFiles = true): SaveTarget | null {
    const skip = skipTempFiles
      ? [this.settings.snapshotFolder || ".versions(SH)", this.settings.tempVersionFolder].filter(Boolean)
      : [];
    const target = resolveActiveTarget(this.app, { skipVaultPrefixes: skip });
    if (!target) return null;
    if (target.kind === "external") {
      if (!this.settings.externalFilesEnabled) return null;
      if (skipTempFiles && [...this.tempVersionFiles.values()].includes(target.key)) return null;
    }
    if (!this.isExtensionAllowed(extOfName(target.name))) return null;
    // 登记库外目标：句柄铸造、快照寻址都靠这张表。
    if (target.kind === "external") this.registerExternalTarget(target);
    return target;
  }

  /** 上游语义的「当前文件」：库外目标返回合成 TFile 句柄（path = 快照目录）。 */
  getActiveFile(skipTempFiles = true): TFile | null {
    const target = this.getActiveTarget(skipTempFiles);
    if (!target) return null;
    if (target.kind === "vault") return target.file ?? null;
    return this.mintTargetHandle(target);
  }

  /** 某个视图如果是库外文件视图，返回它的保存探针。 */
  externalHandleOf(view: unknown): ReturnType<typeof asExternalSaveHandle> {
    return asExternalSaveHandle(view);
  }

  /** 按键（= normalizeKey(abs)）找当前打开的库外视图探针（间隔快照先冲刷用）。 */
  findExternalHandleByKey(key: string): ReturnType<typeof asExternalSaveHandle> {
    let hit: ReturnType<typeof asExternalSaveHandle> = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (hit) return;
      const h = asExternalSaveHandle(leaf.view);
      if (h && normalizeKey(h.abs) === key) hit = h;
    });
    return hit;
  }

  /** 按快照目录(绝对路径)找回库外目标；库内路径返回库内目标。 */
  targetForSnapshotPath(snapshotPath: string): SaveTarget | null {
    if (!snapshotPath) return null;
    const hit = this.externalTargets.get(normalizeKey(snapshotPath));
    if (hit) return hit;
    const file = this.app.vault.getAbstractFileByPath(snapshotPath);
    return file instanceof TFile ? vaultTarget(file) : null;
  }

  /** 快照存储寻址：库内 = vault 路径；库外 = 快照目录(绝对路径)。 */
  snapshotPathFor(target: SaveTarget): string {
    if (target.kind === "vault") return target.key;
    return `${this.getExternalSnapshotRoot()}/${snapshotKeyFor(target)}`;
  }

  getExternalSnapshotRoot(): string {
    const adapter = this.app.vault.adapter as unknown as {
      basePath?: string;
      getBasePath?: () => string;
    };
    const vaultBase =
      (typeof adapter.getBasePath === "function" ? adapter.getBasePath() : adapter.basePath) ?? "";
    return resolveExternalSnapshotRoot({
      configured: this.settings.externalSnapshotFolder,
      vaultBase,
      pluginDir: this.manifest.dir ?? "",
    });
  }

  private registerExternalTarget(target: SaveTarget): void {
    this.externalTargets.set(normalizeKey(this.snapshotPathFor(target)), target);
  }

  /**
   * 给库外目标铸造一个 TFile 形状的句柄，让上游那套认 vault 路径的 UI 与存储
   * 代码原样工作：path = 快照目录（绝对路径，storage 据此路由到 fs 存储），
   * name/basename/extension 取自真实文件名。句柄只在内存里，不进 vault。
   */
  private mintTargetHandle(target: SaveTarget): TFile {
    const snapshotPath = this.snapshotPathFor(target);
    const cached = this.handleCache.get(snapshotPath);
    if (cached) return cached;
    const name = target.name;
    const dot = name.lastIndexOf(".");
    const base = this.app.vault.getFiles()[0];
    const proto = (base ?? ({} as TFile)) as TFile;
    const handle = Object.create(Object.getPrototypeOf(proto) as object) as TFile;
    handle.path = snapshotPath;
    handle.name = name;
    handle.basename = dot > 0 ? name.slice(0, dot) : name;
    handle.extension = dot > 0 ? name.slice(dot + 1) : "";
    Object.defineProperty(handle, "stat", {
      value: { ctime: 0, mtime: 0, size: 0 },
      configurable: true,
    });
    Object.defineProperty(handle, "parent", { value: null, configurable: true, writable: true });
    this.handleCache.set(snapshotPath, handle);
    return handle;
  }

  // ------------------------------------------------------------------
  // 库外改名/删除的善后
  // ------------------------------------------------------------------

  private onExternalRenamed(oldAbs: string, newAbs: string): void {
    const oldTarget = externalTarget(oldAbs);
    const newTarget = externalTarget(newAbs);
    const root = this.getExternalSnapshotRoot();
    renameExternalSnapshotDir(root, snapshotKeyFor(oldTarget), snapshotKeyFor(newTarget));
    // 按文件设置的键跟着搬（键 = 快照目录）。
    const oldKey = this.snapshotPathFor(oldTarget);
    const newKey = this.snapshotPathFor(newTarget);
    const per = this.settings.perFileSettings;
    if (per[oldKey]) {
      per[newKey] = per[oldKey];
      delete per[oldKey];
      void this.saveSettings();
    }
    this.externalTargets.delete(normalizeKey(oldKey));
    this.handleCache.delete(oldKey);
  }

  private onExternalDeleted(abs: string): void {
    const target = externalTarget(abs);
    const root = this.getExternalSnapshotRoot();
    const dir = `${root}/${snapshotKeyFor(target)}`;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = eval("require")("fs") as {
        existsSync(p: string): boolean;
        rmSync?(p: string, opts: { recursive: true; force: true }): void;
      };
      if (fs.existsSync(dir)) fs.rmSync?.(dir, { recursive: true, force: true });
    } catch (e) {
      console.error("[save-control] external snapshot cleanup failed", dir, e);
    }
    const key = this.snapshotPathFor(target);
    delete this.settings.perFileSettings[key];
    this.externalTargets.delete(normalizeKey(key));
    this.handleCache.delete(key);
  }

  // ------------------------------------------------------------------
  // 事件：库内改名/删除时快照文件夹与按文件设置的迁移
  // ------------------------------------------------------------------

  private registerVaultEventHandlers(): void {
    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        if (!(file instanceof TFile) && !(file instanceof TFolder)) return;
        if (file instanceof TFile && !this.isExtensionAllowed(file.extension)) return;

        const oldDir = getSnapshotDirPath(this, oldPath);
        const newDir = getSnapshotDirPath(this, file.path);

        // Don't await rename — it can be slow on Windows
        const renamePromise = renameSnapshotFolder(this.app.vault.adapter, oldDir, newDir);

        const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SAVE_HISTORY);
        const refreshViews = () => {
          for (const leaf of leaves) {
            if (leaf.view instanceof SaveHistoryView) void leaf.view.refresh();
          }
        };
        refreshViews();

        const isFolder = file instanceof TFolder;
        const keysToUpdate: string[] = [];
        for (const key of Object.keys(this.settings.perFileSettings)) {
          if (isFolder) {
            if (key === oldPath || key.startsWith(oldPath + "/")) keysToUpdate.push(key);
          } else {
            if (key === oldPath) keysToUpdate.push(key);
          }
        }
        for (const key of keysToUpdate) {
          const newKey = isFolder ? file.path + key.substring(oldPath.length) : file.path;
          this.settings.perFileSettings[newKey] = this.settings.perFileSettings[key];
          delete this.settings.perFileSettings[key];
        }
        if (keysToUpdate.length > 0) await this.saveSettings();

        void renamePromise.then(refreshViews).catch(() => {});

        const parentDir = oldDir.substring(0, oldDir.lastIndexOf("/"));
        void removeEmptyParentDirs(this, parentDir);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", async (file) => {
        if (!(file instanceof TFile)) return;
        if (!this.isExtensionAllowed(file.extension)) return;
        await deleteSnapshotDirForFile(this, file.path);
      }),
    );
  }

  /**
   * 文件菜单：导出全部版本 / 从文件导入版本（上游能力，库内外都能用——
   * 库外目标的句柄 path 是快照目录，storage 自动路由到 fs 存储）。
   */
  private registerFileMenuItems(): void {
    if (!this.settings.versionHistoryEnabled) return;
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile, _source: string) => {
        const target = this.targetForSnapshotPath(file.path);
        if (!target) return;
        if (target.kind === "vault" && !(file instanceof TFile)) return;
        if (!this.isExtensionAllowed(extOfName(target.name))) return;
        const snapshotPath = target.kind === "vault" ? target.key : this.snapshotPathFor(target);

        menu.addItem((item: MenuItem) => {
          item.setTitle(translate("exportAllVersions")).setIcon("download").onClick(() => {
            void (async () => {
              const snapshots = await listSnapshotsForFile(this, snapshotPath);
              if (snapshots.length === 0) {
                this.toast(translate("exportNoVersions"));
                return;
              }
              await this.exportAllSnapshots(target, snapshots);
            })();
          });
        });

        menu.addItem((item: MenuItem) => {
          item.setTitle(translate("importVersions")).setIcon("upload").onClick(() => {
            this.importVersionsFromFiles(target, snapshotPath);
          });
        });

        // 库外文件额外给一个「打开版本历史」入口（库内的在侧栏/功能区）。
        if (isExternalHandle(file)) {
          menu.addItem((item: MenuItem) => {
            item
              .setTitle(translate("viewTitle"))
              .setIcon("history")
              .onClick(() => {
                void this.app.workspace.getRightLeaf(false)?.setViewState({ type: VIEW_TYPE_SAVE_HISTORY, active: true });
              });
          });
        }
      }),
    );
  }

  private async exportAllSnapshots(
    target: SaveTarget,
    snapshots: { timestamp: string; content: string; name: string }[],
  ): Promise<void> {
    try {
      const baseName = target.name.replace(/\.[^.]+$/, "");
      const ext = extOfName(target.name) || "md";
      if (!(this.app as unknown as { isMobile?: boolean }).isMobile) {
        const w = window as unknown as { showDirectoryPicker?: (opts: { mode: string }) => Promise<unknown> };
        if (typeof w.showDirectoryPicker === "function") {
          try {
            interface DirHandle {
              getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirHandle>;
              getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
            }
            interface FileHandle {
              createWritable(): Promise<{ write(data: string | BufferSource | Blob): Promise<void>; close(): Promise<void> }>;
            }
            const dirHandle = await w.showDirectoryPicker({ mode: "readwrite" }) as DirHandle;
            const folderHandle = await dirHandle.getDirectoryHandle(baseName, { create: true });
            for (const snap of snapshots) {
              const d = new Date(snap.timestamp);
              const safeTs = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}-${String(d.getSeconds()).padStart(2, "0")}`;
              const fh = await folderHandle.getFileHandle(`${snap.name}_${safeTs}.${ext}`, { create: true });
              const writable = await fh.createWritable();
              await writable.write(snap.content);
              await writable.close();
            }
            this.toast(translate("exportAllSuccess", { path: baseName }));
            return;
          } catch (e: unknown) {
            if ((e as { name?: string })?.name === "AbortError") return;
          }
        }
      }

      const exportDir = getExportFolderPath(this);
      await ensureExportDir(this);
      for (const snap of snapshots) {
        const d = new Date(snap.timestamp);
        const safeTs = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}T${String(d.getHours()).padStart(2, "0")}-${String(d.getMinutes()).padStart(2, "0")}-${String(d.getSeconds()).padStart(2, "0")}`;
        const fileName = `${baseName}_${snap.name}_${safeTs}.${ext}`;
        await this.app.vault.adapter.write(`${exportDir}/${fileName}`, snap.content);
      }
      this.toast(translate("exportAllSuccess", { path: exportDir }));
    } catch (e) {
      console.error("[save-control] export failed", e);
      this.toast(translate("failedLoadSnapshot"));
    }
  }

  private importVersionsFromFiles(_target: SaveTarget, snapshotPath: string): void {
    const doc = activeDocument!;
    const input = doc.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.classList.add("sh-import-input");
    doc.body.appendChild(input);
    input.addEventListener("change", () => {
      void (async () => {
        try {
          const fileList = input.files;
          if (!fileList || fileList.length === 0) {
            this.toast(translate("importNoFiles"));
            return;
          }
          const now = Date.now();
          for (let i = 0; i < fileList.length; i++) {
            const f = fileList[i];
            const raw = await f.text();
            const nameOnly = f.name.replace(/^.*[\\/]/, "");
            const nameNoExt = nameOnly.replace(/\.[^.]+$/, "").replace(/\.[^.]+$/, "");
            const tsMatch = nameNoExt.match(/^(.+)_(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})$/);
            if (tsMatch) {
              const reason = tsMatch[1];
              const ts = new Date(tsMatch[2].replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3")).toISOString();
              await saveSnapshotContent(this, snapshotPath, ts, raw, reason);
            } else {
              try {
                const record = JSON.parse(raw) as Record<string, unknown>;
                if (typeof record.content === "string" && typeof record.timestamp === "string") {
                  const ts = new Date(record.timestamp).toISOString();
                  await saveSnapshotContent(
                    this,
                    snapshotPath,
                    ts,
                    record.content,
                    typeof record.name === "string" ? record.name : typeof record.reason === "string" ? record.reason : "import",
                  );
                } else {
                  const ts = new Date(now + i).toISOString();
                  await saveSnapshotContent(this, snapshotPath, ts, raw, nameNoExt);
                }
              } catch {
                const ts = new Date(now + i).toISOString();
                await saveSnapshotContent(this, snapshotPath, ts, raw, nameNoExt);
              }
            }
          }
          this.toast(translate("importSuccess"));
          const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_SAVE_HISTORY);
          for (const leaf of leaves) {
            if (leaf.view instanceof SaveHistoryView) void leaf.view.refresh();
          }
        } catch {
          this.toast(translate("failedLoadSnapshot"));
        } finally {
          input.remove();
        }
      })();
    });
    input.click();
  }

  // ------------------------------------------------------------------
  // 关标签页时的自动保存（库内 + 库外）
  // ------------------------------------------------------------------

  registerTabCloseListener() {
    if (this.tabCloseEventRef) return;
    this.lastActiveTarget = this.getActiveTarget();
    this.tabCloseEventRef = this.app.workspace.on("active-leaf-change", () => {
      const target = this.getActiveTarget();
      const prev = this.lastActiveTarget;
      if (prev && (!target || prev.key !== target.key || prev.kind !== target.kind)) {
        if (![...this.tempVersionFiles.values()].includes(prev.key)) {
          void this.autosaveManager?.saveOnTabClose(prev).catch(() => {});
        }
      }
      this.lastActiveTarget = target;
    });
    this.registerEvent(this.tabCloseEventRef);
  }

  unregisterTabCloseListener() {
    if (this.tabCloseEventRef) {
      this.app.workspace.offref(this.tabCloseEventRef);
      this.tabCloseEventRef = null;
    }
    this.lastActiveTarget = null;
  }

  // ------------------------------------------------------------------
  // 设置
  // ------------------------------------------------------------------

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<SaveControlSettings> | null;
    this.settings = mergeLegacySettings({ ...DEFAULT_SETTINGS }, data);
    if (!this.settings.snapshotFolder) this.settings.snapshotFolder = ".versions(SH)";
    if (!this.settings.exportFolder) this.settings.exportFolder = "Exported versions";
    if (!this.settings.tempVersionFolder) this.settings.tempVersionFolder = "Preview";
    setLanguage(this.settings.language);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings as unknown as Record<string, unknown>);
    this.autosaveController?.refreshScheduling();
    this.externalScheduler?.refresh();
  }

  getFileSettings(filePath: string): PerFileSettings {
    return this.settings.perFileSettings[filePath] || {};
  }

  async setFileSetting<K extends keyof PerFileSettings>(filePath: string, key: K, value: PerFileSettings[K]): Promise<void> {
    if (!this.settings.perFileSettings[filePath]) {
      this.settings.perFileSettings[filePath] = {};
    }
    this.settings.perFileSettings[filePath][key] = value;
    await this.saveSettings();
  }

  async clearFileSetting(filePath: string, key: keyof PerFileSettings): Promise<void> {
    const per = this.settings.perFileSettings[filePath];
    if (per) {
      delete per[key];
      if (Object.keys(per).length === 0) delete this.settings.perFileSettings[filePath];
      await this.saveSettings();
    }
  }

  async resetAllFileSettings(filePath: string): Promise<void> {
    delete this.settings.perFileSettings[filePath];
    await this.saveSettings();
  }

  getEffectiveAutosaveInterval(filePath: string): number {
    const per = this.getFileSettings(filePath);
    if (per.autosaveInterval !== undefined) return per.autosaveInterval;
    return this.settings.autosaveInterval;
  }

  getEffectiveAutosaveOnTabClose(filePath: string): boolean {
    const per = this.getFileSettings(filePath);
    if (per.autosaveOnTabClose !== undefined) return per.autosaveOnTabClose;
    return this.settings.autosaveOnTabClose;
  }

  getEffectiveMaxAutosaveVersions(filePath: string): number {
    const per = this.getFileSettings(filePath);
    if (per.maxAutosaveVersions !== undefined) return per.maxAutosaveVersions;
    return this.settings.maxAutosaveVersions;
  }

  getEffectiveGroupBy(filePath: string): GroupByMode {
    const per = this.getFileSettings(filePath);
    if (per.groupBy !== undefined) return per.groupBy;
    return this.settings.groupBy;
  }

  isExtensionAllowed(ext: string): boolean {
    return this.getAllowedExtensions().has(ext.toLowerCase());
  }

  getAllowedExtensions(): Set<string> {
    const set = new Set<string>(["md"]);
    const raw = this.settings.allowedExtensions;
    if (raw) {
      for (const part of raw.split(/[,;\s]+/)) {
        const clean = part.trim().toLowerCase().replace(/^\./, "");
        if (clean) set.add(clean);
      }
    }
    return set;
  }

  refreshCommands(): void {
    if (this.settings.versionHistoryEnabled) registerCommands(this, this.versioning);
  }

  toast(message: string) {
    new Notice(message);
  }

  applyStatusColors(): void {
    this.saveStatusIndicator?.setColors(this.settings.savedStatusColor, this.settings.pendingStatusColor);
  }

  applyStatusIconSize(): void {
    this.saveStatusIndicator?.setIconSize(this.settings.statusIconSizePx);
  }

  /** 开关变化后把各子系统调到与设置一致（设置页调用）。 */
  async applyToggles(): Promise<void> {
    // 状态栏
    if (this.settings.statusIndicatorEnabled && !this.saveStatusIndicator) {
      this.saveStatusIndicator = new SaveStatusIndicator(this);
      this.saveStatusIndicator.attach();
      this.saveStatusIndicator.setPendingNoteNamesProvider(() => this.getPendingNoteNames());
      this.applyStatusColors();
      this.applyStatusIconSize();
    } else if (!this.settings.statusIndicatorEnabled && this.saveStatusIndicator) {
      this.saveStatusIndicator.detach();
      this.saveStatusIndicator = null;
    }
    // 自动保存（间隔快照）：随 autosaveEnabled 开关启停。
    // 控制器与调度器常驻（见 onload 注释）——持有语义在它们内部按开关门控。
    if (this.settings.autosaveEnabled && !this.autosaveManager) {
      this.autosaveManager = new AutosaveManager(this, this.versioning);
      this.autosaveManager.start();
    } else if (!this.settings.autosaveEnabled && this.autosaveManager) {
      this.autosaveManager.stop();
      this.autosaveManager = null;
    }
    if (this.settings.externalFilesEnabled && !this.externalScheduler) {
      this.externalScheduler = new ExternalSaveScheduler(this);
      this.externalScheduler.setPendingSaveCountChangeHandler((n) => this.saveStatusIndicator?.setPendingSaveCount(n));
      this.externalScheduler.start();
    } else if (this.externalScheduler && !this.settings.externalFilesEnabled) {
      this.externalScheduler.stop();
      this.externalScheduler = null;
    }
    this.externalScheduler?.refresh();
  }

  // ------------------------------------------------------------------
  // 临时版本文件（上游机制：预览用的库内临时副本）
  // ------------------------------------------------------------------

  async cleanupTempVersionFiles(): Promise<void> {
    const openPaths = new Set<string>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as { file?: { path: string } };
      if (view?.file?.path) openPaths.add(view.file.path);
    });
    const toDelete: string[] = [];
    for (const [key, filePath] of this.tempVersionFiles) {
      if (!openPaths.has(filePath)) toDelete.push(key);
    }
    const tempRoot = this.settings.tempVersionFolder;
    for (const key of toDelete) {
      const filePath = this.tempVersionFiles.get(key);
      this.tempVersionFiles.delete(key);
      if (!filePath) continue;
      try {
        if (await this.app.vault.adapter.exists(filePath)) {
          await this.app.vault.adapter.remove(filePath);
        }
      } catch { /* ignore */ }
      if (tempRoot && filePath.startsWith(tempRoot + "/")) {
        let dir = filePath.substring(0, filePath.lastIndexOf("/"));
        while (dir && dir !== tempRoot && dir.startsWith(tempRoot + "/")) {
          if (!(await this.app.vault.adapter.exists(dir))) break;
          try {
            const list = await this.app.vault.adapter.list(dir);
            if ((list.files?.length ?? 0) > 0 || (list.folders?.length ?? 0) > 0) break;
            await this.app.vault.adapter.rmdir(dir, false);
          } catch { break; }
          const next = dir.lastIndexOf("/");
          if (next < 0) break;
          dir = dir.substring(0, next);
        }
      }
    }
  }

  restoreTempVersionFiles(): void {
    const folder = this.settings.tempVersionFolder;
    if (!folder) return;
    const prefix = folder + "/";
    this.app.workspace.iterateAllLeaves((leaf) => {
      const view = leaf.view as { file?: { path: string } };
      if (view?.file?.path && view.file.path.startsWith(prefix)) {
        this.tempVersionFiles.set(view.file.path, view.file.path);
      }
    });
  }

  async ensureTempVersionFolder(tmpPath?: string): Promise<void> {
    const folder = this.settings.tempVersionFolder;
    if (!folder) return;
    const dirPath = tmpPath ? tmpPath.substring(0, tmpPath.lastIndexOf("/")) : folder;
    if (!dirPath) return;
    const parts = dirPath.replace(/\\/g, "/").split("/").filter(p => p);
    let currentPath = "";
    for (const part of parts) {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(currentPath)) {
        try {
          await this.app.vault.createFolder(currentPath);
        } catch {
          // folder may have been created by another call
        }
      }
    }
  }

  async cleanupAllTempFiles(): Promise<void> {
    for (const [, filePath] of this.tempVersionFiles) {
      this.app.workspace.iterateAllLeaves((leaf) => {
        const view = leaf.view as { file?: { path: string } };
        if (view?.file?.path === filePath) leaf.detach();
      });
    }
    for (const [, filePath] of this.tempVersionFiles) {
      try {
        if (await this.app.vault.adapter.exists(filePath)) {
          await this.app.vault.adapter.remove(filePath);
        }
      } catch { /* ignore */ }
    }
    this.tempVersionFiles.clear();
  }
}

export default SaveControlPlugin;
