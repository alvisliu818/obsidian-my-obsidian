/**
 * Supertag collection section (Tana tag page / Logseq DB new-tag table parity).
 *
 * When the page you are viewing IS a supertag definition, the bottom of the
 * outline gains a table of every block carrying that tag — Tana's "supertag
 * page" and Logseq DB's automatic per-tag table in one. Columns are the
 * RESOLVED template (own fields + everything inherited via `extends::`), in
 * template order, not "whatever props happen to exist", so the table stays
 * stable as instances vary.
 *
 * Read-only by design: it is a view over the index, refreshed on rebuilds.
 * Editing an instance happens where it lives (click a row to jump there).
 */

import { setIcon } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import type { IndexedBlock } from '../index/blockIndex';
import { plainText } from './query';
import { normalizeTag, resolveSupertagFields, type SupertagRegistry } from './supertags';

export const SUPERTAG_SECTION_CLASS = 'page-supertag-collection';

const MAX_ROWS = 200;

/** Props never shown as a collection column. */
const HIDDEN_COLUMNS = new Set(['id', 'collapsed', 'style', 'extends']);

/**
 * Build the table model for a tag's collection: template-ordered columns, one
 * row per instance. Returns null when the tag is not a supertag (no section).
 */
export function buildSupertagCollection(
  reg: SupertagRegistry,
  tag: string,
  instances: readonly IndexedBlock[],
): { columns: string[]; rows: IndexedBlock[] } | null {
  if (!reg.has(normalizeTag(tag))) return null;
  const columns = resolveSupertagFields(reg, tag)
    .map((f) => f.key)
    .filter((k) => !HIDDEN_COLUMNS.has(k));
  return { columns, rows: instances.slice(0, MAX_ROWS) };
}

/**
 * Render (or refresh) the collection section at the bottom of the editor.
 * Idempotent: removes any previous section first. No-op for ordinary pages.
 */
export function renderSupertagCollection(
  containerEl: HTMLElement,
  plugin: LogseqEditorPlugin,
  currentPath: string | undefined,
): void {
  containerEl.querySelector(`:scope > .${SUPERTAG_SECTION_CLASS}`)?.remove();
  const idx = plugin.blockIndex;
  if (!idx || !currentPath) return;

  const tag = normalizeTag(currentPath);
  const def = idx.supertagDef(tag);
  if (!def) return; // ordinary page: nothing to show

  const instances = idx.supertagInstances(tag);
  const model = buildSupertagCollection(idx.supertagRegistry(), tag, instances);
  if (!model) return;

  const section = containerEl.createEl('div', { cls: SUPERTAG_SECTION_CLASS });

  // --- header: tag name + instance count (Tana shows "Number of nodes with
  // this tag"; the table IS the collection) ---
  const header = section.createEl('div', { cls: 'page-backlinks-header' });
  const title = header.createEl('span', { cls: 'page-backlinks-title' });
  const icon = title.createEl('span', { cls: 'page-supertag-icon' });
  setIcon(icon, 'tag');
  title.createEl('span', { text: `#${def.name}` });
  const n = model.rows.length;
  header.createEl('span', {
    cls: 'page-supertag-count',
    text: `${n} instance${n === 1 ? '' : 's'}`,
  });

  if (n === 0) {
    section.addClass('is-empty');
    section.createEl('div', {
      cls: 'page-supertag-hint',
      text: 'No block carries this tag yet. Add it to a block to fill in the fields below.',
    });
    renderTemplateHint(section, def.fields.map((f) => f.key), def.parents);
    return;
  }

  // --- the table ---
  const table = section.createEl('table', { cls: 'page-supertag-table' });
  const headRow = table.createEl('thead').createEl('tr');
  headRow.createEl('th', { text: 'Block' });
  for (const c of model.columns) headRow.createEl('th', { text: c });
  headRow.createEl('th', { text: 'Source' });

  const tbody = table.createEl('tbody');
  for (const r of model.rows) {
    const tr = tbody.createEl('tr');
    tr.createEl('td', {
      cls: 'qt-text',
      text: (r.marker ? r.marker + ' ' : '') + (plainText(r.text) || '(empty)'),
    });
    for (const c of model.columns) {
      tr.createEl('td', { text: r.blockProps[c] ?? '' });
    }
    tr.createEl('td', { cls: 'qt-src', text: r.path });
    tr.addEventListener('click', () => {
      if (r.blockId) void plugin.openBlockRef(r.blockId);
      else void plugin.app.workspace.openLinkText(r.path, '', false);
    });
  }

  // The template this collection is built from — makes the page self-documenting.
  renderTemplateHint(section, model.columns, def.parents);
  if (instances.length > MAX_ROWS) {
    section.createEl('div', {
      cls: 'page-supertag-more',
      text: `… ${instances.length - MAX_ROWS} more not shown`,
    });
  }
}

/** "Fields: a, b · extends: #c" — shows the definition driving the table. */
function renderTemplateHint(section: HTMLElement, fields: string[], parents: string[]): void {
  const parts: string[] = [];
  if (fields.length > 0) parts.push(`fields: ${fields.join(', ')}`);
  if (parents.length > 0) parts.push(`extends: ${parents.map((p) => '#' + p).join(', ')}`);
  if (parts.length === 0) return;
  section.createEl('div', { cls: 'page-supertag-template', text: parts.join(' · ') });
}
