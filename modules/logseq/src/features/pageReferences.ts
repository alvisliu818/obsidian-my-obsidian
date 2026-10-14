/**
 * Bottom-of-page references section (v0.2.5): TWO collapsible subsections —
 * "Linked references" (existing backlinks) and "Unlinked references" (plain
 * text mentions with one-click convert). Each section toggles independently
 * via its header; collapsed state lives per plugin session (WeakMap), so it
 * survives re-renders but resets on plugin reload (local preference only).
 *
 * The INITIAL state comes from the `refsDefaultCollapsed` setting: on = both
 * sections start folded, so opening a note shows just the two headers.
 */

import { setIcon } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { renderPageBacklinks } from './pageBacklinks';
import { renderUnlinkedMentions } from './unlinkedMentions';

export const REFERENCES_SECTION_CLASS = 'page-references';

/** Collapsed state per plugin instance. */
const collapsedByView = new WeakMap<object, { linked: boolean; unlinked: boolean }>();

function stateFor(plugin: LogseqEditorPlugin): { linked: boolean; unlinked: boolean } {
  let s = collapsedByView.get(plugin);
  if (!s) {
    const start = plugin.settings.refsDefaultCollapsed === true;
    s = { linked: start, unlinked: start }; // 默认折叠由设置决定
    collapsedByView.set(plugin, s);
  }
  return s;
}

/** 设置变更后调用：丢掉会话状态，下次渲染按新默认值来。 */
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
  const state = stateFor(plugin);
  const wrapper = containerEl.createEl('div', { cls: REFERENCES_SECTION_CLASS });

  // --- Linked references (collapsible) ---
  const linkedHead = wrapper.createEl('div', { cls: 'refs-collapse-header', attr: { 'aria-expanded': String(!state.linked) } });
  const linkedChevron = linkedHead.createEl('span', { cls: 'refs-chevron' });
  setIcon(linkedChevron, state.linked ? 'chevron-right' : 'chevron-down');
  linkedHead.createEl('span', { cls: 'refs-collapse-title', text: 'Linked references' });
  const linkedBody = wrapper.createEl('div', { cls: 'refs-collapse-body' });
  if (state.linked) linkedBody.addClass('is-collapsed');
  renderPageBacklinks(linkedBody, plugin, currentPath, fileBasename);
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
  renderUnlinkedMentions(unlinkedBody, plugin, currentPath, fileBasename);
  unlinkedHead.addEventListener('click', () => {
    state.unlinked = !state.unlinked;
    renderPageReferences(containerEl, plugin, currentPath, fileBasename);
  });
}
