/**
 * 弹窗:名称输入(NanePromptModal)与危险确认(ConfirmModal)。
 *
 * 思源侧文件树操作走 promptDialog + confirm(见 siyuan-editor
 * `components/file-tree.ts` 的 createNewFile/renameEntry/deleteEntry);
 * 这里用 Obsidian 原生 Modal 提供同款交互。
 *
 * 为什么不用 window.prompt/confirm:Electron 渲染进程里这两个原生对话框
 * 不可用(Obsidian 环境实测无效),必须自建。
 */

import { Modal, type App } from 'obsidian';

/** 名称输入弹窗;确定/回车 resolve 名称,取消/Esc resolve null。 */
export class NamePromptModal extends Modal {
  private readonly title: string;
  private readonly placeholder: string;
  private readonly initial: string;
  /** 可选的预校验(比如 extFs.validateEntryName);返回空串表示通过。 */
  private readonly validate?: (name: string) => string;
  private readonly onSubmit: (name: string | null) => void;

  constructor(
    app: App,
    opts: {
      title: string;
      placeholder?: string;
      initial?: string;
      validate?: (name: string) => string;
    },
    onSubmit: (name: string | null) => void,
  ) {
    super(app);
    this.title = opts.title;
    this.placeholder = opts.placeholder ?? '';
    this.initial = opts.initial ?? '';
    this.validate = opts.validate;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.title });

    const input = contentEl.createEl('input', {
      type: 'text',
      cls: 'lgp-name-prompt-input',
      attr: { placeholder: this.placeholder, spellcheck: 'false' },
    });
    input.value = this.initial;
    // 预选「主名」(去扩展名):重命名 .md 文件时只改名字、不动扩展名。
    const dot = this.initial.lastIndexOf('.');
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();

    const errEl = contentEl.createDiv({ cls: 'lgp-name-prompt-error' });
    errEl.style.display = 'none';

    const commit = () => {
      const name = input.value.trim();
      const bad = this.validate?.(name) ?? '';
      if (bad) {
        errEl.textContent = bad;
        errEl.style.display = '';
        return;
      }
      this.close();
      this.onSubmit(name || null);
    };

    const row = contentEl.createDiv({ cls: 'lgp-name-prompt-row' });
    const okBtn = row.createEl('button', { cls: 'mod-cta', text: '确定' });
    okBtn.addEventListener('click', commit);
    const cancelBtn = row.createEl('button', { text: '取消' });
    cancelBtn.addEventListener('click', () => {
      this.close();
      this.onSubmit(null);
    });

    input.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') {
        ev.preventDefault();
        commit();
      } else if ((ev as KeyboardEvent).key === 'Escape') {
        ev.preventDefault();
        this.close();
        this.onSubmit(null);
      }
    });
    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** 危险操作确认弹窗;onSubmit(ok) — 确定传 true。 */
export class ConfirmModal extends Modal {
  private readonly title: string;
  private readonly body: string;
  private readonly confirmText: string;
  private readonly dangerous: boolean;
  private readonly onSubmit: (ok: boolean) => void;

  constructor(
    app: App,
    opts: { title: string; body: string; confirmText?: string; dangerous?: boolean },
    onSubmit: (ok: boolean) => void,
  ) {
    super(app);
    this.title = opts.title;
    this.body = opts.body;
    this.confirmText = opts.confirmText ?? '确定';
    this.dangerous = opts.dangerous ?? false;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: this.title });
    contentEl.createEl('p', { text: this.body });

    const row = contentEl.createDiv({ cls: 'lgp-name-prompt-row' });
    const okBtn = row.createEl('button', {
      cls: this.dangerous ? 'mod-warning' : 'mod-cta',
      text: this.confirmText,
    });
    okBtn.addEventListener('click', () => {
      this.close();
      this.onSubmit(true);
    });
    const cancelBtn = row.createEl('button', { text: '取消' });
    cancelBtn.addEventListener('click', () => {
      this.close();
      this.onSubmit(false);
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
