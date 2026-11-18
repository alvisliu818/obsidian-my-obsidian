/**
 * 记账面板：收入/支出流水。顶部月份汇总（收入/支出/结余）+ 分类横条，
 * 流水按日期倒序；快加（金额+收支+分类+备注）；月切换。
 */
import { ItemView, Menu, type WorkspaceLeaf } from 'obsidian';
import type LifePlugin from '../main';
import { dateKey, genId, parseAmount, sumLedgerMonth } from '../util';
import { LifePromptModal, renderBar, renderEmpty } from './common';

export const VIEW_LIFE_LEDGER = 'life-ledger';

export class LifeLedgerView extends ItemView {
	/** 当前查看的月份 yyyy-mm */
	private month = dateKey(new Date()).slice(0, 7);

	constructor(leaf: WorkspaceLeaf, private plugin: LifePlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_LIFE_LEDGER;
	}

	getDisplayText(): string {
		return '记账';
	}

	getIcon(): string {
		return 'wallet';
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass('life-ledger');
		this.render();
	}

	private render(): void {
		const { contentEl } = this;
		contentEl.empty();
		const bar = renderBar(contentEl, `记账 · ${this.month}`);
		const prev = bar.createEl('button', { text: '‹' });
		prev.addEventListener('click', () => this.shiftMonth(-1));
		const next = bar.createEl('button', { text: '›' });
		next.addEventListener('click', () => this.shiftMonth(1));
		const add = bar.createEl('button', { text: '记一笔', cls: 'mod-cta' });
		add.addEventListener('click', () => this.promptAdd());

		const entries = this.plugin.store.settings.ledger;
		const sum = sumLedgerMonth(entries, this.month);

		// 汇总卡
		const cards = contentEl.createDiv({ cls: 'life-ledger__cards' });
		cards.createDiv({ cls: 'life-ledger__card life-ledger__card--in' }).setText(`收入 ${sum.income}`);
		cards.createDiv({ cls: 'life-ledger__card life-ledger__card--out' }).setText(`支出 ${sum.expense}`);
		cards.createDiv({ cls: 'life-ledger__card life-ledger__card--net' }).setText(`结余 ${Math.round((sum.income - sum.expense) * 100) / 100}`);

		// 分类横条（支出优先,不足 8px 隐藏为纯文字行）
		const cats = Object.entries(sum.byCategory).sort((a, b) => b[1] - a[1]);
		if (cats.length) {
			const catWrap = contentEl.createDiv({ cls: 'life-ledger__cats' });
			const max = cats[0][1] || 1;
			for (const [cat, amt] of cats.slice(0, 8)) {
				const line = catWrap.createDiv({ cls: 'life-ledger__cat' });
				line.createSpan({ cls: 'life-ledger__cat-name', text: cat });
				const barEl = line.createDiv({ cls: 'life-ledger__cat-bar' });
				barEl.style.width = `${Math.max(4, Math.round((amt / max) * 100))}%`;
				line.createSpan({ cls: 'life-ledger__cat-amt', text: String(amt) });
			}
		}

		// 流水（本月,日期倒序）
		const monthEntries = entries
			.filter((e) => e.date.startsWith(this.month))
			.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
		if (!monthEntries.length) {
			renderEmpty(contentEl, '本月还没有账目。右上「记一笔」。');
			return;
		}
		const list = contentEl.createDiv({ cls: 'life-ledger__list' });
		let lastDate = '';
		for (const e of monthEntries) {
			if (e.date !== lastDate) {
				lastDate = e.date;
				list.createDiv({ cls: 'life-ledger__day', text: e.date });
			}
			const row = list.createDiv({ cls: 'life-ledger__row' + (e.kind === 'in' ? ' is-in' : '') });
			row.createSpan({ cls: 'life-ledger__cat', text: e.category });
			row.createSpan({ cls: 'life-ledger__note', text: e.note ?? '' });
			row.createSpan({
				cls: 'life-ledger__amount',
				text: `${e.kind === 'in' ? '+' : '-'}${e.amount}`,
			});
			row.addEventListener('contextmenu', (ev) => {
				ev.preventDefault();
				const menu = new Menu();
				menu.addItem((item) =>
					item.setTitle('删除').setIcon('trash').onClick(() => {
						const s = this.plugin.store.settings;
						s.ledger = s.ledger.filter((x) => x.id !== e.id);
						this.plugin.store.scheduleSave();
						this.render();
					}),
				);
				menu.showAtMouseEvent(ev);
			});
		}
	}

	private shiftMonth(delta: number): void {
		const [y, m] = this.month.split('-').map(Number);
		const d = new Date(y, m - 1 + delta, 1);
		this.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
		this.render();
	}

	private promptAdd(): void {
		const s = this.plugin.store.settings;
		new LifePromptModal(
			this.app,
			`记一笔 · ${this.month}`,
			[
				{ key: 'amount', label: '金额', placeholder: '25 或 25.5', validate: (v) => (parseAmount(v) !== null ? null : '请填正数金额') },
				{
					key: 'kind',
					label: '收支',
					type: 'select',
					value: 'out',
					options: [
						{ value: 'out', label: '支出' },
						{ value: 'in', label: '收入' },
					],
				},
				{
					key: 'category',
					label: '分类（留空=其他）',
					value: '其他',
				},
				{ key: 'note', label: '备注（可选）' },
				{ key: 'date', label: '日期', type: 'date', value: dateKey(new Date()) },
			],
			(values) => {
				const kind = values.kind === 'in' ? 'in' : 'out';
				const category = values.category || '其他';
				void s;
				s.ledger.push({
					id: genId(),
					date: values.date || dateKey(new Date()),
					kind,
					amount: parseAmount(values.amount) ?? 0,
					category,
					note: values.note || undefined,
				});
				this.plugin.store.scheduleSave();
				this.render();
			},
		).open();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}
