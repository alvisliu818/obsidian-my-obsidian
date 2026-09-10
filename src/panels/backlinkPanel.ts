/**
 * Backlinks panel (right sidebar): blocks in other files that link to the
 * currently active file. Click an entry to jump to the referencing block.
 */

import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { plainText } from '../features/query';

export const VIEW_TYPE_BACKLINK_PANEL = 'logseq-backlink-panel';

export class BacklinkPanelView extends ItemView {
  plugin: LogseqEditorPlugin;
  private listEl!: HTMLElement;
  private disposer: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_BACKLINK_PANEL;
  }
  getDisplayText(): string {
    return 'Logseq backlinks';
  }
  getIcon(): string {
    return 'link';
  }

  onload(): void {
    this.disposer = this.plugin.blockIndex?.onRebuild(() => this.renderList()) ?? null;
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.renderList()));
  }

  onunload(): void {
    this.disposer?.();
    this.disposer = null;
  }

  async onOpen(): Promise<void> {
    this.contentEl.empty();
    this.contentEl.addClass('logseq-panel');
    const header = this.contentEl.createEl('div', { cls: 'logseq-panel-header' });
    header.createEl('div', { cls: 'logseq-panel-title', text: 'Linked mentions' });
    this.listEl = this.contentEl.createEl('div', { cls: 'logseq-panel-list' });
    this.renderList();
  }

  async onClose(): Promise<void> {
    this.disposer?.();
    this.disposer = null;
  }

  // ------------------------------------------------------------------

  private renderList(): void {
    const list = this.listEl ?? this.contentEl.querySelector('.logseq-panel-list');
    if (!list) return;
    list.empty();

    const idx = this.plugin.blockIndex;
    const file = this.app.workspace.getActiveFile();
    if (!idx || !file) {
      list.createEl('div', { cls: 'logseq-panel-empty', text: 'No active file.' });
      return;
    }

    const entries = idx.backlinksTo(file.path);
    if (entries.length === 0) {
      list.createEl('div', { cls: 'logseq-panel-empty', text: 'No backlinks to this file.' });
      return;
    }

    const groups = new Map<string, typeof entries>();
    for (const e of entries) {
      const arr = groups.get(e.sourcePath) ?? [];
      arr.push(e);
      groups.set(e.sourcePath, arr);
    }
    for (const [path, items] of groups) {
      const g = list.createEl('div', { cls: 'logseq-panel-group' });
      const h = g.createEl('div', { cls: 'logseq-panel-group-title', text: path });
      h.addEventListener('click', () => this.plugin.app.workspace.openLinkText(path, '', false));
      for (const e of items) {
        const item = g.createEl('div', { cls: 'logseq-panel-item' });
        if (e.marker) {
          const mk = item.createEl('span', { cls: 'block-marker ' + e.marker.toLowerCase() });
          mk.setAttribute('aria-label', e.marker);
        }
        item.createEl('span', { cls: 'logseq-panel-item-text' }).setText(plainText(e.text) || '(empty)');
        item.addEventListener('click', () => {
          if (e.blockId) void this.plugin.openBlockRef(e.blockId);
          else void this.plugin.app.workspace.openLinkText(e.sourcePath, '', false);
        });
      }
    }
  }
}
