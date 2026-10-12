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
  /** 'linked' = [[wiki links]]; 'unlinked' = plain-text title mentions (Logseq parity). */
  private mode: 'linked' | 'unlinked' = 'linked';

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
    const tabs = header.createEl('div', { cls: 'logseq-panel-tabs' });
    for (const f of [{ key: 'linked', label: 'Linked mentions' }, { key: 'unlinked', label: 'Unlinked mentions' }] as const) {
      const t = tabs.createEl('div', { cls: 'logseq-panel-tab', text: f.label });
      t.addEventListener('click', () => {
        this.mode = f.key;
        this.renderList();
      });
    }
    this.listEl = this.contentEl.createEl('div', { cls: 'logseq-panel-list' });
    this.renderList();
  }

  async onClose(): Promise<void> {
    this.disposer?.();
    this.disposer = null;
  }

  // ------------------------------------------------------------------

  /** Plain-text mentions: blocks whose text contains the file's title but no [[link]]. */
  private renderUnlinked(list: HTMLElement, file: import('obsidian').TFile): void {
    const idx = this.plugin.blockIndex;
    if (!idx) return;
    const title = file.basename.toLowerCase();
    if (title.length < 2) {
      list.createEl('div', { cls: 'logseq-panel-empty', text: 'File name too short for mention search.' });
      return;
    }
    const hits = idx
      .allBlocks()
      .filter(
        (b) =>
          b.path !== file.path &&
          b.links.every((l) => !l.toLowerCase().includes(title)) &&
          b.text.toLowerCase().includes(title),
      )
      .slice(0, 300);
    if (hits.length === 0) {
      list.createEl('div', { cls: 'logseq-panel-empty', text: 'No unlinked mentions.' });
      return;
    }
    const groups = new Map<string, typeof hits>();
    for (const e of hits) {
      const arr = groups.get(e.path) ?? [];
      arr.push(e);
      groups.set(e.path, arr);
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
          else void this.plugin.app.workspace.openLinkText(e.path, '', false);
        });
      }
    }
  }

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

    if (this.mode === 'unlinked') {
      this.renderUnlinked(list, file);
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
