/**
 * Vault-wide block search modal (fuzzy): type to search every indexed block,
 * Enter to jump to the owning block / file.
 */

import { FuzzySuggestModal, type App, type FuzzyMatch } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import type { IndexedBlock } from '../index/blockIndex';

const MAX_ITEMS = 5000;

export class BlockSearchModal extends FuzzySuggestModal<IndexedBlock> {
  plugin: LogseqEditorPlugin;

  constructor(app: App, plugin: LogseqEditorPlugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder('Search blocks across the vault…');
    this.setInstructions([
      { command: '↑↓', purpose: 'navigate' },
      { command: '↵', purpose: 'jump to block' },
      { command: 'esc', purpose: 'dismiss' },
    ]);
  }

  getItems(): IndexedBlock[] {
    return (this.plugin.blockIndex?.allBlocks() ?? []).filter((b) => b.text.trim() !== '').slice(0, MAX_ITEMS);
  }

  getItemText(item: IndexedBlock): string {
    return item.text;
  }

  onChooseItem(item: IndexedBlock, _evt: MouseEvent | KeyboardEvent): void {
    void _evt;
    if (item.blockId) void this.plugin.openBlockRef(item.blockId);
    else void this.plugin.app.workspace.openLinkText(item.path, '', false);
  }

  renderSuggestion(item: FuzzyMatch<IndexedBlock>, el: HTMLElement): void {
    const b = item.item;
    el.addClass('block-search-item');
    const row = el.createEl('div', { cls: 'block-search-row' });
    if (b.marker) {
      row.createEl('span', { cls: 'block-marker ' + b.marker.toLowerCase() });
    }
    row.createEl('span', { cls: 'block-search-text' }).setText(b.text);
    el.createEl('div', { cls: 'block-search-src', text: b.path });
  }
}
