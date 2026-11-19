/**
 * Life 模块：倒计时 / 正计时 / 时钟 / 任务 / 习惯 / 代办 / 大日历 / 倒数日 /
 * 计划 / 计时 / 记账 —— 十一个生活面板。
 *
 * 存储：全部落模块数据片（宿主遮蔽的 loadData/saveData,见 store.ts）。
 * 计时：运行态墙钟法（settings.timerRun）,面板关闭也计时——本模块 onload
 * 注册 1s 哨兵（registerInterval）到点 Notice,TimerView 开着时由它自己走针。
 */
import { Menu, Notice, Plugin, TFile, type WorkspaceLeaf } from 'obsidian';
import { LifeStore } from './store';
import type { VaultLogRecord } from './types';
import { VIEW_LIFE_CALENDAR, LifeCalendarView } from './views/calendar';
import { VIEW_LIFE_HOME, LifeHomeView } from './views/home';
import { dailyDue, periodDue, scanVaultSig, diffSigTable, changeSummary, dayKeyOf, parseHHmm } from './vaultLog';
import { VIEW_LIFE_CLOCK, LifeClockView } from './views/clock';
import { VIEW_LIFE_DDAY, LifeDdayView } from './views/dday';
import { VIEW_LIFE_HABITS, LifeHabitsView } from './views/habits';
import { VIEW_LIFE_LEDGER, LifeLedgerView } from './views/ledger';
import { VIEW_LIFE_PLANS, LifePlansView } from './views/plans';
import { VIEW_LIFE_TASKS, LifeTasksView } from './views/tasks';
import { VIEW_LIFE_TIMER, LifeTimerView } from './views/timer';
import { VIEW_LIFE_TODO, LifeTodoView } from './views/todo';
import { todayKey, genId } from './util';

/** 面板注册表：viewType / 命令名 / 图标 / 中文显示（命令+ribbon+菜单共用）。 */
export const LIFE_PANELS = [
	{ type: VIEW_LIFE_HOME, name: 'HOME', icon: 'home' },
	{ type: VIEW_LIFE_CLOCK, name: '时钟', icon: 'clock' },
	{ type: VIEW_LIFE_TIMER, name: '计时', icon: 'timer' },
	{ type: VIEW_LIFE_DDAY, name: '倒数日', icon: 'calendar-clock' },
	{ type: VIEW_LIFE_TODO, name: '代办', icon: 'list-checks' },
	{ type: VIEW_LIFE_TASKS, name: '任务', icon: 'square-check-big' },
	{ type: VIEW_LIFE_HABITS, name: '习惯', icon: 'flame' },
	{ type: VIEW_LIFE_CALENDAR, name: '大日历', icon: 'calendar-days' },
	{ type: VIEW_LIFE_PLANS, name: '计划', icon: 'calendar-range' },
	{ type: VIEW_LIFE_LEDGER, name: '记账', icon: 'wallet' },
] as const;

export default class LifePlugin extends Plugin {
	store!: LifeStore;
	private timerSentinel: number | null = null;
	private vaultLogTimer: number | null = null;

	async onload(): Promise<void> {
		this.store = new LifeStore(this, await this.loadData());

		for (const p of LIFE_PANELS) {
			this.registerView(p.type, (leaf) => this.makeView(p.type, leaf));
			this.addCommand({
				id: `open-${p.type}`,
				name: `打开${p.name}面板`,
				callback: () => void this.activatePanel(p.type),
			});
		}

		// ribbon 一枚：点击弹「生活」菜单（九个面板,不占九个 ribbon 位）
		this.addRibbonIcon('life-buoy', '生活面板', (ev) => {
			const menu = new Menu();
			for (const p of LIFE_PANELS) {
				menu.addItem((item) =>
					item.setTitle(p.name).setIcon(p.icon).onClick(() => void this.activatePanel(p.type)),
				);
			}
			menu.showAtMouseEvent(ev);
		});

		// 计时哨兵：倒计时/番茄到点提醒（面板关着也要响）。1s 一次,开销可忽略。
		this.timerSentinel = window.setInterval(() => void this.tickSentinel(), 1000);
		this.register(() => {
			if (this.timerSentinel !== null) window.clearInterval(this.timerSentinel);
		});

		// 库记录调度(2026-11-19 阶段 C):30s 一查——每日时间点/固定周期到期即
	// 记录+提醒(纯逻辑判定在 vaultLog.ts)。CIM/沙箱无关,面板关着也跑。
	this.vaultLogTimer = window.setInterval(() => void this.vaultLogTick(), 30000);
	this.register(() => {
		if (this.vaultLogTimer !== null) window.clearInterval(this.vaultLogTimer);
	});

	// 今日番茄计数跨天清零：挂一个低频检查（每次 file-open 顺手看）
		this.registerEvent(
			this.app.workspace.on('file-open', (file: TFile | null) => {
				void file;
				const run = this.store.settings.timerRun;
				if (run && run.pomodoroDate && run.pomodoroDate !== todayKey() && run.pomodoroCount) {
					run.pomodoroCount = 0;
					run.pomodoroDate = todayKey();
					this.store.scheduleSave();
				}
			}),
		);
	}

