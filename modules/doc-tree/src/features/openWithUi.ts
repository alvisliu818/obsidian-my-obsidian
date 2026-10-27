/**
 * Editor dialog for one "open with" entry.
 *
 * Ported from `siyuan-editor/src/open-with/open-with-ui.ts`. Kept to a single
 * entry per dialog rather than a full manager grid: the list lives in the
 * settings tab, where Obsidian's `Setting` rows already give it a native look.
 */

import { App, Modal, Notice, Setting } from 'obsidian';
import type { OpenWithApp } from '../types';

export class OpenWithEditModal extends Modal {
  private draft: OpenWithApp;
  private onSave: (app: OpenWithApp) => void;
  private isNew: boolean;

  constructor(app: App, existing: OpenWithApp | null, onSave: (a: OpenWithApp) => void) {
    super(app);
    this.isNew = existing === null;
    this.draft = existing
      ? { ...existing }
      : {
          id: `app-${Date.now().toString(36)}`,
          name: '',
          command: '',
          args: '%1',
          enabled: true,
        };
    this.onSave = onSave;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: this.isNew ? '添加打开方式' : '编辑打开方式' });

    new Setting(contentEl).setName('名称').setDesc('显示在右键菜单里。').addText((t) =>
      t.setValue(this.draft.name).onChange((v) => {
        this.draft.name = v;
      }),
    );

    new Setting(contentEl)
      .setName('程序')
      .setDesc('可执行文件路径，或 PATH 上可直接解析的命令（如 code、typora）。')
      .addText((t) =>
        t.setPlaceholder('C:\\Program Files\\...\\app.exe').setValue(this.draft.command).onChange((v) => {
          this.draft.command = v;
        }),
      );

    new Setting(contentEl)
      .setName('参数')
      .setDesc('%1 替换为文件的绝对路径，%d 替换为文件所在文件夹。')
      .addText((t) =>
        t.setPlaceholder('%1').setValue(this.draft.args).onChange((v) => {
          this.draft.args = v;
        }),
      );

    new Setting(contentEl).setName('启用').addToggle((t) =>
      t.setValue(this.draft.enabled).onChange((v) => {
        this.draft.enabled = v;
      }),
    );

    new Setting(contentEl)
      .addButton((b) =>
        b
          .setButtonText('保存')
          .setCta()
          .onClick(() => {
            if (!this.draft.command.trim()) {
              new Notice('请填写程序路径。');
              return;
            }
            const name = this.draft.name.trim() || this.draft.command.trim();
            this.draft.name = name;
            this.close();
            this.onSave(this.draft);
          }),
      )
      .addButton((b) => b.setButtonText('取消').onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
