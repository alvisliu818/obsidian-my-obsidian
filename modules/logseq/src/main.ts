/**
 * Plugin entry: view registration, setViewState take-over patch, commands,
 * vault-wide block-id index, and clean uninstall (restore native views).
 */

import { Menu, MarkdownView, Notice, Platform, Plugin, TAbstractFile, TFile, WorkspaceLeaf, type CachedMetadata, type ViewState } from 'obsidian';
import { BlockEditorView, VIEW_TYPE_BLOCK_EDITOR } from './view/BlockEditorView';
import { FragmentHost, type FragmentOptions } from './blocks/fragmentEditor';
import { CMD_COLLAPSE_ALL, CMD_FIND, CMD_REPLACE } from './interactions/hotkeys';
import {
  DEFAULT_SETTINGS,
  editorChoiceFromProps,
  parseFolderList,
  pathInFolders,
  shortcutOverridesFrom,
  takeOverForFile,
  contentSearchFrom,
  type BlockEditorSettings,
  type EditorChoice,
} from './types';
import { isMarkdownFile } from './features/codeFileKind';
import { isTextFileName } from '../../doc-tree/src/features/mountFilter';
import { FileExplorerLocateButton } from './features/fileExplorerLocate';
import { LogseqEditorSettingTab } from './settings/tab';
import { initEditorSettingsStore, loadEditorSettings, saveEditorSettings } from './settings/editorSettingsStore';
import { BlockIndex } from './index/blockIndex';
import { vaultSlugOf } from '../../index-core/src/sqlite-service';
import { BlockIndexDaemonClient, forwardVaultEvents } from '../../unified-search/src/daemon/daemonClient';
import { PrologQueryBuilderModal } from './features/prologBuilder';
import { prologTemplate } from './features/prologQuery';
import { TodoPanelView, VIEW_TYPE_TODO_PANEL } from './panels/todoPanel';
import { BacklinkPanelView, VIEW_TYPE_BACKLINK_PANEL } from './panels/backlinkPanel';
import { TagPanelView, VIEW_TYPE_TAG_PANEL } from './panels/tagPanel';
import { BlockSearchModal } from './panels/blockSearch';
import { FlashcardPanelView, VIEW_TYPE_FLASHCARD_PANEL } from './panels/flashcardPanel';
import { BlockGraphModal } from './panels/blockGraph';
import { ExternalFileView, VIEW_TYPE_EXTERNAL_FILE } from './views/ExternalFileView';
import { ExternalCodeView, VIEW_TYPE_EXTERNAL_CODE } from './views/ExternalCodeView';
import { CodeDocView, VIEW_TYPE_CODE_DOC } from './views/CodeDocView';
import { ExternalBlockView, VIEW_TYPE_EXTERNAL_BLOCK } from './views/ExternalBlockView';
import { VIEW_TYPE_IMAGE, isImageFile } from '../../doc-tree/src/views/ImageView';
import { VIEW_TYPE_VIDEO, isVideoFile } from '../../doc-tree/src/views/VideoView';
import { OFFICE_EXTENSIONS } from '../../doc-tree/src/office/types';
import { ContentSearchPanelView, VIEW_TYPE_CONTENT_SEARCH } from './panels/contentSearchPanel';
import { RecentPanelView, VIEW_TYPE_RECENT_PANEL, pushRecent } from './panels/recentPanel';
import { addOpenWithMenuItems } from '../../doc-tree/src/features/openWith';
import { mountDisplayName, type ExternalMount } from '../../doc-tree/src/types';
import type { MountNode } from '../../doc-tree/src/features/mountFilter';
import { docTreeOf } from '../../doc-tree/src/main';
import { registerOpener, removeOpeners } from '../../doc-tree/src/openers';
import { readExternalText } from '../../doc-tree/src/features/extFs';
import { VIEW_TYPE_OFFICE } from '../../doc-tree/src/views/OfficeView';
import { activateIconThemeByPreference } from '../../doc-tree/src/extensions/iconThemeLoader';
import type { HeaderMenuHost } from './views/headerPath';
import { openJournal } from './features/dailyNote';
import { BackupManager } from './core/backup';
import { registerNativeImgFix } from './features/nativeImgFix';
import { applyMarkedTabIcons, markLeafTabIcon } from '../../doc-tree/src/features/tabIcon';
import { ExtensionMarketModal } from './extensions/marketModal';
import { restoreAllExtensions, registerExtensionConsumer, search as extSearch, installExtension, uninstallExtension, toggleExtension, reinstallExtension, getInstalledExtensions } from './extensions/extensionManager';
import { isExtensionInstalled } from './extensions/extensionStore';
import { hasGrammarForFence } from './extensions/tmEngine';
import { applyCodeThemePreference, warmUpSharedBlockEditor, disposeMonaco } from './editor/monaco';
import { TerminalView, VIEW_TYPE_TERMINAL } from './terminal/terminalView';
import { shutdownPtyHelper, findNodeExe } from './terminal/ptyClient';
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
  /** 守护进程索引客户端(档位 2):桌面 + sqliteIndexEnabled 时取代内存 blockIndex。 */
  daemonIndex: BlockIndexDaemonClient | null = null;
  /** daemon 模式下的索引变更监听器(等价 blockIndex.onRebuild 的 listener 集)。 */
  private readonly daemonIndexListeners = new Set<() => void>();
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
    void ensureTmEngineReady().catch(() => {/* wasm 失败时回落 Prism */}).then(() => restoreAllExtensions(this));
    void loadOpLog(this);
    logOp(this, 'plugin.load', '', 'ok', `v${this.manifest.version}`);

    this.registerView(VIEW_TYPE_BLOCK_EDITOR, (leaf) => new BlockEditorView(leaf, this));
    this.registerView(VIEW_TYPE_TODO_PANEL, (leaf) => new TodoPanelView(leaf, this));
    this.registerView(VIEW_TYPE_BACKLINK_PANEL, (leaf) => new BacklinkPanelView(leaf, this));
    this.registerView(VIEW_TYPE_TAG_PANEL, (leaf) => new TagPanelView(leaf, this));
    this.registerView(VIEW_TYPE_FLASHCARD_PANEL, (leaf) => new FlashcardPanelView(leaf, this));
    this.registerView(VIEW_TYPE_EXTERNAL_FILE, (leaf) => new ExternalFileView(leaf, this));
    this.registerView(VIEW_TYPE_EXTERNAL_CODE, (leaf) => new ExternalCodeView(leaf, this));
    // CodeDocView 是旧混合视图(已被 ExternalCodeView 的新混合引擎取代,不再是
    // 打开入口);保留注册只为恢复旧 workspace 布局里已存在的 leaf。
    this.registerView(VIEW_TYPE_CODE_DOC, (leaf) => new CodeDocView(leaf, this));
    this.registerView(VIEW_TYPE_EXTERNAL_BLOCK, (leaf) => new ExternalBlockView(leaf, this));
    this.registerView(VIEW_TYPE_CONTENT_SEARCH, (leaf) => new ContentSearchPanelView(leaf, this));
    this.registerView(VIEW_TYPE_RECENT_PANEL, (leaf) => new RecentPanelView(leaf, this));

    // 库内 .code-workspace 等代码扩展名的注册**不在这里**做:宿主 onload 的
    // registerCodeFiles() 会按 TEXT_MOUNT_EXTENSIONS 派生的 DEFAULT_CODE_EXTENSIONS
    // 统一注册到本模块的 ExternalCodeView(用户指令 2026-10-25:库内库外同一
    // 编辑器)。这里再注册一遍是冗余,还抢在宿主前面占坑。

    // ---- 库外文件 opener 登记(2026-10-27 模块拆分)----
    // 库外文件的打开路由归 doc-tree 模块(openExternalEntry);md/文本的编辑
    // 路线在本模块,按 doc-tree openers.ts 的契约登记进去。doc-tree 先于本
    // 模块引导(descriptor 顺序),它被禁用时 docTreeOf 为 null——库外 md/text
    // 没有编辑路线,原生路线(doc-tree 自己的)不受影响。
    registerOpener({
      owner: 'logseq',
      route: 'markdown',
      open: async (_ctx, mount, node) => {
        if (!isMarkdownFile(node.name)) return false;
        return this.openInBlockEditor(mount, node);
      },
    });
    registerOpener({
      owner: 'logseq',
      route: 'code',
      open: async (_ctx, mount, node, opts) => {
        if (isMarkdownFile(node.name) || !isTextFileName(node.name)) return false;
        if (!opts?.forceCodeEditor && (await this.openInCodeDocView(mount, node))) return true;
        return this.openInCodeEditor(mount, node);
      },
    });
    registerOpener({
      owner: 'logseq',
      route: 'shim',
      open: async (_ctx, mount, node, opts) => {
        await this.openExternalInShimView(mount, node, opts);
        return true;
      },
    });
    this.register(() => removeOpeners('logseq'));

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
    // `\(…\)` / `\[…\]` 公式渲染**不在这里注册**：正主是 latex-delimiter-renderer
    // 模块（宿主里单独一个开关），它自己注册实时预览与阅读模式两条路。本模块
    // 只负责那些「自己掌握源但没有 section 信息」的渲染面 —— 静态块、内嵌、
    // 闪卡、代码块前缀、库外文件 —— 通过 features/latexSource 转发。

    // Vault-wide ((block-id)) index。indexExcludedFolders 的目录不进索引:
    // 备份/参考资料不吃索引内存(~99 万块 ≈ 250-300MB),反链面板也没有副本噪音。
    // 谓词直读设置(每次调用现取),设置热改后「重建块索引」即生效。
    //
    // 档位 2(2026-10-25):桌面 + sqliteIndexEnabled 时改走守护进程——
    // 独立 node 进程独占 SQLite(better-sqlite3,FTS5),渲染进程只留小常驻
    // 缓存(byId 池 ~90 块/标签/卡片),JS 堆 -160~190MB。失败自动回落内存索引。
    const daemonMode = Platform.isDesktopApp && this.settings.sqliteIndexEnabled;
    if (daemonMode) {
      this.daemonIndex = await this.startDaemonIndex();
    }
    // daemon-only(2026-10-25 用户指定「daemon 起不来时就不要索引」):内存
    // blockIndex 与渲染内 sqliteIndex 两层回落全部退役——索引要么在独立
    // 守护进程里,要么没有(旧兜底正是双启动 OOM 白屏的半个根源)。
    // daemon 起不来时 syncIndex=null,消费方(全是 ?. 调用)渲染空。
    this.app.workspace.onLayoutReady(() => {
      if (this.daemonIndex) void this.daemonIndex.upsertFiles([]); // 触发一次 changed→缓存预热
      if (this.settings.pagePropsEditor === 'native') void this.resolveNativePropsCtor();
      this.convertOpenMarkdownLeaves();
      // 预热块内代码块的 Monaco 单例:延后一拍再建,不与启动期的布局/索引
      // 抢主线程(建实例是一次性的,晚 1.5s 不影响「第一次点进代码块」的体验)。
      if (this.settings.codeBlockPrewarm) {
        window.setTimeout(() => warmUpSharedBlockEditor(this), 1500);
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
        if (this.daemonIndex) {
          void this.daemonIndex.rebuild().then(() => new Notice('Block index rebuilt (daemon).'));
        } else {
          new Notice('索引守护进程未运行(daemon-only,无索引可重建)。');
        }
      },
    });

    this.addCommand({
      id: 'turbo-rebuild-block-index',
      name: 'Turbo rebuild the block index (max resources)',
      callback: () => void this.runTurbo('rebuild'),
    });

    this.addCommand({
      id: 'turbo-sync-block-index',
      name: 'Turbo sync the block index (incremental, max resources)',
      callback: () => void this.runTurbo('sync'),
    });

    this.addCommand({
      id: 'sync-sqlite-index',
      name: 'Sync the SQLite index with the vault files',
      checkCallback: (checking) => {
        if (!this.daemonIndex) return false;
        if (!checking) void this.daemonIndex.sync();
        return true;
      },
    });

    this.addCommand({
      id: 'rebuild-sqlite-index',
      name: 'Rebuild the SQLite index from markdown',
      checkCallback: (checking) => {
        if (!this.daemonIndex) return false;
        if (!checking) void this.daemonIndex.rebuild();
        return true;
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
          if (!path || !this.syncIndex?.supertagDef(path)) return false;
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
    this.addCommand({
      id: 'open-in-video-view',
      name: 'Open this video in the video player',
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !isVideoFile(file.name)) return false;
        if (checking) return true;
        void this.openInView(VIEW_TYPE_VIDEO, file);
        return true;
      },
    });

    // File-explorer context menu: the "open with" entries plus the two new
    // viewers. Registered as an event so Obsidian owns the menu's lifetime.
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (file instanceof TFile) {
          menu.addSeparator();
          addOpenWithMenuItems(this.app, file, menu, docTreeOf(this.app)?.settings.openWithApps ?? []);
          if (isImageFile(file.name)) {
            menu.addItem((item) =>
              item
                .setTitle('在增强图片查看器中打开')
                .setIcon('image' as never)
                .onClick(() => void this.openInView(VIEW_TYPE_IMAGE, file)),
            );
          }
          if (isVideoFile(file.name)) {
            menu.addItem((item) =>
              item
                .setTitle('在视频播放器中打开')
                .setIcon('play' as never)
                .onClick(() => void this.openInView(VIEW_TYPE_VIDEO, file)),
            );
          }
          if (docTreeOf(this.app)?.settings.officeViewerEnabled !== false && OFFICE_EXTENSIONS.includes(file.extension.toLowerCase())) {
            menu.addItem((item) =>
              item
                .setTitle('用 Office 预览器打开')
                .setIcon('file-text' as never)
                .onClick(() => void this.openInView(VIEW_TYPE_OFFICE, file)),
            );
          }
          // 库内文本文件(Obsidian 没有应用内编辑器,默认只能丢给系统)给一个
          // 代码编辑器入口——与库外「同一文件同一编辑器」对齐(用户指令
          // 2026-10-25:Code.code-workspace 类型文件)。md 有块编辑器、canvas
          // 有自己的视图,不在此列。
          if (
            isTextFileName(file.name) &&
            !isMarkdownFile(file.name) &&
            file.extension.toLowerCase() !== 'canvas'
          ) {
            menu.addItem((item) =>
              item
                .setTitle('用代码编辑器打开')
                .setIcon('code' as never)
                .onClick(() => void this.openVaultFileInCodeEditor(file)),
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
    // 守护进程收尾:先停事件再 dispose(退出流会把 in-flight 请求全 reject)。
    this.daemonIndex?.dispose();
    this.daemonIndex = null;

    // 块内代码块的 Monaco 单例常驻在 body 的隐藏池里,不显式销毁会随插件
    // 禁用/重载泄漏(外部代码视图的实例由各自的 view 自己 dispose)。
    disposeMonaco();
    void shutdownAllLsp();
    shutdownPtyHelper();
    logOp(this, 'plugin.unload', '', 'ok');
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
    if (typeof this.settings.indexExcludedFolders !== 'string') this.settings.indexExcludedFolders = '';
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

    this.settings.recentFiles = Array.isArray(this.settings.recentFiles)
      ? this.settings.recentFiles.filter((p): p is string => typeof p === 'string').slice(0, 60)
      : [];
    this.settings.contentSearch = contentSearchFrom(this.settings.contentSearch);
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

  /** daemon 模式:订阅索引变更(与 blockIndex.onRebuild 同语义)。 */
  onDaemonIndexChange(cb: () => void): () => void {
    this.daemonIndexListeners.add(cb);
    return () => {
      this.daemonIndexListeners.delete(cb);
    };
  }

  /**
   * 统一的同步索引访问面(消费方用):daemon 模式返回客户端(小缓存同步 API),
   * 否则返回内存 blockIndex。两者同形(withIds/get/allTags/allCards/supertag*)。
   */
  /** 组装并启动守护进程索引客户端(桌面 + sqliteIndexEnabled)。失败返回 null——
   *  daemon-only:没有第二层索引兜底,失败即「无索引」。 */
  private async startDaemonIndex(): Promise<BlockIndexDaemonClient | null> {
    const client = new BlockIndexDaemonClient({
      app: this.app,
      pluginDir: this.manifest.dir ?? '',
      dbPath: this.sqliteDbPath,
      findNode: findNodeExe,
      excludes: () => parseFolderList(this.settings.indexExcludedFolders),
      onChange: () => this.notifyBlockIndexConsumers(),
    });
    try {
      await client.start();
      forwardVaultEvents(this, client);
      return client;
    } catch (e) {
      console.warn('[logseq] index daemon failed to start (no fallback index):', e);
      client.dispose();
      return null;
    }
  }

  get syncIndex(): {
    withIds(): import('./index/blockIndex').IndexedBlock[];
    get(id: string): import('./index/blockIndex').IndexedBlock | null;
    allTags(): string[];
    allCards(): import('./index/blockIndex').CardEntry[];
    supertagRegistry(): Map<string, import('./features/supertags').SupertagDef>;
    supertagDef(name: string): import('./features/supertags').SupertagDef | null;
    supertagInstances(tag: string): import('./index/blockIndex').IndexedBlock[];
    onRebuild(cb: () => void): () => void;
    readonly version: number;
  } | null {
    // daemon 客户端没有 onRebuild(监听器住在 plugin 上)——包一层同形适配。
    const d = this.daemonIndex;
    if (!d) return this.blockIndex;
    return {
      withIds: () => d.withIds(),
      get: (id: string) => d.get(id),
      allTags: () => d.allTags(),
      allCards: () => d.allCards(),
      supertagRegistry: () => d.supertagRegistry(),
      supertagDef: (name: string) => d.supertagDef(name),
      supertagInstances: (_tag: string) => [], // 异步查询,同步面禁用(调用方直接用 daemonIndex)
      onRebuild: (cb: () => void) => this.onDaemonIndexChange(cb),
      get version() { return d.version; },
    } as unknown as NonNullable<ReturnType<() => LogseqEditorPlugin['syncIndex']>>;
  }

  /** badge 预取缓存(daemon 模式):当前打开文件的块引用反链,打开/变更时刷新。 */
  daemonPrefetchedRefs: Map<string, import('./index/blockIndex').BacklinkEntry[]> = new Map();

  /** daemon changed 事件落地:唤醒全部消费方缓存。 */
  notifyBlockIndexConsumers(): void {
    for (const cb of [...this.daemonIndexListeners]) {
      try {
        cb();
      } catch {
        /* 同 blockIndex.notify:监听器错误不外溢 */
      }
    }
  }

  /** 索引排除(独立于编辑器排除):这些目录不进块索引/块级反链。 */
  isIndexExcluded(file: string): boolean {
    return pathInFolders(file, parseFolderList(this.settings.indexExcludedFolders ?? ''));
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

  // ------------------------------------------------------------------
  // SQLite secondary index (markdown is the source of truth)
  // ------------------------------------------------------------------

  /**
   * Where the disposable database image is kept. Configurable via settings
   * (`sqliteDbDir`), default `E:\HOME\Runtime` — an arbitrary Node-fs
   * absolute path, because vault.adapter resolves every path against the
   * vault root and cannot reach outside it.
   */
  private get sqliteDbPath(): string {
    const dir = (this.settings.sqliteDbDir || '').trim().replace(/[\\/]+$/, '');
    // 命名沿 unified-index 惯例(vaultSlugOf,2026-10-25 用户指定):
    // E__HOME_BaiduSyncdisk-9d1843.sqlite——slug 后缀哈希可反查归属库
    // (后缀 .sqlite,用户 2026-10-25 指定)。目录 = unified-index(unified-search
    // 的旧 .db 已退役删除,新索引独占该目录;命名沿 unified-index 的
    // vaultSlugOf 惯例,可反查归属库;每库一个文件,共享文件会互清索引)。
    const base = (this.app.vault.adapter as { getBasePath?: () => string }).getBasePath?.() ?? '';
    return `${dir || 'E:/HOME/Runtime/unified-index'}/${vaultSlugOf(base)}.sqlite`;
  }

  /**
   * 狂暴索引(用户指定,2026-10-25):rebuild=全量重建 / sync=增量补索引。
   * 进度条用可更新 Notice;结束后报耗时与规模。仅 daemon 模式(内存索引
   * 没有这条路径)。public:设置页的狂暴按钮也走这里。
   */
  async runTurbo(mode: 'rebuild' | 'sync'): Promise<void> {
    const d = this.daemonIndex;
    if (!d) {
      new Notice('狂暴索引需要守护进程模式(设置里开启 SQLite 索引并重启)。');
      return;
    }
    const label = mode === 'rebuild' ? '狂暴重建' : '狂暴增量';
    const progressNotice: { current: Notice | null } = { current: null };
    let lastText = '';
    const show = (done: number, total: number): void => {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const text = `${label}: ${done}/${total} (${pct}%)`;
      if (text !== lastText) {
        lastText = text;
        progressNotice.current?.hide();
        progressNotice.current = new Notice(text, 0);
      }
    };
    show(0, 0);
    try {
      const r = await (mode === 'rebuild' ? d.turboRebuild(show) : d.turboSync(show));
      progressNotice.current?.hide();
      new Notice(`${label}完成: ${r.files} 文件 / ${r.blocks} 块 / ${r.ms}ms`);
      this.notifyBlockIndexConsumers();
    } catch (e) {
      progressNotice.current?.hide();
      new Notice(`${label}失败: ${String(e).slice(0, 120)}`);
    }
  }

  /** Called by the settings tab when the SQLite toggles change. daemon-only:
   *  关 = 停守护进程(无兜底索引);开 = 现场拉起。 */
  applySqliteSettings(): void {
    const want = this.settings.sqliteIndexEnabled;
    if (!want && this.daemonIndex) {
      this.daemonIndex.dispose();
      this.daemonIndex = null;
      this.notifyBlockIndexConsumers();
      return;
    }
    if (want && !this.daemonIndex && Platform.isDesktopApp) {
      void this.startDaemonIndex().then((c) => {
        if (c) void this.daemonIndex?.upsertFiles([]); // 触发 changed→缓存预热
        this.notifyBlockIndexConsumers();
      });
    }
  }

  /**
   * 数据库位置（sqliteDbDir）变更后调用：daemon 的库文件路径在启动时定格，
   * 热改不重开——提示重启生效。旧位置的索引文件不迁移、不删除——用户自己处置。
   */
  restartSqliteIndex(): void {
    new Notice('索引库位置变更后需重启 Obsidian 生效。');
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
    // 库外壳视图(logseq-external-block)内持块编辑器,同属 Logseq 编辑模式——
    // 不认它的话,库外文件的状态栏模式芯片直接隐身。
    if (this.app.workspace.getActiveViewOfType(ExternalBlockView)) return 'edit';
    const md = this.app.workspace.getActiveViewOfType(MarkdownView);
    // Obsidian's own raw source mode (mode 'source' + source flag true) —
    // NOT live preview, which is also an editing mode.
    if (md && md.getMode() === 'source' && md.getState()['source'] === true) return 'source';
    return 'native';
  }

  /**
   * 活动原生 Markdown 视图里的文件是不是库外文件（TExternalFile，path 带
   * `file:` 前缀）。是 → 返回磁盘绝对路径；库内文件/非外部 → null。
   */
  private externalMarkdownAbs(md: MarkdownView): string | null {
    const p = md.file?.path ?? '';
    return this.isExternalVaultPath(p) ? p.slice('file:'.length) : null;
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
    // 库外壳视图:内持块编辑器,与库内 BlockEditorView 同属「Logseq 编辑」档。
    const shell = this.app.workspace.getActiveViewOfType(ExternalBlockView);
    const md = this.app.workspace.getActiveViewOfType(MarkdownView);
    const mdExtAbs = md ? this.externalMarkdownAbs(md) : null;
    if (mode === 'edit') {
      if (shell) return;
      if (mdExtAbs) await this.switchExternalToBlockEditor(leaf, mdExtAbs);
      else if (!blockView && md) await this.switchToBlockEditor(leaf);
    } else if (mode === 'source') {
      if (blockView) this.switchToNative(leaf, 'source');
      else if (shell) this.switchExternalToNativeEditor(leaf, 'source');
      else if (md && !(md.getState()['source'] === true)) await this.setNativeSourceMode(leaf, true);
    } else {
      if (blockView) this.switchToNative(leaf);
      else if (shell) this.switchExternalToNativeEditor(leaf);
      else if (md && md.getState()['source'] === true) await this.setNativeSourceMode(leaf, false);
    }
    // In-view mode flips fire neither active-leaf-change nor layout-change —
    // refresh the chip explicitly.
    this.updateStatusBar();
  }

  /**
   * 库外壳视图 → Obsidian 原生编辑器（库外 TExternalFile 原生可编辑，1.14.4+）。
   * `sourceMode` 传 'source' 时直接落在整文件源码形态。
   */
  private switchExternalToNativeEditor(leaf: WorkspaceLeaf, sourceMode?: 'source'): void {
    const shell = leaf.view as ExternalBlockView | null;
    const abs = shell?.abs;
    if (!abs || !this.canOpenNativeExternal()) return;
    const state: Record<string, unknown> = { file: 'file:' + abs };
    if (sourceMode) {
      state.mode = 'source';
      state.source = true;
    }
    // file: 前缀会让接管补丁自己走原生分支；bypass 双保险。
    void this.bypassingSetViewState(leaf, { type: 'markdown', state, active: true } as ViewState);
  }

  /** 库外文件的原生编辑器 → 回 Logseq 块编辑器（壳视图按 abs 重建）。 */
  private async switchExternalToBlockEditor(leaf: WorkspaceLeaf, abs: string): Promise<void> {
    const name = abs.split(/[\\/]/).pop() ?? abs;
    await leaf.setViewState({
      type: VIEW_TYPE_EXTERNAL_BLOCK,
      state: { abs, name },
      active: true,
    } as ViewState);
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

  /**
   * 库内文件 → ExternalCodeView(用户指令 2026-10-25:Code.code-workspace
   * 类型文件等 Obsidian 没有应用内编辑器的文本,给一个代码编辑器入口)。
   * 视图的 setState 认 `{file}`(vault 相对路径),自己解析真实路径并挂
   * inVault 徽标;叶策略与库外 openInCodeDocView 同(设置分屏否则新标签)。
   */
  async openVaultFileInCodeEditor(file: TFile): Promise<void> {
    const leaf = this.app.workspace.getLeaf(this.extSplitView() ? 'split' : 'tab');
    markLeafTabIcon(leaf, { name: file.name, rel: file.path });
    await leaf.setViewState({
      type: VIEW_TYPE_EXTERNAL_CODE,
      active: true,
      state: { file: file.path },
    });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
    this.refreshTabIcons();
    this.refreshTabIconsSoon();
    logOp(this, 'vault.open', file.path, 'ok', 'code-editor');
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
    const info = this.syncIndex?.get(blockId);
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
    const leaf = this.app.workspace.getLeaf(this.extSplitView() ? 'split' : 'tab');
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
      const leaf = this.app.workspace.getLeaf(this.extSplitView() ? 'split' : 'tab');
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

  // ------------------------------------------------------------------
  // 虚拟文档树门面(2026-10-27 模块拆分)
  //
  // 库外文件的挂载面板/路由/查看器整体迁往 doc-tree 模块。这里保留的四个
  // 方法是跨模块兼容门面:omnisearch/unified-search 按 legacyId 取本模块
  // (live.get('logseq')),renderTree 经 host.plugin 调媒体打开——调用点不动,
  // 实现委托 docTreeOf()。doc-tree 被禁用时门面降级为 Notice/空结果。
  // ------------------------------------------------------------------

  /** 库外文件叶策略(设置已迁 doc-tree,经模块实例读)。 */
  private extSplitView(): boolean {
    return docTreeOf(this.app)?.settings.externalSplitView === true;
  }

  /** 兼容门面:打开一个库外挂载条目(omnisearch 搜索结果 / e2e 探针入口)。 */
  async openExternalEntry(
    mount: ExternalMount,
    node: MountNode,
    opts?: { readOnly?: boolean; forceCodeEditor?: boolean; forceBlockEditor?: boolean },
  ): Promise<void> {
    const dt = docTreeOf(this.app);
    if (!dt) {
      new Notice('虚拟文档树模块未启用，无法打开库外文件。');
      return;
    }
    await dt.openExternalEntry(mount, node, opts);
  }

  /** 兼容门面:库外媒体(图片/视频)→ doc-tree 的增强查看器/播放器。 */
  async openExternalInView(viewType: string, spec: { abs: string; name?: string }): Promise<void> {
    await docTreeOf(this.app)?.openExternalInView(viewType, spec);
  }

  /** 兼容门面:反查绝对路径属于哪个挂载(omnisearch 打开库外结果用)。 */
  resolveExternalMount(abs: string): { mount: ExternalMount; rel: string } | null {
    return docTreeOf(this.app)?.resolveExternalMount(abs) ?? null;
  }

  /** 兼容门面:列举库外可搜索文件(omnisearch / unified-search 的数据源)。 */
  listExternalSearchFiles(): Array<{ abs: string; name: string; mtime: number }> {
    return docTreeOf(this.app)?.listExternalSearchFiles() ?? [];
  }

  /**
   * doc-tree 的操作日志转发入口:doc-tree 不 import 本模块(分层规则),
   * 经插件表运行时反查把 mount.add / external.open 等记录写进同一条
   * .logseq-editor/log.jsonl。
   */
  logOpPublic(op: string, file: string, status: 'ok' | 'error' | 'skipped', detail = ''): void {
    logOp(this, op, file, status, detail);
  }

  /**
   * HeaderMenuHost 适配面（headerPath 面包屑）：externalMounts 已随挂载域迁往
   * doc-tree、revealInSystem 是 DocTreePlugin 的方法，这里合成一个满足
   * HeaderMenuHost 的对象给三个库外视图，避免它们各自摸 docTreeOf。
   */
  get headerMenuHost(): HeaderMenuHost {
    const dt = docTreeOf(this.app);
    return {
      settings: { externalMounts: dt?.settings.externalMounts },
      app: this.app,
      // mount is ExternalMountLike by the interface, but headerPath only ever
    // feeds back entries taken from host.settings.externalMounts — i.e. these
    // are full doc-tree ExternalMounts at runtime.
    openExternalEntry: (mount, node) => this.openExternalEntry(mount as ExternalMount, node),
      revealInSystem: (abs) => dt?.revealInSystem(abs),
    };
  }
}
