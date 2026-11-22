/**
 * HOME 标签页(2026-11-19 阶段 D):一页聚合——今日库变化、库记录列表
 * (点击展开明细,总体/按文件夹双视图)、迷你月网格(任务/计划圆点)、
 * 任务/代办/习惯/计时摘要(点击跳对应面板)、日记显示(今日/最近,
 * 阶段 D2)、库记录设置(折叠)。
 *
 * 数据源全部来自本模块 store(todos/tasks/habits/plans/timer + vaultLog
 * 记录序列);打开即全量渲染,操作后局部重绘(store 薄层惯例)。
 * 库记录引擎见 ../vaultLog(纯逻辑);调度与手动打点在 main.ts。
 * 日记数据源 = md-editor 的 journal 体系(journalPathFor + openJournalFor,
 * 经 moduleInstance 运行时取 md-editor 实例, dailyNote.ts 同款调用)。
 */
import { TFile, ItemView, type WorkspaceLeaf } from 'obsidian';
import { journalPathFor, openJournalFor } from '../../../md-editor/src/features/dailyNote';
import { addDays } from '../../../md-editor/src/core/journalDate';
import type LifePlugin from '../main';
import type LogseqEditorPlugin from '../../../md-editor/src/main';
import { VIEW_LIFE_HOME } from './homeTypes';
import { monthGrid, todayKey, formatDuration } from '../util';
import { changeSummary, filterVaultLogRecordsByDate, sortVaultLogRecordsDesc } from '../vaultLog';
import {
	renderRecordListInto,
	renderRecordSummaryRow,
	renderVaultLogSettingsInto,
	type VaultLogUiState,
} from './vaultLogRender';

export { VIEW_LIFE_HOME };

export class LifeHomeView extends ItemView {
	/** 库记录明细视图:overall = 总体列表;folder = 按顶级文件夹分组 */
	private detailMode: 'overall' | 'folder' = 'folder';
	/** 明细展开针对的记录 */
	private detailRecordId: string | null = null;
	/** 目录树收起集(共享渲染层按「记录id::路径」记键) */
	private collapsedDirs = new Set<string>();
	private settingsOpen = false;
	/** 库记录日期筛选(2026-11-21 用户):yyyy-mm-dd,''=全部;只存视图 UI state,不落盘 */
	private filterDate = '';

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

		// ---- 库记录设置(折叠;共享渲染层) ----
		if (this.settingsOpen) {
			const sec = contentEl.createDiv({ cls: 'life-home-section is-settings' });
			sec.createDiv({ cls: 'life-home-sec-title', text: '库记录设置' });
			renderVaultLogSettingsInto(sec, s.vaultLog, () => {
				this.plugin.store.scheduleSave();
				void this.plugin.refreshEditorDiffs();
			});
		}

		// ---- 今日库变化(今天的最新一条) ----
		const todayRec = s.vaultLogRecords.find((r) => r.date === dateStr) ?? null;
		const latest = s.vaultLogRecords[0] ?? null;
		const sec1 = contentEl.createDiv({ cls: 'life-home-section' });
		sec1.createDiv({ cls: 'life-home-sec-title', text: '今日库变化' });
		if (todayRec) {
			renderRecordSummaryRow(sec1, todayRec);
		} else if (latest) {
			sec1.createDiv({
				cls: 'life-home-muted',
				text: `今天还没有记录。最近一条:${latest.date.slice(5)}(${changeSummary(latest)})`,
			});
		} else {
			sec1.createDiv({ cls: 'life-home-muted', text: '还没有任何记录。点「记录库变化」打第一笔。' });
		}

		// ---- 库记录列表(倒序;日期筛选 2026-11-21 用户,与独立库记录面板同款) ----
		const sec2 = contentEl.createDiv({ cls: 'life-home-section' });
		sec2.createDiv({ cls: 'life-home-sec-title', text: '库记录' });
		// 日期筛选:选日期只看该天,「全部」清空恢复;状态不落盘
		const filterRow = sec2.createDiv({ cls: 'life-home-head-btns' });
		const dateInput = filterRow.createEl('input', {
			cls: 'life-home-date-filter',
			attr: { type: 'date', 'aria-label': '按日期筛选记录' },
		});
		dateInput.value = this.filterDate;
		dateInput.addEventListener('change', () => {
			this.filterDate = dateInput.value.trim();
			this.render();
		});
		const clearBtn = filterRow.createEl('button', {
			cls: 'life-home-mode-btn',
			text: '全部',
			attr: { 'aria-label': '清除日期筛选,显示全部记录' },
		});
		clearBtn.addEventListener('click', () => {
			if (this.filterDate === '') return; // 已是全部,避免无谓重绘
			this.filterDate = '';
			this.render();
		});
		const shown = filterVaultLogRecordsByDate(sortVaultLogRecordsDesc(s.vaultLogRecords), this.filterDate);
		if (this.filterDate !== '' && shown.length === 0) {
			sec2.createDiv({ cls: 'life-home-muted', text: `${this.filterDate} 当天没有记录。点「全部」清除筛选。` });
		} else if (shown.length === 0) {
			sec2.createDiv({ cls: 'life-home-muted', text: '暂无记录。' });
		} else {
			const ui: VaultLogUiState = {
				expandedIds: this.detailRecordId ? new Set([this.detailRecordId]) : new Set(),
				detailMode: this.detailMode,
				settingsOpen: this.settingsOpen,
				collapsedDirs: this.collapsedDirs,
			};
			renderRecordListInto(sec2, shown.slice(0, 10), ui, {
				onToggleRecord: (id) => {
					this.detailRecordId = this.detailRecordId === id ? null : id;
					this.render();
				},
				onModeChange: (mode) => {
					this.detailMode = mode;
					this.render();
				},
				onManualRecord: () => void this.plugin.recordVaultChanges('manual'),
				onOpenFile: (path) => void this.plugin.app.workspace.openLinkText(path, ''),
				onOpenModified: (path) => void this.plugin.openModifiedFileWithDiff(path),
				onCompareFile: (path) => void this.plugin.openRecordDiffView(path),
			});
		}

