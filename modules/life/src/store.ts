/**
 * Life 存储层：模块数据片（loadData/saveData 切片由宿主遮蔽）之上的薄层。
 *
 * 为什么不搞响应式 store：各视图都是「打开即全量渲染、操作后局部重绘」的
 * 小面板，直接 settings 变更 + 显式 re-render 最直白；唯一的公共语义是
 * 「变更即持久化（去抖 400ms）+ 关闭时冲刷」。
 */
import type { LifeSettings } from './types';
import { DEFAULT_LIFE_SETTINGS, DEFAULT_VAULT_LOG_SETTINGS } from './types';

export interface LifeStoreHost {
	loadData(): Promise<unknown>;
	saveData(data: unknown): Promise<void>;
}

export function lifeSettingsFrom(raw: unknown): LifeSettings {
	const o = (raw ?? {}) as Partial<LifeSettings>;
	return {
		...DEFAULT_LIFE_SETTINGS,
		...o,
		// 列表字段防旧数据/脏数据：非数组一律回落默认
		timerCountdownPresets: Array.isArray(o.timerCountdownPresets)
			? o.timerCountdownPresets.filter((n) => typeof n === 'number' && n > 0)
			: DEFAULT_LIFE_SETTINGS.timerCountdownPresets,
		todos: Array.isArray(o.todos) ? o.todos : [],
		tasks: Array.isArray(o.tasks) ? o.tasks : [],
		habits: Array.isArray(o.habits) ? o.habits : [],
		ddays: Array.isArray(o.ddays) ? o.ddays : [],
		plans: Array.isArray(o.plans) ? o.plans : [],
		ledger: Array.isArray(o.ledger) ? o.ledger : [],
		ledgerExpenseCategories: Array.isArray(o.ledgerExpenseCategories) && o.ledgerExpenseCategories.length
			? o.ledgerExpenseCategories
			: DEFAULT_LIFE_SETTINGS.ledgerExpenseCategories,
		ledgerIncomeCategories: Array.isArray(o.ledgerIncomeCategories) && o.ledgerIncomeCategories.length
			? o.ledgerIncomeCategories
			: DEFAULT_LIFE_SETTINGS.ledgerIncomeCategories,
		vaultLogRecords: Array.isArray(o.vaultLogRecords) ? o.vaultLogRecords.slice(0, 200) : [],
		vaultLog: {
			...DEFAULT_VAULT_LOG_SETTINGS,
			...(o.vaultLog ?? {}),
		},
		vaultLogLastDailyDate: typeof o.vaultLogLastDailyDate === 'string' ? o.vaultLogLastDailyDate : '',
		vaultLogLastPeriodAt: typeof o.vaultLogLastPeriodAt === 'number' ? o.vaultLogLastPeriodAt : 0,
		vaultLogLastRemindDate: typeof o.vaultLogLastRemindDate === 'string' ? o.vaultLogLastRemindDate : '',
		homeOpenOnStartup: o.homeOpenOnStartup !== false,
	};
}

export class LifeStore {
	readonly settings: LifeSettings;
	private host: LifeStoreHost;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(host: LifeStoreHost, raw?: unknown) {
		this.host = host;
		this.settings = lifeSettingsFrom(raw);
	}

	/** 变更落盘（去抖 400ms）——视图操作后调这一个就够。 */
	scheduleSave(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.flush();
		}, 400);
	}

	/** 立即落盘（onunload/关键节点）。 */
	async flush(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		await this.host.saveData(this.settings);
	}
}
