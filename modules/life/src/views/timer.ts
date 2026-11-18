/**
 * 计时面板：三个标签页 —— 倒计时 / 正计时 / 番茄钟。
 *
 * 运行态存 settings.timerRun（墙钟法）：
 *   倒计时/番茄 = remainMs 快照 + paused 标志（运行中 remain = endAt - now）;
 *   正计时 = startedAt 起点。
 * 视图关了计时也不停：插件 onload 里注册 1s 全局哨兵（见 main.ts tickTimer）,
 * 到点 Notice 提醒并清态;面板开着时由本视图走针重绘。
 */
import { ItemView, Notice, type WorkspaceLeaf } from 'obsidian';
import type LifePlugin from '../main';
import { formatDuration, parseDurationInput, todayKey } from '../util';
import { renderBar, renderEmpty } from './common';

export const VIEW_LIFE_TIMER = 'life-timer';

type Tab = 'countdown' | 'stopwatch' | 'pomodoro';

export class LifeTimerView extends ItemView {
	private tab: Tab = 'countdown';
	private ticker: number | null = null;
	private bigEl: HTMLElement | null = null;
	private subEl: HTMLElement | null = null;
	private lapListEl: HTMLElement | null = null;
	/** 正计时圈数（会话内存即可,不入盘） */
	private laps: number[] = [];
	private lapStart = 0;

	constructor(leaf: WorkspaceLeaf, private plugin: LifePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_LIFE_TIMER;
	}

	getDisplayText(): string {
		return '计时';
	}

	getIcon(): string {
		return 'timer';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('life-timer');
		renderBar(this.contentEl, '计时');
		const tabs = this.contentEl.createDiv({ cls: 'life-timer__tabs' });
		for (const t of [
			['countdown', '倒计时'],
			['stopwatch', '正计时'],
			['pomodoro', '番茄钟'],
		] as [Tab, string][]) {
			const b = tabs.createEl('button', { text: t[1] });
			b.dataset.tab = t[0];
			b.addEventListener('click', () => {
				this.tab = t[0];
				this.renderTabs();
				this.renderStage();
			});
		}
		this.renderTabs();
		this.bigEl = this.contentEl.createDiv({ cls: 'life-timer__big' });
		this.subEl = this.contentEl.createDiv({ cls: 'life-timer__sub' });
		this.lapListEl = this.contentEl.createDiv({ cls: 'life-timer__laps' });
		this.renderStage();
		this.ticker = window.setInterval(() => this.onTick(), 250);
	}

	private renderTabs(): void {
		for (const b of this.contentEl.querySelectorAll<HTMLButtonElement>('.life-timer__tabs button')) {
			b.classList.toggle('is-active', b.dataset.tab === this.tab);
		}
	}

	private run() {
		return this.plugin.store.settings.timerRun;
	}

	private async setRun(run: typeof this.plugin.store.settings.timerRun): Promise<void> {
		this.plugin.store.settings.timerRun = run;
		this.plugin.store.scheduleSave();
	}

	/** 剩余/已过 ms（墙钟法;暂停返回快照）。 */
	private remainMs(): number {
		const r = this.run();
		if (!r) return 0;
		if (r.paused) return r.remainMs;
		const elapsed = Date.now() - r.startedAt;
		return Math.max(0, r.baseMs - elapsed);
	}

	private elapsedMs(): number {
		const r = this.run();
		if (!r) return 0;
		return r.paused ? r.remainMs : Date.now() - r.startedAt;
	}

	private renderStage(): void {
		if (!this.bigEl || !this.subEl) return;
		this.bigEl.empty();
		this.subEl.empty();
		if (this.lapListEl) this.lapListEl.empty();
		const stage = this.bigEl.createDiv({ cls: 'life-timer__stage' });
		const r = this.run();
		if (this.tab === 'countdown') {
			if (r && r.kind === 'countdown') {
				this.renderCountdownRunning(stage);
			} else {
				this.renderCountdownIdle(stage);
			}
		} else if (this.tab === 'stopwatch') {
			if (r && r.kind === 'stopwatch') {
				this.renderStopwatchRunning(stage);
			} else {
				this.renderStopwatchIdle(stage);
			}
		} else {
			if (r && r.kind === 'pomodoro') {
				this.renderPomodoroRunning(stage);
			} else {
				this.renderPomodoroIdle(stage);
			}
		}
	}

