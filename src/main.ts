/**
 * Plugin entry: view registration, setViewState take-over patch, commands,
 * vault-wide block-id index, and clean uninstall (restore native views).
 */

import { Menu, MarkdownView, Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf, debounce, normalizePath, type CachedMetadata, type ViewState } from 'obsidian';
import { BlockEditorView, VIEW_TYPE_BLOCK_EDITOR } from './view/BlockEditorView';
import { CMD_COLLAPSE_ALL, CMD_FIND, CMD_REPLACE } from './interactions/hotkeys';
import {
  DEFAULT_SETTINGS,
  editorChoiceFromProps,
  parseFolderList,
  pathInFolders,
  shortcutOverridesFrom,
  takeOverForFile,
  type BlockEditorSettings,
  type EditorChoice,
} from './types';
import { LogseqEditorSettingTab } from './settings/tab';
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
import { openJournal } from './features/dailyNote';
import { BackupManager } from './core/backup';
import { loadOpLog, logOp, flushOpLog } from './features/logger';
import { OpLogModal } from './features/opLogModal';
import { BackupRestoreModal } from './features/backupModal';
import { builtinSlashItems, registerSlashEditorCommands } from './features/commandMenu';
import { getLogseqPageProps } from './pagePropsRegistry';
import { NativeSlashSuggest, setBuiltinSlashProvider } from './features/nativeSlashSuggest';
import { isRefFilterActive, refFilterFrom } from './features/backlinkFilter';
import type { OperationRecord } from './core/operationLog';

export default class LogseqEditorPlugin extends Plugin {
  settings: BlockEditorSettings = DEFAULT_SETTINGS;
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

  private origSetViewState: ((this: WorkspaceLeaf, state: ViewState, eState?: unknown) => Promise<void>) | null = null;
  private statusModeEl: HTMLElement | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.addSettingTab(new LogseqEditorSettingTab(this.app, this));
    void loadOpLog(this);
    logOp(this, 'plugin.load', '', 'ok', `v${this.manifest.version}`);

    this.registerView(VIEW_TYPE_BLOCK_EDITOR, (leaf) => new BlockEditorView(leaf, this));
    this.registerView(VIEW_TYPE_TODO_PANEL, (leaf) => new TodoPanelView(leaf, this));
    this.registerView(VIEW_TYPE_BACKLINK_PANEL, (leaf) => new BacklinkPanelView(leaf, this));
    this.registerView(VIEW_TYPE_TAG_PANEL, (leaf) => new TagPanelView(leaf, this));
    this.registerView(VIEW_TYPE_FLASHCARD_PANEL, (leaf) => new FlashcardPanelView(leaf, this));

    // Vault-wide ((block-id)) index
    this.blockIndex = new BlockIndex(this.app);
    this.blockIndex.attach(this);
    this.attachSqliteIndex();
    this.app.workspace.onLayoutReady(() => {
      void this.blockIndex?.buildAll();
      void this.startSqliteIndex();
      if (this.settings.pagePropsEditor === 'native') void this.resolveNativePropsCtor();
      this.convertOpenMarkdownLeaves();
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
      for (const [k, v] of Object.entries(props)) {
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
        frontmatter: { ...(cache?.frontmatter ?? {}), ...props, position: cache?.frontmatter?.position },
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

    this.addCommand({
      id: 'search-blocks',
      name: 'Search blocks across the vault',
      callback: () => new BlockSearchModal(this.app, this).open(),
    });

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

  onunload(): void {
    logOp(this, 'plugin.unload', '', 'ok');
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

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
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
      if (file && this.shouldTakeOverFile(file)) {
        void leaf.setViewState({ ...vs, type: VIEW_TYPE_BLOCK_EDITOR } as ViewState);
      }
    }
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
  private async activatePanel(viewType: string): Promise<void> {
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
}
