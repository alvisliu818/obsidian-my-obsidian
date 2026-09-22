/**
 * Plugin entry: view registration, setViewState take-over patch, commands,
 * vault-wide block-id index, and clean uninstall (restore native views).
 */

import { Notice, Plugin, WorkspaceLeaf, type ViewState } from 'obsidian';
import { BlockEditorView, VIEW_TYPE_BLOCK_EDITOR } from './view/BlockEditorView';
import { DEFAULT_SETTINGS, type BlockEditorSettings } from './types';
import { LogseqEditorSettingTab } from './settings/tab';
import { BlockIndex } from './index/blockIndex';
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
import type { OperationRecord } from './core/operationLog';

export default class LogseqEditorPlugin extends Plugin {
  settings: BlockEditorSettings = DEFAULT_SETTINGS;
  blockIndex: BlockIndex | null = null;
  /** Automatic pre-write backups for user-visible .md files. */
  backups: BackupManager = new BackupManager(this);
  /** In-memory operation log ring (newest last) + pending disk appends. */
  opLog: OperationRecord[] = [];
  opLogPending: OperationRecord[] = [];
  /** Set when a block reference should be revealed after opening a file. */
  pendingReveal: { path: string; blockId: string } | null = null;

  private origSetViewState: ((this: WorkspaceLeaf, state: ViewState, eState?: unknown) => Promise<void>) | null = null;

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
    this.app.workspace.onLayoutReady(() => {
      void this.blockIndex?.buildAll();
      this.convertOpenMarkdownLeaves();
    });

    this.patchSetViewState();

    // ---- Commands ----
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
        if (!checking) this.switchToBlockEditor(leaf);
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
      else if (active.view.getViewType() === 'markdown') this.switchToBlockEditor(active);
    });

    this.addRibbonIcon('calendar-day', "Open today's journal", () => void openJournal(this));
  }

  onunload(): void {
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
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BLOCK_EDITOR)) {
      const state = leaf.view.getState();
      const file = (state.state as { file?: string } | undefined)?.file;
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
    if (typeof this.settings.journalFolder !== 'string') this.settings.journalFolder = '';
    if (typeof this.settings.journalFormat !== 'string') this.settings.journalFormat = '';
    if (typeof this.settings.journalTemplate !== 'string') this.settings.journalTemplate = '';
    if (typeof this.settings.customTemplateVars !== 'string') this.settings.customTemplateVars = '';
    this.settings.backupsEnabled = this.settings.backupsEnabled !== false;
    this.settings.opLogEnabled = this.settings.opLogEnabled !== false;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ------------------------------------------------------------------
  // Take-over patch
  // ------------------------------------------------------------------

  isExcluded(file: string): boolean {
    const folders = this.settings.excludedFolders
      .split(',')
      .map((s) => s.trim().replace(/^\/+|\/+$/g, ''))
      .filter(Boolean);
    return folders.some((f) => file === f || file.startsWith(f + '/'));
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
      if (
        plugin.settings.takeOverByDefault &&
        state.type === 'markdown' &&
        (state.state as { file?: string } | undefined)?.file &&
        !plugin.isExcluded((state.state as { file: string }).file)
      ) {
        state = { ...state, type: VIEW_TYPE_BLOCK_EDITOR } as ViewState;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (plugin.origSetViewState as any).call(this, state, eState);
    };
  }

  /** After enable/reload: convert already-open native markdown leaves. */
  private convertOpenMarkdownLeaves(): void {
    if (!this.settings.takeOverByDefault) return;
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const st = leaf.view.getState();
      const file = (st.state as { file?: string } | undefined)?.file;
      if (file && !this.isExcluded(file)) {
        void leaf.setViewState({ ...st, type: VIEW_TYPE_BLOCK_EDITOR } as ViewState);
      }
    }
  }

  // ------------------------------------------------------------------
  // View switching
  // ------------------------------------------------------------------

  private switchToNative(leaf: WorkspaceLeaf): void {
    const state = leaf.view.getState();
    const file = (state.state as { file?: string } | undefined)?.file;
    if (!file) return;
    void leaf.setViewState({ type: 'markdown', state: { file }, active: true } as ViewState);
  }

  private switchToBlockEditor(leaf: WorkspaceLeaf): void {
    const state = leaf.view.getState();
    const file = (state.state as { file?: string } | undefined)?.file;
    if (!file) return;
    void leaf.setViewState({ type: VIEW_TYPE_BLOCK_EDITOR, state: { file }, active: true } as ViewState);
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
