/**
 * Vault-wide block search modal (fuzzy): type to search every indexed block,
 * Enter to jump to the owning block / file.
 */

import { FuzzySuggestModal, type App, type FuzzyMatch } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import type { IndexedBlock } from '../index/blockIndex';

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

  // 基类 Suggest 支持 Promise（typings: Suggest 层 `T[] | Promise<T[]>`，
  // FuzzySuggestModal 层只标同步——运行时 updateSuggestions 会 await）。
  // daemon 模式：查询走内核 FTS（trigram，中文子串毫秒级，已按 rank 排序），
  // 不再全量拉块进渲染进程。无 daemon → 空列表（与旧态一致）。
  // @ts-expect-error — override widens the declared sync return to Promise
  async getSuggestions(query: string): Promise<FuzzyMatch<IndexedBlock>[]> {
    const q = query.trim();
    const daemon = this.plugin.daemonIndex;
    if (!q || !daemon) return [];
    const rows = await daemon.ftsSearch(q, '', 200).catch(() => []);
    return rows.map((r) => ({
      item: {
        path: r.path,
        blockId: r.blockId,
        text: r.text,
        marker: r.marker,
      } as IndexedBlock,
      score: 0, // 内核已按 FTS rank 排序
      match: { score: 0, matches: [] },
    }));
  }

  // 基类抽象方法（typings 要求）——数据由覆写的 getSuggestions 异步供给。
  getItems(): IndexedBlock[] {
    return [];
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
