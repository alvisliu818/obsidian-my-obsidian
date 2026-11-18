/**
 * 代办面板：随手 checklist。顶部快加输入（Enter 新建），条目点击切换完成，
 * 右键删除/清掉已完成。完成的沉底置灰。
 */
import { ItemView, Menu, type WorkspaceLeaf } from 'obsidian';
import type LifePlugin from '../main';
import { genId } from '../util';
import { LifePromptModal, renderBar, renderEmpty } from './common';

export const VIEW_LIFE_TODO = 'life-todo';

export class LifeTodoView extends ItemView {
	private inputEl: HTMLInputElement | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: LifePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_LIFE_TODO;
	}

	getDisplayText(): string {
		return '代办';
	}

	getIcon(): string {
		return 'list-checks';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('life-todo');
		const bar = renderBar(this.contentEl, '代办');
		const clearDone = bar.createEl('button', { text: '清掉已完成' });
		clearDone.addEventListener('click', () => {
			const s = this.plugin.store.settings;
			s.todos = s.todos.filter((t) => !t.done);
			this.plugin.store.scheduleSave();
			this.render();
		});
		const quick = this.contentEl.createDiv({ cls: 'life-quickadd' });
		this.inputEl = quick.createEl('input');
		this.inputEl.placeholder = '记一件代办，回车新建';
		this.inputEl.addEventListener('keydown', (ev: KeyboardEvent) => {
			if (ev.key === 'Enter' && this.inputEl?.value.trim()) this.add();
		});
		this.render();
	}

	private add(): void {
		const title = this.inputEl?.value.trim();
		if (!title || !this.inputEl) return;
		const s = this.plugin.store.settings;
		s.todos.push({ id: genId(), title, done: false, createdAt: Date.now() });
		this.inputEl.value = '';
		this.plugin.store.scheduleSave();
		this.render();
	}

	private render(): void {
		this.contentEl.querySelectorAll('.life-todo__list, .life-empty').forEach((el) => el.remove());
		const items = this.plugin.store.settings.todos;
		if (!items.length) {
			renderEmpty(this.contentEl, '没有代办。上面输入框随手记。');
			return;
		}
		const sorted = [...items].sort((a, b) => Number(a.done) - Number(b.done) || b.createdAt - a.createdAt);
		const list = this.contentEl.createDiv({ cls: 'life-todo__list' });
		for (const it of sorted) {
			const row = list.createDiv({ cls: 'life-todo__row' + (it.done ? ' is-done' : '') });
			const box = row.createDiv({ cls: 'life-todo__box' });
			box.setText(it.done ? '☑' : '☐');
			row.createSpan({ cls: 'life-todo__title', text: it.title });
			row.addEventListener('click', () => {
				it.done = !it.done;
				it.doneAt = it.done ? Date.now() : undefined;
				this.plugin.store.scheduleSave();
				this.render();
			});
			row.addEventListener('contextmenu', (ev) => {
				ev.preventDefault();
				const menu = new Menu();
				menu.addItem((item) =>
					item.setTitle('重命名').setIcon('pencil').onClick(() => {
						new LifePromptModal(this.app, '重命名代办', [
							{ key: 'title', label: '名称', value: it.title, validate: (v) => (v ? null : '请填名称') },
						], (values) => {
							it.title = values.title;
							this.plugin.store.scheduleSave();
							this.render();
						}).open();
					}),
				);
				menu.addItem((item) =>
					item.setTitle('删除').setIcon('trash').onClick(() => {
						const s = this.plugin.store.settings;
						s.todos = s.todos.filter((x) => x.id !== it.id);
						this.plugin.store.scheduleSave();
						this.render();
					}),
				);
				menu.showAtMouseEvent(ev);
			});
		}
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}