	private makeView(
		type: string,
		leaf: WorkspaceLeaf,
	):
		| LifeClockView
		| LifeTimerView
		| LifeDdayView
		| LifeTodoView
		| LifeTasksView
		| LifeHabitsView
		| LifeCalendarView
		| LifePlansView
		| LifeLedgerView
		| LifeHomeView {
		switch (type) {
			case VIEW_LIFE_HOME:
				return new LifeHomeView(leaf, this);
			case VIEW_LIFE_CLOCK:
				return new LifeClockView(leaf, this);
			case VIEW_LIFE_TIMER:
				return new LifeTimerView(leaf, this);
			case VIEW_LIFE_DDAY:
				return new LifeDdayView(leaf, this);
			case VIEW_LIFE_TODO:
				return new LifeTodoView(leaf, this);
			case VIEW_LIFE_TASKS:
				return new LifeTasksView(leaf, this);
			case VIEW_LIFE_HABITS:
				return new LifeHabitsView(leaf, this);
			case VIEW_LIFE_CALENDAR:
				return new LifeCalendarView(leaf, this);
			case VIEW_LIFE_PLANS:
				return new LifePlansView(leaf, this);
			case VIEW_LIFE_LEDGER:
				return new LifeLedgerView(leaf, this);
			default:
				throw new Error(`life: unknown view ${type}`);
		}
	}

