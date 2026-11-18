/**
 * 习惯面板：每个习惯一行 —— 名称 + 最近 7 天打卡点格 + 连续天数。
 * 点今日格子打卡/取消；左滑行（右键）编辑/删除。打卡数据 logs[dateKey]=true。
 */
import { ItemView, Menu, type WorkspaceLeaf } from 'obsidian';
import type LifePlugin from '../main';
import { genId, recentDayKeys, streakOf, todayKey, WEEKDAY_LABELS } from '../util';
import { LifePromptModal, renderBar, renderEmpty } from './common';

export const VIEW_LIFE_HABITS = 'life-habits';

const HABIT_COLORS = ['#eac54f', '#7bd17b', '#7ab8f5', '#f0a0c8', '#b48ef5'];

export class LifeHabitsView extends ItemView {
	constructor(leaf: WorkspaceLeaf, private plugin: LifePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_LIFE_HABITS;
	}

	getDisplayText(): string {
		return '习惯';
	}

	getIcon(): string {
		return 'flame';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('life-habits');
		const bar = renderBar(this.contentEl, '习惯');
		const add = bar.createEl('button', { text: '新建习惯', cls: 'mod-cta' });
		add.addEventListener('click', () => this.promptAdd());
		this.render();
	}

	private render(): void {
		this.contentEl.querySelectorAll('.life-habits__list, .life-empty').forEach((el) => el.remove());
		const habits = this.plugin.store.settings.habits;
		if (!habits.length) {
			renderEmpty(this.contentEl, '还没有习惯。建一个（喝水/拉伸/背单词…），每天点一下打卡。');
			return;
		}
		const days = recentDayKeys(7);
		const today = todayKey();
		const list = this.contentEl.createDiv({ cls: 'life-habits__list' });
		// 表头：星期标签
		const head = list.createDiv({ cls: 'life-habits__row life-habits__row--head' });
		head.createDiv({ cls: 'life-habits__name', text: '习惯' });
		const gridHead = head.createDiv({ cls: 'life-habits__grid' });
		for (let i = 0; i < 7; i++) {
			const d = new Date(days[0]);
			d.setDate(d.getDate() + i);
			gridHead.createDiv({ cls: 'life-habits__cell life-habits__cell--head', text: WEEKDAY_LABELS[(d.getDay() + 6) % 7] });
		}
		head.createDiv({ cls: 'life-habits__streak', text: '连续' });

		for (const h of habits) {
			const row = list.createDiv({ cls: 'life-habits__row' });
			const name = row.createDiv({ cls: 'life-habits__name' });
			const dot = name.createSpan({ cls: 'life-habits__dot' });
			dot.style.background = h.color ?? HABIT_COLORS[0];
			name.createSpan({ text: h.name });
			const grid = row.createDiv({ cls: 'life-habits__grid' });
			for (const key of days) {
				const cell = grid.createDiv({ cls: 'life-habits__cell' + (key === today ? ' is-today' : '') });
				if (h.logs[key]) {
					cell.addClass('is-done');
					cell.style.background = h.color ?? HABIT_COLORS[0];
				}
				cell.addEventListener('click', () => {
					if (h.logs[key]) delete h.logs[key];
					else h.logs[key] = true;
					this.plugin.store.scheduleSave();
					this.render();
				});
			}
			const streak = row.createDiv({ cls: 'life-habits__streak', text: `${streakOf(h.logs, today)}🔥` });
			void streak;
			row.addEventListener('contextmenu', (ev) => {
				ev.preventDefault();
				const menu = new Menu();
				menu.addItem((item) =>
					item.setTitle('编辑').setIcon('pencil').onClick(() => this.promptEdit(h.id)),
				);
				menu.addItem((item) =>
					item.setTitle('删除').setIcon('trash').onClick(() => {
						const s = this.plugin.store.settings;
						s.habits = s.habits.filter((x) => x.id !== h.id);
						this.plugin.store.scheduleSave();
						this.render();
					}),
				);
				menu.showAtMouseEvent(ev);
			});
		}
	}

	private promptAdd(): void {
		new LifePromptModal(
			this.app,
			'新建习惯',
			[
				{ key: 'name', label: '名称', placeholder: '每天喝水', validate: (v) => (v ? null : '请填名称') },
			],
			(values) => {
				const s = this.plugin.store.settings;
				s.habits.push({
					id: genId(),
					name: values.name,
					color: HABIT_COLORS[s.habits.length % HABIT_COLORS.length],
					start: todayKey(),
					logs: {},
				});
				this.plugin.store.scheduleSave();
				this.render();
			},
		).open();
	}

	private promptEdit(id: string): void {
		const h = this.plugin.store.settings.habits.find((x) => x.id === id);
		if (!h) return;
		new LifePromptModal(
			this.app,
			'编辑习惯',
			[{ key: 'name', label: '名称', value: h.name, validate: (v) => (v ? null : '请填名称') }],
			(values) => {
				h.name = values.name;
				this.plugin.store.scheduleSave();
				this.render();
			},
		).open();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}
