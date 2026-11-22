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
	/** 库记录(HOME 页消费):记录序列(新在前,上限 200) */
	vaultLogRecords: VaultLogRecord[];
	/** 库记录设置 */
	vaultLog: VaultLogSettings;
	/** 上次每日自动记录的归属日 yyyy-mm-dd(防同日重复) */
	vaultLogLastDailyDate: string;
	/** 上次周期记录时刻 epoch ms */
	vaultLogLastPeriodAt: number;
	/** 上次每日提醒的归属日 yyyy-mm-dd */
	vaultLogLastRemindDate: string;
	/** Obsidian 启动时自动打开 HOME 标签页(2026-11-20 用户要求) */
	homeOpenOnStartup: boolean;
}

/** 库记录:相对上一次记录的文件变化(2026-11-19 阶段 C)。 */
export interface VaultLogRecord {
	id: string;
	/** 记录时刻 ISO */
	at: string;
	/** 归属日 yyyy-mm-dd(HOME 日视图按此聚合) */
	date: string;
	/** 触发方式:定时周期 / 每日时间点 / 手动打点 */
	trigger: 'period' | 'daily' | 'manual';
	/** 相对上一次记录:新增/修改/删除的库内文件路径(已删除的只有路径) */
	added: string[];
	modified: string[];
	deleted: string[];
	/** 重命名/移动配对(签名一致的 删除↔新增;2026-11-20 识别改进) */
	renames?: Array<{ from: string; to: string }>;
	/** 首次记录 = 只建立基线,不列变化(此前全量报「新增」不准;2026-11-20) */
	first?: boolean;
	/** 记录时点的库内文件总数 */
	totalFiles: number;
}

export interface VaultLogSettings {
	/** 修改对比基线(2026-11-21 用户改成设置项):git = 上次 git 提交(HEAD);
	 * record = 上次库记录时点。默认 git。 */
	diffBaseline?: 'git' | 'record';
	/** 修改对比整个功能的总开关(2026-11-22 用户):false = 编辑器装点/覆盖层/
	 * 库记录「对比」钮全部消失。缺省开。 */
	diffEnabled?: boolean;
	/** 对比弹窗视图样式(2026-11-22 用户):list = 行级差异列表(原视图);
	 * split = VSCode 式两栏对照(左基线/右当前)。缺省 list。 */
	diffViewMode?: 'list' | 'split';
	/** VSCode 可执行/CLI 路径(2026-11-22 用户):「用 VSCode 打开对比」用。
	 * 留空自动探测(LOCALAPPDATA 常见安装位置 → PATH 的 code)。 */
	vscodePath?: string;
	/** 库记录点击修改文件的默认打开方式(2026-11-22 用户):modal = 内置对比
	 * 弹窗(样式见 diffViewMode);vscode = 直接拉 VSCode diff(需 vscodePath
	 * 或本机装有 VSCode)。缺省 modal。 */
	diffOpenWith?: 'modal' | 'vscode';
	/** 自动记录总开关(关=只允许手动打点) */
	enabled: boolean;
	/** 每日固定记录时间 HH:mm(''=关) */
	dailyTime: string;
	/** 固定周期记录间隔(分钟,0=关) */
	periodMin: number;
	/** 记录完成后提醒(Notice 摘要) */
	remind: boolean;
	/** 每日提醒时间 HH:mm(''=关;只提醒当日待办/任务概要,不触发记录) */
	remindTime: string;
}

export const DEFAULT_VAULT_LOG_SETTINGS: VaultLogSettings = {
	enabled: true,
	dailyTime: '21:00',
	periodMin: 0,
	remind: true,
	remindTime: '',
};

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
	vaultLogRecords: [],
	vaultLog: DEFAULT_VAULT_LOG_SETTINGS,
	vaultLogLastDailyDate: '',
	vaultLogLastPeriodAt: 0,
	vaultLogLastRemindDate: '',
	homeOpenOnStartup: true,
};
