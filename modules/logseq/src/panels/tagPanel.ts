/**
 * Tags panel (right sidebar): vault-wide #tag aggregation, Logseq md parity.
 * All tags as clickable chips → filter to that tag's blocks. Read-only;
 * click an item to jump to the owning block.
 */

import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import type { IndexedBlock } from '../index/blockIndex';
import { plainText } from '../features/query';

export const VIEW_TYPE_TAG_PANEL = 'logseq-tag-panel';

const MAX_ITEMS = 500;

export class TagPanelView extends ItemView {
  plugin: LogseqEditorPlugin;
  private activeTag: string | null = null;
  private disposer: (() => void) | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: LogseqEditorPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_TAG_PANEL;
  }
  getDisplayText(): string {
    return 'Logseq tags';
  }
  getIcon(): string {
    return 'tags';
  }

  onload(): void {
    this.disposer = this.plugin.blockIndex?.onRebuild(() => this.render()) ?? null;
  }

  onunload(): void {
    this.disposer?.();
    this.disposer = null;
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    this.disposer?.();
    this.disposer = null;
  }

  // ------------------------------------------------------------------

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('logseq-panel');
    const idx = this.plugin.blockIndex;

    // Tag chip cloud (always visible; active tag highlighted).
    const chipWrap = contentEl.createEl('div', { cls: 'logseq-panel-tagcloud' });
    const tags = idx?.allTags() ?? [];
    if (tags.length === 0) {
      chipWrap.createEl('div', { cls: 'logseq-panel-empty', text: 'No tags yet — add #tag to any block.' });
    }
    for (const t of tags) {
      const chip = chipWrap.createEl('span', {
        cls: 'logseq-tag-chip' + (this.activeTag === t ? ' is-active' : ''),
        text: '#' + t,
      });
      chip.addEventListener('click', () => {
        this.activeTag = this.activeTag === t ? null : t;
        this.render();
      });
    }

    // Filtered block list for the active tag.
    if (!this.activeTag) return;
    const list = contentEl.createEl('div', { cls: 'logseq-panel-list' });
    const all = idx?.allBlocks() ?? [];
    const items = all.filter((b: IndexedBlock) => b.tags.includes(this.activeTag!)).slice(0, MAX_ITEMS);
    if (items.length === 0) {
      list.createEl('div', { cls: 'logseq-panel-empty', text: `No blocks tagged #${this.activeTag}.` });
      return;
    }
    // Group by source file (vault order).
    const groups = new Map<string, IndexedBlock[]>();
    for (const b of items) {
      const arr = groups.get(b.path) ?? [];
      arr.push(b);
      groups.set(b.path, arr);
    }
    for (const [path, blocks] of groups) {
      const g = list.createEl('div', { cls: 'logseq-panel-group' });
      const h = g.createEl('div', { cls: 'logseq-panel-group-title', text: path });
      h.addEventListener('click', () => this.plugin.app.workspace.openLinkText(path, '', false));
      for (const b of blocks) {
        const item = g.createEl('div', { cls: 'logseq-panel-item' });
        if (b.marker) {
          const mk = item.createEl('span', { cls: 'block-marker ' + b.marker.toLowerCase() });
          mk.setAttribute('aria-label', b.marker);
        }
        item.createEl('span', { cls: 'logseq-panel-item-text' }).setText(plainText(b.text) || '(empty)');
        item.addEventListener('click', () => {
          if (b.blockId) void this.plugin.openBlockRef(b.blockId);
          else void this.plugin.app.workspace.openLinkText(b.path, '', false);
        });
      }
    }
    if (all.filter((b: IndexedBlock) => b.tags.includes(this.activeTag!)).length > MAX_ITEMS) {
      list.createEl('div', { cls: 'logseq-panel-empty', text: '… more not shown' });
    }
  }
}
