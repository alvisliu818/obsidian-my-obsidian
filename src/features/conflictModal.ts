/**
 * External-modification conflict resolution: modal with a line diff of
 * "my unsaved edits" vs "the version on disk" and keep-mine / use-external
 * actions. Closing the modal without choosing keeps local edits (no data loss).
 */

import { App, ButtonComponent, Modal } from 'obsidian';
import { collapseDiff, lineDiff } from './lineDiff';

export interface ConflictOptions {
  path: string;
  /** Serialized current editor content (unsaved edits included). */
  mine: string;
  /** File content as read from disk. */
  external: string;
  onKeepMine: () => void;
  onUseExternal: () => void;
}

export class ConflictModal extends Modal {
  private resolved = false;

  constructor(app: App, private opts: ConflictOptions) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText('File changed externally');
    this.contentEl.empty();
    this.contentEl.createEl('div', { cls: 'conflict-path', text: this.opts.path });
    this.contentEl.createEl('p', {
      cls: 'conflict-hint',
      text: 'The file changed on disk while you have unsaved edits. Red = your version, green = the file on disk.',
    });

    const body = this.contentEl.createEl('div', { cls: 'conflict-diff' });
    for (const row of collapseDiff(lineDiff(this.opts.mine, this.opts.external))) {
      if (row.kind === 'gap') {
        body.createEl('div', { cls: 'cd-gap', text: `⋯ ${row.count} unchanged lines` });
      } else {
        const sign = row.kind === 'del' ? '- ' : row.kind === 'add' ? '+ ' : '  ';
        body.createEl('div', { cls: `cd-line cd-${row.kind}`, text: sign + (row.text || '') });
      }
    }

    const actions = this.contentEl.createEl('div', { cls: 'conflict-actions' });
    new ButtonComponent(actions)
      .setButtonText('Use the file on disk')
      .setWarning()
      .onClick(() => this.finish(this.opts.onUseExternal));
    new ButtonComponent(actions)
      .setButtonText('Keep my edits')
      .setCta()
      .onClick(() => this.finish(this.opts.onKeepMine));
  }

  /** Dismissed without an explicit choice (Esc / backdrop): keep mine. */
  onClose(): void {
    this.finish(this.opts.onKeepMine);
  }

  private finish(action: () => void): void {
    if (this.resolved) return;
    this.resolved = true;
    action();
  }
}
