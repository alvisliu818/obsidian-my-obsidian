/**
 * SQL console over the secondary index.
 *
 * It exists to make the "markdown is the truth" contract observable: every
 * row you can query here was derived from a .md file, and the Rebuild button
 * throws the whole database away and re-derives it from the vault.
 */

import { Notice, Setting, Modal } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { TABLE_NAMES } from '../index/sqliteSchema';

const SAMPLES: { label: string; sql: string }[] = [
  { label: 'Index size', sql: 'SELECT COUNT(*) AS files FROM files' },
  { label: 'Blocks per page', sql: 'SELECT page, COUNT(*) AS n FROM blocks GROUP BY page ORDER BY n DESC LIMIT 20' },
  { label: 'Open tasks', sql: "SELECT text, path FROM blocks WHERE marker IN ('TODO','DOING') LIMIT 50" },
  { label: 'Tag usage', sql: 'SELECT tag, COUNT(*) AS n FROM tags GROUP BY tag ORDER BY n DESC LIMIT 30' },
  { label: 'Most linked pages', sql: 'SELECT target, COUNT(*) AS n FROM links GROUP BY target ORDER BY n DESC LIMIT 30' },
  { label: 'Block references', sql: 'SELECT target_id, COUNT(*) AS n FROM refs GROUP BY target_id ORDER BY n DESC LIMIT 30' },
  { label: 'Property values', sql: "SELECT key, value, COUNT(*) AS n FROM props GROUP BY key, value ORDER BY n DESC LIMIT 50" },
  { label: 'Outline of one page', sql: "SELECT ord, depth, text FROM blocks WHERE path = 'journal.md' ORDER BY ord LIMIT 100" },
];

export class SqliteConsoleModal extends Modal {
  private sql = SAMPLES[1].sql;
  private resultEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;

  constructor(private plugin: LogseqEditorPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('lgp-sqlite-console');
    contentEl.createEl('h2', { text: 'SQLite index console' });
    contentEl.createEl('p', {
      cls: 'lgp-sqlite-note',
      text:
        'Read-only view of a derived index. Every row comes from your markdown — ' +
        'editing the database never changes a note, and Rebuild re-derives it from the files.',
    });

    const index = this.plugin.sqliteIndex;
    if (!index) {
      contentEl.createEl('p', { text: 'The SQLite index is disabled (or failed to start).' });
      return;
    }
    if (index.lastError) {
      contentEl.createEl('p', { cls: 'lgp-sqlite-error', text: `Last error: ${index.lastError}` });
    }

    this.statusEl = contentEl.createEl('div', { cls: 'lgp-sqlite-status' });
    this.renderStatus();

    new Setting(contentEl)
      .setName('Sample queries')
      .setDesc('Pick one, or write your own below.')
      .addDropdown((d) => {
        for (const s of SAMPLES) d.addOption(s.sql, s.label);
        d.setValue(this.sql);
        d.onChange((v) => {
          this.sql = v;
          const area = contentEl.querySelector('.lgp-sqlite-input') as HTMLTextAreaElement | null;
          if (area) {
            area.value = v;
            void this.run();
          }
        });
      });

    const area = contentEl.createEl('textarea', { cls: 'lgp-sqlite-input' });
    area.value = this.sql;
    area.rows = 4;
    area.placeholder = 'SELECT …';
    area.addEventListener('keydown', (evt) => {
      if ((evt.ctrlKey || evt.metaKey) && evt.key === 'Enter') {
        evt.preventDefault();
        void this.run();
      }
    });
    area.addEventListener('input', () => {
      this.sql = area.value;
    });

    const actions = contentEl.createDiv({ cls: 'lgp-sqlite-actions' });
    const btn = (label: string, cls: string, run: () => void) =>
      actions.createEl('button', { cls: `lgp-sqlite-btn ${cls}`, text: label }).addEventListener('click', run);
    btn('Run', 'mod-cta', () => void this.run());
    btn('Sync', '', () => void this.sync());
    btn('Rebuild', '', () => void this.rebuild());
    btn('Verify', '', () => void this.verify());

    contentEl.createEl('div', { cls: 'lgp-sqlite-schema' }).setText(
      `tables: ${TABLE_NAMES.join(', ')}`,
    );

    this.resultEl = contentEl.createDiv({ cls: 'lgp-sqlite-result' });
    void this.run();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private renderStatus(): void {
    const el = this.statusEl;
    const index = this.plugin.sqliteIndex;
    if (!el || !index) return;
    const s = index.stats;
    el.setText(
      `files ${s.files} · blocks ${s.blocks} · tags ${s.tags} · links ${s.links} · refs ${s.refs} · last run ${s.ms} ms`,
    );
  }

  private async run(): Promise<void> {
    const index = this.plugin.sqliteIndex;
    if (!index || !this.resultEl) return;
    const res = await index.query(this.sql);
    this.renderStatus();
    const el = this.resultEl;
    el.empty();
    if (res.error) {
      el.createEl('div', { cls: 'lgp-sqlite-error', text: res.error });
      return;
    }
    el.createEl('div', { cls: 'lgp-sqlite-meta', text: `${res.rows.length} rows · ${res.ms} ms${res.truncated ? ' (truncated)' : ''}` });
    if (res.rows.length === 0) return;
    const table = el.createEl('table', { cls: 'lgp-sqlite-table' });
    const head = table.createEl('tr');
    for (const c of res.columns) head.createEl('th', { text: c });
    for (const row of res.rows) {
      const tr = table.createEl('tr');
      for (const cell of row) tr.createEl('td', { text: cell === null ? '∅' : String(cell) });
    }
  }

  private async sync(): Promise<void> {
    const index = this.plugin.sqliteIndex;
    if (!index) return;
    const s = await index.sync();
    new Notice(
      `SQLite index synced: +${s.added} ~${s.changed} -${s.removed} (${s.unchanged} unchanged, ${s.ms} ms)`,
    );
    this.renderStatus();
    await this.run();
  }

  private async rebuild(): Promise<void> {
    const index = this.plugin.sqliteIndex;
    if (!index) return;
    const s = await index.rebuild();
    new Notice(`SQLite index rebuilt from markdown: ${s.files} files, ${s.blocks} blocks (${s.ms} ms)`);
    this.renderStatus();
    await this.run();
  }

  private async verify(): Promise<void> {
    const index = this.plugin.sqliteIndex;
    if (!index) return;
    const v = await index.verify();
    const drift = v.drift.length > 0 ? ` drift: ${v.drift.slice(0, 5).join(', ')}` : '';
    const missing = v.missing.length > 0 ? ` missing: ${v.missing.slice(0, 5).join(', ')}` : '';
    new Notice(
      v.drift.length === 0 && v.missing.length === 0
        ? `Index matches the files (${v.checked} checked, ${v.ms} ms)`
        : `Index is stale:${drift}${missing}`,
    );
  }
}
