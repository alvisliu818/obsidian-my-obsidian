/**
 * Life 视图公共件：输入弹窗（字段声明式,Enter 提交）+ 小的渲染助手。
 * 九个面板共享;都在 contentEl 上画,样式前缀 life-。
 */
import { Modal, type App } from 'obsidian';

export interface PromptField {
	key: string;
	label: string;
	/** text（缺省）/ number / date / time / select / textarea */
	type?: 'text' | 'number' | 'date' | 'time' | 'select' | 'textarea';
	value?: string;
	placeholder?: string;
	/** select 的选项 */
	options?: { value: string; label: string }[];
	/** 提交前的单字段校验;返回错误文案 = 拦截 */
	validate?: (value: string) => string | null;
}

/** 声明式输入弹窗：fields → onOk(values)。Enter 提交 / Esc 取消。 */
export class LifePromptModal extends Modal {
	constructor(
		app: App,
		private title: string,
		private fields: PromptField[],
		private onOk: (values: Record<string, string>) => void,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl, modalEl } = this;
		modalEl.addClass('life-prompt-modal');
		contentEl.createEl('h3', { text: this.title });
		const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
		for (const f of this.fields) {
			const row = contentEl.createDiv({ cls: 'life-prompt-row' });
			row.createEl('label', { text: f.label });
			let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
			if (f.type === 'textarea') {
				input = row.createEl('textarea');
				input.rows = 2;
			} else if (f.type === 'select') {
				input = row.createEl('select');
				for (const opt of f.options ?? []) {
					const o = input.createEl('option', { text: opt.label });
					(o as HTMLOptionElement).value = opt.value;
				}
			} else {
				input = row.createEl('input');
				input.type = f.type === 'number' ? 'text' : (f.type ?? 'text');
				if (f.type === 'number') input.inputMode = 'decimal';
			}
			const asInput = input as HTMLInputElement;
			if (asInput.type !== 'select-one') asInput.placeholder = f.placeholder ?? '';
			input.value = f.value ?? '';
			inputs.set(f.key, input);
			row.addEventListener('keydown', (ev: KeyboardEvent) => {
				if (ev.key === 'Enter' && (ev.target as HTMLElement).tagName !== 'TEXTAREA') {
					ev.preventDefault();
					this.commit(inputs);
				}
			});
		}
		const btnRow = contentEl.createDiv({ cls: 'life-prompt-btns' });
		const ok = btnRow.createEl('button', { text: '确定', cls: 'mod-cta' });
		ok.addEventListener('click', () => this.commit(inputs));
		const cancel = btnRow.createEl('button', { text: '取消' });
		cancel.addEventListener('click', () => this.close());
	}

	private commit(inputs: Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>): void {
		const values: Record<string, string> = {};
		for (const f of this.fields) {
			const input = inputs.get(f.key);
			const raw = (input?.value ?? '').trim();
			const err = f.validate?.(raw) ?? null;
			if (err) {
				// 标红 + title 提示（输入即清除标红）
				if (input) {
					(input as HTMLElement).addClass('life-input-error');
					(input as HTMLElement).setAttribute('title', err);
					input.addEventListener('input', () => (input as HTMLElement).removeClass('life-input-error'), {
						once: true,
					});
					input.focus();
				}
				return;
			}
			values[f.key] = raw;
		}
		this.close();
		this.onOk(values);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** 空态文案块。 */
export function renderEmpty(host: HTMLElement, text: string): void {
	host.createDiv({ cls: 'life-empty', text });
}

/** 头部条（标题 + 右侧动作区,返回动作容器）。 */
export function renderBar(host: HTMLElement, title: string): HTMLElement {
	const bar = host.createDiv({ cls: 'life-bar' });
	bar.createSpan({ cls: 'life-bar__title', text: title });
	return bar;
}
