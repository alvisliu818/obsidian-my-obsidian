/**
 * 任务面板：带日期与优先级的任务（强于代办的「随手记」）。
 * 分组：今天 / 明天 / 本周 / 稍后（无日期）/ 已完成；优先级三档彩色点。
 * 点击切换完成；点击标题改任务；右键删除。大日历按 due 落格。
 */
import { ItemView, Menu, Notice, type WorkspaceLeaf } from 'obsidian';
import type LifePlugin from '../main';
import { daysBetween, genId, todayKey } from '../util';
import { LifePromptModal, renderBar, renderEmpty } from './common';

export const VIEW_LIFE_TASKS = 'life-tasks';

const PRIORITY_LABELS: Record<number, string> = { 0: '低', 1: '中', 2: '高' };

export class LifeTasksView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private plugin: LifePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_LIFE_TASKS;
	}

	getDisplayText(): string {
		return '任务';
	}

	getIcon(): string {
		return 'square-check-big';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('life-tasks');
		const bar = renderBar(this.contentEl, '任务');
		const add = bar.createEl('button', { text: '新建任务', cls: 'mod-cta' });
		add.addEventListener('click', () => this.promptAdd());
		this.render();
	}

	private render(): void {
		this.contentEl.querySelectorAll('.life-tasks__groups, .life-empty').forEach((el) => el.remove());
		const tasks = this.plugin.store.settings.tasks;
		if (!tasks.length) {
			renderEmpty(this.contentEl, '还没有任务。点右上「新建任务」。');
			return;
		}
		const today = todayKey();
		const groups: { label: string; items: typeof tasks }[] = [
			{ label: '今天', items: [] },
			{ label: '明天', items: [] },
			{ label: '本周', items: [] },
			{ label: '稍后', items: [] },
			{ label: '已完成', items: [] },
		];
		for (const t of tasks) {
			if (t.done) {
				groups[4].items.push(t);
				continue;
			}
			if (!t.due) {
				groups[3].items.push(t);
				continue;
			}
			const diff = daysBetween(today, t.due);
			if (diff === null) groups[3].items.push(t);
			else if (diff <= 0) groups[0].items.push(t);
			else if (diff === 1) groups[1].items.push(t);
			else if (diff <= 6) groups[2].items.push(t);
			else groups[3].items.push(t);
		}
		// 组内排序：优先级高先,再按日期
		const cmp = (a: (typeof tasks)[number], b: (typeof tasks)[number]) =>
			b.priority - a.priority || (a.due || '9999').localeCompare(b.due || '9999');
		for (const g of groups) g.items.sort(cmp);

		const wrap = this.contentEl.createDiv({ cls: 'life-tasks__groups' });
		for (const g of groups) {
			if (!g.items.length) continue;
			wrap.createDiv({ cls: 'life-tasks__group-title', text: `${g.label} · ${g.items.length}` });
			for (const t of g.items) this.renderRow(wrap, t);
		}
	}

	private renderRow(host: HTMLElement, t: (typeof this.plugin.store.settings.tasks)[number]): void {
		const row = host.createDiv({ cls: 'life-tasks__row' + (t.done ? ' is-done' : '') });
		const box = row.createDiv({ cls: 'life-tasks__box' });
		box.setText(t.done ? '☑' : '☐');
		box.addEventListener('click', (ev) => {
			ev.stopPropagation();
			t.done = !t.done;
			t.doneAt = t.done ? Date.now() : undefined;
			this.plugin.store.scheduleSave();
			this.render();
		});
		const pri = row.createDiv({ cls: `life-tasks__pri is-p${t.priority}`, text: PRIORITY_LABELS[t.priority] });
		void pri;
		row.createSpan({ cls: 'life-tasks__title', text: t.title });
		if (t.due) {
			const overdue = !t.done && daysBetween(todayKey(), t.due) !== null && (daysBetween(todayKey(), t.due) ?? 0) < 0;
			row.createSpan({ cls: 'life-tasks__due' + (overdue ? ' is-overdue' : ''), text: t.due });
		}
		row.addEventListener('click', () => this.promptEdit(t.id));
		row.addEventListener('contextmenu', (ev) => {
			ev.preventDefault();
			const menu = new Menu();
			menu.addItem((item) =>
				item.setTitle('编辑').setIcon('pencil').onClick(() => this.promptEdit(t.id)),
			);
			menu.addItem((item) =>
				item.setTitle('删除').setIcon('trash').onClick(() => {
					const s = this.plugin.store.settings;
					s.tasks = s.tasks.filter((x) => x.id !== t.id);
					this.plugin.store.scheduleSave();
					this.render();
				}),
			);
			menu.showAtMouseEvent(ev);
		});
	}

	private promptAdd(): void {
		new LifePromptModal(
			this.app,
			'新建任务',
			[
				{ key: 'title', label: '任务', placeholder: '做什么', validate: (v) => (v ? null : '请填标题') },
				{ key: 'due', label: '截止日（可选）', type: 'date' },
				{
					key: 'priority',
					label: '优先级',
					type: 'select',
					value: '1',
					options: [
						{ value: '0', label: '低' },
						{ value: '1', label: '中' },
						{ value: '2', label: '高' },
					],
				},
			],
			(values) => {
				const s = this.plugin.store.settings;
				s.tasks.push({
					id: genId(),
					title: values.title,
					due: values.due ?? '',
					priority: (Number(values.priority || 0) as 0 | 1 | 2) ?? 0,
					done: false,
					createdAt: Date.now(),
				});
				this.plugin.store.scheduleSave();
				this.render();
			},
		).open();
	}

	private promptEdit(id: string): void {
		const t = this.plugin.store.settings.tasks.find((x) => x.id === id);
		if (!t) return;
		new LifePromptModal(
			this.app,
			'编辑任务',
			[
				{ key: 'title', label: '任务', value: t.title, validate: (v) => (v ? null : '请填标题') },
				{ key: 'due', label: '截止日（可选）', type: 'date', value: t.due || '' },
				{
					key: 'priority',
					label: '优先级',
					type: 'select',
					value: String(t.priority),
					options: [
						{ value: '0', label: '低' },
						{ value: '1', label: '中' },
						{ value: '2', label: '高' },
					],
				},
			],
			(values) => {
				t.title = values.title;
				t.due = values.due ?? '';
				const pri = Number(values.priority);
				t.priority = (pri === 0 || pri === 1 || pri === 2 ? pri : 0) as 0 | 1 | 2;
				this.plugin.store.scheduleSave();
				this.render();
			},
		).open();
	}

	/** 大日历快捷加任务入口（calendar.ts 复用）。 */
	static quickAdd(plugin: LifePlugin, app: unknown, due: string, onDone: () => void): void {
		new LifePromptModal(
			app as never,
			`新建任务 · ${due}`,
			[
				{ key: 'title', label: '任务', validate: (v) => (v ? null : '请填标题') },
				{
					key: 'priority',
					label: '优先级',
					type: 'select',
					value: '1',
					options: [
						{ value: '0', label: '低' },
						{ value: '1', label: '中' },
						{ value: '2', label: '高' },
					],
				},
			],
			(values) => {
				const s = plugin.store.settings;
				s.tasks.push({
					id: genId(),
					title: values.title,
					due,
					priority: (Number(values.priority || 1) as 0 | 1 | 2) ?? 1,
					done: false,
					createdAt: Date.now(),
				});
				plugin.store.scheduleSave();
				new Notice('任务已建');
				onDone();
			},
		).open();
	}
}
