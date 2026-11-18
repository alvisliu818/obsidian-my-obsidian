/**
 * 时钟面板：大数字时钟 + 日期/星期 + 简易模拟表盘（CSS 指针）。
 * setInterval 每秒走针,onClose 摘掉。
 */
import { ItemView, type WorkspaceLeaf } from 'obsidian';
import type LifePlugin from '../main';
import { WEEKDAY_LABELS } from '../util';

export const VIEW_LIFE_CLOCK = 'life-clock';

export class LifeClockView extends ItemView {
	private ticker: number | null = null;
	private timeEl: HTMLElement | null = null;
	private dateEl: HTMLElement | null = null;
	private secDot: HTMLElement | null = null;
	private hourHand: HTMLElement | null = null;
	private minHand: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, _plugin: LifePlugin) {
		super(leaf);
		void _plugin;
	}

	getViewType(): string {
		return VIEW_LIFE_CLOCK;
	}

	getDisplayText(): string {
		return '时钟';
	}

	getIcon(): string {
		return 'clock';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('life-clock');
		const wrap = this.contentEl.createDiv({ cls: 'life-clock__wrap' });

		this.timeEl = wrap.createDiv({ cls: 'life-clock__time' });
		this.secDot = wrap.createDiv({ cls: 'life-clock__secdot' });
		this.dateEl = wrap.createDiv({ cls: 'life-clock__date' });

		const face = wrap.createDiv({ cls: 'life-clock__face' });
		for (let i = 1; i <= 12; i++) {
			const tick = face.createDiv({ cls: 'life-clock__tick', text: String(i) });
			const ang = i * 30 - 60;
			tick.style.transform = `rotate(${ang}deg) translateY(-76px)`;
		}
		this.hourHand = face.createDiv({ cls: 'life-clock__hand life-clock__hand--hour' });
		this.minHand = face.createDiv({ cls: 'life-clock__hand life-clock__hand--min' });
		const center = face.createDiv({ cls: 'life-clock__center' });

		void center;
		this.ticker = window.setInterval(() => this.tick(), 1000);
		this.tick();
	}

	private tick(): void {
		const now = new Date();
		if (this.timeEl) {
			this.timeEl.setText(
				`${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
			);
		}
		if (this.dateEl) {
			this.dateEl.setText(
				`${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · 星期${WEEKDAY_LABELS[(now.getDay() + 6) % 7]}`,
			);
		}
		if (this.secDot) this.secDot.setText(String(now.getSeconds()).padStart(2, '0'));
		if (this.hourHand) {
			const h = (now.getHours() % 12) + now.getMinutes() / 60;
			this.hourHand.style.transform = `rotate(${h * 30}deg)`;
		}
		if (this.minHand) {
			const m = now.getMinutes() + now.getSeconds() / 60;
			this.minHand.style.transform = `rotate(${m * 6}deg)`;
		}
	}

	async onClose(): Promise<void> {
		if (this.ticker) window.clearInterval(this.ticker);
		this.ticker = null;
		this.contentEl.empty();
	}
}
