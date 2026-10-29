/**
 * Tasks panel (right sidebar): vault-wide TODO / DOING / DONE browser.
 * Read-only; click an item to jump to the owning block.
 */

import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import type { IndexedBlock } from '../index/blockIndex';
import { plainText } from '../features/query';

export const VIEW_TYPE_TODO_PANEL = 'logseq-todo-panel';

type Filter = 'TODO' | 'DOING' | 'DONE' | 'ALL';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'TODO', label: 'TODO' },
  { key: 'DOING', label: 'DOING' },
  { key: 'DONE', label: 'DONE' },
  { key: 'ALL', label: 'All' },
];

const MAX_ITEMS = 500;

export class TodoPanelView extends ItemView {
  plugin: LogseqEditorPlugin;
  private filter: Filter = 'TODO';
  private disposer: (() => void) | null = null;
  private listEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_TODO_PANEL;
  }
  getDisplayText(): string {
    return 'Logseq tasks';
  }
  getIcon(): string {
    return 'list-checks';
  }

  onload(): void {
    this.disposer = this.plugin.blockIndex?.onRebuild(() => this.renderList()) ?? null;
  }

  onunload(): void {
    this.disposer?.();
    this.disposer = null;
  }

  async onOpen(): Promise<void> {
    this.renderSkeleton();
    this.renderList();
  }

  async onClose(): Promise<void> {
    this.disposer?.();
    this.disposer = null;
  }

  // ------------------------------------------------------------------

  private renderSkeleton(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('logseq-panel');
    const header = contentEl.createEl('div', { cls: 'logseq-panel-header' });
    const tabs = header.createEl('div', { cls: 'logseq-panel-tabs' });
    for (const f of FILTERS) {
      const t = tabs.createEl('div', { cls: 'logseq-panel-tab', text: f.label });
      t.addEventListener('click', () => {
        this.filter = f.key;
        this.renderSkeleton();
        this.renderList();
      });
    }
    const refresh = header.createEl('div', {
      cls: 'logseq-panel-refresh clickable-icon',
      text: '⟳',
    });
    refresh.setAttribute('aria-label', 'Rebuild index and refresh');
    refresh.addEventListener('click', () => void this.plugin.blockIndex?.buildAll());
    this.listEl = contentEl.createEl('div', { cls: 'logseq-panel-list' });
    this.markActiveTab();
  }

  private markActiveTab(): void {
    const tabs = this.contentEl.querySelectorAll('.logseq-panel-tab');
    tabs.forEach((t, i) => {
      (t as HTMLElement).classList.toggle('is-active', FILTERS[i].key === this.filter);
    });
  }

  private renderList(): void {
    const list = this.listEl ?? this.contentEl.querySelector('.logseq-panel-list');
    if (!list) return;
    list.empty();

    const idx = this.plugin.blockIndex;
    if (!idx) {
      list.createEl('div', { cls: 'logseq-panel-empty', text: 'Index unavailable.' });
      return;
    }
    const all = idx.allBlocks();
    const items =
      this.filter === 'ALL'
        ? all.filter((b) => b.marker)
        : all.filter((b) => (b.marker ?? '').toUpperCase() === this.filter);

    if (items.length === 0) {
      list.createEl('div', {
        cls: 'logseq-panel-empty',
        text: this.filter === 'ALL' ? 'No tasks yet.' : `No ${this.filter} blocks.`,
      });
      return;
    }

    // Group by source file, preserving vault order.
    const groups = new Map<string, IndexedBlock[]>();
    for (const b of items.slice(0, MAX_ITEMS)) {
      const arr = groups.get(b.path) ?? [];
      arr.push(b);
      groups.set(b.path, arr);
    }
    for (const [path, blocks] of groups) {
      const g = list.createEl('div', { cls: 'logseq-panel-group' });
      const h = g.createEl('div', { cls: 'logseq-panel-group-title', text: path });
      h.addEventListener('click', () => this.plugin.app.workspace.openLinkText(path, '', false));
      for (const b of blocks) g.appendChild(this.itemEl(b));
    }
    if (items.length > MAX_ITEMS) {
      list.createEl('div', { cls: 'logseq-panel-empty', text: `… ${items.length - MAX_ITEMS} more not shown` });
    }
  }

  private itemEl(b: IndexedBlock): HTMLElement {
    const item = document.createElement('div');
    item.className = 'logseq-panel-item';
    if (b.marker) {
      const mk = item.createEl('span', { cls: 'block-marker ' + b.marker.toLowerCase() });
      mk.setAttribute('aria-label', b.marker);
    }
    item.createEl('span', { cls: 'logseq-panel-item-text' }).setText(plainText(b.text) || '(empty)');
    item.addEventListener('click', () => {
      if (b.blockId) void this.plugin.openBlockRef(b.blockId);
      else void this.plugin.app.workspace.openLinkText(b.path, '', false);
    });
    return item;
  }
}
