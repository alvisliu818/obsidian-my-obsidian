/**
 * Backup restore modal: list automatic backups (newest first), preview one,
 * restore it (the current content is itself backed up first), or delete a
 * backup. Reached from the command palette. Backups live in the dot-folder
 * `.logseq-editor/backups/` and are listed via the adapter (see backup.ts).
 */

import { Modal, Setting, TFile, Notice } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { BackupManager } from '../core/backup';

export class BackupRestoreModal extends Modal {
  private mgr: BackupManager;
  private plugin: LogseqEditorPlugin;
  private path: string;
  private previewEl: HTMLElement | null = null;

  constructor(plugin: LogseqEditorPlugin, file?: TFile) {
    super(plugin.app);
    this.plugin = plugin;
    this.mgr = new BackupManager(plugin);
    this.path = file?.path ?? '';
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Backups' });

    if (!this.path) {
      contentEl.createEl('p', { text: 'Showing all backups (open a file to filter).', cls: 'oplog-hint' });
    }
    const all = await this.mgr.listAllEntries();
    const relevant = this.path ? all.filter((e) => e.originalPath === this.path) : all;

    if (relevant.length === 0) {
      contentEl.createEl('p', { text: 'No backups yet for this file.', cls: 'oplog-hint' });
      return;
    }

    const list = contentEl.createEl('div', { cls: 'backup-list' });
    this.previewEl = contentEl.createEl('div', { cls: 'backup-preview' });
    for (const entry of relevant.slice(0, 50)) {
      const d = new Date(entry.mtime);
      const pad = (n: number) => String(n).padStart(2, '0');
      const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const row = list.createEl('div', { cls: 'backup-row' });
      const label = row.createEl('div', { cls: 'backup-label' });
      if (!this.path) label.createEl('div', { text: entry.originalPath, cls: 'backup-path' });
      label.createEl('span', { text: `${when} · ${Math.ceil(entry.size / 1024)} KB`, cls: 'backup-time' });
      new Setting(row)
        .addButton((b) =>
          b.setButtonText('Preview').onClick(async () => {
            try {
              const data = await this.mgr.readBackup(entry.name);
              this.previewEl?.empty();
              this.previewEl?.createEl('pre', { text: data.slice(0, 4000), cls: 'oplog-pre' });
            } catch (e) {
              new Notice(`Failed to read backup: ${String(e)}`);
            }
          }),
        )
        .addButton((b) =>
          b
            .setButtonText('Restore')
            .setCta()
            .onClick(async () => {
              const ok = await this.mgr.restore(entry);
              if (ok) this.close();
            }),
        )
        .addButton((b) =>
          b.setButtonText('Delete').onClick(async () => {
            try {
              await this.plugin.app.vault.adapter.remove(entry.path);
              new Notice('Backup deleted');
            } catch (e) {
              new Notice(`Failed to delete: ${String(e)}`);
            }
            void this.onOpen();
          }),
        );
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
