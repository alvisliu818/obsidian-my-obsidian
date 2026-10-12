/**
 * Block-view rendering (table / cards / tabs) — the DOM side of
 * `features/blockViews.ts`. Rendered in place of the parent's child list.
 *
 * Interactivity is deliberately thin: every record row/card/tab is clickable and
 * zooms into that child (`host.zoomIn`), so a view never becomes a dead end —
 * the underlying outline is always one click away. Tabs additionally keep a
 * selected index in a per-block WeakMap, so switching tabs survives re-renders
 * (a patch rebuild would otherwise reset the view to the first tab).
 */

import type { BlockRenderHost } from '../blocks/renderHost';
import type { Block } from '../types';
import { buildBlockView, type BlockViewModel, type ViewChild } from '../features/blockViews';

export const VIEW_CLASS = 'block-view';

/**
 * Cap on rendered records. A block with thousands of children would otherwise
 * build a huge table on every render; the same ceiling `{{query}}` uses. The
 * overflow is reported rather than silently dropped.
 */
const MAX_VIEW_RECORDS = 200;

/** Selected tab index per parent block (survives re-render / patch). */
const selectedTabByBlock = new WeakMap<Block, number>();

/** Reduce a child block to the shape the view model consumes. */
function toViewChild(b: Block): ViewChild {
  return {
    text: b.text.split('\n')[0]?.trim() ?? '',
    marker: b.marker,
    props: b.props,
    hasChildren: b.children.length > 0,
  };
}

/**
 * Render the parent's children as a view. Returns null when the block has no
 * `view::` property, so the caller falls back to the normal child list.
 */
export function renderBlockView(b: Block, host: BlockRenderHost): HTMLElement | null {
  const model = buildBlockView(b.props, b.children.map(toViewChild), MAX_VIEW_RECORDS);
  if (!model) return null;

  const el = document.createElement('div');
  el.className = `${VIEW_CLASS} block-view-${model.kind}`;
  el.dataset.view = model.kind;

  if (model.records.length === 0) {
    // An explicit empty state: a `view::` on a childless block must not look
    // like a rendering failure.
    const empty = el.createEl('div', { cls: 'block-view-empty' });
    empty.createEl('span', { text: 'No child blocks' });
    const hint = empty.createEl('span', { cls: 'block-view-empty-hint' });
    hint.setText(`view:: ${model.kind} — indent blocks under this one to fill it`);
    return el;
  }

  if (model.kind === 'table') renderTable(el, b, model, host);
  else if (model.kind === 'cards') renderCards(el, b, model, host);
  else renderTabs(el, b, model, host);

  if (b.children.length > MAX_VIEW_RECORDS) {
    el.createEl('div', {
      cls: 'block-view-more',
      text: `… ${b.children.length - MAX_VIEW_RECORDS} more not shown`,
    });
  }
  return el;
}

function markerSpan(parent: HTMLElement, marker: string | null): void {
  if (!marker) return;
  const mk = parent.createEl('span', { cls: 'block-marker ' + marker.toLowerCase() });
  mk.setAttribute('aria-label', marker);
}

/** Table view: one row per child, one column per property. */
function renderTable(el: HTMLElement, b: Block, model: BlockViewModel, host: BlockRenderHost): void {
  const table = el.createEl('table', { cls: 'block-view-table' });
  const thead = table.createEl('thead');
  const hrow = thead.createEl('tr');
  hrow.createEl('th', { text: 'Block' });
  for (const c of model.columns) hrow.createEl('th', { text: c });

  const tbody = table.createEl('tbody');
  model.records.forEach((r, i) => {
    const tr = tbody.createEl('tr');
    tr.dataset.viewRow = String(i);
    const nameCell = tr.createEl('td', { cls: 'block-view-title' });
    markerSpan(nameCell, r.child.marker);
    nameCell.createEl('span', { text: r.title || '(empty)' });
    for (const c of model.columns) {
      tr.createEl('td', { text: r.values[c] ?? '' });
    }
    wire(tr, b.children[r.childIndex], host);
  });
}

