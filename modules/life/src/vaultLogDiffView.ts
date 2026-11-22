/**
 * 库记录修改对比视图(2026-11-22 用户:弹窗升级为标签页——VSCode 同款文件
 * 分栏对照,支持上下跳转差异)。
 *
 * 顶部工具栏:文件名 + 基线徽标 + 路径;右侧「上一处 / 第 n / m 处 / 下一处」
 * 跳转组 + 刷新 / 打开原文件 / 撤回。主体两栏按 rows 对齐序列并排:左=基线,
 * 右=当前,行号 + 红删/绿增/蓝改,单侧缺行用斜纹占位;两栏滚动联动。跳转单位
 * = 连续非上下文行组成的一处差异,跳到该处首行并加当前高亮。
 *
 * 视图固定两栏对照(全文,含未改动的上下文),跳转单位 = 连续非上下文行。
 * 行内容按文件类型渲染:.md 默认行内 Markdown(顶部按钮可切 Monaco 源码着色),
 * 代码文件用 Monaco colorize 着色。
 * 数据源 = LifePlugin.getRecordDiff(基线 git HEAD / 上次库记录时点)。
 */
import { ItemView, Notice, setIcon, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import type LifePlugin from './main';
import type { LineDiff } from './vaultLog';
import { renderFileLines } from './lineRender';
import { colorizeCode, getLanguageByPath, setupMonaco } from '../../code-editor/src/editor/monaco';

export const VIEW_LIFE_DIFF = 'life-vault-diff';

interface SplitCell {
	no: number | null;
	text: string;
	kind: 'ctx' | 'del' | 'mod' | 'add';
}

interface SplitPair {
	l: SplitCell | null;
	r: SplitCell | null;
}

/** rows(对齐序列) → 两栏行对。del 缓存与配对 mod 组一行;孤立 del/add 各占一侧。 */
function buildSplitPairs(diff: LineDiff): SplitPair[] {
	const pairs: SplitPair[] = [];
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

const isCtxPair = (p: SplitPair): boolean => p.l?.kind === 'ctx' && p.r?.kind === 'ctx';

/** 从 diff.rows 还原两栏全文行数组(按各自行号落位)。 */
function paneLines(diff: LineDiff): { before: string[]; after: string[] } {
	const before: string[] = new Array<string>(diff.beforeLines).fill('');
	const after: string[] = new Array<string>(diff.afterLines).fill('');
	for (const r of diff.rows) {
		if (r.beforeLine != null) before[r.beforeLine - 1] = r.text;
		if (r.afterLine != null) after[r.afterLine - 1] = r.text;
	}
	return { before, after };
}

/** 连续非上下文行 = 一处差异;返回每处首行的 pair 下标。 */
function hunkStartsOf(pairs: SplitPair[]): number[] {
	const starts: number[] = [];
	for (let i = 0; i < pairs.length; i++) {
		if (isCtxPair(pairs[i])) continue;
		if (i === 0 || isCtxPair(pairs[i - 1])) starts.push(i);
	}
	return starts;
}

export class VaultLogDiffView extends ItemView {
	private path = '';
	private pairs: SplitPair[] = [];
	private hunkStarts: number[] = [];
	private hunkIdx = -1;
	private leftRows: Array<HTMLElement | null> = [];
	private rightRows: Array<HTMLElement | null> = [];
	private leftScroll: HTMLElement | null = null;
	private rightScroll: HTMLElement | null = null;
	private prevBtn: HTMLButtonElement | null = null;
	private nextBtn: HTMLButtonElement | null = null;
	private counterEl: HTMLElement | null = null;

	constructor(
		leaf: WorkspaceLeaf,
		private plugin: LifePlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_LIFE_DIFF;
	}

	getDisplayText(): string {
		const name = this.path.split('/').pop() ?? '';
		return name ? `${name} (${this.baselineShort()})` : '修改对比';
	}

	getIcon(): string {
		return 'diff';
	}

	getState(): Record<string, unknown> {
		return { path: this.path };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		const s = (state ?? {}) as { path?: string };
		if (typeof s.path === 'string' && s.path) this.path = s.path;
		await super.setState(state, result);
		this.refreshTabTitle();
		await this.render();
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass('vl-diff-view');
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	/** 外部(文件保存/撤回等)触发的重读。 */
	async refresh(): Promise<void> {
		await this.render();
	}

	/** 标签页标题:文件名 + 基线(工作树 / 上次记录)。视图标题栏缓存了挂载时
	 *  的文案,setState 后主动写一次(参考 momentum 的同款处理)。 */
	private refreshTabTitle(): void {
		const update = (): void => {
			const leaf = this.leaf as unknown as { updateHeader?: () => void; tabHeaderInnerTitleEl?: HTMLElement };
			leaf.updateHeader?.();
			if (leaf.tabHeaderInnerTitleEl) leaf.tabHeaderInnerTitleEl.textContent = this.getDisplayText();
		};
		update();
		window.setTimeout(update, 50);
	}

	private isRecordBaseline(): boolean {
		return this.plugin.store.settings.vaultLog?.diffBaseline === 'record';
	}

	/** 徽标 / 标签页标题用的短基线名。 */
	private baselineShort(): string {
		return this.isRecordBaseline() ? '上次记录' : '工作树';
	}

	/** 工具栏与空态说明用的长基线名。 */
	private baselineLong(): string {
		return this.isRecordBaseline() ? '上次库记录时点' : '上次提交(HEAD)';
	}

	/** Markdown 文件的渲染方式(2026-11-22 用户):editor = 行内渲染;monaco = Monaco 源码着色。 */
	private mdMode(): 'editor' | 'monaco' {
		return this.plugin.store.settings.vaultLog?.mdDiffRender === 'monaco' ? 'monaco' : 'editor';
	}

	private isMarkdownFile(): boolean {
		return /\.md$/i.test(this.path);
	}

	private async render(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('vl-diff-view');
		if (!this.path) {
			contentEl.createDiv({ cls: 'vl-diff-empty', text: '没有指定要对比的文件。' });
			return;
		}
		this.refreshTabTitle();

		const diff = await this.plugin.getRecordDiff(this.path);
		this.pairs = diff ? buildSplitPairs(diff) : [];
		this.hunkStarts = diff ? hunkStartsOf(this.pairs) : [];
		this.leftRows = [];
		this.rightRows = [];
		this.leftScroll = null;
		this.rightScroll = null;
		this.hunkIdx = -1;
		this.prevBtn = null;
		this.nextBtn = null;
		this.counterEl = null;

		// ---- 工具栏 ----
		const bar = contentEl.createDiv({ cls: 'vl-diff-bar' });
		const main = bar.createDiv({ cls: 'vl-diff-bar-main' });
		main.createSpan({ cls: 'vl-diff-bar-name', text: this.path.split('/').pop() ?? this.path });
		main.createSpan({ cls: 'vl-diff-chip', text: this.baselineShort() });
		const pathEl = main.createSpan({ cls: 'vl-diff-bar-path', text: this.path });
		pathEl.setAttr('title', this.path);
		bar.createDiv({ cls: 'vl-diff-bar-spacer' });

		if (diff && this.hunkStarts.length > 0) {
			const nav = bar.createDiv({ cls: 'vl-diff-bar-group' });
			this.prevBtn = nav.createEl('button', { cls: 'vl-diff-bar-btn', attr: { 'aria-label': '上一处差异' } });
			setIcon(this.prevBtn, 'arrow-up');
			this.counterEl = nav.createSpan({ cls: 'vl-diff-count', text: '' });
			this.nextBtn = nav.createEl('button', { cls: 'vl-diff-bar-btn', attr: { 'aria-label': '下一处差异' } });
			setIcon(this.nextBtn, 'arrow-down');
			this.prevBtn.addEventListener('click', () => this.gotoHunk(this.hunkIdx - 1));
			this.nextBtn.addEventListener('click', () => this.gotoHunk(this.hunkIdx + 1));
		}

		// Markdown 渲染方式切换(2026-11-22 用户:差异视图内加按钮)
		if (diff && this.isMarkdownFile()) {
			const modeBtn = bar.createEl('button', {
				cls: 'vl-diff-bar-btn vl-diff-mode-btn',
				attr: { title: '切换 Markdown 渲染方式（行内渲染 / Monaco 源码）' },
			});
			modeBtn.setText(this.mdMode() === 'monaco' ? 'Monaco' : '渲染');
			modeBtn.addEventListener('click', () => this.setMdMode(this.mdMode() === 'monaco' ? 'editor' : 'monaco'));
		}

		const actions = bar.createDiv({ cls: 'vl-diff-bar-group' });
		this.actionButton(actions, 'refresh-cw', '刷新对比', () => void this.render());
		this.actionButton(actions, 'file-text', '打开原文件', () => {
			void this.app.workspace.openLinkText(this.path, '', false);
		});
		this.actionButton(actions, 'undo-2', '撤回此文件到基线内容', async () => {
			const ok = await this.plugin.revertRecordFile(this.path);
			if (ok) await this.render();
			else new Notice('撤回失败:没有可用基线或文件不在库内');
		});

		if (!diff) {
			const empty = contentEl.createDiv({ cls: 'vl-diff-empty' });
			empty.createDiv({ text: `当前内容与${this.baselineLong()}一致,没有可对比的差异。` });
			const open = empty.createEl('button', { cls: 'mod-cta', text: '打开原文件' });
			open.addEventListener('click', () => void this.app.workspace.openLinkText(this.path, '', false));
			return;
		}

		await this.renderSplit(diff);
	}

	/** 切换 Markdown 渲染方式并重绘(设置持久化,下次打开沿用)。 */
	private setMdMode(mode: 'editor' | 'monaco'): void {
		const settings = this.plugin.store.settings;
		if (!settings.vaultLog) {
			settings.vaultLog = { enabled: true, dailyTime: '21:00', periodMin: 0, remind: true, remindTime: '' };
		}
		settings.vaultLog.mdDiffRender = mode;
		this.plugin.store.scheduleSave();
		void this.render();
	}

	/** 工具栏动作按钮(图标 + aria-label;hover 提示走 title)。 */
	private actionButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const btn = parent.createEl('button', { cls: 'vl-diff-bar-btn', attr: { 'aria-label': label, title: label } });
		setIcon(btn, icon);
		btn.addEventListener('click', onClick);
	}

	/** VSCode 式分栏:左基线 / 右当前,按对齐序列逐行并排(内容按类型渲染)。 */
	private async renderSplit(diff: LineDiff): Promise<void> {
		// Monaco colorize 依赖运行时初始化(worker/主题 CSS);失败则退化为纯文本
		try {
			setupMonaco(this.plugin);
		} catch {
			/* 无 Monaco 环境 */
		}
		const split = this.contentEl.createDiv({ cls: 'vl-diff-split' });
		const left = this.makePane(split, `基线 · ${this.baselineLong()}`, diff.beforeLines);
		const right = this.makePane(split, '当前', diff.afterLines);
		const { before, after } = paneLines(diff);
		const opts = {
			mdMode: this.mdMode(),
			colorize: colorizeCode,
			languageId: this.isMarkdownFile() ? null : getLanguageByPath(this.path),
		};
		const [leftHtml, rightHtml] = await Promise.all([
			renderFileLines(this.path, before, opts),
			renderFileLines(this.path, after, opts),
		]);

		for (let i = 0; i < this.pairs.length; i++) {
			const pair = this.pairs[i];
			this.leftRows.push(this.appendRow(left.scroll, pair.l, leftHtml));
			this.rightRows.push(this.appendRow(right.scroll, pair.r, rightHtml));
		}
		this.leftScroll = left.scroll;
		this.rightScroll = right.scroll;
		this.linkScroll(left.scroll, right.scroll);
		if (this.hunkStarts.length > 0) {
			// 布局收敛后再跳(刚挂载时 offsetTop 还没算出来)
			window.setTimeout(() => this.gotoHunk(0, true), 60);
		} else {
			this.updateNav(0);
		}
	}

	private makePane(
		parent: HTMLElement,
		title: string,
		lineCount: number,
	): { pane: HTMLElement; scroll: HTMLElement } {
		const pane = parent.createDiv({ cls: 'vl-diff-pane' });
		const head = pane.createDiv({ cls: 'vl-diff-pane-head' });
		head.createSpan({ cls: 'vl-diff-pane-title', text: title });
		head.createSpan({ cls: 'vl-diff-pane-meta', text: `${lineCount} 行` });
		const scroll = pane.createDiv({ cls: 'vl-diff-scroll' });
		return { pane, scroll };
	}

	private appendRow(scroll: HTMLElement, cell: SplitCell | null, htmlLines: string[]): HTMLElement {
		const row = scroll.createDiv({
			cls: 'vl-split-row ' + (cell ? `is-${cell.kind}` : 'is-empty'),
		});
		row.createSpan({ cls: 'vl-split-no', text: cell?.no != null ? String(cell.no) : '' });
		const textEl = row.createSpan({ cls: 'vl-split-text' });
		const html = cell && cell.no != null ? htmlLines[cell.no - 1] : '';
		// html 来自 lineRender(文本全部转义);空内容保留一个空格占行高
		textEl.innerHTML = html || ' ';
		return row;
	}

	/** 两栏行数/行高一致,滚动位置直接同步(VSCode 同款联动)。 */
	private linkScroll(a: HTMLElement, b: HTMLElement): void {
		let syncing = false;
		const link = (src: HTMLElement, dst: HTMLElement): void => {
			src.addEventListener('scroll', () => {
				if (syncing) return;
				syncing = true;
				dst.scrollTop = src.scrollTop;
				syncing = false;
			});
		};
		link(a, b);
		link(b, a);
	}

	/** 跳到第 idx 处差异:两栏滚到该处首行,高亮整块,更新计数与按钮状态。 */
	private gotoHunk(idx: number, instant = false): void {
		const total = this.hunkStarts.length;
		if (total === 0) {
			this.updateNav(0);
			return;
		}
		const i = Math.max(0, Math.min(total - 1, idx));
		this.hunkIdx = i;
		for (const rows of [this.leftRows, this.rightRows]) {
			for (const el of rows) el?.removeClass('is-current');
		}
		const start = this.hunkStarts[i];
		let end = i + 1 < total ? this.hunkStarts[i + 1] : this.pairs.length;
		// 下一处差异前的上下文行不属于本处(高亮只罩真正变化行)
		for (let k = start + 1; k < end; k++) {
			if (isCtxPair(this.pairs[k])) {
				end = k;
				break;
			}
		}
		for (let k = start; k < end; k++) {
			this.leftRows[k]?.addClass('is-current');
			this.rightRows[k]?.addClass('is-current');
		}
		this.scrollToRow(this.leftScroll, this.leftRows[start], instant);
		this.scrollToRow(this.rightScroll, this.rightRows[start], instant);
		this.updateNav(i);
	}

	private scrollToRow(scroll: HTMLElement | null, row: HTMLElement | null, instant: boolean): void {
		if (!scroll || !row) return;
		scroll.scrollTo({ top: Math.max(0, row.offsetTop - 8), behavior: instant ? 'auto' : 'smooth' });
	}

	private updateNav(idx: number): void {
		const total = this.hunkStarts.length;
		if (this.counterEl) this.counterEl.setText(total ? `第 ${idx + 1} / ${total} 处差异` : '无差异');
		if (this.prevBtn) this.prevBtn.disabled = total === 0 || idx <= 0;
		if (this.nextBtn) this.nextBtn.disabled = total === 0 || idx >= total - 1;
	}
}
