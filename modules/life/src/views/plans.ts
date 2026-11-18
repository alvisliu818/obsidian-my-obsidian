/**
 * 计划面板：带日期（可选时间）的事项条目——比任务轻、比代办更「日程」。
 * 按日期分组（近的在前,过期标红）；大日历按 date 落格。
 */
import { ItemView, Menu, type WorkspaceLeaf } from 'obsidian';
import type LifePlugin from '../main';
import { daysBetween, genId, todayKey } from '../util';
import { LifePromptModal, renderBar, renderEmpty } from './common';

export const VIEW_LIFE_PLANS = 'life-plans';

export class LifePlansView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private plugin: LifePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_LIFE_PLANS;
	}

	getDisplayText(): string {
		return '计划';
	}

	getIcon(): string {
		return 'calendar-range';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('life-plans');
		const bar = renderBar(this.contentEl, '计划');
		const add = bar.createEl('button', { text: '新建计划', cls: 'mod-cta' });
		add.addEventListener('click', () => this.promptAdd());
		this.render();
	}

	private render(): void {
		this.contentEl.querySelectorAll('.life-plans__groups, .life-empty').forEach((el) => el.remove());
		const plans = this.plugin.store.settings.plans;
		if (!plans.length) {
			renderEmpty(this.contentEl, '还没有计划。建一个带日期的事项，大日历会显示它。');
			return;
		}
		// 按日期分组（未完成的在前）
		const byDate = new Map<string, typeof plans>();
		for (const p of [...plans].sort((a, b) => (a.date + (a.time ?? '')).localeCompare(b.date + (b.time ?? '')) || Number(a.done) - Number(b.done))) {
			if (!byDate.has(p.date)) byDate.set(p.date, []);
			byDate.get(p.date)?.push(p);
		}
		const today = todayKey();
		const wrap = this.contentEl.createDiv({ cls: 'life-plans__groups' });
		const dates = [...byDate.keys()].sort((a, b) => {
			// 今天夹在中间：未来升序在前,过去降序在后
			const da = daysBetween(today, a) ?? 0;
			const db = daysBetween(today, b) ?? 0;
			if (da >= 0 && db >= 0) return da - db;
			if (da < 0 && db < 0) return db - da;
			return da >= 0 ? -1 : 1;
		});
		for (const date of dates) {
			const diff = daysBetween(today, date) ?? 0;
			const title = diff === 0 ? '今天' : diff === 1 ? '明天' : date;
			const group = wrap.createDiv({ cls: 'life-plans__group' + (diff < 0 ? ' is-past' : diff === 0 ? ' is-today' : '') });
			group.createDiv({ cls: 'life-plans__group-title', text: title });
			for (const p of byDate.get(date) ?? []) this.renderRow(group, p);
		}
	}

	private renderRow(host: HTMLElement, p: (typeof this.plugin.store.settings.plans)[number]): void {
		const row = host.createDiv({ cls: 'life-plans__row' + (p.done ? ' is-done' : '') });
		const box = row.createDiv({ cls: 'life-plans__box' });
		box.setText(p.done ? '☑' : '☐');
		box.addEventListener('click', (ev) => {
			ev.stopPropagation();
			p.done = !p.done;
			this.plugin.store.scheduleSave();
			this.render();
		});
		row.createSpan({ cls: 'life-plans__time', text: p.time ?? '' });
		const title = row.createSpan({ cls: 'life-plans__title', text: p.title });
		void title;
		row.addEventListener('click', () => this.promptEdit(p.id));
		row.addEventListener('contextmenu', (ev) => {
			ev.preventDefault();
			const menu = new Menu();
			menu.addItem((item) =>
				item.setTitle('编辑').setIcon('pencil').onClick(() => this.promptEdit(p.id)),
			);
			menu.addItem((item) =>
				item.setTitle('删除').setIcon('trash').onClick(() => {
					const s = this.plugin.store.settings;
					s.plans = s.plans.filter((x) => x.id !== p.id);
					this.plugin.store.scheduleSave();
					this.render();
				}),
			);
			menu.showAtMouseEvent(ev);
		});
	}

	private promptAdd(defaultDate?: string): void {
		new LifePromptModal(
			this.app,
			'新建计划',
			[
				{ key: 'title', label: '事项', placeholder: '做什么', validate: (v) => (v ? null : '请填标题') },
				{ key: 'date', label: '日期', type: 'date', value: defaultDate ?? todayKey(), validate: (v) => (v ? null : '请选日期') },
				{ key: 'time', label: '时间（可选）', type: 'time' },
				{ key: 'note', label: '备注（可选）', type: 'textarea' },
			],
			(values) => {
				const s = this.plugin.store.settings;
				s.plans.push({
					id: genId(),
					date: values.date,
					time: values.time || undefined,
					title: values.title,
					note: values.note || undefined,
					done: false,
				});
				this.plugin.store.scheduleSave();
				this.render();
			},
		).open();
	}

	private promptEdit(id: string): void {
		const p = this.plugin.store.settings.plans.find((x) => x.id === id);
		if (!p) return;
		new LifePromptModal(
			this.app,
			'编辑计划',
			[
				{ key: 'title', label: '事项', value: p.title, validate: (v) => (v ? null : '请填标题') },
				{ key: 'date', label: '日期', type: 'date', value: p.date },
				{ key: 'time', label: '时间（可选）', type: 'time', value: p.time ?? '' },
				{ key: 'note', label: '备注（可选）', type: 'textarea', value: p.note ?? '' },
			],
			(values) => {
				p.title = values.title;
				p.date = values.date;
				p.time = values.time || undefined;
				p.note = values.note || undefined;
				this.plugin.store.scheduleSave();
				this.render();
			},
		).open();
	}

	/** 大日历快捷加计划（calendar.ts 复用）。 */
	static quickAdd(plugin: LifePlugin, app: unknown, date: string, onDone: () => void): void {
		new LifePromptModal(
			app as never,
			`新建计划 · ${date}`,
			[
				{ key: 'title', label: '事项', validate: (v) => (v ? null : '请填标题') },
				{ key: 'time', label: '时间（可选）', type: 'time' },
			],
			(values) => {
				const s = plugin.store.settings;
				s.plans.push({ id: genId(), date, time: values.time || undefined, title: values.title, done: false });
				plugin.store.scheduleSave();
				onDone();
			},
		).open();
	}
}
