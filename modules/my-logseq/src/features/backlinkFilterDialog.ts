/**
 * Linked-references filter dialog (Logseq parity: the funnel next to
 * "Linked references"). Owns its own DOM in `document.body` and positions
 * itself under the funnel button, so it is never clipped by the references
 * section (which lives inside the editor's scroller).
 *
 * Values come from `countRefValues` over the UNFILTERED references (so the
 * candidate list doesn't shrink while you filter), and every toggle writes
 * through `onChange` — the caller persists the filter and re-renders.
 */

import { setIcon } from 'obsidian';
import {
  countRefValues,
  filterRefValues,
  isRefFilterActive,
  toggleRefFilter,
  type RefFilterValue,
} from './backlinkFilter';
import type { RefFilter } from '../types';
import type { BacklinkEntry } from '../index/blockIndex';

export const FILTER_BTN_CLASS = 'page-backlinks-filter-btn';
export const FILTER_DIALOG_CLASS = 'backlink-filter-dialog';

/** Cap the candidate list; Logseq virtualizes past 100 entries. */
const MAX_VALUES = 100;

interface DialogCtx {
  el: HTMLElement;
  /** The funnel button the dialog is anchored under (survives re-renders). */
  anchor: HTMLElement;
  /** Unfiltered references — the candidate pool never shrinks while filtering. */
  entries: BacklinkEntry[];
  /** Value never offered as a candidate (the page being viewed). */
  skip: string[];
  /**
   * The live filter. The dialog holds it LOCALLY rather than reading it back
   * from the caller: the references section re-renders on every toggle and
   * cannot refresh this dialog (it lives in document.body), so waiting for the
   * persisted value would leave the chips showing stale include/exclude state.
   */
  filter: RefFilter;
  onChange: (f: RefFilter) => void;
}

let ctx: DialogCtx | null = null;

/** Close the dialog if open (no-op otherwise). */
export function closeBacklinkFilterDialog(): void {
  if (!ctx) return;
  const { el } = ctx;
  ctx = null;
  window.removeEventListener('pointerdown', onOutsidePointer, { capture: true });
  window.removeEventListener('keydown', onKeydown, { capture: true });
  el.remove();
}

function onOutsidePointer(e: PointerEvent): void {
  if (!ctx) return;
  const target = e.target as Node | null;
  if (target && (ctx.el.contains(target) || ctx.el.contains(target.parentElement ?? target))) return;
  // Clicking the funnel itself re-opens (handled by its own click listener);
  // closing here first would just make it flicker.
  if (target && ctx.anchor.contains(target)) return;
  closeBacklinkFilterDialog();
}

function onKeydown(e: KeyboardEvent): void {
  // Escape closes; every other key belongs to Obsidian (never preventDefault).
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeBacklinkFilterDialog();
  }
}

/**
 * Open the dialog anchored under `anchorEl`. Re-opens (re-rendering) when it is
 * already open, so a click on the funnel always shows a fresh list.
 */
export function openBacklinkFilterDialog(
  anchorEl: HTMLElement,
  entries: BacklinkEntry[],
  skip: string[],
  initialFilter: RefFilter,
  onChange: (f: RefFilter) => void,
): void {
  closeBacklinkFilterDialog();
  const el = document.createElement('div');
  el.className = FILTER_DIALOG_CLASS;
  document.body.appendChild(el);
  ctx = { el, anchor: anchorEl, entries, skip, filter: initialFilter, onChange };
  // Clicks inside must not reach the editor (the scroller would treat them as
  // block clicks and flip rows into edit mode).
  el.addEventListener('pointerdown', (e) => e.stopPropagation());
  window.addEventListener('pointerdown', onOutsidePointer, { capture: true });
  window.addEventListener('keydown', onKeydown, { capture: true });
  renderDialog();
  el.querySelector<HTMLInputElement>('.bfilter-search')?.focus();
}

/** Apply a toggle: update local state, notify the caller, re-render the chips. */
function applyFilter(next: RefFilter): void {
  if (!ctx) return;
  ctx.filter = next;
  ctx.onChange(next);
  renderDialog();
}

