/**
 * Bottom-of-page references section (v0.2.5): TWO collapsible subsections —
 * "Linked references" (existing backlinks) and "Unlinked references" (plain
 * text mentions with one-click convert). Each section toggles independently
 * via its header; collapsed state lives per plugin session (WeakMap), so it
 * survives re-renders but resets on plugin reload (local preference only).
 *
 * The INITIAL state comes from the `refsLinkedDefaultCollapsed` /
 * `refsUnlinkedDefaultCollapsed` settings: on = that section starts folded, so
 * opening a note shows just the header (no query — expanding one runs it).
 */

import { setIcon } from 'obsidian';
import { perViewState } from '../core/perViewState';
import type LogseqEditorPlugin from '../main';
import { renderPageBacklinks } from './pageBacklinks';
import { renderUnlinkedMentions } from './unlinkedMentions';

export const REFERENCES_SECTION_CLASS = 'page-references';

/** Collapsed state per plugin session（perViewState 统一出处）。 */
const collapsedByView = perViewState<LogseqEditorPlugin, { linked: boolean; unlinked: boolean }>((plugin) => ({
  // 初始折叠态由设置决定（默认：链接引用展开、未链接引用折叠——后者是
  // 全库线性扫描，见 types.ts）。
  linked: plugin.settings.refsLinkedDefaultCollapsed === true,
  unlinked: plugin.settings.refsUnlinkedDefaultCollapsed === true,
}));

function stateFor(plugin: LogseqEditorPlugin): { linked: boolean; unlinked: boolean } {
  return collapsedByView.get(plugin);
}

/** Drop the per-session collapse memory so new defaults reach open editors. */
export function resetReferencesCollapse(plugin: LogseqEditorPlugin): void {
  collapsedByView.delete(plugin);
}

/**
 * Render the references area: a wrapper with two toggleable subsections.
 * The linked/unlinked renderers stay unchanged — this only adds the
 * collapsible chrome around them.
 */
export function renderPageReferences(
  containerEl: HTMLElement,
  plugin: LogseqEditorPlugin,
  currentPath: string | undefined,
  fileBasename: string,
): void {
  containerEl.querySelector(`:scope > .${REFERENCES_SECTION_CLASS}`)?.remove();
  if (!currentPath) return;
  // 总开关(2026-11-21 用户):关 = 底部引用区整块不渲染。
  if (plugin.settings.pageReferencesEnabled === false) return;
  const state = stateFor(plugin);

  // 布局(2026-11-21 用户):stacked = 上下堆叠(默认);dual = 左右双面板,
  // 窄容器由 CSS 自动回落单列。
  const dual = plugin.settings.pageReferencesLayout === 'dual';
  const wrapper = containerEl.createEl('div', {
    cls: dual ? `${REFERENCES_SECTION_CLASS} is-dual` : REFERENCES_SECTION_CLASS,
  });

  // --- Linked references (collapsible) ---
  const linkedHead = wrapper.createEl('div', { cls: 'refs-collapse-header', attr: { 'aria-expanded': String(!state.linked) } });
  const linkedChevron = linkedHead.createEl('span', { cls: 'refs-chevron' });
  setIcon(linkedChevron, state.linked ? 'chevron-right' : 'chevron-down');
  linkedHead.createEl('span', { cls: 'refs-collapse-title', text: 'Linked references' });
  const linkedBody = wrapper.createEl('div', { cls: 'refs-collapse-body' });
  if (state.linked) linkedBody.addClass('is-collapsed');
  // 折叠的区不渲染查询体（懒加载）：折叠时打开笔记只画标题栏，不跑反链
  // 查询；展开的那一次（以及之后处于展开态的每次重渲染）才查询。10-17 同步
  // 独立插件线时这条 else 曾被冲掉，导致折叠也只是视觉折叠、查询照跑。
  else renderPageBacklinks(linkedBody, plugin, currentPath, fileBasename);
  linkedHead.addEventListener('click', () => {
    state.linked = !state.linked;
    renderPageReferences(containerEl, plugin, currentPath, fileBasename);
  });

  // --- Unlinked references (collapsible) ---
  const unlinkedHead = wrapper.createEl('div', { cls: 'refs-collapse-header', attr: { 'aria-expanded': String(!state.unlinked) } });
  const unlinkedChevron = unlinkedHead.createEl('span', { cls: 'refs-chevron' });
  setIcon(unlinkedChevron, state.unlinked ? 'chevron-right' : 'chevron-down');
  unlinkedHead.createEl('span', { cls: 'refs-collapse-title', text: 'Unlinked references' });
  const unlinkedBody = wrapper.createEl('div', { cls: 'refs-collapse-body' });
  if (state.unlinked) unlinkedBody.addClass('is-collapsed');
  else renderUnlinkedMentions(unlinkedBody, plugin, currentPath, fileBasename);
  unlinkedHead.addEventListener('click', () => {
    state.unlinked = !state.unlinked;
    renderPageReferences(containerEl, plugin, currentPath, fileBasename);
  });
}
