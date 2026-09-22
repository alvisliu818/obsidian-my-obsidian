/**
 * Bottom-of-page backlinks area (Logseq md parity): "Linked mentions" for the
 * CURRENT page, rendered as a collapsed-by-default section under the outline.
 * Clicking a source row jumps to the referencing page/block. Refreshes on
 * index rebuilds and file switches.
 */

import { setIcon } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import type { BacklinkEntry } from '../index/blockIndex';
import { plainText } from '../features/query';

export const BACKLINKS_SECTION_CLASS = 'page-backlinks';

/**
 * Render (or refresh) the backlinks section at the bottom of the editor
 * container. Idempotent: removes any previous section first.
 */
export function renderPageBacklinks(
  containerEl: HTMLElement,
  plugin: LogseqEditorPlugin,
  currentPath: string | undefined,
  fileBasename: string,
): void {
  containerEl.querySelector(`:scope > .${BACKLINKS_SECTION_CLASS}`)?.remove();
  if (!currentPath) return;

  const idx = plugin.blockIndex;
  if (!idx) return;
  const entries = idx.backlinksTo(currentPath);

  const section = containerEl.createEl('div', { cls: BACKLINKS_SECTION_CLASS });
  const header = section.createEl('div', { cls: 'page-backlinks-header' });
  const count = entries.length;
  header.createEl('span', { cls: 'page-backlinks-title', text: `${count} linked mention${count === 1 ? '' : 's'}` });

  if (entries.length === 0) {
    section.addClass('is-empty');
    return;
  }

  const body = section.createEl('div', { cls: 'page-backlinks-list' });
  // Group by source page, vault order.
  const groups = new Map<string, BacklinkEntry[]>();
  for (const e of entries) {
    const arr = groups.get(e.sourcePath) ?? [];
    arr.push(e);
    groups.set(e.sourcePath, arr);
  }
  for (const [sourcePath, items] of groups) {
    const group = body.createEl('div', { cls: 'page-backlinks-group' });
    const pageRow = group.createEl('div', { cls: 'page-backlinks-page' });
    const icon = pageRow.createEl('span', { cls: 'page-backlinks-icon' });
    setIcon(icon, 'file-text');
    pageRow.createEl('span', { text: sourcePath });
    pageRow.addEventListener('click', () => {
      void plugin.app.workspace.openLinkText(sourcePath, '', false);
    });
    for (const e of items) {
      const row = group.createEl('div', { cls: 'page-backlinks-item' });
      if (e.marker) {
        const mk = row.createEl('span', { cls: 'block-marker ' + e.marker.toLowerCase() });
        mk.setAttribute('aria-label', e.marker);
      }
      row.createEl('span', { cls: 'page-backlinks-item-text', text: plainText(e.text) || '(empty)' });
      row.addEventListener('click', () => {
        if (e.blockId) void plugin.openBlockRef(e.blockId);
        else void plugin.app.workspace.openLinkText(e.sourcePath, '', false);
      });
    }
  }
  void fileBasename;
}