	/** 激活面板（存在即复用,否则右侧新开）。 */
	async activatePanel(viewType: string): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(viewType)[0];
		if (existing) {
			this.app.workspace.revealLeaf(existing);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf(true);
		if (!leaf) return;
		await leaf.setViewState({ type: viewType, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * 全局计时哨兵：仅处理「面板关闭时的到点」——视图开着时它自己 onTick 收尾
	 * （两边幂等：setRun(null) 后哨兵读不到 run 即跳过）。
	 */
	private async tickSentinel(): Promise<void> {
		const run = this.store.settings.timerRun;
		if (!run || run.paused || run.kind === 'stopwatch') return;
		const remain = run.baseMs - (Date.now() - run.startedAt);
		if (remain > 0) return;
		// 番茄工作段 → 进休息段;其余（倒计时/休息段）→ 清态提醒
		if (run.kind === 'pomodoro' && run.phase === 'work') {
			const s = this.store.settings;
			this.store.settings.timerRun = {
				...run,
				pomodoroCount: (run.pomodoroCount ?? 0) + 1,
				pomodoroDate: todayKey(),
				startedAt: Date.now(),
				baseMs: s.timerPomodoroBreakMin * 60000,
				remainMs: s.timerPomodoroBreakMin * 60000,
				paused: false,
				phase: 'break',
			};
			this.store.scheduleSave();
			new Notice('🍅 番茄完成！休息一下');
		} else {
			this.store.settings.timerRun = null;
			await this.store.flush();
			new Notice(run.kind === 'pomodoro' ? '休息结束' : `⏰ 倒计时到点${run.label ? '：' + run.label : ''}`);
		}
	}

	async onunload(): Promise<void> {
		await this.store.flush();
	}

	/**
	 * 库记录调度 tick(30s):每日时间点到期 → 每日记录;固定周期到期 →
	 * 周期记录。判定纯函数在 vaultLog.ts;记录本体在 recordVaultChanges。
	 */
	private async vaultLogTick(): Promise<void> {
		const vl = this.store.settings.vaultLog;
		if (!vl.enabled) return;
		const now = new Date();
		if (dailyDue(now, vl.dailyTime, this.store.settings.vaultLogLastDailyDate)) {
			await this.recordVaultChanges('daily');
			return; // 同轮不再查周期(每日记录已写 lastDailyDate)
		}
		if (periodDue(now, vl.periodMin, this.store.settings.vaultLogLastPeriodAt)) {
			await this.recordVaultChanges('period');
		}
		// 每日提醒时间到期:只提醒当日概要(任务/代办/习惯),不触发记录
		if (vl.remindTime) {
			const target = parseHHmm(vl.remindTime);
			const today = dayKeyOf(now);
			if (target !== null && this.store.settings.vaultLogLastRemindDate !== today) {
				const mins = now.getHours() * 60 + now.getMinutes();
				if (mins >= target) {
					this.store.settings.vaultLogLastRemindDate = today;
					await this.store.flush();
					const due = this.store.settings.tasks.filter((t) => t.due === today && !t.done).length;
					const todo = this.store.settings.todos.filter((t) => !t.done).length;
					const habitsLeft = this.store.settings.habits.filter((h) => !h.logs[today]).length;
					new Notice(
						'📅 每日提醒:今日到期任务 ' + due + ' · 待办 ' + todo + ' · 习惯待打卡 ' + habitsLeft,
					);
				}
			}
		}
	}

	/**
	 * 记录库变化(2026-11-19 阶段 C):全库文件签名快照 vs 上一次快照 →
	 * 新增/修改/删除;快照本体存独立文件(data.json 不吃万级条目)。
	 */
	async recordVaultChanges(trigger: 'period' | 'daily' | 'manual' = 'manual'): Promise<VaultLogRecord> {
		const cur = scanVaultSig(this.app.vault);
		const prev = await this.loadVaultLogSnapshot();
		const diff = diffSigTable(prev, cur);
		await this.saveVaultLogSnapshot(cur);
		const now = new Date();
		const rec: VaultLogRecord = {
			id: genId(),
			at: now.toISOString(),
			date: dayKeyOf(now),
			trigger,
			added: diff.added,
			modified: diff.modified,
			deleted: diff.deleted,
			totalFiles: Object.keys(cur).length,
		};
		const cap = (list: string[]): string[] => (list.length > 500 ? list.slice(0, 500) : list);
		rec.added = cap(rec.added);
		rec.modified = cap(rec.modified);
		rec.deleted = cap(rec.deleted);
		const s = this.store.settings;
		s.vaultLogRecords = [rec, ...s.vaultLogRecords].slice(0, 200);
		if (trigger === 'daily') s.vaultLogLastDailyDate = dayKeyOf(now);
		if (trigger === 'period') s.vaultLogLastPeriodAt = now.getTime();
		await this.store.flush();
		this.refreshHomeViews();
		if (s.vaultLog.remind) {
			new Notice('📋 库记录(' + (trigger === 'manual' ? '手动' : trigger === 'daily' ? '每日' : '周期') + '):' + changeSummary(diff));
		}
		return rec;
	}

	/** 快照存取(独立文件,manifest.dir 下——data.json 不吃万级签名表)。 */
	private snapshotPath(): string {
		return (this.manifest.dir ?? '') + '/vault-log-snapshot.json';
	}

	private async loadVaultLogSnapshot(): Promise<Record<string, string>> {
		try {
			const raw = await this.app.vault.adapter.read(this.snapshotPath());
			return JSON.parse(raw) as Record<string, string>;
		} catch {
			return {};
		}
	}

	private async saveVaultLogSnapshot(table: Record<string, string>): Promise<void> {
		await this.app.vault.adapter.write(this.snapshotPath(), JSON.stringify(table));
	}

	/** HOME 视图刷新(开着就重绘;记录/设置变更后调用)。 */
	refreshHomeViews(): void {
		window.app.workspace.iterateAllLeaves((l) => {
			if (l.view?.getViewType?.() === VIEW_LIFE_HOME) {
				(l.view as LifeHomeView).refresh();
			}
		});
	}

}
