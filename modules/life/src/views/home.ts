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
import { TFile, ItemView, Notice, type EventRef, type WorkspaceLeaf } from 'obsidian';
import { journalPathFor, openJournalFor } from '../../../md-editor/src/features/dailyNote';
import { addDays } from '../../../md-editor/src/core/journalDate';
import type LifePlugin from '../main';
import type LogseqEditorPlugin from '../../../md-editor/src/main';
import { VIEW_LIFE_HOME } from './homeTypes';
import { SnapshotPreviewModal } from './snapshotPreview';
import { monthGrid, todayKey, formatDuration } from '../util';
import { normalizeHomeSectionOrder } from '../homeSections';
import { changeSummary, filterVaultLogRecordsByDate, sortVaultLogRecordsDesc } from '../vaultLog';
import {
	renderRecordListInto,
	renderRecordSummaryRow,
	renderVaultLogSettingsInto,
	type VaultLogUiState,
} from './vaultLogRender';

export { VIEW_LIFE_HOME };

/** Git 历史条目(HOME 区块用到的字段;来自 obsidian-git GitManager.log)。 */
interface GitCommitLite {
	hash: string;
	date: string;
	message: string;
	author?: { name?: string };
	diff?: { changed?: number; files?: Array<{ path: string; vaultPath?: string; fromPath?: string }> };
}

/** 保存历史快照(HOME 区块;来自 save-control.listAllSnapshotFiles)。 */
interface SaveSnapshotLite {
	timestamp: string;
	name?: string;
	favorite?: boolean;
	filePath: string;
	content?: string;
}

interface SnapshotFileLite {
	targetPath: string;
	kind: 'vault' | 'external';
	lastAt: string;
	count: number;
	snapshots: SaveSnapshotLite[];
}

interface SaveControlApi {
	listAllSnapshotFiles?: () => Promise<SnapshotFileLite[]>;
	readSnapshotContent?: (filePath: string) => Promise<{ content?: string } | null>;
}

