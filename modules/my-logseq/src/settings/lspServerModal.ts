// LSP 语言服务器添加/编辑 Modal。
// generic 服务器（非内置 pyright）的三要素：languages（扩展名列表）、launch
// （node 脚本 / 直接命令）、command+args。保存后写回 settings.lspServers。

import { Modal, Setting, type App } from 'obsidian';
import type { LspServerSpec } from '../types';

export class LspServerEditModal extends Modal {
  private draft: LspServerSpec;
  private readonly onSave: (spec: LspServerSpec) => Promise<void> | void;

  constructor(app: App, existing: LspServerSpec | null, onSave: (spec: LspServerSpec) => Promise<void> | void) {
    super(app);
    this.draft = existing
      ? { ...existing, languages: [...existing.languages], args: [...existing.args], config: existing.config ? existing.config.map((c) => ({ ...c })) : undefined }
      : { id: '', languages: [], launch: 'node', command: '', args: ['--stdio'], enabled: true };
    this.onSave = onSave;
  }

  onOpen(): void {
    this.contentEl.empty();
    this.setTitle(this.draft.id ? '编辑语言服务器' : '添加语言服务器');

    const idRow = new Setting(this.contentEl).setName('ID').setDesc('唯一标识（内置 "pyright" 不可用）。留空则按第一个语言自动生成。');
    if (this.draft.builtin) {
      idRow.addText((t) => t.setValue(this.draft.id).setDisabled(true));
    } else {
      idRow.addText((t) =>
        t.setValue(this.draft.id).onChange((v) => {
          this.draft.id = v.trim();
        }),
      );
    }

    new Setting(this.contentEl)
      .setName('语言（扩展名）')
      .setDesc('逗号分隔，如 "ts, tsx, mjs"。文件按扩展名路由到这个服务器。')
      .addText((t) =>
        t
          .setPlaceholder('ts, tsx')
          .setValue(this.draft.languages.join(', '))
          .onChange((v) => {
            this.draft.languages = v
              .split(',')
              .map((s) => s.trim().toLowerCase().replace(/^\./, ''))
              .filter(Boolean);
          }),
      );

    new Setting(this.contentEl)
      .setName('启动方式')
      .setDesc('"Node 脚本"：用系统 Node.js 跑一个 JS 语言服务器（如 typescript-language-server 的 lib/cli.js）；"直接命令"：PATH 上或绝对路径的可执行文件（如 clangd）。')
      .addDropdown((d) =>
        d
          .addOptions({ node: 'Node 脚本', direct: '直接命令' })
          .setValue(this.draft.launch)
          .onChange((v) => {
            this.draft.launch = v as 'node' | 'direct';
            if (this.draft.launch === 'direct') this.draft.args = [];
          }),
      );

    new Setting(this.contentEl)
      .setName('命令')
      .setDesc(this.draft.launch === 'node' ? 'JS 脚本路径（相对插件目录或绝对路径）。' : '可执行文件名或绝对路径。')
      .addText((t) =>
        t
          .setPlaceholder(this.draft.launch === 'node' ? 'node_modules/typescript-language-server/lib/cli.js' : 'clangd')
          .setValue(this.draft.command)
          .onChange((v) => {
            this.draft.command = v.trim();
          }),
      );

    new Setting(this.contentEl).setName('参数').setDesc('空格分隔，通常 "--stdio"（若为空则补上）。').addText((t) =>
      t
        .setPlaceholder('--stdio')
        .setValue(this.draft.args.join(' '))
        .onChange((v) => {
          this.draft.args = v.trim() ? v.trim().split(/\s+/) : [];
        }),
    );

    new Setting(this.contentEl)
      .addButton((b) =>
        b
          .setButtonText('保存')
          .setCta()
          .onClick(async () => {
            if (!this.draft.id) {
              this.draft.id = `lsp-${this.draft.languages[0] ?? 'custom'}`;
            }
            if (!this.draft.languages.length || !this.draft.command) {
              return; // 语言或命令缺失不保存
            }
            if (this.draft.launch === 'node' && !this.draft.args.length) this.draft.args = ['--stdio'];
            await this.onSave(this.draft);
            this.close();
          }),
      )
      .addButton((b) => b.setButtonText('取消').onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
