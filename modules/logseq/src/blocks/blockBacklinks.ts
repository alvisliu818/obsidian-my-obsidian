/**
 * Block-level backlinks (Logseq md parity): blocks referenced via ((id)) get
 * a count badge on the right side of the block row; clicking it expands an
 * inline list of referencing blocks UNDER the block (independent per block,
 * multiple can be open at once). Data comes from BlockIndex.refsToBlock.
 */

import { setIcon } from 'obsidian';
import type { BlockEditorView } from '../view/BlockEditorView';
import type { Block } from '../types';
import type { BacklinkEntry } from '../index/blockIndex';
import { plainText } from '../features/query';
import { blockId } from '../types';
import { findBlockEl } from './renderTree';

const BADGE_CLASS = 'block-backlink-badge';
const PANEL_CLASS = 'block-backlinks-panel';

/** Currently expanded block ids (per view session). */
const expandedByView = new WeakMap<BlockEditorView, Set<string>>();

function expandedFor(view: BlockEditorView): Set<string> {
  let s = expandedByView.get(view);
  if (!s) {
    s = new Set();
    expandedByView.set(view, s);
  }
  return s;
}

/**
 * Update every rendered block's backlink badge from the current index.
 * Called after tree renders and index rebuilds; cheap (map lookups).
 */
export function refreshBlockBacklinkBadges(view: BlockEditorView): void {
  const idx = view.plugin.blockIndex;
  if (!idx) return;
  const walk = (blocks: Block[]): void => {
    for (const b of blocks) {
      const wrap = findBlockEl(b);
      if (wrap) updateBadge(view, b, wrap);
      walk(b.children);
    }
  };
  walk(view.visibleRoots);
}

function updateBadge(view: BlockEditorView, block: Block, wrap: HTMLElement): void {
  const main = wrap.querySelector(':scope > .block-main');
  if (!main) return;
  const id = blockId(block);
  const refs = id ? view.plugin.blockIndex?.refsToBlock(id) ?? [] : [];
  let badge = main.querySelector(`:scope > .${BADGE_CLASS}`) as HTMLElement | null;
  if (refs.length === 0) {
    badge?.remove();
    wrap.querySelector(`:scope > .${PANEL_CLASS}`)?.remove();
    return;
  }
  if (!badge) {
    badge = main.createEl('div', { cls: BADGE_CLASS });
    const icon = badge.createEl('span', { cls: 'block-backlink-icon' });
    setIcon(icon, 'link');
    badge.createEl('span', { cls: 'block-backlink-count' });
    badge.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePanel(view, block, wrap);
    });
    badge.setAttribute('aria-label', 'Show referencing blocks');
  }
  const countEl = badge.querySelector('.block-backlink-count');
  if (countEl) countEl.textContent = String(refs.length);
  badge.setAttribute('data-count', String(refs.length));
  // Live-sync an open panel's content.
  if (expandedFor(view).has(id)) renderPanel(view, block, wrap, refs);
}

/** Expand/collapse the backlinks panel directly under the block's wrap. */
function togglePanel(view: BlockEditorView, block: Block, wrap: HTMLElement): void {
  const id = blockId(block);
  if (!id) return;
  const set = expandedFor(view);
  if (set.has(id)) {
    set.delete(id);
    wrap.querySelector(`:scope > .${PANEL_CLASS}`)?.remove();
    return;
  }
  set.add(id);
  const refs = view.plugin.blockIndex?.refsToBlock(id) ?? [];
  renderPanel(view, block, wrap, refs);
}

function renderPanel(view: BlockEditorView, block: Block, wrap: HTMLElement, refs: BacklinkEntry[]): void {
  const id = blockId(block);
  if (!id) return;
  let panel = wrap.querySelector(`:scope > .${PANEL_CLASS}`) as HTMLElement | null;
  if (!panel) {
    panel = wrap.createEl('div', { cls: PANEL_CLASS });
  }
  panel.empty();
  const header = panel.createEl('div', { cls: 'block-backlinks-panel-header' });
  header.createEl('span', { text: `${refs.length} reference${refs.length === 1 ? '' : 's'}` });
  header.addEventListener('click', (e) => {
    e.stopPropagation();
    expandedFor(view).delete(id);
    panel?.remove();
  });
  for (const e of refs.slice(0, 50)) {
    const row = panel.createEl('div', { cls: 'block-backlinks-row' });
    if (e.marker) {
      const mk = row.createEl('span', { cls: 'block-marker ' + e.marker.toLowerCase() });
      mk.setAttribute('aria-label', e.marker);
    }
    row.createEl('span', { cls: 'block-backlinks-row-text', text: plainText(e.text) || '(empty)' });
    row.createEl('span', { cls: 'block-backlinks-row-src', text: e.sourcePath });
    row.addEventListener('click', () => {
      if (e.blockId) void view.plugin.openBlockRef(e.blockId);
      else void view.plugin.app.workspace.openLinkText(e.sourcePath, '', false);
    });
  }
  if (refs.length > 50) {
    panel.createEl('div', { cls: 'block-backlinks-more', text: '… more not shown' });
  }
}
