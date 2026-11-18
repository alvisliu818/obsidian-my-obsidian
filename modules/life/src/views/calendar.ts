/**
 * 大日历面板：月视图网格（周一开头）聚合全部域 —— 任务(due)/计划(date)/
 * 习惯打卡/倒数日/记账(收支额)。点月份切换、点「今天」回当月、点格子展开
 * 当日明细（列表 + 快捷加任务/计划）。
 */
import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type LifePlugin from '../main';
import { monthGrid, sumLedgerMonth, todayKey, WEEKDAY_LABELS } from '../util';
import { LifeTasksView } from './tasks';
import { LifePlansView } from './plans';

export const VIEW_LIFE_CALENDAR = 'life-calendar';

interface DayDots {
	tasks: number;
	plans: number;
	habits: number;
	dday: boolean;
	ledger: number;
}

export class LifeCalendarView extends ItemView {
	private year: number;
	private month0: number;
	private detailDate: string | null = null;

	constructor(leaf: WorkspaceLeaf, private plugin: LifePlugin) {
		super(leaf);
		this.plugin = plugin;
		const now = new Date();
		this.year = now.getFullYear();
		this.month0 = now.getMonth();
	}

	getViewType(): string {
		return VIEW_LIFE_CALENDAR;
	}

	getDisplayText(): string {
		return '大日历';
	}

	getIcon(): string {
		return 'calendar-days';
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	private collect(key: string): DayDots {
		const s = this.plugin.store.settings;
		return {
			tasks: s.tasks.filter((t) => !t.done && t.due === key).length,
			plans: s.plans.filter((p) => p.date === key).length,
			habits: s.habits.filter((h) => h.logs[key]).length,
			dday: s.ddays.some((d) => d.date === key),
			ledger: sumLedgerMonth(
				s.ledger.filter((e) => e.date === key),
				key.slice(0, 7),
			).expense,
		};
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const today = todayKey();
		const bar = contentEl.createDiv({ cls: 'life-cal__bar' });
		const prev = bar.createEl('button', { text: '‹' });
		prev.addEventListener('click', () => this.shift(-1));
		bar.createSpan({ cls: 'life-cal__title', text: `${this.year} 年 ${this.month0 + 1} 月` });
		const next = bar.createEl('button', { text: '›' });
		next.addEventListener('click', () => this.shift(1));
		const todayBtn = bar.createEl('button', { text: '今天' });
		todayBtn.addEventListener('click', () => {
			const now = new Date();
			this.year = now.getFullYear();
			this.month0 = now.getMonth();
			this.detailDate = today;
			this.render();
		});

		const gridWrap = contentEl.createDiv({ cls: 'life-cal__grid' });
		for (const w of WEEKDAY_LABELS) gridWrap.createDiv({ cls: 'life-cal__weekday', text: w });

		const cells = monthGrid(this.year, this.month0, today);
		for (const cell of cells) {
			const dots = this.collect(cell.key);
			const el = gridWrap.createDiv({
				cls:
					'life-cal__cell' +
					(cell.inMonth ? '' : ' is-out') +
					(cell.key === today ? ' is-today' : '') +
					(cell.key === this.detailDate ? ' is-selected' : ''),
			});
			el.createDiv({ cls: 'life-cal__day', text: String(cell.day) });
			const badge = el.createDiv({ cls: 'life-cal__dots' });
			if (dots.tasks) badge.createSpan({ cls: 'life-cal__dot life-cal__dot--task', text: String(dots.tasks) });
			if (dots.plans) badge.createSpan({ cls: 'life-cal__dot life-cal__dot--plan', text: String(dots.plans) });
			if (dots.habits) badge.createSpan({ cls: 'life-cal__dot life-cal__dot--habit', text: '🔥' });
			if (dots.dday) badge.createSpan({ cls: 'life-cal__dot life-cal__dot--dday', text: '📌' });
			if (dots.ledger) badge.createSpan({ cls: 'life-cal__dot life-cal__dot--ledger', text: '¥' });
			el.addEventListener('click', () => {
				this.detailDate = cell.key;
				this.render();
			});
		}

		this.renderDetail();
	}

	/** 当日明细：勾掉任务/计划,快捷加任务/计划/记账。 */
	private renderDetail(): void {
		const { contentEl } = this;
		contentEl.querySelectorAll('.life-cal__detail').forEach((el) => el.remove());
		if (!this.detailDate) return;
		const key = this.detailDate;
		const s = this.plugin.store.settings;
		const detail = contentEl.createDiv({ cls: 'life-cal__detail' });
		detail.createDiv({ cls: 'life-cal__detail-title', text: `${key} 明细` });

		const tasks = s.tasks.filter((t) => t.due === key);
		const plans = s.plans.filter((p) => p.date === key);
		if (!tasks.length && !plans.length) {
			detail.createDiv({ cls: 'life-empty', text: '当天没有任务/计划。下面快捷添加。' });
		} else {
			for (const t of tasks) {
				const row = detail.createDiv({ cls: 'life-cal__row' + (t.done ? ' is-done' : '') });
				const box = row.createDiv({ cls: 'life-tasks__box' });
				box.setText(t.done ? '☑' : '☐');
				box.addEventListener('click', (ev) => {
					ev.stopPropagation();
					t.done = !t.done;
					t.doneAt = t.done ? Date.now() : undefined;
					this.plugin.store.scheduleSave();
					this.render();
				});
				row.createSpan({ cls: 'life-cal__row-text', text: `[任务] ${t.title}` });
			}
			for (const p of plans) {
				const row = detail.createDiv({ cls: 'life-cal__row' + (p.done ? ' is-done' : '') });
				const box = row.createDiv({ cls: 'life-tasks__box' });
				box.setText(p.done ? '☑' : '☐');
				box.addEventListener('click', (ev) => {
					ev.stopPropagation();
					p.done = !p.done;
					this.plugin.store.scheduleSave();
					this.render();
				});
				row.createSpan({ cls: 'life-cal__row-text', text: `${p.time ? p.time + ' ' : ''}[计划] ${p.title}` });
			}
		}
		const actions = detail.createDiv({ cls: 'life-cal__actions' });
		const addTask = actions.createEl('button', { text: '+ 任务' });
		addTask.addEventListener('click', () =>
			LifeTasksView.quickAdd(this.plugin, this.app, key, () => this.render()),
		);
		const addPlan = actions.createEl('button', { text: '+ 计划' });
		addPlan.addEventListener('click', () =>
			LifePlansView.quickAdd(this.plugin, this.app, key, () => this.render()),
		);
	}

	private shift(delta: number): void {
		this.month0 += delta;
		if (this.month0 < 0) {
			this.month0 = 11;
			this.year--;
		} else if (this.month0 > 11) {
			this.month0 = 0;
			this.year++;
		}
		this.detailDate = null;
		this.render();
	}
}
