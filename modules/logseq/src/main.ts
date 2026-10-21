/**
 * Plugin entry: view registration, setViewState take-over patch, commands,
 * vault-wide block-id index, and clean uninstall (restore native views).
 */

import { Menu, MarkdownView, Notice, Platform, Plugin, TAbstractFile, TFile, WorkspaceLeaf, debounce, normalizePath, type CachedMetadata, type ViewState } from 'obsidian';
import { BlockEditorView, VIEW_TYPE_BLOCK_EDITOR } from './view/BlockEditorView';
import { FragmentHost, type FragmentOptions } from './blocks/fragmentEditor';
import { CMD_COLLAPSE_ALL, CMD_FIND, CMD_REPLACE } from './interactions/hotkeys';
import {
  DEFAULT_SETTINGS,
  editorChoiceFromProps,
  mountTreeOrderFrom,
  mountsFrom,
  parseFolderList,
  pathInFolders,
  shortcutOverridesFrom,
  takeOverForFile,
  contentSearchFrom,
  openWithAppsFrom,
  type BlockEditorSettings,
  type EditorChoice,
  type ExternalMount,
} from './types';
import { mountDisplayName } from './types';
import { isMarkdownFile } from './features/codeFileKind';
import { compileFilter, isTextFileName, extOfName } from './features/mountFilter';
import { FileExplorerLocateButton } from './features/fileExplorerLocate';
import { LogseqEditorSettingTab } from './settings/tab';
import { initEditorSettingsStore, loadEditorSettings, saveEditorSettings } from './settings/editorSettingsStore';
import { BlockIndex } from './index/blockIndex';
import {
  SqliteIndex,
  type SqliteFileSource,
  type SqliteSnapshotStore,
} from './index/sqliteIndex';
import { SqliteConsoleModal } from './features/sqliteConsole';
import { PrologQueryBuilderModal } from './features/prologBuilder';
import { prologTemplate } from './features/prologQuery';
import { TodoPanelView, VIEW_TYPE_TODO_PANEL } from './panels/todoPanel';
import { BacklinkPanelView, VIEW_TYPE_BACKLINK_PANEL } from './panels/backlinkPanel';
import { TagPanelView, VIEW_TYPE_TAG_PANEL } from './panels/tagPanel';
import { BlockSearchModal } from './panels/blockSearch';
import { FlashcardPanelView, VIEW_TYPE_FLASHCARD_PANEL } from './panels/flashcardPanel';
import { BlockGraphModal } from './panels/blockGraph';
import { MountEditorModal, MountListModal, MountPositionModal } from './panels/mountModals';
import { MountPanelView, VIEW_TYPE_MOUNT_PANEL } from './panels/mountPanel';
import { ExternalFileView, VIEW_TYPE_EXTERNAL_FILE } from './views/ExternalFileView';
import { ExternalCodeView, VIEW_TYPE_EXTERNAL_CODE } from './views/ExternalCodeView';
import { CodeDocView, VIEW_TYPE_CODE_DOC } from './views/CodeDocView';
import { ExternalBlockView, VIEW_TYPE_EXTERNAL_BLOCK } from './views/ExternalBlockView';
import { OfficeView, VIEW_TYPE_OFFICE } from './views/OfficeView';
import { ImageView, VIEW_TYPE_IMAGE, IMAGE_EXTENSIONS, isImageFile } from './views/ImageView';
import { OFFICE_EXTENSIONS } from './office/types';
import { registerFreeExtensions } from '../../../src/extensionRegistry';
import { ContentSearchPanelView, VIEW_TYPE_CONTENT_SEARCH } from './panels/contentSearchPanel';
import { RecentPanelView, VIEW_TYPE_RECENT_PANEL, pushRecent } from './panels/recentPanel';
import {
  PRESET_OPEN_WITH,
  addOpenWithMenuItems,
  openWithAppById,
  openWithSystemDefault,
  revealInSystemExplorer,
} from './features/openWith';
import {
  exists,
  linkTargetFor,
  linkVaultPath,
  readExternalText,
  safeSegment,
  sameVolume,
  scanExternal,
} from './features/extFs';
import type { MountNode, ScanEntry } from './features/mountFilter';
import { openJournal } from './features/dailyNote';
import { BackupManager } from './core/backup';
import { registerNativeImgFix } from './features/nativeImgFix';
import { applyMarkedTabIcons, markLeafTabIcon } from './features/tabIcon';
import { ExtensionMarketModal } from './extensions/marketModal';
import { restoreAllExtensions, registerExtensionConsumer, search as extSearch, installExtension, uninstallExtension, toggleExtension, reinstallExtension, getInstalledExtensions } from './extensions/extensionManager';
import { isExtensionInstalled } from './extensions/extensionStore';
import { hasGrammarForFence } from './extensions/tmEngine';
import { activateIconThemeByPreference, ICON_THEME_CHANGED_EVENT } from './extensions/iconThemeLoader';
import { applyCodeThemePreference, warmUpSharedBlockEditor, disposeMonaco } from './editor/monaco';
import { TerminalView, VIEW_TYPE_TERMINAL } from './terminal/terminalView';
import { shutdownPtyHelper } from './terminal/ptyClient';
import { shutdownAllLsp } from './lsp/lspHost';
import type { ExtensionSource } from './extensions/types';
import { registerGrammarFromExtension, unregisterGrammarFromExtension, ensureTmEngineReady } from './extensions/tmEngine';
import { loadOpLog, logOp, flushOpLog } from './features/logger';
import { OpLogModal } from './features/opLogModal';
import { discoverPythonEnvs, probeVersions, spawnEnvFor, type PythonEnv } from './exec/pythonEnvs';
import { setActivePythonEnv, getActivePythonEnv } from './exec/activeEnv';
import { BackupRestoreModal } from './features/backupModal';
import { builtinSlashItems, registerSlashEditorCommands } from './features/commandMenu';
import { getLogseqPageProps } from './pagePropsRegistry';
import { NativeSlashSuggest, setBuiltinSlashProvider } from './features/nativeSlashSuggest';
import { isRefFilterActive, refFilterFrom } from './features/backlinkFilter';
import type { OperationRecord } from './core/operationLog';

export default class LogseqEditorPlugin extends Plugin {
  settings: BlockEditorSettings = DEFAULT_SETTINGS;
  /** 核心文件浏览器工具栏上的「定位当前文件」按钮（注入式 UI，需自行装卸）。 */
  fileExplorerLocate: FileExplorerLocateButton | null = null;
  blockIndex: BlockIndex | null = null;
  slashSuggest: NativeSlashSuggest | null = null;
  /** Automatic pre-write backups for user-visible .md files. */
  backups: BackupManager = new BackupManager(this);
  /** In-memory operation log ring (newest last) + pending disk appends. */
  opLog: OperationRecord[] = [];
  opLogPending: OperationRecord[] = [];
  /** Set when a block reference should be revealed after opening a file. */
  pendingReveal: { path: string; blockId: string } | null = null;
  /** Constructor of Obsidian's native properties editor (grabbed off a live instance). */
  nativePropsCtor: unknown = null;
  private nativePropsCtorPromise: Promise<unknown> | null = null;
  /**
   * Secondary index over the vault. Markdown stays the source of truth: this
   * is a rebuildable cache, never an authority (see `index/sqliteIndex.ts`).
   */
  sqliteIndex: SqliteIndex | null = null;
  /** Paths waiting for an incremental re-index; flushed on a debounce. */
  private sqlitePending = new Set<string>();
  private sqliteFlush: (() => void) | null = null;
  /** Timer id for the mount panel's optional auto-refresh; 0 = not scheduled. */
  private mountRefreshTimer = 0;

