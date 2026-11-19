/**
 * HOME 标签页(2026-11-19 阶段 D):一页聚合——今日库变化、库记录列表
 * (点击展开明细,总体/按文件夹双视图)、迷你月网格(任务/计划圆点)、
 * 任务/代办/习惯/计时摘要(点击跳对应面板)、库记录设置(折叠)。
 *
 * 数据源全部来自本模块 store(todos/tasks/habits/plans/timer + vaultLog
 * 记录序列);打开即全量渲染,操作后局部重绘(store 薄层惯例)。
 * 库记录引擎见 ../vaultLog(纯逻辑);调度与手动打点在 main.ts。
 */
import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type LifePlugin from '../main';
import { VIEW_LIFE_HOME } from './homeTypes';
import { monthGrid, todayKey, formatDuration } from '../util';
import { changeSummary } from '../vaultLog';
import type { VaultLogRecord } from '../types';

export { VIEW_LIFE_HOME };

export class LifeHomeView extends ItemView {
	/** 库记录明细视图:overall = 总体列表;folder = 按顶级文件夹分组 */
	private detailMode: 'overall' | 'folder' = 'folder';
	/** 明细展开针对的记录 */
	private detailRecordId: string | null = null;
	private settingsOpen = false;

	constructor(leaf: WorkspaceLeaf, private plugin: LifePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_LIFE_HOME;
	}

	getDisplayText(): string {
		return 'HOME';
	}

