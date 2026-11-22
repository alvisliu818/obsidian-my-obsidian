/**
 * 库记录修改对比弹窗(2026-11-21 用户):点「对比」/库记录里点修改的文件打开
 * (2026-11-22 用户:嵌入编辑器的覆盖层区块退役,统一弹本弹窗——「定位对比弹
 * 窗」)。
 *
 * 两种视图(设置 vaultLog.diffViewMode,默认 list 保留原样):
 *   - list:行级 diff 列表(删除红/新增绿/修改蓝,行号+符号)
 *   - split:VSCode 式两栏对照——左=基线内容,右=当前内容,按 rows 对齐序列
 *     并排(ctx/del/mod/add),差异行着色,滚动比例联动
 *
 * 打开时**定位**到第一处修改(滚动到首个非 ctx 行)。footer:「打开原文件」
 * (跳原文件编辑,装点登记已退役仅跳转)、「撤回此文件到该记录前」。
 */
import { Modal, Notice, type App } from 'obsidian';
import type LifePlugin from './main';
import type { LineDiff } from './vaultLog';

interface SplitCell {
	no: number | null;
	text: string;
	kind: 'ctx' | 'del' | 'mod' | 'add' | 'empty';
}

/** rows(对齐序列) → 两栏行对。del 缓存与配对 mod 组一行;孤立 del/add 各占一侧。 */
function buildSplitPairs(diff: LineDiff): Array<{ l: SplitCell | null; r: SplitCell | null }> {
	const pairs: Array<{ l: SplitCell | null; r: SplitCell | null }> = [];
	let pendingDel: SplitCell | null = null;
	for (const r of diff.rows) {
		if (r.kind === 'ctx') {
			pairs.push({
				l: { no: r.beforeLine, text: r.text, kind: 'ctx' },
				r: { no: r.afterLine, text: r.text, kind: 'ctx' },
			});
		} else if (r.kind === 'del') {
			pendingDel = { no: r.beforeLine, text: r.text, kind: 'del' };
		} else if (r.kind === 'mod') {
			pairs.push({ l: pendingDel, r: { no: r.afterLine, text: r.text, kind: 'mod' } });
			pendingDel = null;
		} else {
			if (pendingDel) {
				pairs.push({ l: pendingDel, r: { no: r.afterLine, text: r.text, kind: 'add' } });
				pendingDel = null;
			} else {
				pairs.push({ l: null, r: { no: r.afterLine, text: r.text, kind: 'add' } });
			}
		}
	}
	if (pendingDel) pairs.push({ l: pendingDel, r: null });
	return pairs;
}

export class VaultLogDiffModal extends Modal {
	constructor(
		app: App,
		private plugin: LifePlugin,
		private path: string,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.titleEl.setText('修改对比');
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('vl-diff-modal');
		contentEl.createDiv({ cls: 'vl-diff-path', text: this.path });

		const diff = await this.plugin.getRecordDiff(this.path);
		if (!diff) {
			contentEl.createDiv({
				cls: 'vl-diff-empty',
				text: '该文件当前与上次提交(HEAD)一致(可能已撤回/已提交)。',
			});
			return;
		}

		const mode = this.plugin.store.settings.vaultLog?.diffViewMode === 'split' ? 'split' : 'list';
		if (mode === 'split') this.renderSplit(diff);
		else this.renderList(diff);
		this.renderFoot();
		this.revealFirstChange(mode);
	}

	/** 原视图:行级差异列表。 */
	private renderList(diff: LineDiff): void {
		const { contentEl } = this;
		const events: Array<{ line: number; kind: 'add' | 'mod' | 'del'; text: string }> = [
			...diff.added.map((l) => ({ line: l, kind: 'add' as const, text: '' })),
			...diff.modified.map((l) => ({ line: l, kind: 'mod' as const, text: '' })),
			...diff.deleted.map((d) => ({ line: d.line, kind: 'del' as const, text: d.text })),
		].sort((x, y) => x.line - y.line || (x.kind === 'del' ? -1 : 1));

		const list = contentEl.createDiv({ cls: 'vl-diff-list' });
		for (const ev of events) {
			const row = list.createDiv({ cls: `vl-diff-row is-${ev.kind}` });
			row.createSpan({ cls: 'vl-diff-lineno', text: String(ev.kind === 'del' ? Math.max(0, ev.line - 1) : ev.line) });
			row.createSpan({ cls: 'vl-diff-sign', text: ev.kind === 'add' ? '+' : ev.kind === 'mod' ? '~' : '-' });
			row.createSpan({ cls: 'vl-diff-text', text: ev.text });
		}
		if (events.length === 0) {
			list.createDiv({ cls: 'vl-diff-empty', text: '无差异。' });
		}
	}

