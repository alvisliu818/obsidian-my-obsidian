/**
 * Editable page-properties card (v0.2.3): the page-props header becomes a
 * real editor — add / edit / delete `key:: value` pairs, persisted to the
 * page's markdown file (Logseq md format: unindented `key:: value` lines
 * after optional frontmatter).
 */

import { setIcon } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { parseDocument } from '../core/parser';
import { serializeDocument } from '../core/serializer';
import { logOp } from './logger';
import { TFile } from 'obsidian';

interface PagePropRow {
  key: string;
  value: string;
}

/** Parse the stored pageProps string into editable rows. */
export function parsePageProps(pageProps: string): PagePropRow[] {
  const rows: PagePropRow[] = [];
  for (const line of pageProps.split('\n')) {
    const idx = line.indexOf('::');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 2).trim();
    if (key) rows.push({ key, value });
  }
  return rows;
}

/** Serialize rows back to the pageProps string (one `key:: value` per line). */
export function serializePageProps(rows: PagePropRow[]): string {
  return rows
    .filter((r) => r.key.trim() !== '')
    .map((r) => `${r.key.trim()}:: ${r.value}`)
    .join('\n');
}

/**
 * Render the editable page-props card. Replaces the previous read-only card.
 * - Pencil toggle → edit mode: one input per key/value + delete buttons,
 *   an "add property" row, Enter commits the row.
 * - Save rewrites the file with the updated pageProps (original content
 *   elsewhere in the file is preserved via full re-serialization).
 */
export function renderEditablePageProps(
  containerEl: HTMLElement,
  plugin: LogseqEditorPlugin,
  filePath: string | undefined,
  pageProps: string,
  onSaved: () => void,
): void {
  containerEl.querySelector(':scope > .page-props-card')?.remove();
  const rows = parsePageProps(pageProps);
  // Even with no props yet, show the card so the user can add page properties
  // (goal: first-block-as-props affordance). The card stays compact when empty.
  if (!filePath) return;

  const card = containerEl.createEl('div', { cls: 'page-props-card' });
  const table = card.createEl('div', { cls: 'page-props-table' });
  for (const row of rows) {
    const el = table.createEl('div', { cls: 'page-prop-row' });
    el.createEl('span', { cls: 'page-prop-key', text: row.key });
    el.createEl('span', { cls: 'page-prop-value', text: row.value });
  }
  if (rows.length === 0) {
    card.addClass('is-empty');
    table.createEl('span', { cls: 'page-props-empty-hint', text: 'No page properties yet.' });
  }

  // Edit toggle (pencil).
  const actions = card.createEl('div', { cls: 'page-props-actions' });
  const editBtn = actions.createEl('div', {
    cls: 'page-props-edit clickable-icon',
    attr: { 'aria-label': 'Edit page properties' },
  });
  setIcon(editBtn, 'pencil');

  editBtn.addEventListener('click', () => {
    card.addClass('is-editing');
    table.empty();
    const working: PagePropRow[] = rows.map((r) => ({ ...r }));

    const commit = async (): Promise<void> => {
      const newProps = serializePageProps(working);
      if (newProps === pageProps) {
        onSaved();
        return;
      }
      const f = plugin.app.vault.getAbstractFileByPath(filePath);
      if (!(f instanceof TFile)) return;
      try {
        const data = await plugin.app.vault.read(f);
        const doc = parseDocument(data);
        doc.pageProps = newProps;
        // Guarded write: backup + log.
        const ok = await plugin.backups.safeProcess(f, () => serializeDocument(doc), 'page.props');
        if (!ok) return;
        logOp(plugin, 'page.props', filePath, 'ok', `${working.length} props`);
        onSaved();
      } catch (e) {
        logOp(plugin, 'page.props', filePath, 'error', String(e));
      }
    };

    const renderRows = (): void => {
      table.empty();
      working.forEach((row, i) => {
        const rowEl = table.createEl('div', { cls: 'page-prop-row is-edit-row' });
        const keyInput = rowEl.createEl('input', {
          cls: 'page-prop-input page-prop-input-key',
          value: row.key,
          attr: { placeholder: 'key', 'data-idx': String(i), 'data-field': 'key' },
        });
        const valInput = rowEl.createEl('input', {
          cls: 'page-prop-input page-prop-input-value',
          value: row.value,
          attr: { placeholder: 'value', 'data-idx': String(i), 'data-field': 'value' },
        });
        keyInput.addEventListener('change', () => {
          working[i].key = keyInput.value.trim();
        });
        valInput.addEventListener('change', () => {
          working[i].value = valInput.value;
        });
        const del = rowEl.createEl('div', { cls: 'page-prop-delete clickable-icon', attr: { 'aria-label': 'Delete property' } });
        setIcon(del, 'trash-2');
        del.addEventListener('click', () => {
          working.splice(i, 1);
          renderRows();
        });
        keyInput.addEventListener('keydown', (ev) => {
          if ((ev as KeyboardEvent).key === 'Enter') {
            ev.preventDefault();
            void commit();
          }
        });
      });
      // Add-property row.
      const addRow = table.createEl('div', { cls: 'page-prop-row is-add-row' });
      const newKey = addRow.createEl('input', {
        cls: 'page-prop-input page-prop-input-key',
        attr: { placeholder: 'new key' },
      });
      const newVal = addRow.createEl('input', {
        cls: 'page-prop-input page-prop-input-value',
        attr: { placeholder: 'new value' },
      });
      const add = rowEl_createAdd(addRow, () => {
        if (newKey.value.trim() === '') return;
        working.push({ key: newKey.value.trim(), value: newVal.value });
        renderRows();
      });
      void add;
      newKey.addEventListener('keydown', (ev) => {
        if ((ev as KeyboardEvent).key === 'Enter') {
          ev.preventDefault();
          if (newKey.value.trim() === '') return;
          working.push({ key: newKey.value.trim(), value: newVal.value });
          renderRows();
        }
      });
    };

    function rowEl_createAdd(addRow: HTMLElement, onAdd: () => void): HTMLElement {
      const addBtn = addRow.createEl('div', { cls: 'page-prop-add clickable-icon', attr: { 'aria-label': 'Add property' } });
      setIcon(addBtn, 'plus');
      addBtn.addEventListener('click', onAdd);
      return addBtn;
    }

    renderRows();

    // Save / cancel buttons.
    const btns = card.createEl('div', { cls: 'page-props-btns' });
    const save = btns.createEl('button', { cls: 'mod-cta', text: 'Save' });
    const cancel = btns.createEl('button', { text: 'Cancel' });
    save.addEventListener('click', () => void commit());
    cancel.addEventListener('click', () => onSaved());
  });
}