		// ---- 迷你月网格(任务/计划圆点 + 当日明细) ----
		const sec3 = contentEl.createDiv({ cls: 'life-home-section' });
		sec3.createDiv({ cls: 'life-home-sec-title', text: '大日历' });
		sec3.createDiv({ cls: 'life-home-muted', text: '完整版(点格子加任务/计划)在「大日历」面板 →' });
		this.renderMiniCalendar(sec3);

		// ---- 日记(今日/最近,md-editor journal 体系) ----
		const secDiary = contentEl.createDiv({ cls: 'life-home-section' });
		secDiary.createDiv({ cls: 'life-home-sec-title', text: '日记' });
		this.renderDiarySection(secDiary);

		// ---- 任务/代办/习惯/计时 摘要 ----
		const sec4 = contentEl.createDiv({ cls: 'life-home-section' });
		sec4.createDiv({ cls: 'life-home-sec-title', text: '今日概览' });
		this.renderLifeSummaries(sec4);
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

	/**
	 * 日记节(2026-11-19 阶段 D2):今日日记(存在=行+预览;不存在=创建按钮)
	 * + 最近 7 天的日记行。数据源 = md-editor 的 journal 体系(journalPathFor
	 * 解析路径 / openJournalFor 创建并打开)——运行时取 md-editor 模块实例。
	 */
	private renderDiarySection(container: HTMLElement): void {
		const host2 = window.app.plugins.plugins['obsidian-my-obsidian'] as unknown as { moduleInstance?: (id: string) => LogseqEditorPlugin | undefined };
		const md = host2?.moduleInstance?.('md-editor') as
			| LogseqEditorPlugin
			| undefined;
		if (!md) {
			container.createDiv({ cls: 'life-home-muted', text: '(md-editor 模块未启用,日记不可用)' });
			return;
		}
		const list = container.createDiv({ cls: 'life-home-diary' });
		list.createDiv({ cls: 'life-home-muted', text: '加载中…' });
		void (async () => {
			list.empty();
			const today = new Date();
			const todayPath = journalPathFor(md, today);
			const recent: { path: string; date: Date; file: TFile }[] = [];
			for (let i = 0; i < 7; i++) {
				const d = addDays(today, -i);
				const p = journalPathFor(md, d);
				const af = this.app.vault.getAbstractFileByPath(p);
				if (af instanceof TFile) recent.push({ path: p, date: d, file: af });
			}
			const todayFile = recent[0] && recent[0].date.getTime() >= new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() ? recent[0].file : null;
			const labelOf = (d: Date): string => {
				const p = (n: number) => String(n).padStart(2, '0');
				return `${p(d.getMonth() + 1)}/${p(d.getDate())}`;
			};
			const openRow = (p: string): void => {
				void this.app.workspace.openLinkText(p, '', false);
			};
			// 今日日记行:存在=高亮行(点击打开+预览);不存在=创建按钮
			if (todayFile) {
				const row = list.createDiv({ cls: 'life-home-diary-row is-today' });
				row.createSpan({ cls: 'life-home-diary-name', text: '今日日记' });
				row.createSpan({ cls: 'life-home-diary-meta', text: todayPath });
				row.addEventListener('click', () => openRow(todayPath));
			} else {
				const mk = list.createEl('button', { cls: 'life-home-mode-btn', text: '创建并打开今日日记' });
				mk.addEventListener('click', () => void openJournalFor(md, 0));
			}
			// 最近日记行(跳过今日;今天已在上方或缺失)
			for (const r of recent.slice(todayFile ? 1 : 0)) {
				const row = list.createDiv({ cls: 'life-home-diary-row' });
				row.createSpan({ cls: 'life-home-diary-name', text: labelOf(r.date) + (r.path.endsWith(todayPath) ? '(今日)' : '') });
				row.createSpan({ cls: 'life-home-diary-meta', text: r.path });
				row.addEventListener('click', () => openRow(r.path));
			}
			// 今日日记预览(前 6 行)
			if (todayFile) {
				try {
					const content = await this.app.vault.cachedRead(todayFile);
					const lines = content.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('---')).slice(0, 6);
					for (const line of lines) {
						list.createDiv({ cls: 'life-home-diary-preview', text: line.slice(0, 80) });
					}
				} catch {
					/* 预览失败静默 */
				}
			}
		})();
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
}