	/** VSCode 式两栏对照(2026-11-22 用户):左=基线,右=当前,差异着色+滚动联动。 */
	private renderSplit(diff: LineDiff): void {
		const { contentEl } = this;
		const pairs = buildSplitPairs(diff);
		// 第一处修改(非 ctx/非空行)——revealFirstChange 用
		this.firstDiffIndex = pairs.findIndex(
			(p) => (p.l && p.l.kind !== 'ctx') || (p.r && p.r.kind !== 'ctx'),
		);
		const wrap = contentEl.createDiv({ cls: 'vl-diff-split' });
		const left = wrap.createDiv({ cls: 'vl-diff-pane is-before' });
		const right = wrap.createDiv({ cls: 'vl-diff-pane is-after' });
		for (const pair of pairs) {
			this.appendSplitRow(left, pair.l, 'l');
			this.appendSplitRow(right, pair.r, 'r');
		}
		// 滚动联动(比例同步——两侧内容行数不同,绝对值会漂移)
		let syncing = false;
		const link = (src: HTMLElement, dst: HTMLElement): void => {
			src.addEventListener('scroll', () => {
				if (syncing) return;
				syncing = true;
				const ratio = src.scrollTop / Math.max(1, src.scrollHeight - src.clientHeight);
				dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight);
				syncing = false;
			});
		};
		link(left, right);
		link(right, left);
	}

	private appendSplitRow(pane: HTMLElement, cell: SplitCell | null, side: 'l' | 'r'): void {
		const row = pane.createDiv({
			cls: 'vl-split-row ' + (cell ? `is-${cell.kind}` : 'is-empty') + (side === 'l' ? ' is-left' : ' is-right'),
		});
		row.createSpan({ cls: 'vl-split-no', text: cell?.no != null ? String(cell.no) : '' });
		row.createSpan({ cls: 'vl-split-text', text: cell ? cell.text || ' ' : ' ' });
	}

	private renderFoot(): void {
		const foot = this.contentEl.createDiv({ cls: 'vl-diff-foot' });
		// 「打开原文件」(2026-11-22 用户):对比看完直接跳原文件编辑。
		const openBtn = foot.createEl('button', { cls: 'life-home-rec-btn', text: '打开原文件' });
		openBtn.addEventListener('click', () => {
			void this.app.workspace.openLinkText(this.path, '', false);
			this.close();
		});
		const btn = foot.createEl('button', { cls: 'life-home-rec-btn', text: '撤回此文件到上次提交' });
		btn.addEventListener('click', async () => {
			const ok = await this.plugin.revertRecordFile(this.path);
			if (ok) {
				new Notice(`已撤回:${this.path} → 上次提交(HEAD)的内容`);
				this.close();
			} else {
				new Notice('撤回失败:git 模块未启用或文件不在仓库中');
			}
		});
	}

	/** 定位:滚动到第一处修改(list=第一个差异行;split=两栏首个差异行),加瞬时高亮。 */
	private revealFirstChange(mode: 'list' | 'split'): void {
		this.contentEl.scrollTo({ top: 0 });
		window.setTimeout(() => {
			if (mode === 'list') {
				const first = this.contentEl.querySelector<HTMLElement>('.vl-diff-list .vl-diff-row');
				if (first) {
					first.scrollIntoView({ block: 'center' });
					first.addClass('is-revealed');
					window.setTimeout(() => first.removeClass('is-revealed'), 1200);
				}
				return;
			}
			const panes = [...this.contentEl.querySelectorAll<HTMLElement>('.vl-diff-pane')];
			const idx = this.firstDiffIndex ?? 0;
			for (const pane of panes) {
				const row = pane.querySelectorAll<HTMLElement>('.vl-split-row')[idx];
				if (row) {
					pane.scrollTop = Math.max(0, row.offsetTop - pane.clientHeight / 3);
				}
			}
		}, 60);
	}

	/** 第一处修改在 pairs 里的索引(split 用);null = list 模式。 */
	private firstDiffIndex: number | null = null;

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}
}
