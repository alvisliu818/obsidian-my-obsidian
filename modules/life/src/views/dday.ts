/**
 * 倒数日面板：目标日列表（未来 = D-x 倒数,过去 = D+x 累计,今天 = D-Day），
 * 按临近排序；添加/编辑/删除走 LifePromptModal。
 */
import { ItemView, Menu, type WorkspaceLeaf } from 'obsidian';
import type LifePlugin from '../main';
import { ddayLabel, daysBetween, genId, todayKey } from '../util';
import { LifePromptModal, renderBar, renderEmpty } from './common';

export const VIEW_LIFE_DDAY = 'life-dday';

export class LifeDdayView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private plugin: LifePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_LIFE_DDAY;
	}

	getDisplayText(): string {
		return '倒数日';
	}

	getIcon(): string {
		return 'calendar-clock';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('life-dday');
		const bar = renderBar(this.contentEl, '倒数日');
		const add = bar.createEl('button', { text: '添加', cls: 'mod-cta' });
		add.addEventListener('click', () => this.promptAdd());
		this.render();
	}

	private render(): void {
		this.contentEl.querySelectorAll('.life-dday__list, .life-empty').forEach((el) => el.remove());
		const items = [...this.plugin.store.settings.ddays].sort((a, b) => {
			const da = daysBetween(todayKey(), a.date) ?? 0;
			const db = daysBetween(todayKey(), b.date) ?? 0;
			// 未来按近先,过去按近先（|diff| 小者前）
			return Math.abs(da) - Math.abs(db);
		});
		if (!items.length) {
			renderEmpty(this.contentEl, '还没有倒数日。添加一个纪念日/截止日，它按 D-x 倒数。');
			return;
		}
		const list = this.contentEl.createDiv({ cls: 'life-dday__list' });
		for (const it of items) {
			const row = list.createDiv({ cls: 'life-dday__row' });
			const badge = row.createDiv({ cls: 'life-dday__badge' });
			row.createSpan({ cls: 'life-dday__emoji', text: it.emoji ?? '📌' });
			row.createDiv({ cls: 'life-dday__name', text: it.title });
			row.createDiv({ cls: 'life-dday__date', text: it.date });
			const label = ddayLabel(it.date) ?? '--';
			badge.addClass(label === 'D-Day' ? 'is-today' : label.startsWith('D-') ? 'is-future' : 'is-past');
			badge.setText(label);
			row.addEventListener('contextmenu', (ev) => {
				ev.preventDefault();
				this.showRowMenu(ev, it.id);
			});
			row.addEventListener('click', () => this.promptEdit(it.id));
		}
	}

	/** 行内菜单：编辑 / 删除。 */
	private showRowMenu(ev: MouseEvent, id: string): void {
		const menu = new Menu();
		menu.addItem((item) =>
			item.setTitle('编辑').setIcon('pencil').onClick(() => this.promptEdit(id)),
		);
		menu.addItem((item) =>
			item.setTitle('删除').setIcon('trash').onClick(() => {
				const s = this.plugin.store.settings;
				s.ddays = s.ddays.filter((x) => x.id !== id);
				this.plugin.store.scheduleSave();
				this.render();
			}),
		);
		menu.showAtMouseEvent(ev);
	}

	private promptAdd(): void {
		new LifePromptModal(
			this.app,
			'添加倒数日',
			[
				{ key: 'title', label: '名称', placeholder: '生日 / 截止日…', validate: (v) => (v ? null : '请填名称') },
				{ key: 'date', label: '目标日', type: 'date', value: todayKey(), validate: (v) => (v ? null : '请选日期') },
				{ key: 'emoji', label: '图标（可选）', placeholder: '🎂 ✈️ 🎯' },
			],
			(values) => {
				const s = this.plugin.store.settings;
				s.ddays.push({ id: genId(), title: values.title, date: values.date, emoji: values.emoji || undefined });
				this.plugin.store.scheduleSave();
				this.render();
			},
		).open();
	}

	private promptEdit(id: string): void {
		const it = this.plugin.store.settings.ddays.find((x) => x.id === id);
		if (!it) return;
		new LifePromptModal(
			this.app,
			'编辑倒数日',
			[
				{ key: 'title', label: '名称', value: it.title, validate: (v) => (v ? null : '请填名称') },
				{ key: 'date', label: '目标日', type: 'date', value: it.date },
				{ key: 'emoji', label: '图标（可选）', value: it.emoji ?? '' },
			],
			(values) => {
				it.title = values.title;
				it.date = values.date;
				it.emoji = values.emoji || undefined;
				this.plugin.store.scheduleSave();
				this.render();
			},
		).open();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}