	// ---------- 倒计时 ----------

	private renderCountdownIdle(stage: HTMLElement): void {
		const presets = this.plugin.store.settings.timerCountdownPresets;
		const row = stage.createDiv({ cls: 'life-timer__presets' });
		for (const min of presets) {
			const b = row.createEl('button', { text: `${min} 分` });
			b.addEventListener('click', () => void this.startCountdown(min * 60000, `${min} 分钟`));
		}
		const custom = stage.createDiv({ cls: 'life-timer__custom' });
		const input = custom.createEl('input');
		input.placeholder = '自定义 mm:ss 或 h:mm:ss';
		input.inputMode = 'numeric';
		const go = custom.createEl('button', { text: '开始', cls: 'mod-cta' });
		const commit = (): void => {
			const ms = parseDurationInput(input.value);
			if (ms === null) {
				new Notice('格式：25 / 25:30 / 1:05:00');
				return;
			}
			void this.startCountdown(ms, input.value);
		};
		go.addEventListener('click', commit);
		input.addEventListener('keydown', (ev: KeyboardEvent) => {
			if (ev.key === 'Enter') commit();
		});
	}

	private renderCountdownRunning(stage: HTMLElement): void {
		const r = this.run();
		if (!r) return;
		const label = stage.createDiv({ cls: 'life-timer__label', text: r.label ? `倒计时 · ${r.label}` : '倒计时' });
		void label;
		const actions = stage.createDiv({ cls: 'life-timer__actions' });
		const toggle = actions.createEl('button', { text: r.paused ? '继续' : '暂停', cls: 'mod-cta' });
		toggle.addEventListener('click', () => void this.togglePause());
		const stop = actions.createEl('button', { text: '结束' });
		stop.addEventListener('click', () => void this.stopRun());
	}

	// ---------- 正计时 ----------

	private renderStopwatchIdle(stage: HTMLElement): void {
		this.laps = [];
		this.lapStart = 0;
		const actions = stage.createDiv({ cls: 'life-timer__actions' });
		const go = actions.createEl('button', { text: '开始', cls: 'mod-cta' });
		go.addEventListener('click', () => {
			this.laps = [];
			this.lapStart = Date.now();
			void this.setRun({ kind: 'stopwatch', startedAt: Date.now(), baseMs: 0, remainMs: 0, paused: false });
			this.renderStage();
		});
		renderEmpty(this.subEl ?? stage, '正计时：计圈、看累计,随手掐时间。');
	}

	private renderStopwatchRunning(stage: HTMLElement): void {
		const actions = stage.createDiv({ cls: 'life-timer__actions' });
		const lap = actions.createEl('button', { text: '计圈', cls: 'mod-cta' });
		lap.addEventListener('click', () => {
			const now = Date.now();
			const r = this.run();
			const since = r && !r.paused ? now - (this.lapStart || r.startedAt) : 0;
			this.laps.unshift(since);
			this.lapStart = now;
			this.renderLaps();
		});
		const toggle = actions.createEl('button', { text: this.run()?.paused ? '继续' : '暂停' });
		toggle.addEventListener('click', () => void this.togglePause());
		const stop = actions.createEl('button', { text: '结束' });
		stop.addEventListener('click', () => void this.stopRun());
		this.renderLaps();
	}

	private renderLaps(): void {
		const listEl = this.lapListEl;
		if (!listEl) return;
		listEl.empty();
		this.laps.forEach((ms, i) => {
			listEl.createDiv({
				cls: 'life-timer__lap',
				text: `#${this.laps.length - i}  +${formatDuration(ms)}`,
			});
		});
	}

	// ---------- 番茄钟 ----------

	private pomodoroToday(): number {
		const r = this.run();
		if (r && r.pomodoroDate === todayKey()) return r.pomodoroCount ?? 0;
		return 0;
	}

	private renderPomodoroIdle(stage: HTMLElement): void {
		const s = this.plugin.store.settings;
		const actions = stage.createDiv({ cls: 'life-timer__actions' });
		const go = actions.createEl('button', { text: `开始专注（${s.timerPomodoroWorkMin} 分钟）`, cls: 'mod-cta' });
		go.addEventListener('click', () => void this.startPomodoro('work'));
		renderEmpty(this.subEl ?? stage, `今天已完成 ${this.pomodoroToday()} 个番茄 · ${s.timerPomodoroWorkMin}/${s.timerPomodoroBreakMin} 分钟`);
	}

