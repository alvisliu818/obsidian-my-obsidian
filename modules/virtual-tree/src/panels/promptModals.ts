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


// ---------------------------------------------------------------------------
// 新建文件弹窗（用户 2026-11-20：文件名/扩展名双输入框）：
//   - 文件名默认 untitled；扩展名默认 .md,记忆上一次成功创建的扩展名
//   - 什么都不输 → untitled.md；已有 untitled.md → untitled_0/1/2…（调用方
//     用 withSequence 做序号防撞）
//   - 2026-11-24：显式「无扩展名」勾选（Dockerfile/Makefile 这类文件），
//     勾上清空并禁用扩展名框；本会话内记住上次选择，连续建同类文件不必
//     每次都勾。
// ---------------------------------------------------------------------------

export interface NewFileModalOpts {
	title?: string;
	defaultName?: string;
	defaultExt?: string;
	validateName?: (name: string) => string;
}

/** 重名序号：base 已存在 → base_0/base_1…（上限 1000,兜底返回原 base）。 */
export function withSequence(base: string, exists: (candidate: string) => boolean): string {
	if (!exists(base)) return base;
	for (let i = 0; i < 1000; i++) {
		const candidate = `${base}_${i}`;
		if (!exists(candidate)) return candidate;
	}
	return base;
}

/** 本会话内记住上次是否选了「无扩展名」（不写盘：磁盘只记正常扩展名）。 */
let lastNewFileNoExt = false;

export class NewFileModal extends Modal {
	private readonly title: string;
	private readonly defaultName: string;
	private readonly defaultExt: string;
	private readonly validateName?: (name: string) => string;
	private readonly onSubmit: (fullName: string) => void;

	constructor(
		app: App,
		opts: NewFileModalOpts,
		onSubmit: (fullName: string) => void,
	) {
		super(app);
		this.title = opts.title ?? '新建文件';
		this.defaultName = opts.defaultName ?? 'untitled';
		this.defaultExt = opts.defaultExt ?? 'md';
		this.validateName = opts.validateName;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: this.title });

		const row = contentEl.createDiv({ cls: 'lgp-name-prompt-input' });
		row.style.display = 'flex';
		row.style.gap = '8px';
		const nameInput = row.createEl('input', {
			type: 'text',
			cls: 'lgp-name-prompt-input',
			attr: { placeholder: this.defaultName, spellcheck: 'false' },
		});
		nameInput.value = this.defaultName;
		nameInput.style.flex = '1';
		nameInput.select();
		const dotEl = row.createDiv({ text: '.', cls: 'lgp-newfile-dot' });
		dotEl.style.cssText = 'align-self:center;font-weight:700;color:var(--text-muted)';
		const extInput = row.createEl('input', {
			type: 'text',
			cls: 'lgp-name-prompt-input',
			attr: { placeholder: 'md', spellcheck: 'false' },
		});
		extInput.value = this.defaultExt;
		extInput.style.width = '72px';

		// 无扩展名开关（2026-11-24 用户：Dockerfile / Makefile 这类文件名本身
		// 就是全名，没有点号分隔的扩展名）。勾选后清空并禁用扩展名框；
		// 用户手动清空扩展名框也自动勾上，两种操作路径都可达。
		const noExtRow = contentEl.createDiv({ cls: 'lgp-newfile-noext-row' });
		noExtRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-top:8px;font-size:12px;color:var(--text-muted)';
		const noExtBox = noExtRow.createEl('input', { type: 'checkbox', cls: 'lgp-newfile-noext' });
		noExtBox.checked = lastNewFileNoExt;
		const noExtLabel = noExtRow.createEl('label', { text: '无扩展名（Dockerfile、Makefile 等）' });
		noExtLabel.style.cursor = 'pointer';
		noExtLabel.addEventListener('click', (ev) => {
			ev.preventDefault();
			noExtBox.checked = !noExtBox.checked;
			noExtBox.dispatchEvent(new Event('change'));
		});
		// 记住勾选前用户填过的扩展名，取消勾选时还原（不丢输入）。
		let rememberedExt = this.defaultExt;
		const applyNoExt = (): void => {
			const typed = extInput.value.trim();
			if (typed) rememberedExt = typed;
			if (noExtBox.checked) {
				extInput.value = '';
				extInput.disabled = true;
				extInput.placeholder = '无';
			} else {
				extInput.disabled = false;
				extInput.value = rememberedExt;
				extInput.placeholder = 'md';
			}
		};
		noExtBox.addEventListener('change', applyNoExt);
		extInput.addEventListener('input', () => {
			if (!noExtBox.checked && !extInput.value.trim()) {
				noExtBox.checked = true;
				applyNoExt();
			}
		});
		applyNoExt();

		const errEl = contentEl.createDiv({ cls: 'lgp-name-prompt-error' });
		errEl.style.display = 'none';

		const commit = () => {
			const name = nameInput.value.trim();
			const ext = noExtBox.checked ? '' : extInput.value.trim().replace(/^\.+/, '');
			const nameErr = this.validateName?.(name) ?? '';
			if (nameErr || !name) {
				errEl.textContent = nameErr || '请填文件名';
				errEl.style.display = '';
				nameInput.focus();
				return;
			}
			if (/[/\\]/.test(ext)) {
				errEl.textContent = '扩展名不能含路径分隔符';
				errEl.style.display = '';
				extInput.focus();
				return;
			}
			// 拼接完整文件名（ext 空 = 无扩展名,显式清空/勾选是用户意图）
			lastNewFileNoExt = !ext;
			this.onSubmit(ext ? `${name}.${ext}` : name);
			this.close();
		};

		const enter = (ev: KeyboardEvent): void => {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				commit();
			}
		};
		nameInput.addEventListener('keydown', enter);
		extInput.addEventListener('keydown', enter);

		const btn = contentEl.createEl('button', { text: '创建', cls: 'mod-cta' });
		btn.style.marginTop = '10px';
		btn.addEventListener('click', commit);
	}
}