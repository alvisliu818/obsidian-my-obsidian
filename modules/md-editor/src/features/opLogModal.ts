/**
 * "Operation log" modal: view the newest operations (time, op, file, status,
 * detail), open the log folder, and export a timestamped .log file.
 */

import { Modal, Setting, Notice } from 'obsidian';
import type LogseqEditorPlugin from '../main';
import { recentOpLog, exportOpLog } from './logger';
import { formatRecord } from '../core/operationLog';

export class OpLogModal extends Modal {
  constructor(private plugin: LogseqEditorPlugin) {
    super(plugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: 'Operation log' });
    contentEl.createEl('p', {
      text: 'Newest first. The full trail persists to .logseq-editor/log.jsonl (auto-rotating).',
      cls: 'oplog-hint',
    });

    const recs = recentOpLog(this.plugin);
    const box = contentEl.createEl('div', { cls: 'oplog-list' });
    if (recs.length === 0) {
      box.createEl('p', { text: 'No operations recorded yet.', cls: 'oplog-hint' });
    } else {
      const pre = box.createEl('pre', { cls: 'oplog-pre' });
      for (const r of recs.slice(0, 300)) {
        pre.createEl('div', { cls: `oplog-row is-${r.status}`, text: formatRecord(r) });
      }
    }

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText('Export log')
          .setCta()
          .onClick(() => {
            exportOpLog(this.plugin)
              .then((p) => new Notice(`Log exported: ${p}`))
              .catch((e) => new Notice(String(e), 6000));
          }),
      )
      .addButton((b) => b.setButtonText('Refresh').onClick(() => this.onOpen()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