	private renderPomodoroRunning(stage: HTMLElement): void {
		const r = this.run();
		if (!r) return;
		const label = stage.createDiv({
			cls: 'life-timer__label',
			text: r.phase === 'break' ? '休息中' : `专注中 · 今天 ${this.pomodoroToday()} 个番茄`,
		});
		void label;
		const actions = stage.createDiv({ cls: 'life-timer__actions' });
		const toggle = actions.createEl('button', { text: r.paused ? '继续' : '暂停' });
		toggle.addEventListener('click', () => void this.togglePause());
		const stop = actions.createEl('button', { text: '放弃' });
		stop.addEventListener('click', () => void this.stopRun());
	}

	// ---------- 动作 ----------

	private async startCountdown(ms: number, label: string): Promise<void> {
		await this.setRun({ kind: 'countdown', startedAt: Date.now(), baseMs: ms, remainMs: ms, paused: false, label });
		this.renderStage();
	}

	private async startPomodoro(phase: 'work' | 'break'): Promise<void> {
		const s = this.plugin.store.settings;
		const min = phase === 'work' ? s.timerPomodoroWorkMin : s.timerPomodoroBreakMin;
		const prev = this.run();
		await this.setRun({
			kind: 'pomodoro',
			startedAt: Date.now(),
			baseMs: min * 60000,
			remainMs: min * 60000,
			paused: false,
			phase,
			pomodoroCount: prev?.pomodoroCount ?? 0,
			pomodoroDate: todayKey(),
		});
		this.renderStage();
	}

	private async togglePause(): Promise<void> {
		const r = this.run();
		if (!r) return;
		if (r.paused) {
			const remain = r.remainMs;
			await this.setRun({ ...r, paused: false, startedAt: Date.now(), baseMs: remain, remainMs: remain });
		} else {
			const remain = this.tab === 'stopwatch' ? this.elapsedMs() : this.remainMs();
			await this.setRun({ ...r, paused: true, remainMs: remain });
		}
		this.renderStage();
	}

	private async stopRun(): Promise<void> {
		await this.setRun(null);
		this.renderStage();
	}

	// ---------- 走针 ----------

	private onTick(): void {
		const r = this.run();
		if (!this.bigEl) return;
		let big = '';
		let sub = '';
		if (!r) {
			big = this.tab === 'stopwatch' ? '00:00' : this.tab === 'pomodoro' ? formatDuration(this.plugin.store.settings.timerPomodoroWorkMin * 60000) : '00:00';
		} else if (r.kind === 'stopwatch') {
			big = formatDuration(this.elapsedMs());
			sub = r.paused ? '已暂停' : '';
		} else {
			const remain = this.remainMs();
			big = formatDuration(remain);
			sub = r.paused ? '已暂停' : '';
			if (remain <= 0 && !r.paused) {
				void this.onExpire(r.kind, r.phase);
				return;
			}
		}
		this.bigEl.setText(big);
		if (this.subEl) this.subEl.setText(sub);
	}

	/** 倒计时/番茄到点：本地收尾 + 提醒（全局哨兵兜底见 main.ts）。 */
	private async onExpire(kind: 'countdown' | 'pomodoro', phase?: 'work' | 'break'): Promise<void> {
		const s = this.plugin.store.settings;
		if (kind === 'pomodoro' && phase === 'work') {
			const prev = this.run();
			await this.setRun({
				kind: 'pomodoro',
				startedAt: Date.now(),
				baseMs: s.timerPomodoroBreakMin * 60000,
				remainMs: s.timerPomodoroBreakMin * 60000,
				paused: false,
				phase: 'break',
				pomodoroCount: (prev?.pomodoroCount ?? 0) + 1,
				pomodoroDate: todayKey(),
			});
			new Notice('🍅 番茄完成！休息一下');
		} else if (kind === 'pomodoro' && phase === 'break') {
			await this.setRun(null);
			new Notice('休息结束，开始下一个番茄？');
		} else {
			await this.setRun(null);
			new Notice('⏰ 倒计时到点');
		}
		this.renderStage();
	}

	async onClose(): Promise<void> {
		if (this.ticker) window.clearInterval(this.ticker);
		this.ticker = null;
		this.contentEl.empty();
	}
}
