/**
 * Bottom-of-page backlinks area (Logseq md parity): "Linked mentions" for the
 * CURRENT page, rendered as a collapsed-by-default section under the outline.
 * Clicking a source row jumps to the referencing page/block. Refreshes on
 * index rebuilds and file switches.
 *
 * A funnel button next to the count opens the linked-references filter dialog
 * (Logseq parity). The active filter lives in `plugin.settings.refFilters`
 * keyed by page path, so it survives re-renders, file switches and restarts;
 * matching is include=AND / exclude=NONE (see `backlinkFilter.ts`).
 */

import { setIcon } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import type { BacklinkEntry } from '../index/blockIndex';
import { plainText, normalizeLinkTarget } from '../features/query';
import { filterRefs, isRefFilterActive, refFilterFrom, refFilterState } from '../features/backlinkFilter';
import { FILTER_BTN_CLASS, openBacklinkFilterDialog } from '../features/backlinkFilterDialog';
import type { RefFilter } from '../types';

export const BACKLINKS_SECTION_CLASS = 'page-backlinks';

/** Read this page's filter (sanitized — data.json may be hand-edited). */
function filterFor(plugin: LogseqEditorPlugin, currentPath: string): RefFilter {
  return refFilterFrom(plugin.settings.refFilters?.[currentPath]);
}

/** Persist this page's filter; empty filters are removed to keep data.json small. */
async function saveFilter(plugin: LogseqEditorPlugin, currentPath: string, f: RefFilter): Promise<void> {
  const map = { ...(plugin.settings.refFilters ?? {}) };
  if (isRefFilterActive(f)) map[currentPath] = { includes: f.includes, excludes: f.excludes };
  else delete map[currentPath];
  plugin.settings.refFilters = map;
  await plugin.saveSettings();
}

/**
 * Render (or refresh) the backlinks section at the bottom of the editor
 * container. Idempotent: removes any previous section first.
 */
export function renderPageBacklinks(
  containerEl: HTMLElement,
  plugin: LogseqEditorPlugin,
  currentPath: string | undefined,
  _fileBasename: string,
): void {
  containerEl.querySelector(`:scope > .${BACKLINKS_SECTION_CLASS}`)?.remove();
  if (!currentPath) return;

  const idx = plugin.blockIndex;
  if (!idx) return;
  const allEntries = idx.backlinksTo(currentPath);
  // Candidates come from the UNFILTERED set, so the dialog's list does not
  // shrink every time you pick a value.
  const filter = filterFor(plugin, currentPath);
  const entries = filterRefs(allEntries, filter);

  const section = containerEl.createEl('div', { cls: BACKLINKS_SECTION_CLASS });
  const header = section.createEl('div', { cls: 'page-backlinks-header' });
  const count = entries.length;
  const shown = `${count} linked mention${count === 1 ? '' : 's'}`;
  header.createEl('span', {
    cls: 'page-backlinks-title',
    // While filtering, show how much of the total survived (Logseq does the same).
    text: isRefFilterActive(filter) && count !== allEntries.length
      ? `${shown} (of ${allEntries.length})`
      : shown,
  });

  // Funnel button — hidden with nothing to filter, colored by filter state.
  if (allEntries.length > 0) {
    const state = refFilterState(filter);
    const btn = header.createEl('div', {
      cls: `${FILTER_BTN_CLASS} is-${state}`,
      attr: { 'aria-label': 'Filter references', 'data-state': state },
    });
    setIcon(btn, 'filter');
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openBacklinkFilterDialog(
        btn,
        allEntries,
        [normalizeLinkTarget(currentPath)], // the page itself is never a candidate
        filter,
        (next) => {
          void saveFilter(plugin, currentPath, next).then(() => {
            // Re-render ourselves so the count + funnel color update. The
            // dialog lives in document.body and keeps its own state.
            renderPageBacklinks(containerEl, plugin, currentPath, _fileBasename);
          });
        },
      );
    });
  }

  if (entries.length === 0) {
    section.addClass('is-empty');
    if (isRefFilterActive(filter)) {
      // Distinguish "filtered everything out" from "no references at all".
      section.createEl('div', {
        cls: 'page-backlinks-filtered-empty',
        text: `All ${allEntries.length} references hidden by the current filter`,
      });
    }
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
}