/** Anchor under the button, kept inside the viewport. */
function positionDialog(): void {
  if (!ctx) return;
  // Every filter toggle re-renders the references section, which REPLACES the
  // funnel button — a detached anchor reports a zero rect and would teleport the
  // dialog to the viewport corner, so keep the last good position instead.
  if (!ctx.anchor.isConnected) return;
  const a = ctx.anchor.getBoundingClientRect();
  const el = ctx.el;
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let left = a.right - w;
  let top = a.bottom + 6;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  if (left < 8) left = 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, a.top - h - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function renderDialog(): void {
  if (!ctx) return;
  const { el, entries, skip } = ctx;
  const filter = ctx.filter;
  const values = countRefValues(entries, { exclude: skip, limit: MAX_VALUES });
  let query = el.querySelector<HTMLInputElement>('.bfilter-search')?.value ?? '';

  el.empty();

  // --- header (icon + title + hint) ---
  const head = el.createEl('div', { cls: 'bfilter-head' });
  const badge = head.createEl('div', { cls: 'bfilter-badge' });
  setIcon(badge, 'filter');
  const titles = head.createEl('div', { cls: 'bfilter-titles' });
  titles.createEl('div', { cls: 'bfilter-title', text: 'Filter references' });
  titles.createEl('div', { cls: 'bfilter-hint', text: 'Click to include · Shift-click to exclude' });

  // --- pinned values (Includes / Excludes), like Logseq's dialog ---
  const pinned = el.createEl('div', { cls: 'bfilter-pinned' });
  if (filter.includes.length > 0) pinRow(pinned, 'Includes', filter.includes);
  if (filter.excludes.length > 0) pinRow(pinned, 'Excludes', filter.excludes);

  // --- search box ---
  const searchWrap = el.createEl('div', { cls: 'bfilter-search-wrap' });
  const searchIcon = searchWrap.createEl('span', { cls: 'bfilter-search-icon' });
  setIcon(searchIcon, 'search');
  const search = searchWrap.createEl('input', { cls: 'bfilter-search', attr: { type: 'text' } });
  search.value = query;
  search.placeholder = 'Search values';
  search.addEventListener('input', () => {
    query = search.value;
    renderValueList(query, values);
  });

  // --- candidate values ---
  const list = el.createEl('div', { cls: 'bfilter-values' });
  renderValueListInto(list, query, values);

  // --- footer: clear all ---
  if (isRefFilterActive(filter)) {
    const clear = el.createEl('div', { cls: 'bfilter-clear', text: 'Clear all filters' });
    clear.addEventListener('click', () => applyFilter({ includes: [], excludes: [] }));
  }

  // Keep the caret in the search box across re-renders.
  if (query) {
    search.focus();
    search.setSelectionRange(query.length, query.length);
  }
  positionDialog();
}

/** One "Includes" / "Excludes" row of pinned value chips. */
function pinRow(parent: HTMLElement, label: string, list: readonly string[]): void {
  const row = parent.createEl('div', { cls: 'bfilter-pin-row' });
  row.createEl('span', { cls: 'bfilter-pin-label', text: label });
  for (const v of list) valueChip(row, v, null).addClass('is-pinned');
}

/** Replace only the candidate list (used while typing in the search box). */
function renderValueList(query: string, values: RefFilterValue[]): void {
  if (!ctx) return;
  const list = ctx.el.querySelector<HTMLElement>('.bfilter-values');
  if (!list) return;
  renderValueListInto(list, query, values);
}

function renderValueListInto(list: HTMLElement, query: string, values: RefFilterValue[]): void {
  if (!ctx) return;
  list.empty();
  const shown = filterRefValues(values, ctx.filter, query);
  if (shown.length === 0) {
    list.createEl('div', { cls: 'bfilter-empty', text: 'No matching values' });
    return;
  }
  for (const v of shown) valueChip(list, v.key, v.count);
}

/** One clickable value chip; click = include, Shift-click = exclude. */
function valueChip(parent: HTMLElement, key: string, count: number | null): HTMLElement {
  const filter = ctx?.filter ?? { includes: [], excludes: [] };
  const included = filter.includes.includes(key);
  const excluded = filter.excludes.includes(key);
  const chip = parent.createEl('div', {
    cls: 'bfilter-value' + (included ? ' is-included' : '') + (excluded ? ' is-excluded' : ''),
    attr: { 'aria-pressed': String(included || excluded), 'data-value': key },
  });
  chip.createEl('span', { cls: 'bfilter-value-name', text: key });
  if (count !== null) chip.createEl('sup', { cls: 'bfilter-value-count', text: String(count) });
  chip.addEventListener('click', (e) => applyFilter(toggleRefFilter(filter, key, e.shiftKey)));
  return chip;
}