	getIcon(): string {
		return 'home';
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	/** 外部刷新入口(记录/设置变更后由 LifePlugin 调)。 */
	refresh(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('life-home');
		const s = this.plugin.store.settings;
		const now = new Date();
		const dateStr = todayKey();

		// ---- 头部:日期 + 立即记录按钮 ----
		const head = contentEl.createDiv({ cls: 'life-home-head' });
		head.createDiv({ cls: 'life-home-date', text: `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日` });
		const headBtns = head.createDiv({ cls: 'life-home-head-btns' });
		const recBtn = headBtns.createEl('button', { cls: 'life-home-rec-btn', text: '记录库变化' });
		recBtn.addEventListener('click', () => void this.plugin.recordVaultChanges('manual'));
		const gear = headBtns.createEl('button', { cls: 'life-home-gear', attr: { 'aria-label': '库记录设置' } });
		gear.setText('⚙');
		gear.addEventListener('click', () => {
			this.settingsOpen = !this.settingsOpen;
			this.render();
		});

		// ---- 库记录设置(折叠) ----
		if (this.settingsOpen) this.renderVaultLogSettings(contentEl);

		// ---- 今日库变化(今天的最新一条) ----
		const todayRec = s.vaultLogRecords.find((r) => r.date === dateStr) ?? null;
		const latest = s.vaultLogRecords[0] ?? null;
		const sec1 = contentEl.createDiv({ cls: 'life-home-section' });
		sec1.createDiv({ cls: 'life-home-sec-title', text: '今日库变化' });
		if (todayRec) {
			this.renderRecordSummary(sec1, todayRec);
		} else if (latest) {
			sec1.createDiv({
				cls: 'life-home-muted',
				text: `今天还没有记录。最近一条:${latest.date.slice(5)}(${changeSummary(latest)})`,
			});
		} else {
			sec1.createDiv({ cls: 'life-home-muted', text: '还没有任何记录。点「记录库变化」打第一笔。' });
		}

		// ---- 库记录列表(最近 10 条,点击展开明细) ----
		const sec2 = contentEl.createDiv({ cls: 'life-home-section' });
		sec2.createDiv({ cls: 'life-home-sec-title', text: '库记录' });
		if (s.vaultLogRecords.length === 0) {
			sec2.createDiv({ cls: 'life-home-muted', text: '暂无记录。' });
		} else {
			this.renderRecordList(sec2, s.vaultLogRecords.slice(0, 10));
		}

		// ---- 迷你月网格(任务/计划圆点 + 当日明细) ----
		const sec3 = contentEl.createDiv({ cls: 'life-home-section' });
		sec3.createDiv({ cls: 'life-home-sec-title', text: '大日历' });
		this.renderMiniCalendar(sec3);
		sec3.createDiv({ cls: 'life-home-muted', text: '完整版(点格子加任务/计划)在「大日历」面板 →' });

		// ---- 任务/代办/习惯/计时 摘要 ----
		const sec4 = contentEl.createDiv({ cls: 'life-home-section' });
		sec4.createDiv({ cls: 'life-home-sec-title', text: '今日概览' });
		this.renderLifeSummaries(sec4);
	}

	/** 一条记录的摘要行(+N · ~M · -K + 时间 + 触发方式)。 */
	private renderRecordSummary(container: HTMLElement, rec: VaultLogRecord): void {
		const row = container.createDiv({ cls: 'life-home-rec-summary' });
		row.createSpan({
			cls: 'life-home-rec-counts',
			text: `+${rec.added.length} 新增 · ~${rec.modified.length} 修改 · -${rec.deleted.length} 删除`,
		});
		row.createSpan({
			cls: 'life-home-rec-meta',
			text: `${rec.at.slice(11, 16)} · ${rec.trigger === 'manual' ? '手动' : rec.trigger === 'daily' ? '每日' : '周期'}`,
		});
	}

	/** 记录列表:每行摘要,点击展开明细(总体/按文件夹双视图)。 */
	private renderRecordList(container: HTMLElement, records: VaultLogRecord[]): void {
		const modeRow = container.createDiv({ cls: 'life-home-mode-row' });
		for (const [label, mode] of [
			['总体', 'overall'],
			['按文件夹', 'folder'],
		] as const) {
			const btn = modeRow.createEl('button', { cls: 'life-home-mode-btn', text: label });
			if (this.detailMode === mode) btn.addClass('is-active');
			btn.addEventListener('click', (ev) => {
				ev.stopPropagation();
				this.detailMode = mode;
				this.render();
			});
		}
		for (const rec of records) {
			const isExpanded = this.detailRecordId === rec.id;
			const row = container.createDiv({ cls: 'life-home-rec-row' });
			row.createSpan({
				cls: 'life-home-rec-time',
				text: rec.date.slice(5) + ' ' + rec.at.slice(11, 16),
			});
			row.createSpan({ cls: 'life-home-rec-counts', text: changeSummary(rec) });
			row.createSpan({ cls: 'life-home-rec-trigger', text: rec.trigger === 'manual' ? '手动' : '自动' });
			row.addEventListener('click', () => {
				this.detailRecordId = isExpanded ? null : rec.id;
				this.render();
			});
			if (!isExpanded) continue;
			const detail = container.createDiv({ cls: 'life-home-rec-detail' });
			this.renderDiffLists(detail, rec, this.detailMode);
		}
	}

	/** 变化清单:overall = 平铺三类;folder = 按顶级文件夹分组。 */
	private renderDiffLists(container: HTMLElement, rec: VaultLogRecord, mode: 'overall' | 'folder'): void {
		const empty = rec.added.length + rec.modified.length + rec.deleted.length === 0;
		if (empty) {
			container.createDiv({ cls: 'life-home-muted', text: '(无变化)' });
			return;
		}
		if (mode === 'overall') {
			const kinds: [string, string[], string][] = [
				['新增', rec.added, 'is-added'],
				['修改', rec.modified, 'is-modified'],
				['删除', rec.deleted, 'is-deleted'],
			];
			for (const [label, list, cls] of kinds) {
				if (list.length === 0) continue;
				container.createDiv({ cls: 'life-home-rec-kind-title', text: `${label}(${list.length})` });
				for (const p of list.slice(0, 30)) {
					container.createDiv({ cls: `life-home-rec-item ${cls}`, text: p });
				}
				if (list.length > 30) container.createDiv({ cls: 'life-home-muted', text: `…还有 ${list.length - 30} 条` });
			}
			return;
		}
		// 按文件夹分组:路径 → 变化条目(顶级目录键;根文件归「(根)」)
		const groups = new Map<string, { label: string; kind: 'added' | 'modified' | 'deleted' }[]>();
		const put = (path: string, kind: 'added' | 'modified' | 'deleted') => {
			const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '(根)';
			const list = groups.get(dir) ?? [];
			list.push({ label: path.slice(dir === '(根)' ? 0 : dir.length + 1), kind });
			groups.set(dir, list);
		};
		for (const p of rec.added) put(p, 'added');
		for (const p of rec.modified) put(p, 'modified');
		for (const p of rec.deleted) put(p, 'deleted');
		for (const [dir, items] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			const g = container.createDiv({ cls: 'life-home-rec-group' });
			g.createDiv({ cls: 'life-home-rec-group-title', text: dir });
			for (const it of items) {
				const cls = it.kind === 'added' ? 'is-added' : it.kind === 'modified' ? 'is-modified' : 'is-deleted';
				g.createDiv({ cls: `life-home-rec-item ${cls}`, text: (it.kind === 'added' ? '+ ' : it.kind === 'modified' ? '~ ' : '- ') + it.label });
			}
		}
	}

	/** 迷你月网格(任务/计划圆点)+ 当日明细。 */
	private renderMiniCalendar(container: HTMLElement): void {
		const now = new Date();
		const cells = monthGrid(now.getFullYear(), now.getMonth(), todayKey());
		const s = this.plugin.store.settings;
		const grid = container.createDiv({ cls: 'life-home-cal' });
		const headRow = grid.createDiv({ cls: 'life-home-cal-row is-head' });
		for (const w of ['一', '二', '三', '四', '五', '六', '日']) headRow.createSpan({ cls: 'life-home-cal-wd', text: w });
		for (const cell of cells) {
			const cellEl = grid.createDiv({ cls: `life-home-cal-cell${cell.inMonth ? '' : ' is-out'}${cell.key === todayKey() ? ' is-today' : ''}` });
			cellEl.createSpan({ cls: 'life-home-cal-day', text: String(cell.day) });
			const taskCount = s.tasks.filter((t) => t.due === cell.key && !t.done).length;
			const planCount = s.plans.filter((p) => p.date === cell.key).length;
			if (taskCount > 0) cellEl.createSpan({ cls: 'life-home-cal-dot is-task', text: String(taskCount) });
			if (planCount > 0) cellEl.createSpan({ cls: 'life-home-cal-dot is-plan', text: String(planCount) });
		}
		// 当日明细:今日到期任务 + 今日计划
		const today = todayKey();
		const dueToday = s.tasks.filter((t) => t.due === today && !t.done);
		const plansToday = s.plans.filter((p) => p.date === today);
		const detail = container.createDiv({ cls: 'life-home-cal-detail' });
		if (dueToday.length === 0 && plansToday.length === 0) {
			detail.createDiv({ cls: 'life-home-muted', text: '今天没有到期的任务和计划。' });
			return;
		}
		for (const t of dueToday.slice(0, 8)) {
			detail.createDiv({ cls: 'life-home-cal-item', text: `[任务] ${t.title}` });
		}
		for (const p of plansToday.slice(0, 8)) {
			detail.createDiv({ cls: 'life-home-cal-item', text: `[计划] ${p.time ? p.time + ' ' : ''}${p.title}` });
		}
	}

	/** 今日概览:任务/代办/习惯/计时四卡,点击跳对应面板。 */
	private renderLifeSummaries(container: HTMLElement): void {
		const s = this.plugin.store.settings;
		const today = todayKey();
		const cards = container.createDiv({ cls: 'life-home-cards' });
		const mkCard = (title: string, lines: string[], panel: string, icon: string) => {
			const card = cards.createDiv({ cls: 'life-home-card is-clickable' });
			card.createDiv({ cls: 'life-home-card-title', text: `${icon} ${title}` });
			if (lines.length === 0) card.createDiv({ cls: 'life-home-muted', text: '(空)' });
			for (const line of lines.slice(0, 5)) card.createDiv({ cls: 'life-home-card-line', text: line });
			card.addEventListener('click', () => void this.plugin.activatePanel(panel));
		};
		const dueToday = s.tasks.filter((t) => t.due === today && !t.done);
		const prio = s.tasks.filter((t) => !t.done && t.priority === 2).slice(0, 3);
		mkCard(
			'任务',
			[...dueToday.slice(0, 3).map((t) => `[今日] ${t.title}`), ...prio.map((t) => `[高优] ${t.title}`)],
			'life-tasks',
			'✅',
		);
		mkCard('代办', s.todos.filter((t) => !t.done).slice(0, 5).map((t) => t.title), 'life-todo', '☑');
		mkCard('习惯', s.habits.map((h) => `${h.logs[today] ? '✓' : '○'} ${h.name}`), 'life-habits', '🔥');
		const run = s.timerRun;
		if (run && !run.paused) {
			const remain = run.kind === 'stopwatch' ? Date.now() - run.startedAt : Math.max(0, run.baseMs - (Date.now() - run.startedAt));
			mkCard('计时', [`${run.kind === 'pomodoro' ? '番茄' : run.kind === 'countdown' ? '倒计时' : '正计时'} ${formatDuration(remain)}${run.label ? ' · ' + run.label : ''}`], 'life-timer', '⏱');
		} else {
			mkCard('计时', ['(未运行)'], 'life-timer', '⏱');
		}
	}

	/** 库记录设置(折叠面板内):开关/每日时间/周期/提醒。 */
	private renderVaultLogSettings(container: HTMLElement): void {
		const sec = container.createDiv({ cls: 'life-home-section is-settings' });
		sec.createDiv({ cls: 'life-home-sec-title', text: '库记录设置' });
		const s = this.plugin.store.settings;
		const vl = s.vaultLog;
		const save = () => {
			this.plugin.store.scheduleSave();
		};
		const toggleRow = (label: string, value: boolean, onChange: (v: boolean) => void): void => {
			const row = sec.createDiv({ cls: 'life-home-setting-row' });
			row.createSpan({ cls: 'life-home-setting-label', text: label });
			const btn = row.createEl('button', { cls: 'life-home-mode-btn', text: value ? '开' : '关' });
			btn.addEventListener('click', () => {
				onChange(!value);
				btn.setText(!value ? '开' : '关');
				save();
			});
		};
		toggleRow('自动记录', vl.enabled, (v) => {
			vl.enabled = v;
		});
		const textRow = (label: string, value: string, placeholder: string, onChange: (v: string) => void): void => {
			const row = sec.createDiv({ cls: 'life-home-setting-row' });
			row.createSpan({ cls: 'life-home-setting-label', text: label });
			const input = row.createEl('input', { cls: 'life-home-setting-input', attr: { placeholder } });
			input.value = value;
			input.addEventListener('change', () => {
				onChange(input.value.trim());
				save();
			});
		};
		textRow('每日记录时间', vl.dailyTime, '21:00', (v) => {
			vl.dailyTime = v;
		});
		textRow('周期记录(分钟,0=关)', String(vl.periodMin || ''), '如 30', (v) => {
			vl.periodMin = Math.max(0, Math.floor(Number(v) || 0));
		});
		toggleRow('记录后提醒', vl.remind, (v) => {
			vl.remind = v;
		});
		textRow('每日提醒时间', vl.remindTime, '09:00', (v) => {
			vl.remindTime = v;
		});
	}
}