/** Cards view: one card per child, showing all of its properties. */
function renderCards(el: HTMLElement, b: Block, model: BlockViewModel, host: BlockRenderHost): void {
  const grid = el.createEl('div', { cls: 'block-view-cards' });
  model.records.forEach((r, i) => {
    const card = grid.createEl('div', { cls: 'block-view-card' });
    card.dataset.viewRow = String(i);
    const head = card.createEl('div', { cls: 'block-view-card-title' });
    markerSpan(head, r.child.marker);
    head.createEl('span', { text: r.title || '(empty)' });
    if (model.columns.length > 0) {
      const body = card.createEl('div', { cls: 'block-view-card-body' });
      for (const c of model.columns) {
        const line = body.createEl('div', { cls: 'block-view-card-line' });
        line.createEl('span', { cls: 'block-view-card-key', text: c });
        line.createEl('span', { cls: 'block-view-card-val', text: r.values[c] ?? '' });
      }
    }
    wire(card, b.children[r.childIndex], host);
  });
}

/** Tabs view: child names as tabs, the selected child's record below. */
function renderTabs(el: HTMLElement, b: Block, model: BlockViewModel, host: BlockRenderHost): void {
  const bar = el.createEl('div', { cls: 'block-view-tabs' });
  const body = el.createEl('div', { cls: 'block-view-tab-body' });

  const last = selectedTabByBlock.get(b) ?? 0;
  const sel = last >= 0 && last < model.records.length ? last : 0;

  const paint = (index: number): void => {
    selectedTabByBlock.set(b, index);
    for (const [i, tab] of Array.from(bar.children).entries()) {
      tab.classList.toggle('is-active', i === index);
      tab.setAttribute('aria-selected', String(i === index));
    }
    body.empty();
    const r = model.records[index];
    if (!r) return;
    const panel = body.createEl('div', { cls: 'block-view-tab-panel' });
    const head = panel.createEl('div', { cls: 'block-view-card-title' });
    markerSpan(head, r.child.marker);
    head.createEl('span', { text: r.title || '(empty)' });
    if (r.child.hasChildren) {
      panel.createEl('div', { cls: 'block-view-tab-nested', text: 'Has child blocks' });
    }
    if (model.columns.length > 0) {
      const dl = panel.createEl('div', { cls: 'block-view-card-body' });
      for (const c of model.columns) {
        const line = dl.createEl('div', { cls: 'block-view-card-line' });
        line.createEl('span', { cls: 'block-view-card-key', text: c });
        line.createEl('span', { cls: 'block-view-card-val', text: r.values[c] ?? '' });
      }
    }
  };

  model.records.forEach((r, i) => {
    const tab = bar.createEl('div', {
      cls: 'block-view-tab',
      attr: { role: 'tab', 'aria-selected': 'false' },
    });
    tab.dataset.viewRow = String(i);
    tab.createEl('span', { text: r.title || '(empty)' });
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      paint(i);
    });
  });

  paint(sel);

  // Clicking the PANEL (not a tab) zooms into the shown child.
  body.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.block-view-tab')) return;
    // Read the CURRENT tab (not the render-time one — the user may have
    // switched) and clamp, so a stale index can never open the wrong block.
    const current = selectedTabByBlock.get(b) ?? 0;
    const shown = model.records[current] ?? model.records[0];
    const child = shown ? b.children[shown.childIndex] : undefined;
    if (child) host.zoomIn(child);
  });
  el.appendChild(bar);
  el.appendChild(body);
}

/** A record opens the child it represents (zoom in) — never a dead end. */
function wire(row: HTMLElement, child: Block | undefined, host: BlockRenderHost): void {
  if (!child) return;
  row.classList.add('is-clickable');
  row.setAttribute('title', 'Open this block');
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    host.zoomIn(child);
  });
}
