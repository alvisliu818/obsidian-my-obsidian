/**
 * 库记录修改对比的覆盖层 DOM 构建器(2026-11-22 用户:VSCode 那样的弹层——
 * 插入在修改行下方,红删/绿增/双行号,头部带撤回/关闭)。
 *
 * 中性层:monaco 视图(视图区)与原生 CM6(块 widget)各自调用本构建器出 DOM,
 * 不 import 任何编辑器实现。行为:撤回/关闭走回调(由调用方注入)。
 */

export interface DiffOverlayRow {
	/** before 行号(1-based);新增行 = null */
	bl: number | null;
	/** after 行号(1-based);删除行 = null */
	al: number | null;
	/** ctx = 上下文 / add = 新增(绿) / mod = 修改(蓝) / del = 删除(红) */
	k: 'ctx' | 'add' | 'mod' | 'del';
	t: string;
}

export interface DiffOverlayOpts {
	/** 头部标题(文件名) */
	title: string;
	/** 副标题(如「与上次提交(HEAD)比」) */
	sub?: string;
	rows: DiffOverlayRow[];
	onRevert: () => void;
	onClose: () => void;
}

const KIND_SIGN: Record<DiffOverlayRow['k'], string> = { ctx: ' ', add: '+', mod: '~', del: '-' };
const KIND_CLASS: Record<DiffOverlayRow['k'], string> = {
	ctx: 'is-ctx',
	add: 'is-add',
	mod: 'is-mod',
	del: 'is-del',
};

/** 构建覆盖层 DOM(头部 + 行列表)。样式类 lgp-diff-overlay-*(CSS 在 styles.css)。 */
export function buildDiffOverlayDom(opts: DiffOverlayOpts): HTMLElement {
	const root = document.createElement('div');
	root.className = 'lgp-diff-overlay';

	const head = root.createDiv({ cls: 'lgp-diff-overlay-head' });
	head.createSpan({ cls: 'lgp-diff-overlay-brand', text: 'Git 本地更改(工作树)' });
	head.createSpan({ cls: 'lgp-diff-overlay-title', text: opts.title });
	head.createSpan({ cls: 'lgp-diff-overlay-flex' });
	const revertBtn = head.createEl('button', {
		cls: 'lgp-diff-overlay-btn',
		attr: { 'aria-label': '撤回此文件到基线内容' },
	});
	revertBtn.setText('撤回');
	revertBtn.addEventListener('click', (ev) => {
		ev.stopPropagation();
		opts.onRevert();
	});
	const closeBtn = head.createEl('button', {
		cls: 'lgp-diff-overlay-btn lgp-diff-overlay-close',
		attr: { 'aria-label': '关闭对比视图' },
	});
	closeBtn.setText('×');
	closeBtn.addEventListener('click', (ev) => {
		ev.stopPropagation();
		opts.onClose();
	});

	const rowsEl = root.createDiv({ cls: 'lgp-diff-overlay-rows' });
	for (const row of opts.rows) {
		const rowEl = rowsEl.createDiv({ cls: `lgp-diff-overlay-row ${KIND_CLASS[row.k]}` });
		rowEl.createSpan({ cls: 'lgp-diff-overlay-no', text: row.bl === null ? '' : String(row.bl) });
		rowEl.createSpan({ cls: 'lgp-diff-overlay-no', text: row.al === null ? '' : String(row.al) });
		rowEl.createSpan({ cls: 'lgp-diff-overlay-sign', text: KIND_SIGN[row.k] });
		rowEl.createSpan({ cls: 'lgp-diff-overlay-text', text: row.t || ' ' });
	}
	if (opts.rows.length === 0) {
		rowsEl.createDiv({ cls: 'lgp-diff-overlay-empty', text: '无差异。' });
	}
	return root;
}