  /** 打开（或聚焦）终端标签页 */
  async activateTerminalView(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
    let leaf: WorkspaceLeaf;
    if (existing.length) {
      leaf = existing[0];
    } else {
      leaf = workspace.getLeaf('split');
      await leaf.setViewState({ type: VIEW_TYPE_TERMINAL, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  /** 扩展市场 API（设置/命令/E2E 与其他插件消费的正式入口） */
  extMarket = {
    open: () => new ExtensionMarketModal(this).open(),
    search: (q: string, size?: number, source?: ExtensionSource) => extSearch(q, size, source),
    install: (ns: string, name: string, source?: ExtensionSource, version?: string) => installExtension(this, ns, name, source, version),
    uninstall: (id: string) => uninstallExtension(this, id),
    toggle: (id: string) => toggleExtension(this, id),
    reinstall: (id: string) => reinstallExtension(this, id),
    list: () => getInstalledExtensions(this),
    isInstalled: (id: string) => isExtensionInstalled(this, id),
    /** fence 语言是否命中已安装的 TextMate 语法（消费端分流状态） */
    hasGrammarForFence: (lang: string) => hasGrammarForFence(lang),
  };

  private origSetViewState: ((this: WorkspaceLeaf, state: ViewState, eState?: unknown) => Promise<void>) | null = null;
  private statusModeEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    // 供 obsidian-jupyter-notebook 复用同一份环境发现(与它取
    // renderMarkdownFragment 的软依赖方式一致;插件必须能独立运行,所以那边
    // 也有自己的降级实现)。
    (this as unknown as Record<string, unknown>).pythonEnvs = {
      discover: (roots?: string[]) => discoverPythonEnvs(roots ?? []),
      resolve: (id: string) => discoverPythonEnvs().find((e) => e.id === id) ?? null,
      spawnEnvFor,
    };

    this.addSettingTab(new LogseqEditorSettingTab(this.app, this));

    // 扩展市场：注册消费端（语法 → TextMate 引擎），预热引擎后恢复已安装扩展
    registerExtensionConsumer((ext, action) => {
      if (action === 'install' || action === 'enable' || action === 'restore') registerGrammarFromExtension(ext);
      else unregisterGrammarFromExtension(ext);
      // 贡献点变化后按偏好重应用代码主题与图标主题（manager 已先加载好本扩展的
      // 贡献点再通知到这里）：装/启/恢复 → 可能切到扩展主题；禁用/卸载 → 回退内置。
      applyCodeThemePreference(this.settings.codeThemePref);
      activateIconThemeByPreference(this.settings.iconThemePref);
    });
    // 图标主题就绪/切换 → 挂载面板行内图标重绘（iconForEntry 每次渲染时查询）
    // 自定义事件不走 registerDomEvent（其重载只收已知事件名），register 兜底注销。
    const onIconThemeChanged = () => {
      for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MOUNT_PANEL)) {
        (leaf.view as MountPanelView).render();
      }
    };
    window.addEventListener(ICON_THEME_CHANGED_EVENT, onIconThemeChanged);
    this.register(() => window.removeEventListener(ICON_THEME_CHANGED_EVENT, onIconThemeChanged));
    void ensureTmEngineReady().catch(() => {/* wasm 失败时回落 Prism */}).then(() => restoreAllExtensions(this));
    void loadOpLog(this);
    logOp(this, 'plugin.load', '', 'ok', `v${this.manifest.version}`);

    this.registerView(VIEW_TYPE_BLOCK_EDITOR, (leaf) => new BlockEditorView(leaf, this));
    this.registerView(VIEW_TYPE_TODO_PANEL, (leaf) => new TodoPanelView(leaf, this));
    this.registerView(VIEW_TYPE_BACKLINK_PANEL, (leaf) => new BacklinkPanelView(leaf, this));
    this.registerView(VIEW_TYPE_TAG_PANEL, (leaf) => new TagPanelView(leaf, this));
    this.registerView(VIEW_TYPE_FLASHCARD_PANEL, (leaf) => new FlashcardPanelView(leaf, this));
    this.registerView(VIEW_TYPE_MOUNT_PANEL, (leaf) => new MountPanelView(leaf, this));
    this.registerView(VIEW_TYPE_EXTERNAL_FILE, (leaf) => new ExternalFileView(leaf, this));
    this.registerView(VIEW_TYPE_EXTERNAL_CODE, (leaf) => new ExternalCodeView(leaf, this));
    // CodeDocView 是旧混合视图(已被 ExternalCodeView 的新混合引擎取代,不再是
    // 打开入口);保留注册只为恢复旧 workspace 布局里已存在的 leaf。
    this.registerView(VIEW_TYPE_CODE_DOC, (leaf) => new CodeDocView(leaf, this));
    this.registerView(VIEW_TYPE_EXTERNAL_BLOCK, (leaf) => new ExternalBlockView(leaf, this));
    this.registerView(VIEW_TYPE_OFFICE, (leaf) => new OfficeView(leaf, this));
    this.registerView(VIEW_TYPE_IMAGE, (leaf) => new ImageView(leaf, this));
    this.registerView(VIEW_TYPE_CONTENT_SEARCH, (leaf) => new ContentSearchPanelView(leaf, this));
    this.registerView(VIEW_TYPE_RECENT_PANEL, (leaf) => new RecentPanelView(leaf, this));

    // Hand Office files to the previewer. Obsidian has no viewer for these at
    // all (it offers "open in default app" and nothing else), so taking the
    // extension costs nothing and gains an in-app read path.
    // 走 registerFreeExtensions:registerExtensions 整批原子,一个已占用扩展名
    // (核心的、别的插件的、或本插件宿主随后要注册的)就会整体抛异常打死
    // onload。跳过已占用项 + 兜底,详见 extensionRegistry.ts。
    if (this.settings.officeViewerEnabled) {
      registerFreeExtensions(this, OFFICE_EXTENSIONS, VIEW_TYPE_OFFICE, "office viewer");
    }
    // Images are different: Obsidian already previews them, so this is opt-in.
    // svg 之类核心已占用,同样靠 registerFreeExtensions 跳过。
    if (this.settings.imageViewerTakeOver) {
      registerFreeExtensions(this, IMAGE_EXTENSIONS, VIEW_TYPE_IMAGE, "image viewer");
    }

    // Recent-files tracking. `file-open` fires for every file the user lands
    // on, which is exactly the notion of "recent" the panel wants.
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (!file) return;
        this.settings.recentFiles = pushRecent(this.settings.recentFiles ?? [], file.path);
        void this.saveSettings();
      }),
    );

    // Native-view HTML img 相对 src 锚定（防库内同名劫持，见 features/nativeImgFix）
    registerNativeImgFix(this);

    // Vault-wide ((block-id)) index
    this.blockIndex = new BlockIndex(this.app);
    this.blockIndex.attach(this);
    this.attachSqliteIndex();
    this.app.workspace.onLayoutReady(() => {
      void this.blockIndex?.buildAll();
      void this.startSqliteIndex();
      if (this.settings.pagePropsEditor === 'native') void this.resolveNativePropsCtor();
      this.convertOpenMarkdownLeaves();
      // 预热块内代码块的 Monaco 单例:延后一拍再建,不与启动期的布局/索引
      // 抢主线程(建实例是一次性的,晚 1.5s 不影响「第一次点进代码块」的体验)。
      if (this.settings.codeBlockPrewarm) {
        window.setTimeout(() => warmUpSharedBlockEditor(this), 1500);
      }
      // 未链接引用的签名索引：建好之后每次查询十几毫秒，但第一次建在主库
      // 要 ~0.5 秒。延后一拍在后台分片建完（让出主线程，不与启动争抢），
      // 于是用户第一次展开那个区也是十几毫秒。
      if (this.settings.unlinkedScanPrewarm !== false) {
        void this.blockIndex?.buildAll().then(() => {
          window.setTimeout(() => void this.blockIndex?.prewarmSignatures(), 1500);
        });
      }
    });

    this.patchSetViewState();

    // Logseq-format page properties (file-top `key:: value` lines) are not
    // frontmatter, so Obsidian's metadata cache never sees them. Expose them
    // to other plugins by merging them into getFileCache's frontmatter —
    // the file format itself stays Logseq (no conversion).
    const mc = this.app.metadataCache as unknown as {
      getFileCache: (f: TAbstractFile) => CachedMetadata | null;
      getCache: (p: string) => CachedMetadata | null;
    };
    const origGetFileCache = mc.getFileCache.bind(mc);
    const origGetCache = mc.getCache.bind(mc);
    const mergeProps = (cache: CachedMetadata | null, path: string): CachedMetadata | null => {
      const props = getLogseqPageProps(path);
      if (!props) return cache;
      // Logseq-format page props surface as native frontmatter for other
      // plugins; the file itself stays Logseq (no conversion). Property values
      // that resolve to existing files also get synthetic frontmatterLinks —
      // plugins like abstract-folder build parent-child trees from those
      // (Obsidian's own parser only extracts links from real frontmatter).
      const fmLinks: NonNullable<CachedMetadata['frontmatterLinks']> = [];
      // Obsidian's list-type properties (tags/aliases/cssclasses) render as
      // multi-value editors expecting an ARRAY — a comma-separated Logseq
      // value merged as one string renders as a single broken chip. Split
      // them (full-width commas too); other keys keep their literal value.
      const LIST_KEYS = new Set(['tags', 'aliases', 'cssclasses', 'cssclass']);
      const fmValues: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(props)) {
        if (LIST_KEYS.has(k) && typeof v === 'string' && /[，,]/.test(v)) {
          fmValues[k] = v.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
        } else {
          fmValues[k] = v;
        }
        const dest = v ? this.app.metadataCache.getFirstLinkpathDest(v, path) : null;
        if (dest) {
          fmLinks.push({
            key: k,
            link: v,
            original: v,
          });
        }
      }
      return {
        ...cache,
        frontmatter: { ...(cache?.frontmatter ?? {}), ...fmValues, position: cache?.frontmatter?.position },
        ...(fmLinks.length > 0 ? { frontmatterLinks: [...(cache?.frontmatterLinks ?? []), ...fmLinks] } : {}),
      } as CachedMetadata;
    };
    mc.getFileCache = (file: TAbstractFile) => mergeProps(origGetFileCache(file), file.path);
    mc.getCache = (path: string) => mergeProps(origGetCache(path), path);
    this.register(() => {
      mc.getFileCache = origGetFileCache;
      mc.getCache = origGetCache;
    });
    // Debug handle for e2e verification (harmless).
    (window as unknown as { __lgDebug?: Record<string, unknown> }).__lgDebug = {
      pageProps: (path: string) => getLogseqPageProps(path),
      metadata: (path: string) => this.app.metadataCache.getCache(path)?.frontmatter ?? null,
    };


    // NATIVE slash menu (Logseq parity): an EditorSuggest that lists every
    // editor command (core + plugins + our built-ins) and triggers on `/`.
    this.slashSuggest = new NativeSlashSuggest(this);
    (this.app.workspace as unknown as { editorSuggest: { addSuggest(s: unknown): void; removeSuggest(s: unknown): void } }).editorSuggest.addSuggest(this.slashSuggest);
    this.register(() => (this.app.workspace as unknown as { editorSuggest: { removeSuggest(s: unknown): void } }).editorSuggest.removeSuggest(this.slashSuggest));
    // Take priority over the core slash-command suggest (when the user has it
    // enabled) inside the block editor: the trigger walks the registered
    // suggests in order, so ours must come first. It declines for non-block
    // editors, leaving the native editor's own menu untouched.
    const suggests = (this.app.workspace as unknown as { editorSuggest: { suggests?: unknown[] } }).editorSuggest.suggests;
    if (Array.isArray(suggests)) {
      const i = suggests.indexOf(this.slashSuggest);
      if (i > 0) {
        suggests.splice(i, 1);
        suggests.unshift(this.slashSuggest);
      }
    }
    registerSlashEditorCommands(this);
    // Wire the built-in slash items into the native suggest — without this
    // the suggest's built-in list is empty and the menu shows only registry
    // commands (whose order varies, so the cap could hide them entirely).
    setBuiltinSlashProvider(builtinSlashItems);

    // ---- Commands ----
    // In-page find / replace.
    //
    // These DO declare `hotkeys`, and that is the whole point — see the long
    // note in hotkeys.ts. An earlier version tried to catch Ctrl+F with a
    // CAPTURE-phase DOM listener on the view container. Probing a real
    // Obsidian showed that never works: Obsidian's own keymap listens on
    // `window` in the capture phase and calls `preventDefault()` first, so
    // the event is already `defaultPrevented` before it ever reaches us, and
    // it never even arrives at the container. Measured: a listener registered
    // LAST on window-capture still observed `defaultPrevented === true`.
    //
    // Declaring `hotkeys` hands the decision to Obsidian's keymap, which runs
    // first and dispatches our command directly. The DOM handler then must NOT
    // also claim these keys, or it would double-fire.
    this.registerView(VIEW_TYPE_TERMINAL, (leaf) => new TerminalView(leaf, this));

    this.addCommand({
      id: 'open-terminal',
      name: '打开终端',
      callback: () => this.activateTerminalView(),
    });

    this.addRibbonIcon(
      'terminal-square',
      '打开终端',
      () => this.activateTerminalView(),
    );

    this.addCommand({
      id: 'open-ext-market',
      name: '打开扩展市场',
      callback: () => this.extMarket.open(),
    });
    // 功能区图标入口（lucide package：与源侧市场卡片的默认扩展图标同源）
    this.addRibbonIcon('package', '打开扩展市场', () => this.extMarket.open());
    this.addCommand({
      id: CMD_FIND,
      name: 'Find in current file (outline)',
      hotkeys: [{ modifiers: ['Mod'], key: 'f' }],
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BlockEditorView);
        if (!view) return false;
        if (!checking) view.openSearch(false);
        return true;
      },
    });
    this.addCommand({
      id: CMD_REPLACE,
      name: 'Replace in current file (outline)',
      hotkeys: [{ modifiers: ['Mod'], key: 'h' }],
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BlockEditorView);
        if (!view) return false;
        if (!checking) view.openSearch(true);
        return true;
      },
    });
    this.addCommand({
      id: CMD_COLLAPSE_ALL,
      name: 'Toggle collapse all (outline)',
      // Ctrl+\ — routed through the keymap for the same reason as Ctrl+F: the
      // keymap wins the capture race, a DOM listener never sees the event.
      hotkeys: [{ modifiers: ['Mod'], key: '\\' }],
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BlockEditorView);
        if (!view) return false;
        if (!checking) view.toggleCollapseAll();
        return true;
      },
    });

    this.addCommand({
      id: 'open-with-native-editor',
      name: 'Open current file with the native editor',
      checkCallback: (checking) => {
        const leaf = this.app.workspace.getActiveViewOfType(BlockEditorView)?.leaf;
        if (!leaf) return false;
        if (!checking) this.switchToNative(leaf);
        return true;
      },
    });

    this.addCommand({
      id: 'open-with-block-editor',
      name: 'Open current file with the block editor',
      checkCallback: (checking) => {
        const leaf = this.app.workspace.activeLeaf;
        if (!leaf || leaf.view.getViewType() !== 'markdown') return false;
        if (!checking) void this.switchToBlockEditor(leaf);
        return true;
      },
    });

    this.addCommand({
      id: 'rebuild-block-index',
      name: 'Rebuild block reference index',
      callback: () => {
        void this.blockIndex?.buildAll().then(() => new Notice('Block index rebuilt.'));
      },
    });

    this.addCommand({
      id: 'open-sqlite-console',
      name: 'Open the SQLite index console',
      callback: () => new SqliteConsoleModal(this).open(),
    });

    this.addCommand({
      id: 'sync-sqlite-index',
      name: 'Sync the SQLite index with the vault files',
      callback: () => {
        const idx = this.sqliteIndex;
        if (!idx) {
          new Notice('The SQLite index is disabled.');
          return;
        }
        void idx.sync().then((s) => {
          new Notice(
            `SQLite index synced: +${s.added} new, ~${s.changed} changed, -${s.removed} removed (${s.unchanged} unchanged, ${s.ms} ms)`,
          );
        });
      },
    });

    this.addCommand({
      id: 'rebuild-sqlite-index',
      name: 'Rebuild the SQLite index from markdown',
      callback: () => {
        const idx = this.sqliteIndex;
        if (!idx) {
          new Notice('The SQLite index is disabled.');
          return;
        }
        void idx.rebuild().then((s) => {
          new Notice(`SQLite index rebuilt from markdown: ${s.files} files, ${s.blocks} blocks (${s.ms} ms)`);
        });
      },
    });

    this.addCommand({
      id: 'verify-sqlite-index',
      name: 'Check the SQLite index against the files',
      callback: () => {
        const idx = this.sqliteIndex;
        if (!idx) {
          new Notice('The SQLite index is disabled.');
          return;
        }
        void idx.verify().then((v) => {
          if (v.drift.length === 0 && v.missing.length === 0) {
            new Notice(`SQLite index matches the files (${v.checked} checked, ${v.ms} ms)`);
          } else {
            new Notice(
              `SQLite index is stale — drift: ${v.drift.slice(0, 5).join(', ') || 'none'}; missing: ${v.missing.slice(0, 5).join(', ') || 'none'}`,
            );
          }
        });
      },
    });

    this.addCommand({
      id: 'show-operation-log',
      name: 'Show the operation log (sync/write trail)',
      callback: () => new OpLogModal(this).open(),
    });

    this.addCommand({
      id: 'restore-backup',
      name: 'Restore this file from an automatic backup',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || file.extension !== 'md') return false;
        if (!checking) new BackupRestoreModal(this, file).open();
        return true;
      },
    });

    this.addCommand({
      id: 'browse-all-backups',
      name: 'Browse all automatic backups',
      callback: () => new BackupRestoreModal(this).open(),
    });

    // Supertags: apply/remove the supertag of the block's own PAGE. The page's
    // own properties ARE the field template, so a block that lives on a
    // supertag page is already an instance of it — this materializes the
    // inherited fields onto the focused block.
    const supertagCmd = (id: string, label: string, run: (v: BlockEditorView) => boolean) => {
      this.addCommand({
        id,
        name: label,
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(BlockEditorView);
          if (!view) return false;
          const path = view.file?.path;
          if (!path || !this.blockIndex?.supertagDef(path)) return false;
          if (!checking) run(view);
          return true;
        },
      });
    };
    supertagCmd('apply-supertag', 'Apply this page\'s supertag to the focused block', (v) =>
      v.applySupertag(v.file?.path ?? ''),
    );
    supertagCmd('remove-supertag', 'Remove this page\'s supertag from the focused block', (v) =>
      v.removeSupertag(v.file?.path ?? ''),
    );

    this.addCommand({
      id: 'prolog-query-builder',
      name: 'Build a Prolog query (visual builder)',
      callback: () => new PrologQueryBuilderModal(this).open(),
    });

    this.addCommand({
      id: 'insert-prolog-query',
      name: 'Insert an empty Prolog query block',
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BlockEditorView);
        if (!view?.file) return false;
        if (!checking) view.insertTopLevelBlock(prologTemplate(), 'raw');
        return true;
      },
    });

    this.addCommand({
      id: 'open-todo-panel',
      name: 'Open the tasks panel',
      callback: () => void this.activatePanel(VIEW_TYPE_TODO_PANEL),
    });

    this.addCommand({
      id: 'open-backlink-panel',
      name: 'Open the backlinks panel',
      callback: () => void this.activatePanel(VIEW_TYPE_BACKLINK_PANEL),
    });

    this.addCommand({
      id: 'open-flashcard-panel',
      name: 'Review flashcards',
      callback: () => void this.activatePanel(VIEW_TYPE_FLASHCARD_PANEL),
    });

    this.addCommand({
      id: 'open-today-journal',
      name: "Open today's journal",
      callback: () => void openJournal(this),
    });

    // Logseq md parity: prev/next day journal navigation.
    const journalNav = (id: string, name: string, days: number): void => {
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(BlockEditorView);
          if (!view) return false;
          if (!checking) void view.openAdjacentJournal(days);
          return true;
        },
      });
    };
    journalNav('open-prev-journal', 'Open previous daily note', -1);
    journalNav('open-next-journal', 'Open next daily note', 1);

    // Logseq md parity: global collapse / expand.
    const collapseCmd = (id: string, name: string, run: (v: BlockEditorView) => void): void => {
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(BlockEditorView);
          if (!view) return false;
          if (!checking) run(view);
          return true;
        },
      });
    };
    collapseCmd('collapse-all', 'Collapse all blocks', (v) => v.collapseAll());
    collapseCmd('expand-all', 'Expand all blocks', (v) => v.expandAll());
    collapseCmd('toggle-collapse-all', 'Toggle collapse / expand all (Ctrl+\\)', (v) => v.toggleCollapseAll());

    this.addCommand({
      id: 'open-tag-panel',
      name: 'Open the tags panel',
      callback: () => void this.activatePanel(VIEW_TYPE_TAG_PANEL),
    });

    // ---------- External mounts ----------
    this.addCommand({
      id: 'open-mount-panel',
      name: 'Open the mount panel (folders outside the vault)',
      callback: () => void this.activatePanel(VIEW_TYPE_MOUNT_PANEL),
    });
    this.addCommand({
      id: 'add-external-mount',
      name: 'Mount an external folder',
      callback: () => this.promptAddMount(),
    });
    this.addCommand({
      id: 'manage-external-mounts',
      name: 'Manage external mounts',
      callback: () => new MountListModal(this).open(),
    });
    this.addCommand({
      id: 'refresh-external-mounts',
      name: 'Rescan external mounts',
      callback: () => this.refreshMounts(),
    });

    this.addCommand({
      id: 'search-blocks',
      name: 'Search blocks across the vault',
      callback: () => new BlockSearchModal(this.app, this).open(),
    });

    // ---------- Content search (port of siyuan-editor's search panel) ----------
    this.addCommand({
      id: 'open-content-search',
      name: 'Search file contents across the vault',
      callback: () => void this.activatePanel(VIEW_TYPE_CONTENT_SEARCH),
    });
    this.addCommand({
      id: 'content-search-selection',
      name: 'Search file contents for the selection',
      checkCallback: (checking) => {
        const sel = window.getSelection()?.toString().trim();
        if (!sel) return false;
        if (checking) return true;
        void (async () => {
          await this.activatePanel(VIEW_TYPE_CONTENT_SEARCH);
          const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_CONTENT_SEARCH)[0]?.view;
          if (view instanceof ContentSearchPanelView) {
            view.setQuery(sel);
            view.focusQuery();
            await view.run();
          }
        })();
        return true;
      },
    });

    // ---------- Recent files ----------
    this.addCommand({
      id: 'open-recent-panel',
      name: 'Open the recent files panel',
      callback: () => void this.activatePanel(VIEW_TYPE_RECENT_PANEL),
    });

    // ---------- Office / image viewers ----------
    this.addCommand({
      id: 'open-in-office-view',
      name: 'Reopen this file in the Office previewer',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        void this.openInView(VIEW_TYPE_OFFICE, file);
        return true;
      },
    });
    this.addCommand({
      id: 'open-in-image-view',
      name: 'Open this image in the enhanced viewer',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isImageFile(file.name)) return false;
        if (checking) return true;
        void this.openInView(VIEW_TYPE_IMAGE, file);
        return true;
      },
    });

    // ---------- External applications ----------
    this.addCommand({
      id: 'open-with-system-default',
      name: 'Open the current file with its system default app',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        void openWithSystemDefault(this.app, file);
        return true;
      },
    });
    this.addCommand({
      id: 'reveal-in-explorer',
      name: 'Reveal the current file in the system file manager',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file) return false;
        if (checking) return true;
        revealInSystemExplorer(this.app, file);
        return true;
      },
    });
    for (const app of this.settings.openWithApps ?? []) {
      if (!app.enabled) continue;
      this.addCommand({
        id: `open-with-${app.id}`,
        name: `Open the current file with ${app.name}`,
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file) return false;
          if (checking) return true;
          void openWithAppById(this.app, file, this.settings.openWithApps ?? [], app.id);
          return true;
        },
      });
    }

    // File-explorer context menu: the "open with" entries plus the two new
    // viewers. Registered as an event so Obsidian owns the menu's lifetime.
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile) {
          menu.addSeparator();
          addOpenWithMenuItems(this.app, file, menu, this.settings.openWithApps ?? []);
          if (isImageFile(file.name)) {
            menu.addItem((item) =>
              item
                .setTitle('在增强图片查看器中打开')
                .setIcon('image' as never)
                .onClick(() => void this.openInView(VIEW_TYPE_IMAGE, file)),
            );
          }
          if (this.settings.officeViewerEnabled && OFFICE_EXTENSIONS.includes(file.extension.toLowerCase())) {
            menu.addItem((item) =>
              item
                .setTitle('用 Office 预览器打开')
                .setIcon('file-text' as never)
                .onClick(() => void this.openInView(VIEW_TYPE_OFFICE, file)),
            );
          }
        }
      }),
    );

    this.addCommand({
      id: 'open-block-graph',
      name: 'Open the block reference graph',
      callback: () => new BlockGraphModal(this).open(),
    });

    const pageSearchCmd = (id: string, name: string, withReplace: boolean): void => {
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const v = this.app.workspace.getActiveViewOfType(BlockEditorView);
          if (!v) return false;
          if (!checking) v.openSearch(withReplace);
          return true;
        },
      });
    };
    pageSearchCmd('find-in-page', 'Find in page (block editor)', false);
    pageSearchCmd('replace-in-page', 'Find and replace in page (block editor)', true);

    // ---- Status bar: source-mode & native-editor toggles ----
    this.buildStatusBar();

    // ---- Block commands (act on the focused block of the active editor) ----
    const blockCmd = (
      id: string,
      name: string,
      can: (v: BlockEditorView) => boolean,
      run: (v: BlockEditorView) => void,
    ): void => {
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const v = this.app.workspace.getActiveViewOfType(BlockEditorView);
          if (!v || !can(v)) return false;
          if (!checking) run(v);
          return true;
        },
      });
    };

    blockCmd(
      'zoom-in-block',
      'Focus (zoom in on) the focused block',
      (v) => !!v.focusedBlock,
      (v) => v.focusedBlock && v.zoomIn(v.focusedBlock),
    );
    blockCmd('zoom-out-block', 'Zoom out one level', (v) => !!v.zoomedBlock, (v) => v.zoomOut());
    blockCmd(
      'toggle-collapse-block',
      'Toggle collapse on the focused block',
      (v) => !!v.focusedBlock && v.focusedBlock.children.length > 0,
      (v) => v.focusedBlock && v.toggleCollapse(v.focusedBlock),
    );
    blockCmd(
      'cycle-todo-block',
      'Cycle TODO state of the focused block',
      (v) => !!v.focusedBlock && v.focusedBlock.kind === 'list',
      (v) => v.focusedBlock && v.toggleMarker(v.focusedBlock),
    );

    this.addRibbonIcon('list-tree', 'Open with block editor / native editor', () => {
      const active = this.app.workspace.activeLeaf;
      if (!active) return;
      if (active.view instanceof BlockEditorView) this.switchToNative(active);
      else if (active.view.getViewType() === 'markdown') void this.switchToBlockEditor(active);
    });

    this.addRibbonIcon('calendar-day', "Open today's journal", () => void openJournal(this));
  }

  /**
   * 跨插件公开 API:用本插件的 logseq 风格块编辑器渲染管线,把一段
   * markdown 渲染进 container 并支持就地编辑(可关)。
   *
   * 返回 FragmentHost(一个 Component):调用方把它挂进自己的组件树
   * (addChild)或在不复用时 destroy(),即可随宿主视图回收 DOM 与监听。
   * 编辑提交(块文本落模型/结构变化)时触发 opts.onContentChange,参数是
   * 序列化后的 markdown —— 外部把它写回自己的存储(如 notebook 单元格)。
   */
  renderMarkdownFragment(container: HTMLElement, md: string, opts: FragmentOptions = {}): FragmentHost {
    const host = new FragmentHost(this, container, opts);
    host.setMarkdown(md);
    return host;
  }

  onunload(): void {
    // 块内代码块的 Monaco 单例常驻在 body 的隐藏池里,不显式销毁会随插件
    // 禁用/重载泄漏(外部代码视图的实例由各自的 view 自己 dispose)。
    disposeMonaco();
    void shutdownAllLsp();
    shutdownPtyHelper();
    logOp(this, 'plugin.unload', '', 'ok');
    if (this.mountRefreshTimer) {
      window.clearInterval(this.mountRefreshTimer);
      this.mountRefreshTimer = 0;
    }
    void this.sqliteIndex?.close();
    // Flush pending log records before the adapter access goes away.
    void flushOpLog(this);
    // Restore the patched method...
    if (this.origSetViewState) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (WorkspaceLeaf.prototype as any).setViewState = this.origSetViewState;
      this.origSetViewState = null;
    }
    // ...and put every block-editor leaf back to the native markdown view.
    // NOTE: leaf.getViewState() (leaf level, wraps the file under `state`) —
    // NOT view.getState(), which returns the flat view-level record.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BLOCK_EDITOR)) {
      const file = (leaf.getViewState().state as { file?: string } | undefined)?.file;
      if (file) {
        void leaf.setViewState({ type: 'markdown', state: { file }, active: true } as ViewState);
      }
    }
    // Detach plugin-owned side panels.
    for (const vt of [VIEW_TYPE_TODO_PANEL, VIEW_TYPE_BACKLINK_PANEL, VIEW_TYPE_TAG_PANEL, VIEW_TYPE_FLASHCARD_PANEL]) {
      for (const leaf of this.app.workspace.getLeavesOfType(vt)) leaf.detach();
    }
  }

  /** 已扫描到的环境缓存(设置面板与运行路径共用)。 */
  private pyEnvs: PythonEnv[] | null = null;

  /** 发现环境(含仓库内的 venv);结果缓存,设置面板可强制刷新。 */
  discoveredPythonEnvs(force = false): PythonEnv[] {
    if (!force && this.pyEnvs) return this.pyEnvs;
    const roots: string[] = [];
    const base = (this.app.vault.adapter as unknown as { basePath?: string }).basePath;
    if (base) roots.push(base);
    this.pyEnvs = discoverPythonEnvs(roots);
    return this.pyEnvs;
  }

  /** 异步补版本号(不阻塞:列表先出,版本后到)。 */
  async refreshPythonEnvs(): Promise<void> {
    this.discoveredPythonEnvs(true);
    this.pyEnvs = await probeVersions(this.pyEnvs ?? []);
    this.applyPythonEnv();
  }

  /** 按设置决定当前生效的环境。自定义路径 > 下拉选择 > 自动探测。 */
  applyPythonEnv(): void {
    const custom = this.settings.pythonEnvCustomPath.trim();
    if (custom) {
      setActivePythonEnv({ id: custom, name: `${custom} (自定义)`, cmd: custom, args: [], kind: 'system' });
      return;
    }
    const id = this.settings.pythonEnvId;
    if (id) {
      const hit = this.discoveredPythonEnvs().find((e) => e.id === id);
      if (hit) {
        setActivePythonEnv(hit);
        return;
      }
    }
    setActivePythonEnv(null);
  }

  activePythonEnvLabel(): string {
    const env = getActivePythonEnv();
    if (!env) return '当前:自动探测';
    return `当前:${env.name}${env.version ? ' · ' + env.version : ''} — ${env.cmd}`;
  }

  async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Record<string, unknown> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, raw);
    // 旧单开关迁移：仅当 data.json 里确实持久化过 refsDefaultCollapsed、
    // 且两个新开关都未持久化时，才让两者跟随旧值（之后以各自开关为准）。
    // 没有任何 refs 键的全新配置走 DEFAULT_SETTINGS——Unlinked references
    // 在大库上是全库线性扫描，默认折叠（见 types.ts 注释）。
    if (raw && raw.refsDefaultCollapsed !== undefined
        && raw.refsLinkedDefaultCollapsed === undefined && raw.refsUnlinkedDefaultCollapsed === undefined) {
      const legacy = raw.refsDefaultCollapsed === true;
      this.settings.refsLinkedDefaultCollapsed = legacy;
      this.settings.refsUnlinkedDefaultCollapsed = legacy;
    }
    // Sanitize numeric settings from older/corrupt data files.
    const d = Number(this.settings.saveDebounceMs);
    if (!Number.isFinite(d) || d < 0) this.settings.saveDebounceMs = DEFAULT_SETTINGS.saveDebounceMs;
    if (typeof this.settings.excludedFolders !== 'string') this.settings.excludedFolders = '';
    // Take-over scope defaults to 'all' so pre-scope configs keep the old behavior.
    if (this.settings.scopeMode !== 'all' && this.settings.scopeMode !== 'folders') {
      this.settings.scopeMode = 'all';
    }
    if (typeof this.settings.includedFolders !== 'string') this.settings.includedFolders = '';
    if (typeof this.settings.journalFolder !== 'string') this.settings.journalFolder = '';
    if (typeof this.settings.journalFormat !== 'string') this.settings.journalFormat = '';
    if (typeof this.settings.journalTemplate !== 'string') this.settings.journalTemplate = '';
    if (typeof this.settings.pythonEnvId !== 'string') this.settings.pythonEnvId = '';
    if (typeof this.settings.pythonEnvCustomPath !== 'string') this.settings.pythonEnvCustomPath = '';
    if (typeof this.settings.codeThemePref !== 'string') this.settings.codeThemePref = '';
    if (typeof this.settings.iconThemePref !== 'string') this.settings.iconThemePref = '';
    this.applyPythonEnv();
    if (typeof this.settings.customTemplateVars !== 'string') this.settings.customTemplateVars = '';
    // Shortcut groups: a config written before these settings existed has no
    // `shortcuts` key at all, and must keep stock Logseq behavior.
    this.settings.shortcuts = shortcutOverridesFrom(
      (this.settings as { shortcuts?: unknown }).shortcuts,
    );
    this.settings.backupsEnabled = this.settings.backupsEnabled !== false;
    this.settings.opLogEnabled = this.settings.opLogEnabled !== false;
    // Guide-line fold/unfold depths: non-negative int, 0 = all levels.
    const clampLevels = (v: number) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= 0 ? Math.min(n, 99) : 0;
    };
    this.settings.guideLineCollapseLevels = clampLevels(this.settings.guideLineCollapseLevels);
    this.settings.guideLineExpandLevels = clampLevels(this.settings.guideLineExpandLevels);
    if (this.settings.pagePropsEditor !== 'native') this.settings.pagePropsEditor = 'logseq';
    // Per-page linked-reference filters: absent in every pre-filter config, and
    // each entry is sanitized (data.json is user-editable).
    const rawFilters = (this.settings as { refFilters?: unknown }).refFilters;
    const filters: BlockEditorSettings['refFilters'] = {};
    if (rawFilters && typeof rawFilters === 'object') {
      for (const [path, f] of Object.entries(rawFilters as Record<string, unknown>)) {
        const clean = refFilterFrom(f);
        if (isRefFilterActive(clean)) filters[path] = clean;
      }
    }
    this.settings.refFilters = filters;
    this.settings.sqliteIndexEnabled = this.settings.sqliteIndexEnabled !== false;
    this.settings.sqlitePersist = this.settings.sqlitePersist !== false;
    this.settings.sqliteAutoSync = this.settings.sqliteAutoSync !== false;
    // External mounts: absent in every pre-mount config, and each entry is
    // sanitized because data.json is user-editable.
    this.settings.externalMounts = mountsFrom(
      (this.settings as { externalMounts?: unknown }).externalMounts,
    );
    // Tree drag mode + display-order overrides: absent in pre-drag configs,
    // and the order map is user-editable data.json, so only well-shaped
    // records survive (mountId -> dir rel -> array of names).
    this.settings.mountDragMode = this.settings.mountDragMode === true;
    this.settings.mountTreeOrder = mountTreeOrderFrom(
      (this.settings as { mountTreeOrder?: unknown }).mountTreeOrder,
    );
    this.settings.externalCodeWrap = this.settings.externalCodeWrap !== false;
    // 编辑器设置:settings.json 是唯一存储(<configDir>/plugins/<dir>/settings.json),
    // 缺失即按默认创建。旧「代码编辑器自动换行」开关迁移:首次创建 settings.json
    // 时,若 data.json 里用户明确关过换行(externalCodeWrap === false),把
    // wordWrap:'off' 播种进去 —— 此后 data.json 里的 externalCodeWrap 不再被读取。
    initEditorSettingsStore(this);
    const editorSettings = loadEditorSettings(this);
    if (editorSettings.created && this.settings.externalCodeWrap === false) {
      saveEditorSettings({ ...editorSettings.settings, wordWrap: 'off' });
    }
    this.settings.lspEnabled = this.settings.lspEnabled !== false;
    if (!Array.isArray(this.settings.lspServers)) this.settings.lspServers = [];
    this.settings.externalBanner = this.settings.externalBanner !== false;
    // Absent in every pre-toggle config → the affordance stays visible.
    this.settings.addBlockAffordance = this.settings.addBlockAffordance !== false;
    // Same deal: absent → the hover decorations (line + plus) keep floating in.
    this.settings.addBlockMarks = this.settings.addBlockMarks !== false;

    // "Open with": a config that never had the key gets the presets, so a fresh
    // install has something in the menu; once the key exists (even as []) the
    // user's own list — including an empty one — is respected.
    const rawApps = (this.settings as { openWithApps?: unknown }).openWithApps;
    this.settings.openWithApps =
      rawApps === undefined ? PRESET_OPEN_WITH.map((a) => ({ ...a })) : openWithAppsFrom(rawApps);
    this.settings.recentFiles = Array.isArray(this.settings.recentFiles)
      ? this.settings.recentFiles.filter((p): p is string => typeof p === 'string').slice(0, 60)
      : [];
    this.settings.contentSearch = contentSearchFrom(this.settings.contentSearch);
    this.settings.officeViewerEnabled = this.settings.officeViewerEnabled !== false;
    this.settings.imageViewerTakeOver = this.settings.imageViewerTakeOver === true;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * Re-render every open block editor.
   *
   * Needed by settings that change how a block is RENDERED rather than what it
   * contains — turning the fold caret on/off, or hiding a property — where a
   * re-parse would be wrong (the markdown did not change) and leaving the view
   * stale would be a lie about the current settings.
   */
  refreshAllViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BLOCK_EDITOR)) {
      const view = leaf.view as BlockEditorView | null;
      if (view && typeof view.rerender === 'function') view.rerender();
    }
  }

  // ------------------------------------------------------------------
  // Take-over patch
  // ------------------------------------------------------------------

  isExcluded(file: string): boolean {
    return pathInFolders(file, parseFolderList(this.settings.excludedFolders));
  }

  /**
   * Per-page default-editor override: the page `editor` property. Logseq-format
   * page properties come from the registry (vault-wide — the block index keeps
   * it fresh for never-opened files too); frontmatter comes from Obsidian's
   * metadata cache. Both lookups are synchronous.
   */
  editorDefaultFor(file: string): EditorChoice | null {
    return (
      editorChoiceFromProps(getLogseqPageProps(file)) ??
      editorChoiceFromProps(
        this.app.metadataCache.getCache(file)?.frontmatter as Record<string, unknown> | undefined,
      )
    );
  }

  /** Automatic take-over decision for a vault-relative file path (page `editor` property overrides the settings). */
  shouldTakeOverFile(file: string): boolean {
    const s = this.settings;
    return takeOverForFile(
      this.editorDefaultFor(file),
      s.takeOverByDefault,
      s.scopeMode,
      s.includedFolders,
      s.excludedFolders,
      file,
    );
  }

  private patchSetViewState(): void {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proto = WorkspaceLeaf.prototype as any;
    const plugin = this;
    this.origSetViewState = proto.setViewState;
    proto.setViewState = async function patchedSetViewState(
      this: WorkspaceLeaf,
      state: ViewState,
      eState?: unknown,
    ): Promise<void> {
      // shouldTakeOverFile folds in both the settings and the per-page
      // `editor` property, so this converts even when take-over is off
      // globally but the page opts in with `editor:: logseq`.
      const file = state.type === 'markdown' ? (state.state as { file?: string } | undefined)?.file : undefined;
      // Obsidian 1.14.4+ opens files OUTSIDE the vault as TExternalFile, whose
      // `path` carries the `file:` prefix. The NATIVE editor is built for those
      // (relative image/link resolution, outline, outgoing links) — taking them
      // over would drag an out-of-vault file into our vault-shaped editor, so
      // they always stay native, whatever the take-over settings say.
      if (file && plugin.isExternalVaultPath(file)) {
        return (plugin.origSetViewState as any).call(this, state, eState);
      }
      if (file && plugin.shouldTakeOverFile(file)) {
        state = { ...state, type: VIEW_TYPE_BLOCK_EDITOR } as ViewState;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (plugin.origSetViewState as any).call(this, state, eState);
    };
  }

  /** After enable/reload: convert already-open native markdown leaves. */
  private convertOpenMarkdownLeaves(): void {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      // leaf-level view state (file wrapped under `state`), spread whole so
      // mode/source survive the swap.
      const vs = leaf.getViewState();
      const file = (vs.state as { file?: string } | undefined)?.file;
      // Out-of-vault files stay native — same rule as the setViewState patch.
      if (file && !this.isExternalVaultPath(file) && this.shouldTakeOverFile(file)) {
        void leaf.setViewState({ ...vs, type: VIEW_TYPE_BLOCK_EDITOR } as ViewState);
      }
    }
  }

  // ------------------------------------------------------------------
  // native out-of-vault open (Obsidian 1.14.4+)
  // ------------------------------------------------------------------

  /**
   * Does this view-state file path refer to a file OUTSIDE the vault?
   *
   * On 1.14.4+ such files are `TExternalFile`s whose `path` is `file:` +
   * the absolute filesystem path (verified against the running app), and
   * `vault.getAbstractFileByPath` resolves them through its external fallback.
   * A vault file can never carry that prefix on Windows (`:` is illegal in
   * names); elsewhere the getRealPath check keeps a hypothetical `file:`-named
   * vault file out of this branch.
   */
  isExternalVaultPath(file: string): boolean {
    if (!file.startsWith('file:')) return false;
    try {
      const af = this.app.vault.getAbstractFileByPath(file) as TFile | null;
      return !!af && typeof (af as unknown as { getRealPath?: unknown }).getRealPath === 'function';
    } catch {
      return false;
    }
  }

  /** Can THIS Obsidian open out-of-vault files natively? (desktop, 1.14.4+ installer) */
  canOpenNativeExternal(): boolean {
    return (Platform as unknown as { canOpenExternalFiles?: boolean }).canOpenExternalFiles === true;
  }

  /**
   * Open an external mount file with Obsidian's NATIVE editor.
   *
   * The route is the one Obsidian's own "Open file from outside the vault…"
   * uses underneath: resolve the absolute path to a `TExternalFile` (the
   * `file:`-prefixed form is what `getAbstractFileByPath` hands to the external
   * file manager — measured), then `leaf.openFile` it like any vault file. The
   * setViewState take-over patch explicitly leaves these alone, so this really
   * lands in the native markdown editor, not in ours.
   */
  async openExternalInNativeEditor(node: MountNode): Promise<boolean> {
    if (!this.canOpenNativeExternal()) {
      new Notice('用原生编辑器打开库外文件需要 Obsidian 1.14.4+，并通过最新安装器安装。');
      return false;
    }
    const key = `file:${node.abs.replace(/\\/g, '/')}`;
    const af = this.app.vault.getAbstractFileByPath(key) as TFile | null;
    if (!af || typeof (af as unknown as { getRealPath?: unknown }).getRealPath !== 'function') {
      new Notice('无法打开：文件不存在，或此版本不支持库外文件。');
      return false;
    }
    const leaf = this.app.workspace.getLeaf(this.settings.externalSplitView === true ? 'split' : 'tab');
    await leaf.openFile(af);
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    logOp(this, 'external.open', node.abs, 'ok', 'native-editor');
    return true;
  }

  // ------------------------------------------------------------------
  // SQLite secondary index (markdown is the source of truth)
  // ------------------------------------------------------------------

  /** Where the disposable database image is kept (inside the plugin folder). */
  private get sqliteDbPath(): string {
    return normalizePath(`${this.manifest.dir}/logseq-index.sqlite`);
  }

  /**
   * Build the index over the vault's markdown. The vault is reached through
   * two tiny interfaces so `SqliteIndex` itself stays obsidian-free.
   */
  private attachSqliteIndex(): void {
    if (!this.settings.sqliteIndexEnabled) return;
    const source: SqliteFileSource = {
      listMarkdownFiles: () =>
        this.app.vault
          .getMarkdownFiles()
          .map((f) => ({ path: f.path, mtime: f.stat.mtime, size: f.stat.size })),
      read: (path) => this.app.vault.adapter.read(path),
    };
    const snapshot: SqliteSnapshotStore = {
      load: async () => {
        try {
          if (!(await this.app.vault.adapter.exists(this.sqliteDbPath))) return null;
          return new Uint8Array(await this.app.vault.adapter.readBinary(this.sqliteDbPath));
        } catch {
          return null;
        }
      },
      save: async (bytes) => {
        await this.app.vault.adapter.writeBinary(this.sqliteDbPath, bytes.slice().buffer);
      },
    };
    this.sqliteIndex = new SqliteIndex({
      source,
      snapshot: this.settings.sqlitePersist ? snapshot : null,
    });
    if (!this.settings.sqliteAutoSync) return;

    this.sqliteFlush = debounce(() => void this.flushSqlite(), 1500, true);
    const watch = (path: string): void => {
      if (!path.toLowerCase().endsWith('.md') || !this.sqliteIndex) return;
      this.sqlitePending.add(path);
      this.sqliteFlush?.();
    };
    // Auto-unregistered on unload; the handlers no-op while the index is off.
    this.registerEvent(this.app.vault.on('modify', (f) => f instanceof TFile && watch(f.path)));
    this.registerEvent(this.app.vault.on('create', (f) => f instanceof TFile && watch(f.path)));
    this.registerEvent(
      this.app.vault.on('delete', (f) => {
        if (f instanceof TFile && f.path.toLowerCase().endsWith('.md')) {
          this.sqlitePending.delete(f.path);
          void this.sqliteIndex?.forget(f.path);
        }
      }),
    );
    this.registerEvent(
      this.app.vault.on('rename', (f, oldPath) => {
        if (f instanceof TFile && f.path.toLowerCase().endsWith('.md')) {
          this.sqlitePending.delete(oldPath);
          void this.sqliteIndex?.forget(oldPath);
          watch(f.path);
        }
      }),
    );
  }

  /** Open + catch up with anything that changed while Obsidian was closed. */
  private async startSqliteIndex(): Promise<void> {
    const idx = this.sqliteIndex;
    if (!idx) return;
    await idx.open();
    if (idx.lastError) {
      new Notice(`SQLite index could not start: ${idx.lastError}`);
      return;
    }
    // A sync (not a rebuild) is exactly the right catch-up: the `files` table
    // knows each file's mtime/size, so only real changes are re-read — and a
    // discarded database is empty, which makes this a full derive instead.
    const s = await idx.sync();
    if (s.added + s.changed > 0 && s.unchanged === 0) {
      logOp(this, 'sqlite.sync', '', 'ok', `+${s.added} ~${s.changed} ${s.ms}ms`);
    }
  }

  /** Re-index just the files that moved (debounced by the vault events). */
  private async flushSqlite(): Promise<void> {
    const paths = [...this.sqlitePending];
    this.sqlitePending.clear();
    const idx = this.sqliteIndex;
    if (!idx || paths.length === 0) return;
    for (const p of paths) await idx.syncFile(p);
    await idx.persistNow();
  }

  /** Called by the settings tab when the SQLite toggles change. */
  applySqliteSettings(): void {
    const want = this.settings.sqliteIndexEnabled;
    if (!want && this.sqliteIndex) {
      const idx = this.sqliteIndex;
      this.sqliteIndex = null;
      void idx.close();
      return;
    }
    if (want && !this.sqliteIndex) {
      this.attachSqliteIndex();
      void this.startSqliteIndex();
    }
  }

  // ------------------------------------------------------------------
  // View switching
  // ------------------------------------------------------------------

  /**
   * Status bar: ONE mode chip showing the CURRENT editing mode. Click expands
   * a dropdown menu (Live preview / Page source mode / Native editor) with a
   * check on the active mode — direct switching instead of cycling.
   */
  private buildStatusBar(): void {
    const bar = this.addStatusBarItem();
    bar.addClass('lgp-statusbar');
    this.statusModeEl = bar.createEl('a', { cls: 'lgp-status-item' });
    this.statusModeEl.addEventListener('click', (evt) => this.showModeMenu(evt));
    // Keep the label in sync with whatever view is active. A same-leaf view
    // TYPE swap (native ↔ block editor) does not fire active-leaf-change, so
    // also listen to layout-change.
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.updateStatusBar()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.updateStatusBar()));
    // 库外文件标签页的主题图标:标签页头重建/被 setIcon 重设后丢失,借这两个
    // 事件重应用(applyMarkedTabIcons 有 marker 判断,重复触发代价可忽略)
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.refreshTabIcons()));
    this.registerEvent(this.app.workspace.on('layout-change', () => this.refreshTabIcons()));

    // 核心文件浏览器：工具栏注入「定位当前文件」按钮。布局变化会重建面板，
    // 故每次都要重新注入（install 幂等）；register() 保证卸载时把自己摘掉。
    this.fileExplorerLocate = new FileExplorerLocateButton(this.app);
    this.register(() => this.fileExplorerLocate?.uninstall());
    this.app.workspace.onLayoutReady(() => this.fileExplorerLocate?.installAll());
    this.registerEvent(
      this.app.workspace.on('layout-change', () => this.fileExplorerLocate?.installAll()),
    );
    this.updateStatusBar();
  }

  /** Current editing mode of the active editor (menu check + chip label). */
  private currentMode(): 'edit' | 'source' | 'native' {
    if (this.app.workspace.getActiveViewOfType(BlockEditorView)) return 'edit';
    const md = this.app.workspace.getActiveViewOfType(MarkdownView);
    // Obsidian's own raw source mode (mode 'source' + source flag true) —
    // NOT live preview, which is also an editing mode.
    if (md && md.getMode() === 'source' && md.getState()['source'] === true) return 'source';
    return 'native';
  }

  /** Click → dropdown with the three modes; a check marks the current one. */
  private showModeMenu(evt: MouseEvent): void {
    const current = this.currentMode();
    const menu = new Menu();
    const entry = (title: string, icon: string, mode: 'edit' | 'source' | 'native') =>
      menu.addItem((item) =>
        item.setTitle(title).setIcon(icon).setChecked(mode === current).onClick(() => void this.applyMode(mode)),
      );
    entry('Logseq editor', 'lucide-eye', 'edit');
    entry('Page source mode', 'lucide-file-code', 'source');
    entry('Native editor', 'lucide-pencil-line', 'native');
    menu.showAtMouseEvent(evt);
  }

  /**
   * Switch the active editor to the picked mode (works from any mode).
   * Page source mode IS Obsidian's own native source mode: the leaf opens the
   * native markdown editor with `mode: 'source'` — the whole file as raw
   * markdown, nothing rendered.
   */
  private async applyMode(mode: 'edit' | 'source' | 'native'): Promise<void> {
    const leaf = this.app.workspace.activeLeaf;
    if (!leaf) return;
    const blockView = this.app.workspace.getActiveViewOfType(BlockEditorView);
    const md = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (mode === 'edit') {
      if (!blockView && md) await this.switchToBlockEditor(leaf);
    } else if (mode === 'source') {
      if (blockView) this.switchToNative(leaf, 'source');
      else if (md && !(md.getState()['source'] === true)) await this.setNativeSourceMode(leaf, true);
    } else {
      if (blockView) this.switchToNative(leaf);
      else if (md && md.getState()['source'] === true) await this.setNativeSourceMode(leaf, false);
    }
    // In-view mode flips fire neither active-leaf-change nor layout-change —
    // refresh the chip explicitly.
    this.updateStatusBar();
  }

  private updateStatusBar(): void {
    const el = this.statusModeEl;
    if (!el) return;
    const mode = this.currentMode();
    const leaf = this.app.workspace.activeLeaf;
    const isMarkdown = !!leaf && leaf.view?.getViewType?.() === 'markdown';
    if (mode === 'native' && !isMarkdown) {
      el.style.display = 'none';
      return;
    }
    el.style.display = '';
    el.setText(mode === 'edit' ? 'Logseq editor' : mode === 'source' ? 'Page source mode' : 'Native editor');
    el.toggleClass('mod-active-srcmode', mode === 'source');
    el.setAttribute('aria-label', 'Editing mode — click to switch');
  }

  private switchToNative(leaf: WorkspaceLeaf, sourceMode?: 'source'): void {
    const file = (leaf.getViewState().state as { file?: string } | undefined)?.file;
    if (!file) return;
    const state: Record<string, unknown> = { file };
    if (sourceMode) {
      state.mode = 'source';
      state.source = true;
    }
    // Bypass the take-over patch: the markdown setViewState would otherwise be
    // converted straight back to the block editor (takeOverByDefault).
    void this.bypassingSetViewState(leaf, { type: 'markdown', state, active: true } as ViewState);
  }

  /** Flip the NATIVE editor in place between raw source mode and live preview. */
  private async setNativeSourceMode(leaf: WorkspaceLeaf, source: boolean): Promise<void> {
    const vs = leaf.getViewState();
    const state = (vs.state ?? {}) as Record<string, unknown>;
    state.mode = 'source';
    state.source = source;
    vs.state = state;
    await this.bypassingSetViewState(leaf, vs, { focus: true });
  }

  /** setViewState WITHOUT the take-over patch re-converting the file to the block editor. */
  private async bypassingSetViewState(leaf: WorkspaceLeaf, state: ViewState, eState?: unknown): Promise<void> {
    if (this.origSetViewState) await this.origSetViewState.call(leaf, state, eState);
    else await leaf.setViewState(state, eState);
  }

  private async switchToBlockEditor(leaf: WorkspaceLeaf): Promise<void> {
    const file = (leaf.getViewState().state as { file?: string } | undefined)?.file;
    if (!file) return;
    await leaf.setViewState({ type: VIEW_TYPE_BLOCK_EDITOR, state: { file }, active: true } as ViewState);
  }

  /**
   * Resolve the constructor of Obsidian's native properties editor. The class
   * is not exported, so it is taken off a live instance: any open native
   * markdown view carries one; when none is open (take-over mode), a native
   * markdown view is flashed in a new tab for exactly this purpose and
   * detached again. Resolved once, cached.
   */
  async resolveNativePropsCtor(): Promise<unknown> {
    if (this.nativePropsCtor) return this.nativePropsCtor;
    if (!this.nativePropsCtorPromise) {
      this.nativePropsCtorPromise = (async () => {
        for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const ed = (leaf.view as any)?.metadataEditor;
          if (ed) {
            this.nativePropsCtor = ed.constructor;
            return this.nativePropsCtor;
          }
        }
        const file = this.app.workspace.getActiveFile() ?? this.app.vault.getMarkdownFiles()[0];
        if (!file) return null;
        const leaf = this.app.workspace.getLeaf(true);
        try {
          await this.bypassingSetViewState(leaf, { type: 'markdown', state: { file: file.path } } as ViewState);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.nativePropsCtor = (leaf.view as any)?.metadataEditor?.constructor ?? null;
        } finally {
          leaf.detach();
        }
        return this.nativePropsCtor;
      })();
    }
    return this.nativePropsCtorPromise;
  }

  /** Reveal a side panel, creating its leaf on first use. */
  /** Reveal a sidebar panel, creating its leaf on first use. */
  /**
   * Open a file in one of the plugin's own views (Office / image).
   *
   * `openFile` cannot do this — it dispatches on the extension through
   * Obsidian's registry — so the leaf is pointed at the view type directly and
   * the path handed to it through the view state.
   */
  async openInView(viewType: string, file: TFile): Promise<void> {
    const { workspace } = this.app;
    const leaf = workspace.getLeaf(false);
    await leaf.setViewState({ type: viewType, state: { path: file.path }, active: true });
    workspace.revealLeaf(leaf);
  }

  /** Move a mount so that `fromId` sits immediately before `toId`. */
  async reorderMount(fromId: string, toId: string): Promise<void> {
    const list = this.settings.externalMounts ?? [];
    const from = list.findIndex((m) => m.id === fromId);
    const to = list.findIndex((m) => m.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = list.splice(from, 1);
    list.splice(to, 0, moved);
    await this.saveSettings();
  }

  /** Keep every open image viewer's tab title in sync after prev/next. */
  refreshImageViewTitles(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_IMAGE)) {
      const view = leaf.view as ImageView | null;
      if (!view) continue;
      // Obsidian caches the tab label; assigning the display text again is not
      // enough, so the leaf's own title element is refreshed through the
      // workspace's update path.
      (leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
    }
  }

  /** Re-render every open recent-files panel. */
  refreshRecentPanels(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_RECENT_PANEL)) {
      const view = leaf.view as RecentPanelView | null;
      view?.render();
    }
  }

  async activatePanel(viewType: string): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(viewType)[0];
    if (existing) {
      workspace.revealLeaf(existing);
      return;
    }
    // The mount tree opens in the LEFT sidebar, to the LEFT of the native
    // file explorer: a tree browsing folders OUTSIDE the vault belongs next
    // to the tree that browses the vault. First open only — after that the
    // user's own arrangement wins and reveal is all that happens. Every
    // other panel keeps its right-side slot.
    if (viewType === VIEW_TYPE_MOUNT_PANEL) {
      const explorer = workspace.getLeavesOfType('file-explorer')[0];
      const leaf = workspace.getLeftLeaf(false);
      if (!leaf) return;
      await leaf.setViewState({ type: viewType, active: true });
      if (explorer && leaf.parent === explorer.parent) {
        // Same tab group as the explorer: move this tab to sit before it.
        // insertChild/removeChild are Obsidian-internal but stable, and the
        // probe measured getLeftLeaf landing in this exact container.
        const tabs = explorer.parent as unknown as {
          children: WorkspaceLeaf[];
          insertChild: (index: number, child: WorkspaceLeaf) => void;
          removeChild: (child: WorkspaceLeaf) => void;
        };
        const at = tabs.children.indexOf(explorer);
        if (at > -1) {
          tabs.removeChild(leaf);
          tabs.insertChild(at, leaf);
        }
      }
      workspace.revealLeaf(leaf);
      return;
    }
    const leaf = workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: viewType, active: true });
    workspace.revealLeaf(leaf);
  }

  // ------------------------------------------------------------------
  // Block reference navigation
  // ------------------------------------------------------------------

  // ------------------------------------------------------------------
  // Prolog queries
  // ------------------------------------------------------------------

  /** Insert a ```prolog fence into the active block editor; false when none. */
  insertPrologQuery(source: string): boolean {
    const view = this.app.workspace.getActiveViewOfType(BlockEditorView);
    if (!view || !view.file) return false;
    view.insertTopLevelBlock(source, 'raw');
    return true;
  }

  async openBlockRef(blockId: string): Promise<void> {
    const info = this.blockIndex?.get(blockId);
    if (!info) {
      new Notice(`Block not found: ${blockId}`);
      return;
    }
    if (this.app.workspace.getActiveViewOfType(BlockEditorView)?.file?.path === info.path) {
      this.app.workspace.getActiveViewOfType(BlockEditorView)!.revealBlock(blockId);
      return;
    }
    this.pendingReveal = { path: info.path, blockId };
    await this.app.workspace.openLinkText(info.path, '', false);
    const view = this.app.workspace.getActiveViewOfType(BlockEditorView);
    if (view && view.file?.path === info.path) {
      view.revealBlock(blockId);
      this.pendingReveal = null;
    }
    // else: view will pick up pendingReveal in onLoadFile
  }

  // ------------------------------------------------------------------
  // External mounts (folders outside the vault, in the mount panel)
  // ------------------------------------------------------------------

  /** The vault's own root path — where links get created. */
  vaultBasePath(): string {
    const adapter = this.app.vault.adapter as unknown as {
      basePath?: string;
      getBasePath?: () => string;
    };
    return adapter.basePath ?? adapter.getBasePath?.() ?? '';
  }

  /** Open the add-mount dialog. */
  promptAddMount(): void {
    new MountEditorModal(this).open();
  }

  /** Edit an existing mount. */
  editMount(mount: ExternalMount): void {
    new MountEditorModal(this, mount).open();
  }

  /**
   * Mount a tree row (folder OR file) as its own panel entry. Path and label
   * come from the row; the user only picks where in the mount list it lands.
   * With no existing mounts there is no position to choose — add directly.
   */
  promptMountEntry(draft: Omit<ExternalMount, 'id' | 'enabled'>): void {
    if ((this.settings.externalMounts ?? []).length === 0) {
      void this.addMount(draft).then((m) => new Notice(`已挂载 ${mountDisplayName(m)}`));
      return;
    }
    new MountPositionModal(this, draft).open();
  }

  /** Persist a new mount and show the panel; `atIndex` places it in the panel list. */
  async addMount(draft: Omit<ExternalMount, 'id' | 'enabled'>, atIndex?: number): Promise<ExternalMount> {
    const trimmed = draft.path.trim().replace(/[\\/]+$/, '');
    const base = this.vaultBasePath() || 'mount';
    let id = safeSegment(draft.label.trim() || trimmed.split(/[\\/]+/).pop() || base);
    // Ids become folder names under Mounts/, so they must stay unique there.
    let n = 2;
    while (this.settings.externalMounts.some((m) => m.id === id)) id = `${safeSegment(draft.label || base)}_${n++}`;
    const mount: ExternalMount = { ...draft, path: trimmed, id, enabled: true };
    if (atIndex === undefined || atIndex >= this.settings.externalMounts.length) {
      this.settings.externalMounts.push(mount);
    } else {
      // Clamp negatives to 0 rather than wrapping from the end: callers mean
      // "before the i-th mount", and -1 would silently hide the entry.
      this.settings.externalMounts.splice(Math.max(0, atIndex), 0, mount);
    }
    await this.saveSettings();
    this.startMountRefresh();
    this.refreshMounts();
    await this.activatePanel(VIEW_TYPE_MOUNT_PANEL);
    logOp(this, 'mount.add', mount.path, 'ok');
    return mount;
  }

  /** Remove a mount. Never touches the target folder.
   *  嵌套在其下的挂载提升为顶层(各自有独立真实路径,不连带删除)。 */
  async removeMount(mount: ExternalMount): Promise<void> {
    const list = this.settings.externalMounts;
    const i = list.findIndex((m) => m.id === mount.id);
    if (i < 0) return;
    list.splice(i, 1);
    let promoted = 0;
    for (const m of list) {
      if (m.attachTo === mount.id) {
        delete m.attachTo;
        promoted++;
      }
    }
    await this.saveSettings();
    this.startMountRefresh();
    this.refreshMounts();
    logOp(this, 'mount.remove', mount.path, 'ok');
    new Notice(promoted > 0 ? `已卸载 ${mountDisplayName(mount)}（${promoted} 个嵌套挂载已移到顶层）` : `已卸载 ${mountDisplayName(mount)}`);
  }

  /** Re-scan every open mount panel. */
  refreshMounts(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MOUNT_PANEL)) {
      (leaf.view as MountPanelView | null)?.refreshMounts();
    }
    // 广播「挂载已刷新」：omnisearch 据此重索引库外文件。不广播的话，
    // 会话中新增/删除的库外文件要等下次重启才会进索引。
    this.app.workspace.trigger('logseq:external-mounts-refreshed');
  }

  /**
   * Re-mount the open external-file views.
   *
   * Both the banner and the soft-wrap setting are baked in when the editor is
   * built, so toggling either has to rebuild rather than patch — a mounted
   * CodeMirror instance cannot change its extensions after the fact.
   */
  rerenderExternalViews(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_EXTERNAL_CODE)) {
      const view = leaf.view as ExternalCodeView | null;
      if (!view?.abs) continue;
      view.remount();
    }
    // 外部块编辑器壳视图:设置里的显示类开关(文末添加块/装饰)切换后要立即
    // 作用于已打开的外部文件,一并重渲染。
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_EXTERNAL_BLOCK)) {
      const view = leaf.view as ExternalBlockView | null;
      if (typeof view?.rerender === 'function') view.rerender();
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BLOCK_EDITOR)) {
      const view = leaf.view as BlockEditorView | null;
      if (!view?.isExternal) continue;
      view.renderExternalSections();
    }
  }

  /**
   * Poll the panel for mounts that asked for a timed refresh.
   *
   * A single shared timer rather than one per mount: the panel is the only
   * consumer, and several timers would each re-render the same view.
   */
  private startMountRefresh(): void {
    if (this.mountRefreshTimer) {
      window.clearInterval(this.mountRefreshTimer);
      this.mountRefreshTimer = 0;
    }
    const interval = (this.settings.externalMounts ?? []).reduce(
      (min, m) => (m.enabled && m.refreshSeconds > 0 ? Math.min(min, m.refreshSeconds) : min),
      Infinity,
    );
    if (!Number.isFinite(interval)) return;
    this.mountRefreshTimer = window.setInterval(() => {
      if ((this.settings.externalMounts ?? []).some((m) => m.enabled && m.refreshSeconds > 0)) {
        this.refreshMounts();
      }
    }, Math.max(5, interval) * 1000);
  }

  /**
   * Open one entry of a mount.
   *
   * Text-like files go into the block-style view, which reads and writes the
   * original file over Node fs. Everything else is handed to the system.
   * A synthetic `TFile` would be the shortcut here, but it does not work:
   * measured, `leaf.openFile(fake)` resolves and then mounts the "empty"
   * placeholder, so the content never appears.
   */
  /**
   * 给打开库外文件的标签页补主题文件图标(虚拟文档树同款)。
   * 标签页头重建/setIcon 重设后 marker 元素丢失,layout-change 时重应用。
   */
  private refreshTabIcons(): void {
    const leaves = [
      VIEW_TYPE_EXTERNAL_CODE,
      VIEW_TYPE_EXTERNAL_BLOCK,
      VIEW_TYPE_EXTERNAL_FILE,
    ].flatMap((t) => this.app.workspace.getLeavesOfType(t));
    applyMarkedTabIcons(this.app, leaves);
  }

  /**
   * setIcon(view.getIcon()) 会在 setViewState 之后的某个时点覆盖标签页图标
   * (实测:立即应用的主题图标被清掉),延迟补一次;applyMarkedTabIcons 幂等。
   */
  private refreshTabIconsSoon(): void {
    window.setTimeout(() => this.refreshTabIcons(), 120);
  }

  /**
   * 供其它模块（omnisearch）列举库外可搜索文件——「库外搜索」的数据源。
   *
   * 返回扁平的 `{abs, name, mtime}`（绝对路径）。纯只读：不打开、不建链接、
   * 不写盘；调用方自己转成 `ext:` 伪路径并判断是否可索引。
   *
   * 走与面板同源的 `scanExternal` + mount 的 include/exclude 过滤，保证
   * 「能搜到的」与「面板里看得见的」是同一批文件。单个挂载扫描失败只跳过
   * 它，不影响其余挂载，也绝不抛给调用方。
   */
  public listExternalSearchFiles(): Array<{ abs: string; name: string; mtime: number }> {
    const out: Array<{ abs: string; name: string; mtime: number }> = [];
    const mounts = this.settings.externalMounts ?? [];
    for (const mount of mounts) {
      if (!mount?.enabled || !mount.path) continue;
      const filter = compileFilter({
        include: mount.include ?? '',
        exclude: mount.exclude ?? '',
      });
      // exclude 优先、其次 include —— 与 buildTree 的判定保持一致。
      const keep = (rel: string): boolean => {
        if (filter.exclude?.test(rel)) return false;
        if (filter.include && !filter.include.test(rel)) return false;
        return true;
      };
      let entries: ScanEntry[];
      try {
        entries = scanExternal(mount.path, {
          shouldEnterDir: () => true,
          keepFile: keep,
        }).entries;
      } catch (e) {
        console.warn('[logseq] listExternalSearchFiles: scan failed for', mount.path, e);
        continue;
      }
      for (const entry of entries) {
        if (entry.isDir) continue;
        out.push({ abs: entry.abs, name: entry.name, mtime: entry.mtime ?? 0 });
      }
    }
    return out;
  }

  /**
   * 反查一个绝对路径属于哪个挂载，返回 `{mount, rel}`（rel 用 `/` 分隔）。
   * omnisearch 打开库外搜索结果时用它拼 `openExternalEntry` 需要的
   * mount + node。不在任何启用挂载下（或就是挂载根本身）返回 null。
   *
   * 嵌套挂载取**最长匹配**（最具体的那个），比较按 Windows 习惯忽略大小写。
   */
  public resolveExternalMount(abs: string): { mount: ExternalMount; rel: string } | null {
    const norm = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const target = norm(abs);
    const targetLower = target.toLowerCase();
    let best: { mount: ExternalMount; rel: string } | null = null;
    for (const mount of this.settings.externalMounts ?? []) {
      if (!mount?.enabled || !mount.path) continue;
      const root = norm(mount.path);
      if (!targetLower.startsWith(root.toLowerCase())) continue;
      const rel = target.slice(root.length).replace(/^\//, '');
      if (!rel) continue; // 挂载根本身不是文件
      if (!best || root.length > norm(best.mount.path).length) {
        best = { mount, rel };
      }
    }
    return best;
  }

  async openExternalEntry(
    mount: ExternalMount,
    node: MountNode,
    opts?: { readOnly?: boolean; forceCodeEditor?: boolean },
  ): Promise<void> {
    if (node.isDir) return;
    // Read-only means "show me, change nothing", and it is also the fallback
    // whenever a real editor cannot be given the file. Creating a link is a
    // genuine change to the user's library, so it happens only when they ask
    // for it from the row's context menu — never because they clicked a file.
    if (opts?.readOnly) {
      await this.openExternalInShimView(mount, node, { readOnly: true });
      return;
    }
    // An already-linked file has a real vault path, so open that and let
    // Obsidian dispatch on the extension as it would for any vault note.
    if (this.isLinkedInto(node)) {
      await this.app.workspace.openLinkText(linkVaultPath(safeSegment(node.name)), '', false);
      return;
    }
    // Routing is by CONTENT, not by file type: markdown is prose and belongs in
    // the block editor; everything else — code, config, `.gitignore`, `.env`,
    // plain text — is something you read line by line and belongs in the code
    // editor. An allowlist of "code extensions" was the wrong shape: it sends
    // every file the list forgot to the wrong editor, which is how a
    // `.gitignore` ended up rendered as a document with headings.
    // .ipynb 优先交给 jupyter notebook 插件（库外绝对路径 fs 直读直写）。
    // 未装/未启用时走原路由（通常被二进制门控交给系统）。
    if (extOfName(node.name) === 'ipynb') {
      // App 类型不暴露 plugins（iconTheme 同款防御式访问）
      const host = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins;
      const jupyter = host?.plugins?.['obsidian-jupyter-notebook'] as
        | { openExternalNotebook?: (p: string) => Promise<void> }
        | undefined;
      if (typeof jupyter?.openExternalNotebook === 'function') {
        await jupyter.openExternalNotebook(node.abs);
        return;
      }
    }
    if (isMarkdownFile(node.name)) {
      if (await this.openInBlockEditor(mount, node)) return;
    } else {
      // Real binaries have nothing to edit, so hand them to the system. Judged
      // by whole name as well as extension: `Dockerfile` and friends have no
      // extension and were being treated as binary, which sent them off to some
      // unrelated program instead of opening.
      if (!isTextFileName(node.name)) {
        this.openWithSystem(node.abs);
        return;
      }
      // 默认:混合视图(注释区 = Logseq 块,代码段 = Monaco);右键可切纯 Monaco。
      if (!opts?.forceCodeEditor) {
        if (await this.openInCodeDocView(mount, node)) return;
      }
      if (await this.openInCodeEditor(mount, node)) return;
    }
    await this.openExternalInShimView(mount, node, opts);
  }

  /**
   * Open an external markdown file in THIS plugin's block editor — the real
   * 2500-line editor, not a reduced stand-in, so folding, zoom, undo, drag and
   * inline markdown all work on an outside file.
   *
   * The route matters and was measured four ways. A `TextFileView` only mounts
   * with a file attached: `setViewState({type: 'logseq-block-editor'})` on an
   * empty leaf, with or without a `file` in its state, yields the "empty"
   * placeholder both times. What works is a leaf that is ALREADY showing a block
   * editor — so one is prepared in a NEW tab, and the external content is pushed
   * into it.
   *
   * The tab is separate on purpose. Seeding the ACTIVE leaf would retarget
   * whatever note the user had open, leaving them with a tab pointing at a file
   * they never asked for; reusing an existing block-editor tab would silently
   * replace their work. A fresh tab is the only variant that touches nothing.
   */
  /**
   * 用 ExternalCodeView 打开库外代码文件(默认纯 Monaco 代码编辑器,见
   * externalCodeHybrid 默认 false;用户 2026-10-18 决策「代码文件不用混合
   * 编辑器了」)。混合模式(注释区 = Logseq 块编辑器)仍可在设置或视图头部
   * 按钮按文件开启。库内代码文件经 registerExtensions 同走本视图。
   */
  private async openInCodeDocView(mount: ExternalMount, node: MountNode): Promise<boolean> {
    if (!isTextFileName(node.name)) return false;
    let data: string;
    try {
      data = readExternalText(node.abs);
    } catch {
      return false; // 混合视图打不开时回落(代码编辑器/shim 会给出提示)
    }
    const leaf = this.app.workspace.getLeaf(
      this.settings.externalSplitView === true ? 'split' : 'tab',
    );
    markLeafTabIcon(leaf, { name: node.name, rel: node.rel });
    await leaf.setViewState({
      type: VIEW_TYPE_EXTERNAL_CODE,
      active: true,
      state: {
        abs: node.abs,
        name: node.name,
        content: data,
        mountPath: mount.path,
        mountLabel: mount.label,
      },
    });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.refreshTabIcons();
    this.refreshTabIconsSoon();
    logOp(this, 'external.open', node.abs, 'ok', 'code-editor');
    return true;
  }
  private async openInBlockEditor(mount: ExternalMount, node: MountNode): Promise<boolean> {
    if (!isMarkdownFile(node.name)) return false;
    try {
      readExternalText(node.abs);
    } catch {
      return false; // the shim view reports the failure with the mount name
    }
    try {
      // A TextFileView only mounts with a real file, so one is opened and then
      // retargeted. Hand-attaching our own view DOES mount (measured) but leaves
      // Obsidian's view container empty — the screenshot showed the new-tab
      // placeholder instead of the file, with our tree squeezed below it, so that
      // route renders wrongly and is not used.
      //
      // Two things the user asked for, both here:
      //
      //  - Never touch an existing leaf. Reusing one (or the current tab) means
      //    the note they were reading gets replaced by the seed and then by the
      //    outside file — their work disappears from the screen.
      //  - Always a fresh tab. `getLeaf('tab')` creates one, so the seed's brief
      //    appearance is confined to a tab that did not exist a moment ago. The
      //    alternative, reusing a block editor already on screen, is instant
      //    (measured: a 5 ms window) but costs that editor's tab its contents.
      // The same route the code editor takes: an ItemView mounted by
      // setViewState, which needs no file at all. BlockEditorView is a
      // TextFileView and cannot be mounted that way, so a thin shell hosts it
      // (see ExternalBlockView for the measurements behind this).
      const leaf = this.app.workspace.getLeaf(
        this.settings.externalSplitView === true ? 'split' : 'tab',
      );
      markLeafTabIcon(leaf, { name: node.name, rel: node.rel });
      await leaf.setViewState({
      type: VIEW_TYPE_EXTERNAL_BLOCK,
      active: true,
      state: {
        abs: node.abs,
        name: node.name,
        rel: node.rel,
        mountLabel: mount.label,
        mountPath: mount.path,
      },
    });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.refreshTabIcons();
    this.refreshTabIconsSoon();
    logOp(this, 'external.open', node.abs, 'ok', 'block-editor');
    return true;
    } catch (e) {
      logOp(this, 'external.open', node.abs, 'error', String(e).slice(0, 160));
      return false;
    }
  }

  /**
   * Open an external code file in the plugin's own code editor.
   *
   * Code Files cannot be driven from outside: it exposes no plugin API (checked
   * its source — the only entry point is a static method on its view class, not
   * reachable from the instance), and its view is a TextFileView, so
   * setViewState without a file mounts nothing (measured: the leaf came back as
   * the "empty" placeholder). Rather than give up on code files, this opens them
   * in a view we own, which saves back to the original file.
   */
  private async openInCodeEditor(mount: ExternalMount, node: MountNode): Promise<boolean> {
    if (isMarkdownFile(node.name)) return false;
    let data: string;
    try {
      data = readExternalText(node.abs);
    } catch {
      return false; // the shim view reports the failure with the mount name
    }
    // Our code view is a plain ItemView, not a TextFileView, so it mounts
    // without a file — no seed needed here (measured: setViewState on a
    // TextFileView type with no TFile yields the "empty" placeholder, which is
    // why the markdown path above has to borrow a live editor).
    const leaf = this.app.workspace.getLeaf('tab');
    markLeafTabIcon(leaf, { name: node.name, rel: node.rel });
    await leaf.setViewState({
      type: VIEW_TYPE_EXTERNAL_CODE,
      active: true,
      state: {
        abs: node.abs,
        name: node.name,
        content: data,
        mountPath: mount.path,
        mountLabel: mount.label,
        // 右键「纯代码编辑器」入口:该文件覆盖为纯源码呈现(可头部按钮切回)
        hybrid: false,
      },
    });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.refreshTabIcons();
    this.refreshTabIconsSoon();
    logOp(this, 'external.open', node.abs, 'ok', 'code-editor');
    return true;
  }

  /** True when a link for this entry is already present in the vault. */
  isLinkedInto(node: MountNode): boolean {
    const base = this.vaultBasePath();
    if (!base) return false;
    return exists(linkTargetFor(base, node.name, safeSegment(node.name)));
  }

  /**
   * True when a file at `abs` can be given a real path in this vault.
   *
   * A hard link needs both paths on the same volume (measured: cross-volume
   * fails with "系统无法将文件复制到不同的磁盘驱动器"), while a directory
   * junction crosses volumes fine. So the check is about the volume, not the
   * file type — and it is why the shim view still exists as a fallback.
   */
  canOpenNatively(abs: string): boolean {
    const base = this.vaultBasePath();
    if (!base) return false;
    return sameVolume(base, abs);
  }

  /**
   * Wait until the vault has indexed `path`, so a link created a moment ago can
   * be opened by name.
   *
   * A link made while Obsidian is running is on disk immediately but reaches the
   * indexer on its own schedule; opening it in that window resolves to nothing
   * and leaves the "empty" placeholder view. Measured: with the link present at
   * startup, `openLinkText` works on the first try, so this only has to cover
   * the just-created case.
   */
  async waitForIndex(path: string, timeoutMs = 3000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    // The indexer reacts to a vault event, so yield to it between checks rather
    // than spinning on a tight loop.
    while (Date.now() < deadline) {
      if (this.app.vault.getAbstractFileByPath(path)) return true;
      await new Promise((r) => setTimeout(r, 120));
    }
    return this.app.vault.getAbstractFileByPath(path) !== null;
  }

  /**
   * Fallback: the block-styled view that reads and writes the file directly.
   * Used when a real vault path cannot be created (e.g. the file is on another
   * volume). Same parser and serializer, so the markdown is identical — what is
   * missing is the native take-over, block references and backlinks.
   */
  private async openExternalInShimView(
    mount: ExternalMount,
    node: MountNode,
    opts?: { readOnly?: boolean },
  ): Promise<void> {
    let content: string;
    try {
      content = readExternalText(node.abs);
    } catch (e) {
      // Name the mount, because the user clicked a row in a tree of many and
      // an absolute path alone would not tell them which one failed.
      new Notice(`无法读取「${mountDisplayName(mount)}」中的 ${node.name}：${String(e).slice(0, 90)}`);
      logOp(this, 'external.read', node.abs, 'error', String(e).slice(0, 200));
      return;
    }
    // Reuse the tab already showing this file instead of stacking duplicates.
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_EXTERNAL_FILE)) {
      const view = leaf.view as ExternalFileView | null;
      if (view?.abs === node.abs && view.readOnly === false) {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        return;
      }
    }
    const leaf = this.app.workspace.getLeaf('tab');
    markLeafTabIcon(leaf, { name: node.name, rel: node.rel });
    await leaf.setViewState({
      type: VIEW_TYPE_EXTERNAL_FILE,
      active: true,
      state: { abs: node.abs, name: node.name, readOnly: opts?.readOnly === true },
    });
    const view = leaf.view as ExternalFileView | null;
    if (view) await view.openExternal({ abs: node.abs, name: node.name, content, readOnly: opts?.readOnly });
    this.refreshTabIcons();
    this.refreshTabIconsSoon();
  }

  /** Hand a path to the OS default program. */
  openWithSystem(abs: string): void {
    try {
      const electron = (window as unknown as { require?: (id: string) => unknown }).require?.('electron') as
        | { shell?: { openPath?: (p: string) => Promise<string> } }
        | undefined;
      if (electron?.shell?.openPath) {
        void electron.shell.openPath(abs);
        return;
      }
    } catch {
      /* fall through to the notice below */
    }
    new Notice(`没有可用的系统打开方式：${abs}`);
  }

  /** Reveal a path in Explorer. */
  revealInSystem(abs: string): void {
    try {
      const electron = (window as unknown as { require?: (id: string) => unknown }).require?.('electron') as
        | { shell?: { showItemInFolder?: (p: string) => void } }
        | undefined;
      if (electron?.shell?.showItemInFolder) {
        electron.shell.showItemInFolder(abs);
        return;
      }
    } catch {
      /* fall through */
    }
    new Notice(abs);
  }

  /** Open an entry that has been linked into the vault, natively. */
  async openLinked(linkName: string, rel = ''): Promise<void> {
    await this.app.workspace.openLinkText(linkVaultPath(linkName, rel), '', false);
  }
}