interface GitModuleApi {
	gitManager?: {
		log?: (file?: string, relativeToVault?: boolean, limit?: number) => Promise<GitCommitLite[]>;
	};
	tools?: {
		openDiff?: (opts: Record<string, unknown>) => void;
	};
}

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
	/** Git 历史(HOME 区块,2026-11-22 用户):异步缓存 + 展开集 */
	private gitLog: GitCommitLite[] | null = null;
	private gitLogError = '';
	private gitLogExpanded = new Set<string>();
	private gitRetryTimer: number | null = null;
	private gitRetryCount = 0;
	/** 保存历史(HOME 区块,2026-11-22 用户):所有有历史的文件 + 列表/按文件夹 */
	private saveFiles: SnapshotFileLite[] = [];
	private saveDetailMode: 'overall' | 'folder' = 'overall';
	private saveExpanded = new Set<string>();
	private saveCollapsedDirs = new Set<string>();
	private saveHistoryError = '';

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
		void this.loadHomeHistory();
		// obsidian-git 在 life 之后才建好 gitManager:就绪/刷新事件到达时补拉一次
		const ws = this.app.workspace as unknown as { on(name: string, cb: () => void): EventRef };
		this.registerEvent(ws.on('obsidian-git:refreshed', () => void this.refreshGitHistory()));
		this.registerEvent(ws.on('obsidian-git:status-changed', () => void this.refreshGitHistory()));
		this.register(() => {
			if (this.gitRetryTimer !== null) window.clearTimeout(this.gitRetryTimer);
		});
	}

	/** 外部刷新入口(记录/设置变更后由 LifePlugin 调)。 */
	refresh(): void {
		this.render();
	}

	// ------------------------------------------------------------------
	// HOME 历史区块(2026-11-22 用户):Git 提交 + 保存历史(参考库记录)
	// ------------------------------------------------------------------

	/** 取并入模块实例(与 ExternalCodeView/life 其他跨模块调用同款鸭子类型)。 */
	private hostModule<T>(id: string): T | null {
		const host = (
			this.app as unknown as {
				plugins?: {
					plugins?: Record<string, { moduleInstance?: (id: string) => unknown } | undefined>;
				};
			}
		).plugins?.plugins?.['obsidian-my-obsidian'];
		return (host?.moduleInstance?.(id) as T | undefined) ?? null;
	}

	private async loadHomeHistory(): Promise<void> {
		await Promise.all([this.fetchGitHistory(), this.fetchSaveHistory()]);
		this.render();
	}

	private async fetchGitHistory(): Promise<void> {
		try {
			const git = this.hostModule<GitModuleApi>('obsidian-git');
			const mgr = git?.gitManager;
			if (!mgr?.log) {
				this.gitLog = [];
				this.gitLogError = 'Git 模块未就绪（稍后自动重试，或点「刷新」）。';
				this.scheduleGitRetry();
				return;
			}
			this.gitLog = (await mgr.log(undefined, true, 10)) ?? [];
			this.gitLogError = '';
			this.gitRetryCount = 0;
		} catch (e) {
			this.gitLog = [];
			this.gitLogError = `读取 Git 历史失败:${String(e).slice(0, 100)}`;
			this.scheduleGitRetry();
		}
	}

	private scheduleGitRetry(): void {
		if (this.gitRetryTimer !== null || this.gitRetryCount >= 5) return;
		this.gitRetryCount++;
		this.gitRetryTimer = window.setTimeout(() => {
			this.gitRetryTimer = null;
			void this.refreshGitHistory();
		}, 4000);
	}

	private async refreshGitHistory(): Promise<void> {
		const before = `${this.gitLog ? this.gitLog.length : 'null'}|${this.gitLogError}`;
		await this.fetchGitHistory();
		const after = `${this.gitLog ? this.gitLog.length : 'null'}|${this.gitLogError}`;
		if (after !== before) this.render();
	}

	private async fetchSaveHistory(): Promise<void> {
		const sc = this.hostModule<SaveControlApi>('save-control');
		if (!sc?.listAllSnapshotFiles) {
			this.saveFiles = [];
			this.saveHistoryError = '保存历史模块未启用。';
			return;
		}
		try {
			this.saveFiles = (await sc.listAllSnapshotFiles()) ?? [];
			this.saveHistoryError = '';
		} catch (e) {
			this.saveFiles = [];
			this.saveHistoryError = `读取保存历史失败:${String(e).slice(0, 100)}`;
		}
	}

	private async refreshSaveHistory(): Promise<void> {
		await this.fetchSaveHistory();
		this.render();
	}

	private async previewSnapshot(targetPath: string, snap: SaveSnapshotLite): Promise<void> {
		const sc = this.hostModule<SaveControlApi>('save-control');
		try {
			const rec = await sc?.readSnapshotContent?.(snap.filePath);
			new SnapshotPreviewModal(
				this.app,
				`${targetPath} · ${this.fmtWhen(snap.timestamp)}`,
				rec?.content ?? snap.content ?? '',
			).open();
		} catch (e) {
			new Notice(`读取历史版本失败:${String(e).slice(0, 80)}`);
		}
	}

	/** 保存历史区块:所有有历史的文件;列表模式或按文件夹分组。 */
	private renderSaveSection(container: HTMLElement): void {
		const head = container.createDiv({ cls: 'life-home-sec-head' });
		head.createDiv({
			cls: 'life-home-sec-title',
			text: `保存历史${this.saveFiles.length ? `（${this.saveFiles.length} 个文件）` : ''}`,
		});
		const btns = head.createDiv({ cls: 'life-home-head-btns' });
		const modeBtn = btns.createEl('button', {
			cls: 'life-home-mode-btn',
			text: this.saveDetailMode === 'folder' ? '文件夹' : '列表',
		});
		modeBtn.setAttr('title', '切换 列表 / 按文件夹');
		modeBtn.addEventListener('click', () => {
			this.saveDetailMode = this.saveDetailMode === 'folder' ? 'overall' : 'folder';
			this.render();
		});
		const refresh = btns.createEl('button', { cls: 'life-home-mode-btn', text: '刷新' });
		refresh.addEventListener('click', () => void this.refreshSaveHistory());
		// 云端历史版本(2026-11-22 用户):OneDrive / 百度同步空间是逐文件接口,
		// 没法在 HOME 里全量枚举;入口放在挂载面板的文件右键。
		const cloudBtn = btns.createEl('button', { cls: 'life-home-mode-btn', text: '云端历史' });
		cloudBtn.setAttr('title', 'OneDrive / 百度同步空间:在挂载面板右键文件 →「云端历史版本」');
		cloudBtn.addEventListener('click', () => {
			// 优先走 virtual-tree 自己的激活逻辑(统一文件面板/左侧栏,和 ribbon 一致)
			const vt = this.hostModule<{ activatePanel?: (t: string) => Promise<void> }>('virtual-tree');
			if (vt?.activatePanel) void vt.activatePanel('logseq-mount-panel');
			else void this.openModuleView('logseq-mount-panel');
			new Notice('在挂载面板右键 OneDrive / 百度网盘文件 →「云端历史版本」。');
		});

		if (this.saveHistoryError) {
			container.createDiv({ cls: 'life-home-muted', text: this.saveHistoryError });
			return;
		}
		if (this.saveFiles.length === 0) {
			container.createDiv({ cls: 'life-home-muted', text: '还没有任何保存历史。' });
			return;
		}
		// 文件可能很多(实测 190+):列表区独立滚动,别把 HOME 拉成无限长
		const list = container.createDiv({ cls: 'life-home-hist-list' });
		if (this.saveDetailMode === 'overall') {
			for (const file of this.saveFiles) this.renderSaveFileRow(list, file, false);
			return;
		}
		const groups = new Map<string, SnapshotFileLite[]>();
		for (const file of this.saveFiles) {
			const norm = file.targetPath.replace(/\\/g, '/');
			const idx = norm.lastIndexOf('/');
			const dir = idx >= 0 ? norm.slice(0, idx) : '';
			const arr = groups.get(dir);
			if (arr) arr.push(file);
			else groups.set(dir, [file]);
		}
		for (const [dir, files] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
			const collapsed = this.saveCollapsedDirs.has(dir);
			const row = list.createDiv({ cls: 'life-home-hist-row is-dir' });
			row.createSpan({ cls: 'life-home-hist-chevron', text: collapsed ? '▸' : '▾' });
			row.createSpan({ cls: 'life-home-hist-msg', text: dir || '(根目录)' });
			row.createSpan({ cls: 'life-home-hist-meta', text: `${files.length} 个文件` });
			row.addEventListener('click', () => {
				if (collapsed) this.saveCollapsedDirs.delete(dir);
				else this.saveCollapsedDirs.add(dir);
				this.render();
			});
			if (collapsed) continue;
			for (const file of files) this.renderSaveFileRow(list, file, true);
		}
	}

	private renderSaveFileRow(container: HTMLElement, file: SnapshotFileLite, indent: boolean): void {
		const expanded = this.saveExpanded.has(file.targetPath);
		const row = container.createDiv({ cls: 'life-home-hist-row' + (indent ? ' is-sub' : '') });
		row.createSpan({ cls: 'life-home-hist-chevron', text: expanded ? '▾' : '▸' });
		row.createSpan({ cls: 'life-home-hist-msg', text: file.targetPath.split('/').pop() || file.targetPath });
		row.setAttr('title', file.targetPath);
		row.createSpan({
			cls: 'life-home-hist-meta',
			text: `${file.kind === 'external' ? '库外 · ' : ''}${file.count} 版本 · ${this.fmtWhen(file.lastAt)}`,
		});
		row.addEventListener('click', () => {
			if (expanded) this.saveExpanded.delete(file.targetPath);
			else this.saveExpanded.add(file.targetPath);
			this.render();
		});
		if (!expanded) return;
		const box = container.createDiv({ cls: 'life-home-hist-files' });
		for (const snap of file.snapshots.slice(0, 10)) {
			const srow = box.createDiv({ cls: 'life-home-hist-row is-snap' });
			srow.createSpan({ cls: 'life-home-hist-msg', text: `${snap.name || '自动保存'}${snap.favorite ? ' ★' : ''}` });
			srow.createSpan({
				cls: 'life-home-hist-meta',
				text: `${this.fmtWhen(snap.timestamp)} · ${(snap.content ?? '').length} 字`,
			});
			srow.setAttr('title', '点击预览该历史版本');
			srow.addEventListener('click', (ev) => {
				ev.stopPropagation();
				void this.previewSnapshot(file.targetPath, snap);
			});
		}
		if (file.snapshots.length > 10) {
			box.createDiv({ cls: 'life-home-muted', text: `…还有 ${file.snapshots.length - 10} 个版本` });
		}
	}

	private openCommitFile(commit: GitCommitLite, file: { path: string; fromPath?: string }): void {
		const git = this.hostModule<GitModuleApi>('obsidian-git');
		if (git?.tools?.openDiff) {
			git.tools.openDiff({
				aFile: file.fromPath ?? file.path,
				aRef: `${commit.hash}^`,
				bFile: file.path,
				bRef: commit.hash,
			});
			return;
		}
		void this.openModuleView('git-history-view');
	}

	private async openModuleView(viewType: string): Promise<void> {
		const leaf = this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf('tab');
		if (!leaf) return;
		await leaf.setViewState({ type: viewType, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	private fmtWhen(value: string): string {
		const d = new Date(value);
		if (Number.isNaN(d.getTime())) return value.slice(0, 16);
		const p = (n: number): string => String(n).padStart(2, '0');
		return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('life-home');
		const s = this.plugin.store.settings;
		const now = new Date();

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

		// ---- 各区块:顺序来自设置页「HOME 组件排序」(2026-11-22 用户) ----
		for (const id of normalizeHomeSectionOrder(s.homeSectionOrder)) {
			const sec = contentEl.createDiv({ cls: 'life-home-section' });
			switch (id) {
				case 'todayChanges':
					this.renderTodayChangesSection(sec);
					break;
				case 'vaultLog':
					this.renderVaultLogSection(sec);
					break;
				case 'gitHistory':
					this.renderGitHistorySection(sec);
					break;
				case 'saveHistory':
					this.renderSaveSection(sec);
					break;
				case 'calendar':
					this.renderCalendarSection(sec);
					break;
				case 'diary':
					sec.createDiv({ cls: 'life-home-sec-title', text: '日记' });
					this.renderDiarySection(sec);
					break;
				case 'overview':
					sec.createDiv({ cls: 'life-home-sec-title', text: '今日概览' });
					this.renderLifeSummaries(sec);
					break;
			}
		}
	}

	/** 今日库变化:今天最新一条记录摘要(没有则提示最近一条/空态)。 */
	private renderTodayChangesSection(sec: HTMLElement): void {
		const s = this.plugin.store.settings;
		const todayRec = s.vaultLogRecords.find((r) => r.date === todayKey()) ?? null;
		const latest = s.vaultLogRecords[0] ?? null;
		sec.createDiv({ cls: 'life-home-sec-title', text: '今日库变化' });
		if (todayRec) {
			renderRecordSummaryRow(sec, todayRec);
		} else if (latest) {
			sec.createDiv({
				cls: 'life-home-muted',
				text: `今天还没有记录。最近一条:${latest.date.slice(5)}(${changeSummary(latest)})`,
			});
		} else {
			sec.createDiv({ cls: 'life-home-muted', text: '还没有任何记录。点「记录库变化」打第一笔。' });
		}
	}

	/** 库记录列表(倒序;日期筛选,与独立库记录面板同款)。 */
	private renderVaultLogSection(sec: HTMLElement): void {
		const s = this.plugin.store.settings;
		sec.createDiv({ cls: 'life-home-sec-title', text: '库记录' });
		// 日期筛选:选日期只看该天,「全部」清空恢复;状态不落盘
		const filterRow = sec.createDiv({ cls: 'life-home-head-btns' });
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
			sec.createDiv({ cls: 'life-home-muted', text: `${this.filterDate} 当天没有记录。点「全部」清除筛选。` });
		} else if (shown.length === 0) {
			sec.createDiv({ cls: 'life-home-muted', text: '暂无记录。' });
		} else {
			const ui: VaultLogUiState = {
				expandedIds: this.detailRecordId ? new Set([this.detailRecordId]) : new Set(),
				detailMode: this.detailMode,
				settingsOpen: this.settingsOpen,
				collapsedDirs: this.collapsedDirs,
			};
			renderRecordListInto(sec, shown.slice(0, 10), ui, {
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
	}

	/** Git 历史:最近 10 条提交,展开看文件。 */
	private renderGitHistorySection(sec: HTMLElement): void {
		const gitHead = sec.createDiv({ cls: 'life-home-sec-head' });
		gitHead.createDiv({ cls: 'life-home-sec-title', text: 'Git 历史' });
		const gitBtns = gitHead.createDiv({ cls: 'life-home-head-btns' });
		const gitRefresh = gitBtns.createEl('button', { cls: 'life-home-mode-btn', text: '刷新' });
		gitRefresh.addEventListener('click', () => void this.loadHomeHistory());
		const gitOpen = gitBtns.createEl('button', { cls: 'life-home-mode-btn', text: '历史视图' });
		gitOpen.addEventListener('click', () => void this.openModuleView('git-history-view'));
		if (this.gitLog === null) {
			sec.createDiv({ cls: 'life-home-muted', text: '加载中…' });
		} else if (this.gitLogError) {
			sec.createDiv({ cls: 'life-home-muted', text: this.gitLogError });
		} else if (this.gitLog.length === 0) {
			sec.createDiv({ cls: 'life-home-muted', text: '暂无提交。' });
		} else {
			for (const c of this.gitLog) {
				const expanded = this.gitLogExpanded.has(c.hash);
				const row = sec.createDiv({ cls: 'life-home-hist-row' });
				row.createSpan({ cls: 'life-home-hist-chevron', text: expanded ? '▾' : '▸' });
				row.createSpan({ cls: 'life-home-hist-hash', text: c.hash.slice(0, 7) });
				const msg = row.createSpan({ cls: 'life-home-hist-msg', text: c.message.split('\n')[0] || '(无提交信息)' });
				msg.setAttr('title', c.message);
				row.createSpan({
					cls: 'life-home-hist-meta',
					text: `${c.author?.name ?? ''} · ${this.fmtWhen(c.date)} · ${c.diff?.changed ?? 0} 文件`,
				});
				row.addEventListener('click', () => {
					if (expanded) this.gitLogExpanded.delete(c.hash);
					else this.gitLogExpanded.add(c.hash);
					this.render();
				});
				if (!expanded) continue;
				const files = c.diff?.files ?? [];
				const box = sec.createDiv({ cls: 'life-home-hist-files' });
				if (!files.length) {
					box.createDiv({ cls: 'life-home-muted', text: '没有文件变更（合并/空提交）。' });
					continue;
				}
				for (const f of files.slice(0, 20)) {
					const frow = box.createDiv({ cls: 'life-home-hist-file', text: f.path });
					frow.setAttr('title', '打开该提交的差异');
					frow.addEventListener('click', (ev) => {
						ev.stopPropagation();
						this.openCommitFile(c, f);
					});
				}
				if (files.length > 20) {
					box.createDiv({ cls: 'life-home-muted', text: `…还有 ${files.length - 20} 个文件` });
				}
			}
		}
	}

	/** 大日历区块:迷你月网格 + 当日明细。 */
	private renderCalendarSection(sec: HTMLElement): void {
		sec.createDiv({ cls: 'life-home-sec-title', text: '大日历' });
		sec.createDiv({ cls: 'life-home-muted', text: '完整版(点格子加任务/计划)在「大日历」面板 →' });
		this.renderMiniCalendar(sec);
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