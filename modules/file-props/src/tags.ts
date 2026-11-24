/**
 * 「标签就是属性」（2026-11-24 用户口径）：标签统一存成属性名 `tags`，值由
 * 用户自己填（逗号分隔多个），树行徽标与标签筛选都读它。
 *
 * 之所以放在 file-props 模块：属性权威数据在索引守护进程的 file_props 表
 * （PRIMARY KEY (path, key)，一个路径一条 tags 行），录入/清洗/建议列表都应
 * 由属性的主人负责；虚拟文档树只是它的一个使用方（右键入口 + 树行显示）。
 *
 * 值格式约定：`工作, 读书` —— 逗号/顿号/分号/空白都可作分隔符，写入时统一
 * 用 ", " 归一；`#` 前缀在解析时剥掉（用户习惯写 #标签）。
 */

import { Modal, type App } from 'obsidian';

export const TAGS_PROP_KEY = 'tags';

/** 解析 tags 属性值：多分隔符、去 #、去空、去重保序。 */
export function parseTagValue(v: string): string[] {
	const out: string[] = [];
	for (const raw of String(v ?? '').split(/[,，、;；\s]+/)) {
		const name = raw.trim().replace(/^#+/, '').trim();
		if (name && !out.includes(name)) out.push(name);
	}
	return out;
}

/** 归一写入：`a, b`。 */
export function formatTagValue(names: string[]): string {
	const out: string[] = [];
	for (const n of names) {
		const name = String(n ?? '').trim().replace(/^#+/, '').trim();
		if (name && !out.includes(name)) out.push(name);
	}
	return out.join(', ');
}

export interface TagEditorOptions {
	/** 属性主键（库内相对路径 / 库外绝对路径 / 远端虚拟路径） */
	path: string;
	isDir: boolean;
	/** 当前值（已解析） */
	current: string[];
	/** 全部已知标签名（跨路径汇总，做点选建议） */
	suggestions: string[];
	onSubmit: (names: string[]) => Promise<void> | void;
}

/**
 * 标签编辑弹窗：上方已选 chips（点一下移除）+ 全库已知标签（点一下加入）+
 * 输入框（回车加入，逗号一次多个）+ 保存/清空。
 *
 * 交互刻意做成"点选优先、输入兜底"——绝大多数时候是复用已有标签，反复打字
 * 容易把同一个标签写成两种拼法（`读书` / `读书笔记`）。
 */
export class TagsPromptModal extends Modal {
	private selected: string[] = [];
	private chipsEl: HTMLElement | null = null;
	private suggestEl: HTMLElement | null = null;
	private inputEl: HTMLInputElement | null = null;
	private saving = false;

	constructor(
		app: App,
		private opts: TagEditorOptions,
	) {
		super(app);
		this.selected = [...opts.current];
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		contentEl.empty();
		contentEl.addClass('lgp-tags-modal');
		titleEl.setText(this.opts.isDir ? '文件夹标签' : '文件标签');

		contentEl.createDiv({
			cls: 'lgp-tags-hint',
			text: `属性名固定为 tags，值就是标签名。路径：${this.opts.path}`,
		});

		// —— 已选 ——
		contentEl.createDiv({ cls: 'lgp-tags-label', text: '已选' });
		this.chipsEl = contentEl.createDiv({ cls: 'lgp-tags-chips' });

		// —— 输入 ——
		const addRow = contentEl.createDiv({ cls: 'lgp-tags-add' });
		this.inputEl = addRow.createEl('input', {
			cls: 'lgp-tags-input',
			attr: { placeholder: '输入标签名，回车加入（逗号可一次写多个）' },
		});
		const addBtn = addRow.createEl('button', { text: '加入', cls: 'lgp-tags-btn' });
		const commitInput = (): void => {
			if (!this.inputEl) return;
			const names = parseTagValue(this.inputEl.value);
			if (names.length) this.addNames(names);
			this.inputEl.value = '';
			this.inputEl.focus();
		};
		addBtn.addEventListener('click', commitInput);
		this.inputEl.addEventListener('keydown', (ev) => {
			if (ev.key === 'Enter') {
				ev.preventDefault();
				commitInput();
			}
		});

		// —— 已知标签 ——
		contentEl.createDiv({ cls: 'lgp-tags-label', text: '已有标签（点一下加入）' });
		this.suggestEl = contentEl.createDiv({ cls: 'lgp-tags-chips' });

		// —— 底部 ——
		const bar = contentEl.createDiv({ cls: 'lgp-tags-bar' });
		const clearBtn = bar.createEl('button', { text: '清空', cls: 'lgp-tags-btn' });
		clearBtn.addEventListener('click', () => {
			this.selected = [];
			this.renderChips();
		});
		const spacer = bar.createDiv({ cls: 'lgp-tags-spacer' });
		void spacer;
		const cancelBtn = bar.createEl('button', { text: '取消', cls: 'lgp-tags-btn' });
		cancelBtn.addEventListener('click', () => this.close());
		const saveBtn = bar.createEl('button', { text: '保存', cls: 'lgp-tags-btn mod-cta' });
		saveBtn.addEventListener('click', () => void this.save(saveBtn));

		this.renderChips();
		window.setTimeout(() => this.inputEl?.focus(), 50);
	}

	private addNames(names: string[]): void {
		for (const n of names) if (!this.selected.includes(n)) this.selected.push(n);
		this.renderChips();
	}

	private removeName(name: string): void {
		this.selected = this.selected.filter((n) => n !== name);
		this.renderChips();
	}

	private renderChips(): void {
		if (!this.chipsEl || !this.suggestEl) return;
		this.chipsEl.empty();
		if (!this.selected.length) {
			this.chipsEl.createSpan({ cls: 'lgp-tags-empty', text: '（还没有标签）' });
		}
		for (const name of this.selected) {
			const chip = this.chipsEl.createSpan({ cls: 'lgp-tags-chip is-on', text: '#' + name });
			const x = chip.createSpan({ cls: 'lgp-tags-x', text: '×' });
			x.addEventListener('click', (ev) => {
				ev.stopPropagation();
				this.removeName(name);
			});
		}
		this.suggestEl.empty();
		const rest = this.opts.suggestions.filter((n) => !this.selected.includes(n));
		if (!rest.length) {
			this.suggestEl.createSpan({ cls: 'lgp-tags-empty', text: '（暂无其它标签）' });
		}
		for (const name of rest.slice(0, 60)) {
			const chip = this.suggestEl.createSpan({ cls: 'lgp-tags-chip', text: '#' + name });
			chip.addEventListener('click', () => this.addNames([name]));
		}
	}

	private async save(btn: HTMLButtonElement): Promise<void> {
		if (this.saving) return;
		// 输入框里还没回车的也算上（用户直接点保存的常见路径）
		if (this.inputEl?.value.trim()) {
			this.addNames(parseTagValue(this.inputEl.value));
			this.inputEl.value = '';
		}
		this.saving = true;
		btn.disabled = true;
		try {
			await this.opts.onSubmit([...this.selected]);
			this.close();
		} finally {
			this.saving = false;
			btn.disabled = false;
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
