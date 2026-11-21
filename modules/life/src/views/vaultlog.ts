/**
 * 库记录独立面板(2026-11-19 阶段 C 收尾):完整记录列表(全部记录,不限
 * HOME 的 10 条)+ 明细展开(总体/按文件夹)+ 库记录设置(折叠)。
 *
 * 状态自持(展开集/明细视图/设置展开),变更后整体重绘;记录/设置变更由
 * LifePlugin.refreshHomeViews 触发重绘(该方法同时刷新 HOME 与本面板)。
 */
import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type LifePlugin from '../main';
import { VIEW_LIFE_VAULTLOG } from './homeTypes';
import { formatDuration } from '../util';
import {
	renderRecordListInto,
	renderVaultLogSettingsInto,
	type VaultLogUiState,
} from './vaultLogRender';
import { filterVaultLogRecordsByDate, sortVaultLogRecordsDesc } from '../vaultLog';

export { VIEW_LIFE_VAULTLOG };

export class LifeVaultLogView extends ItemView {
	private expandedIds = new Set<string>();
	private detailMode: 'overall' | 'folder' = 'overall';
	private collapsedDirs = new Set<string>();
	private settingsOpen = false;
	/** 日期筛选选择(yyyy-mm-dd,''=全部);只存视图 UI state,不落盘 */
	private filterDate = '';
	/** 运行态摘要(计时卡片与 HOME 同款数据源) */
	private get timerSummary(): string {
		const run = this.plugin.store.settings.timerRun;
		if (!run || run.paused) return '(未运行)';
		const remain =
			run.kind === 'stopwatch' ? Date.now() - run.startedAt : Math.max(0, run.baseMs - (Date.now() - run.startedAt));
		return `${run.kind === 'pomodoro' ? '番茄' : run.kind === 'countdown' ? '倒计时' : '正计时'} ${formatDuration(remain)}${run.label ? ' · ' + run.label : ''}`;
	}

	constructor(leaf: WorkspaceLeaf, private plugin: LifePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_LIFE_VAULTLOG;
	}

	getDisplayText(): string {
		return '库记录';
	}

	getIcon(): string {
		return 'archive';
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	refresh(): void {
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('life-vaultlog');
		const s = this.plugin.store.settings;
		const now = new Date();

		// ---- 头部:日期 + 日期筛选 + 立即记录 + 设置齿轮 ----
		const head = contentEl.createDiv({ cls: 'life-home-head' });
		head.createDiv({ cls: 'life-home-date', text: `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日` });
		const headBtns = head.createDiv({ cls: 'life-home-head-btns' });
		// 日期筛选(2026-11-21 用户):选日期只看该天,「全部」清空恢复;状态不落盘
		const dateInput = headBtns.createEl('input', {
			cls: 'life-home-date-filter',
			attr: { type: 'date', 'aria-label': '按日期筛选记录' },
		});
		dateInput.value = this.filterDate;
		dateInput.addEventListener('change', () => {
			this.filterDate = dateInput.value.trim();
			this.render();
		});
		const clearBtn = headBtns.createEl('button', {
			cls: 'life-home-mode-btn',
			text: '全部',
			attr: { 'aria-label': '清除日期筛选,显示全部记录' },
		});
		clearBtn.addEventListener('click', () => {
			if (this.filterDate === '') return; // 已是全部,避免无谓重绘
			this.filterDate = '';
			this.render();
		});
		const recBtn = headBtns.createEl('button', { cls: 'life-home-rec-btn', text: '记录库变化' });
		recBtn.addEventListener('click', () => void this.plugin.recordVaultChanges('manual'));
		const gear = headBtns.createEl('button', { cls: 'life-home-gear', attr: { 'aria-label': '库记录设置' } });
		gear.setText('⚙');
		gear.addEventListener('click', () => {
			this.settingsOpen = !this.settingsOpen;
			this.render();
		});

		// ---- 运行态摘要(计时卡片与 HOME 同款,一行) ----
		const runRow = contentEl.createDiv({ cls: 'life-home-rec-summary' });
		runRow.createSpan({ cls: 'life-home-card-title', text: '⏱ ' + this.timerSummary });

		// ---- 设置(折叠) ----
		if (this.settingsOpen) {
			const sec = contentEl.createDiv({ cls: 'life-home-section is-settings' });
			sec.createDiv({ cls: 'life-home-sec-title', text: '库记录设置' });
			renderVaultLogSettingsInto(
				sec,
				s.vaultLog,
				() => {
					this.plugin.store.scheduleSave();
					void this.plugin.recordVaultChanges('manual').catch(() => {});
				},
			);
		}

		// ---- 全部记录(渲染侧倒序 + 日期筛选;存储序不动) ----
		const listSec = contentEl.createDiv({ cls: 'life-home-section' });
		const shown = filterVaultLogRecordsByDate(sortVaultLogRecordsDesc(s.vaultLogRecords), this.filterDate);
		listSec.createDiv({ cls: 'life-home-sec-title', text: `库记录(${shown.length} 条)` });
		const ui: VaultLogUiState = {
			expandedIds: this.expandedIds,
			detailMode: this.detailMode,
			settingsOpen: this.settingsOpen,
			collapsedDirs: this.collapsedDirs,
		};
		if (this.filterDate !== '' && shown.length === 0) {
			// 筛选后 0 条:给出比通用「暂无记录」更明确的提示
			listSec.createDiv({ cls: 'life-home-muted', text: `${this.filterDate} 当天没有记录。点「全部」清除筛选。` });
		} else {
			renderRecordListInto(
				listSec,
				shown,
				ui,
				{
					onToggleRecord: (id) => {
						if (this.expandedIds.has(id)) this.expandedIds.delete(id);
						else this.expandedIds.add(id);
						this.render();
					},
					onModeChange: (mode) => {
						this.detailMode = mode;
						this.render();
					},
					onManualRecord: () => void this.plugin.recordVaultChanges('manual'),
					onOpenFile: (path) => void this.plugin.app.workspace.openLinkText(path, ''),
				onOpenModified: (recordId, path) => void this.plugin.openModifiedFileWithDiff(recordId, path),
				onCompareFile: (recordId, path) => this.plugin.openRecordDiffModal(recordId, path),
				},
			);
		}
	}
}
