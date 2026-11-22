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
import { VIEW_LIFE_VAULTLOG, LifeVaultLogView } from './views/vaultlog';
import { dailyDue, periodDue, scanVaultSig, diffWithRenames, changeSummary, dayKeyOf, parseHHmm, diffLines, type LineDiff, type VaultDiffWithRenames } from './vaultLog';
import { VaultLogDiffModal } from './vaultLogDiffModal';
import { dispatchVaultDiffToCm, setVaultDiffEntry, vaultDiffExtension } from './editorDiffCm6';
import { TFile as _TFileReuse } from 'obsidian';
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
	{ type: VIEW_LIFE_VAULTLOG, name: '库记录', icon: 'archive' },
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

		// 启动时打开 HOME 标签页(用户 2026-11-20 要求,设置可关):布局就绪后
		// 开(布局恢复可能已带 life-home 叶——已开即跳过)。
		this.app.workspace.onLayoutReady(() => {
			if (this.store.settings.homeOpenOnStartup === false) return;
			if (this.app.workspace.getLeavesOfType(VIEW_LIFE_HOME).length > 0) return;
			void this.activatePanel(VIEW_LIFE_HOME);
		});
		// 原生编辑器修改装点(2026-11-21 用户):库记录对比体系的 CM6 扩展
		// (新增绿/修改蓝,点击标记开对比弹窗)。
		this.registerEditorExtension(
			vaultDiffExtension((path) => this.openRecordDiffModal(path)),
		);
		this.app.workspace.onLayoutReady(() => {
			// record 基线的影子兜底:与 first 记录分支互斥幂等。
			if (this.vaultDiffBaseline() === 'record') {
				window.setTimeout(() => void this.buildVaultShadowBaseline(), 3000);
			}
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
		| LifeHomeView
		| LifeVaultLogView {
		switch (type) {
			case VIEW_LIFE_HOME:
				return new LifeHomeView(leaf, this);
			case VIEW_LIFE_VAULTLOG:
				return new LifeVaultLogView(leaf, this);
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
		// HOME 是主工作区标签页(用户 2026-11-20 定稿):走主区 tab,不进侧栏。
		if (viewType === VIEW_LIFE_HOME) {
			const leaf = this.app.workspace.getLeaf('tab');
			if (!leaf) return;
			await leaf.setViewState({ type: viewType, active: true });
			this.app.workspace.revealLeaf(leaf);
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
	 * 记录库变化(2026-11-19 阶段 C;2026-11-20 识别改进):全库文件签名快照
	 * vs 上一次快照 → 重命名/新增/修改/删除;快照本体存独立文件(data.json
	 * 不吃万级条目)。
	 *
	 * 识别改进(用户报「新增 修改 删除识别有问题」):
	 * - 首次记录只建基线(first=true)——此前全库报「新增」;
	 * - 签名一致的 删除↔新增 配对成重命名/移动;
	 * - 自动触发(周期/每日)零变化不落记录——此前空记录刷屏。
	 */
	/** 编辑器装点登记表:库内相对路径 → 行级 diff(基线见 vaultDiffBaseline)。 */
	private editorDiffRegistry = new Map<string, { diff: LineDiff }>();
	/** 库文件内容影子(上次记录时点,单文件 ≤400KB,总量 ≤48MB):record 基线的
	 * before 来源。内存态,重启后由基线重建。仅 diffBaseline='record' 时构建。 */
	private vaultShadow = new Map<string, string>();
	private vaultShadowBytes = 0;
	private shadowReady = false;
	private static readonly SHADOW_FILE_CAP = 400 * 1024;
	private static readonly SHADOW_TOTAL_CAP = 48 * 1024 * 1024;

	private vaultDiffBaseline(): 'git' | 'record' {
		return this.store.settings.vaultLog?.diffBaseline === 'record' ? 'record' : 'git';
	}

	/** obsidian-git 的桌面 git 管理器(HEAD 内容读取/单文件还原);未启用或
	 * 移动端(isomorphic)返回 null——对比/撤回优雅降级为不可用。 */
	private gitDiffManager(): {
		showFileAtHead?: (path: string) => Promise<string | null>;
		restoreFileToHead?: (path: string) => Promise<boolean>;
	} | null {
		const host = (this.app as unknown as {
			plugins?: { plugins?: Record<string, { moduleInstance?: (id: string) => unknown } | undefined> };
		}).plugins?.plugins?.['obsidian-my-obsidian'];
		const git = host?.moduleInstance?.('obsidian-git') as
			| { gitManager?: { showFileAtHead?: unknown; restoreFileToHead?: unknown; useSimpleGit?: boolean } }
			| undefined;
		const mgr = git?.gitManager as
			| { showFileAtHead?: (path: string) => Promise<string | null>; restoreFileToHead?: (path: string) => Promise<boolean> }
			| undefined;
		return mgr && typeof mgr.showFileAtHead === 'function' ? mgr : null;
	}

	/** 读一个库内文件的文本内容做影子;超限或疑似二进制返回 null。 */
	private async readShadowable(path: string): Promise<string | null> {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) return null;
		if (f.stat.size > LifePlugin.SHADOW_FILE_CAP) return null;
		try {
			const content = await this.app.vault.cachedRead(f);
			if (content.includes('\u0000')) return null;
			return content;
		} catch {
			return null;
		}
	}

	private shadowSet(path: string, content: string): void {
		const old = this.vaultShadow.get(path);
		if (old !== undefined) this.vaultShadowBytes -= old.length;
		this.vaultShadow.set(path, content);
		this.vaultShadowBytes += content.length;
		// 总量超限:按插入序淘汰最旧(对比能力优雅降级,记录本身不受影响)
		while (this.vaultShadowBytes > LifePlugin.SHADOW_TOTAL_CAP) {
			const oldest = this.vaultShadow.keys().next().value;
			if (oldest === undefined) break;
			this.vaultShadowBytes -= this.vaultShadow.get(oldest)?.length ?? 0;
			this.vaultShadow.delete(oldest);
		}
	}

	private shadowDelete(path: string): void {
		const old = this.vaultShadow.get(path);
		if (old !== undefined) this.vaultShadowBytes -= old.length;
		this.vaultShadow.delete(path);
	}

	/** 启动基线:把当前全库文本读进影子(8ms 分片让出主线程,后台完成)。
	 * 仅 record 基线需要(git 基线数据源在 git 模块)。 */
	private async buildVaultShadowBaseline(): Promise<void> {
		if (this.shadowReady || this.vaultDiffBaseline() !== 'record') return;
		this.shadowReady = true;
		const files = this.app.vault.getFiles();
		let i = 0;
		const step = async (): Promise<void> => {
			const t0 = performance.now();
			while (i < files.length && performance.now() - t0 < 8) {
				const f = files[i++];
				const content = await this.readShadowable(f.path);
				if (content !== null) this.shadowSet(f.path, content);
			}
			if (i < files.length) window.setTimeout(() => void step(), 0);
		};
		await step();
	}

	/** 影子推进到记录时点(修改/新增读当前内容,删除摘除,重命名搬家)。 */
	private async advanceVaultShadow(diff: VaultDiffWithRenames): Promise<void> {
		for (const p of [...diff.modified, ...diff.added]) {
			const content = await this.readShadowable(p);
			if (content !== null) this.shadowSet(p, content);
			else this.shadowDelete(p);
		}
		for (const p of diff.deleted) this.shadowDelete(p);
		for (const r of diff.renames ?? []) {
			const content = this.vaultShadow.get(r.from) ?? (await this.readShadowable(r.to));
			this.shadowDelete(r.from);
			if (content !== null) this.shadowSet(r.to, content);
		}
	}

	/** 修改对比(库内相对路径):当前内容与基线的行级 diff。基线按设置:
	 * git = 上次提交(HEAD);record = 上次库记录时点(影子)。无基线/无差异/
	 * 总开关关闭返回 null。 */
	async getRecordDiff(path: string): Promise<LineDiff | null> {
		if (this.store.settings.vaultLog?.diffEnabled === false) return null;
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) return null;
		const before = await this.recordBaselineContent(path);
		if (before === null) return null;
		const cur = await this.app.vault.cachedRead(f);
		if (cur === before) return null;
		return diffLines(before, cur);
	}

	/** 修改对比的基线内容(2026-11-22 抽公共方法):git = 上次提交(HEAD);
	 * record = 上次库记录时点(影子)。getRecordDiff/revertRecordFile/VSCode
	 * 对比共用。无基线(null)/总开关关 → null。 */
	async recordBaselineContent(path: string): Promise<string | null> {
		if (this.store.settings.vaultLog?.diffEnabled === false) return null;
		if (this.vaultDiffBaseline() === 'record') {
			return this.vaultShadow.get(path) ?? null;
		}
		const mgr = this.gitDiffManager();
		if (!mgr?.showFileAtHead) return null;
		return await mgr.showFileAtHead(path);
	}

	/** 撤回:单文件还原到上次提交(丢弃未提交修改;git restore HEAD -- path)。 */
	async revertRecordFile(path: string): Promise<boolean> {
		const before = await this.recordBaselineContent(path);
		if (before === null) return false;
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) return false;
		const cur = await this.app.vault.cachedRead(f);
		if (cur === before) return true; // 已是基线内容,幂等
		await this.app.vault.modify(f, before);
		new Notice(
			`已撤回:${path} → ` +
				(this.vaultDiffBaseline() === 'git' ? '上次提交(HEAD)' : '上次库记录时点') +
				'的内容',
		);
		this.refreshHomeViews();
		// monaco 视图无 file→editor 同步:撤回后强制打开中的代码视图重读,
		// 否则其缓冲(旧内容)的自动保存会把撤回覆盖回去(实测)。
		await this.reloadExternalCodeViews(path);
		return true;
	}

	/** 撤回后强制重读打开中的代码视图(monaco 无 file→editor 同步)。 */
	private async reloadExternalCodeViews(path: string): Promise<void> {
		const wanted = path.replace(/\\/g, '/').toLowerCase();
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => leaves.push(leaf));
		for (const leaf of leaves) {
			const v = leaf.view as {
				viewType?: string;
				abs?: string;
				reloadFromDisk?: () => Promise<void>;
			} | null;
			if (v?.viewType !== 'logseq-external-code' || typeof v.reloadFromDisk !== 'function') continue;
			const abs = typeof v.abs === 'string' ? v.abs.replace(/\\/g, '/').toLowerCase() : '';
			if (abs.endsWith('/' + wanted) || abs === wanted) await v.reloadFromDisk();
		}
	}

	// setEditorDiff 已退役(2026-11-22 用户:嵌入编辑器的覆盖层区块整体替换为
	// 「定位对比弹窗」)——不再有任何路径写入登记表,editorDiffRegistry 恒空,
	// monaco 视区 zone / CM6 覆盖层 widget 自然绝迹。registry 的读侧(get/
	// refresh)保留,消费方(ExternalCodeView/CM 扩展)读到 null 即无装饰。

	getEditorDiff(path: string): { diff: LineDiff } | null {
		return this.editorDiffRegistry.get(path) ?? null;
	}

	/** 开关切换后刷新编辑器装点:清登记表 + CM 分发 null + monaco 视图重应用。 */
	async refreshEditorDiffs(): Promise<void> {
		for (const p of [...this.editorDiffRegistry.keys()]) {
			this.editorDiffRegistry.delete(p);
			setVaultDiffEntry(p, null);
			dispatchVaultDiffToCm(this.app, p);
		}
		// monaco 视图(库内代码文件)重应用:读新开关状态清装点
		const leaves: WorkspaceLeaf[] = [];
		this.app.workspace.iterateAllLeaves((leaf) => leaves.push(leaf));
		for (const leaf of leaves) {
			const v = leaf.view as { viewType?: string; applyVaultDiffDecorations?: () => Promise<void> } | null;
			if (v?.viewType === 'logseq-external-code' && typeof v.applyVaultDiffDecorations === 'function') {
				try {
					await v.applyVaultDiffDecorations();
				} catch {
					/* 单视图失败不阻断 */
				}
			}
		}
	}

	/** 库记录点击修改的文件:打开**修改对比弹窗**(2026-11-22 用户两轮澄清:
	 * 原来的对比视图是嵌入编辑器的覆盖层区块——整体退役,统一弹「定位对比
	 * 弹窗」;不再登记 editorDiffRegistry,编辑器里不再出现嵌入区块/装点)。
	 * 「对比」小钮同弹窗。 */
	async openModifiedFileWithDiff(path: string): Promise<void> {
		this.editorDiffRegistry.delete(path);
		// 默认打开方式(2026-11-22 用户):vscode = 直接拉 VSCode diff;
		// modal(缺省) = 内置对比弹窗。弹窗 footer 两种方式手动可用。
		if (this.store.settings.vaultLog?.diffOpenWith === 'vscode') {
			await this.openRecordDiffInVscode(path);
			return;
		}
		this.openRecordDiffModal(path);
	}

	/** 「对比」小钮:打开修改对比弹窗(可撤回)。 */
	openRecordDiffModal(path: string): void {
		new VaultLogDiffModal(this.app, this, path).open();
	}

	/** 用 VSCode 打开 diff(2026-11-22 用户):基线内容写临时文件,
	 * `code --diff <基线> <当前>` 起原生两栏对比。可执行文件探测:
	 * 设置路径 → 常见安装位置 → PATH。失败返回 false(弹 Notice)。 */
	async openRecordDiffInVscode(path: string): Promise<boolean> {
		const before = await this.recordBaselineContent(path);
		if (before === null) {
			new Notice('无基线内容:git 模块未启用或无库记录影子');
			return false;
		}
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) return false;
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const nodeRequire = eval('require') as NodeRequire;
		const fs = nodeRequire('fs') as typeof import('fs');
		const pathMod = nodeRequire('path') as typeof import('path');
		const osMod = nodeRequire('os') as typeof import('os');
		const cp = nodeRequire('child_process') as typeof import('child_process');
		const adapter = this.app.vault.adapter as { getBasePath?: () => string };
		const base = (adapter.getBasePath?.() ?? '').replace(/[\\/]+$/, '');
		const absCurrent = base ? base + '/' + path : path;
		// 基线临时文件:固定名(路径哈希)覆盖写,不堆积
		let h = 5381;
		for (let i = 0; i < path.length; i++) h = (Math.imul(h, 33) ^ path.charCodeAt(i)) >>> 0;
		const tmp = pathMod.join(osMod.tmpdir(), 'obsidian-diff-base-' + h.toString(16) + (pathMod.extname(path) || '.txt'));
		fs.writeFileSync(tmp, before, 'utf8');

		const exe = this.resolveVscodeExe(fs);
		if (!exe) {
			new Notice('未找到 VSCode——可在库记录设置里填写 VSCode 路径');
			return false;
		}
		try {
			const child = cp.spawn(exe, ['--diff', tmp, absCurrent], {
				detached: true,
				stdio: 'ignore',
				// code.cmd 等 CLI 包装需要 shell 解析;.exe 直接起
				shell: !/\.exe$/i.test(exe),
			});
			child.unref?.();
			return true;
		} catch (e) {
			new Notice('VSCode 启动失败:' + String(e).slice(0, 120));
			return false;
		}
	}

	/** VSCode 可执行探测:设置路径 → 本机常见安装位置 → PATH('code')。 */
	private resolveVscodeExe(fs: typeof import('fs')): string | null {
		const custom = this.store.settings.vaultLog?.vscodePath?.trim();
		const cands: string[] = [];
		if (custom) cands.push(custom);
		const local = process.env.LOCALAPPDATA;
		if (local) {
			cands.push(local + '\\Programs\\Microsoft VS Code\\Code.exe');
			cands.push(local + '\\Programs\\Microsoft VS Code Insiders\\Code.exe');
			cands.push(local + '\\Programs\\Cursor\\Cursor.exe');
		}
		cands.push('C:\\Program Files\\Microsoft VS Code\\Code.exe');
		cands.push('C:\\Program Files\\Cursor\\Cursor.exe');
		for (const c of cands) {
			try {
				if (c && fs.existsSync(c)) return c;
			} catch {
				/* 探测失败继续 */
			}
		}
		return 'code'; // PATH 兜底(shell:true 解析 code.cmd)
	}

	async recordVaultChanges(trigger: 'period' | 'daily' | 'manual' = 'manual'): Promise<VaultLogRecord> {
		const cur = scanVaultSig(this.app.vault);
		const prev = await this.loadVaultLogSnapshot();
		const now = new Date();
		const s = this.store.settings;
		if (trigger === 'daily') s.vaultLogLastDailyDate = dayKeyOf(now);
		if (trigger === 'period') s.vaultLogLastPeriodAt = now.getTime();
		// 首次记录:快照文件不存在 = 只建立基线,不列变化(万级「新增」是噪声)
		if (prev === null) {
			await this.saveVaultLogSnapshot(cur);
			// record 基线:影子基线(后台分片),此后修改的文件才有对比数据。
			if (this.vaultDiffBaseline() === 'record') void this.buildVaultShadowBaseline();
			const rec: VaultLogRecord = {
				id: genId(),
				at: now.toISOString(),
				date: dayKeyOf(now),
				trigger,
				added: [],
				modified: [],
				deleted: [],
				first: true,
				totalFiles: Object.keys(cur).length,
			};
			s.vaultLogRecords = [rec, ...s.vaultLogRecords].slice(0, 200);
			await this.store.flush();
			this.refreshHomeViews();
			return rec;
		}
		const diff = diffWithRenames(prev, cur);
		await this.saveVaultLogSnapshot(cur);
		// record 基线:影子推进到本次记录时点(下次对比的 before)。
		if (this.vaultDiffBaseline() === 'record') await this.advanceVaultShadow(diff);
		const empty =
			diff.added.length + diff.modified.length + diff.deleted.length + diff.renames.length === 0;
		// 自动触发零变化:标记已推进(防每 30s 重判),不落记录
		if (empty && trigger !== 'manual') {
			await this.store.flush();
			return {
				id: '',
				at: now.toISOString(),
				date: dayKeyOf(now),
				trigger,
				added: [],
				modified: [],
				deleted: [],
				totalFiles: Object.keys(cur).length,
			};
		}
		const rec: VaultLogRecord = {
			id: genId(),
			at: now.toISOString(),
			date: dayKeyOf(now),
			trigger,
			added: diff.added,
			modified: diff.modified,
			deleted: diff.deleted,
			renames: diff.renames,
			totalFiles: Object.keys(cur).length,
		};
		const cap = (list: string[]): string[] => (list.length > 500 ? list.slice(0, 500) : list);
		rec.added = cap(rec.added);
		rec.modified = cap(rec.modified);
		rec.deleted = cap(rec.deleted);
		rec.renames = rec.renames?.slice(0, 500);
		s.vaultLogRecords = [rec, ...s.vaultLogRecords].slice(0, 200);
		await this.store.flush();
		this.refreshHomeViews();
		if (s.vaultLog.remind) {
			new Notice(
				'📋 库记录(' + (trigger === 'manual' ? '手动' : trigger === 'daily' ? '每日' : '周期') + '):' + changeSummary(diff, diff.renames.length),
			);
		}
		return rec;
	}

	/** 快照存取(独立文件,manifest.dir 下——data.json 不吃万级签名表)。 */
	private snapshotPath(): string {
		return (this.manifest.dir ?? '') + '/vault-log-snapshot.json';
	}

	/** null = 快照文件不存在(首次记录语义;读失败当首次,下次收敛)。 */
	private async loadVaultLogSnapshot(): Promise<Record<string, string> | null> {
		try {
			const raw = await this.app.vault.adapter.read(this.snapshotPath());
			return JSON.parse(raw) as Record<string, string>;
		} catch {
			return null;
		}
	}

	private async saveVaultLogSnapshot(table: Record<string, string>): Promise<void> {
		await this.app.vault.adapter.write(this.snapshotPath(), JSON.stringify(table));
	}

	/** HOME 视图刷新(开着就重绘;记录/设置变更后调用)。 */
	refreshHomeViews(): void {
		window.app.workspace.iterateAllLeaves((l) => {
			const t = l.view?.getViewType?.();
			if (t === VIEW_LIFE_HOME) (l.view as LifeHomeView).refresh();
			if (t === VIEW_LIFE_VAULTLOG) (l.view as LifeVaultLogView).refresh();
		});
	}

}
