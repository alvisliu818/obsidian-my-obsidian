/**
 * Life 模块数据模型（倒计时/正计时/时钟/任务/习惯/代办/大日历/倒数日/计划/计时/记账）。
 *
 * 全部落模块数据片（data.json 的 modules['life'].data），与 virtual-tree 的
 * 挂载/收藏/标签同款存储。量级预期：记账条目年百级、任务/待办几十级——
 * JSON 片足够；将来如果记账膨胀再迁独立 JSON 文件（store.ts 一处改）。
 */

// ---- 日期键：全部 yyyy-mm-dd 本地日（不落时区坑,大日历/习惯/计划共用） ----

export interface TodoItem {
	/** nanoid 风格短 id（util.genId） */
	id: string;
	title: string;
	done: boolean;
	createdAt: number;
	doneAt?: number;
}

export type TaskPriority = 0 | 1 | 2; // 低 / 中 / 高

export interface TaskItem {
	id: string;
	title: string;
	/** yyyy-mm-dd（本地日）；'' = 无日期（收集箱） */
	due: string;
	priority: TaskPriority;
	done: boolean;
	createdAt: number;
	doneAt?: number;
}

export interface HabitItem {
	id: string;
	name: string;
	/** chip 颜色（打卡点与 streak 徽章同色） */
	color?: string;
	/** 建立日 yyyy-mm-dd（统计起点） */
	start: string;
	/** dateKey → 打卡标记（true=当日已打卡） */
	logs: Record<string, boolean>;
}

export interface DDayItem {
	id: string;
	title: string;
	/** 目标日 yyyy-mm-dd（过去 = 累计日,未来 = 倒数日） */
	date: string;
	emoji?: string;
}

export interface PlanItem {
	id: string;
	/** yyyy-mm-dd（大日历按此落格） */
	date: string;
	/** HH:mm（可选,有的话日历与列表按时间排序） */
	time?: string;
	title: string;
	note?: string;
	done: boolean;
}

export type LedgerKind = 'in' | 'out';

export interface LedgerEntry {
	id: string;
	/** yyyy-mm-dd */
	date: string;
	kind: LedgerKind;
	/** 两位小数金额 */
	amount: number;
	category: string;
	note?: string;
}

export type TimerKind = 'countdown' | 'stopwatch' | 'pomodoro';

/**
 * 计时运行态（重启恢复）：倒计时/番茄存剩余毫秒墙钟法（endAt = now + remain），
 * 正计时存起点。暂停即快照，恢复时重算 endAt。
 */
export interface TimerRunState {
	kind: TimerKind;
	/** 本段计时的开始时刻（epoch ms）——正计时用 */
	startedAt: number;
	/** 倒计时/番茄：段总时长 ms */
	baseMs: number;
	/** 剩余 ms（暂停时刻快照；运行中恒等于 endAt - now） */
	remainMs: number;
	/** 暂停中 = true（恢复不重算 endAt） */
	paused: boolean;
	/** 番茄阶段 */
	phase?: 'work' | 'break';
	/** 今天已完成的番茄数（跨重启累计,按日期键清零） */
	pomodoroCount?: number;
	pomodoroDate?: string;
	label?: string;
}

export interface LifeSettings {
	timerPomodoroWorkMin: number;
	timerPomodoroBreakMin: number;
	/** 倒计时预设（分钟,展示 + 快捷起跑） */
	timerCountdownPresets: number[];
	timerRun: TimerRunState | null;
	todos: TodoItem[];
	tasks: TaskItem[];
	habits: HabitItem[];
	ddays: DDayItem[];
	plans: PlanItem[];
	ledger: LedgerEntry[];
	ledgerExpenseCategories: string[];
	ledgerIncomeCategories: string[];
}

export const DEFAULT_LIFE_SETTINGS: LifeSettings = {
	timerPomodoroWorkMin: 25,
	timerPomodoroBreakMin: 5,
	timerCountdownPresets: [5, 10, 25, 45, 60],
	timerRun: null,
	todos: [],
	tasks: [],
	habits: [],
	ddays: [],
	plans: [],
	ledger: [],
	ledgerExpenseCategories: ['餐饮', '交通', '购物', '日用', '娱乐', '医疗', '居住', '其他'],
	ledgerIncomeCategories: ['工资', '奖金', '理财', '红包', '其他'],
};
