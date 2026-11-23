/**
 * 原生编辑器实时预览：渲染**引述块内的列表**（2026-11-23 用户需求）。
 *
 * Obsidian 1.14.4 的 Live Preview 把 `> - 项` 整行只当引述行
 * （`.HyperMD-quote`），不产出列表行语义：`- ` 原样显示、没有圆点/序号与缩进
 * （CDP 实测；阅读视图与块编辑器静态渲染都正常，只有原生编辑器的实时预览缺）。
 * 这里用编辑器扩展在**视图层**补这一层：
 *   - 命中「引述前缀 + 列表标记 + 空白」的行，给标记字符套上 Obsidian 自己的
 *     `list-bullet` / `list-number` 类（主题圆点/序号，与普通列表同一套样式；
 *     标记仍是真文本，点击、光标、回车续列表的行为都和普通列表一致）；
 *   - 行上打 `vt-quote-list-line`（嵌套层级写进 data 属性），CSS 给缩进；
 *   - 文档一个字都不改，纯装饰，保存/往返零影响。
 *
 * 只在 Live Preview 生效；MD 编辑器自家的 CM 实例经 `mdEmojiBypass` 让位
 * （那边是单块编辑器，不需要整篇的引述列表渲染）。
 */

import { Decoration, EditorView, ViewPlugin, type DecorationSet, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { foldService } from '@codemirror/language';
import { RangeSetBuilder, type Extension } from '@codemirror/state';
import { editorLivePreviewField } from 'obsidian';
import { codeRangesInView, mdEmojiBypass } from './emojiShortcodes';

/** 一行引述列表的识别结果（偏移相对行首）。 */
export interface QuoteListHit {
	/** 列表标记（`-` / `*` / `+` / `1.` / `1)`）的起止。 */
	markerFrom: number;
	markerTo: number;
	/** 标记后的空白一并吃掉，避免 widget 后再多一个空格。 */
	markerEnd: number;
	/** 是否有序列表。 */
	ordered: boolean;
	/** 有序标记原文（`3.`），无序为空串。 */
	markerText: string;
	/** 嵌套层级：0 = 引述内第一层，1 = 再缩进一层…… */
	indentLevel: number;
}

/**
 * 识别 `> - 项`、`> 1. 项`、`>   - 嵌套项`、`>> - 双层引述项`。
 * 不匹配普通列表（没有 `>` 引述前缀）与普通引述行。
 */
export function scanQuoteListLine(text: string): QuoteListHit | null {
	const m = /^((?:>[ \t]?)+)([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+|$)/.exec(text);
	if (!m) return null;
	const quotePrefix = m[1];
	const quoteDepth = (quotePrefix.match(/>/g) ?? []).length;
	if (quoteDepth === 0) return null;
	const extra = m[2].replace(/\t/g, '  ');
	const marker = m[3];
	const ordered = /\d/.test(marker);
	const markerFrom = quotePrefix.length + m[2].length;
	return {
		markerFrom,
		markerTo: markerFrom + marker.length,
		markerEnd: markerFrom + marker.length + m[4].length,
		ordered,
		markerText: ordered ? marker : '',
		indentLevel: quoteDepth - 1 + Math.floor(extra.length / 2),
	};
}

/**
 * 引述行里「正文列」：引述前缀之后第一个非空白字符的列（tab 按 2 列）。
 * 非引述行返回 null；只有 `>` 的空引述行返回 +∞（视为子树内部，不终止折叠）。
 * 用来比较引述内列表/段落的缩进层级。
 */
export function quoteContentColumn(text: string): number | null {
	const prefix = /^(?:>[ \t]?)+/.exec(text);
	if (!prefix) return null;
	const rest = text.slice(prefix[0].length);
	const ws = /^[ \t]*/.exec(rest)?.[0] ?? '';
	const width = (s: string): number => s.replace(/\t/g, '  ').length;
	if (!rest.slice(ws.length)) return Number.POSITIVE_INFINITY;
	return width(prefix[0]) + width(ws);
}

/**
 * 从 `startIndex`（0 基）这一行引述列表项向后找出子树的最后一行；没有子行
 * 返回 -1。只统计仍在引述内、且正文列比当前项更深的行（嵌套列表、缩进续行、
 * 空引述行）；普通行或同级/更浅的引述行结束子树。
 */
export function quoteListFoldEnd(lineAt: (index: number) => string | null, startIndex: number): number {
	const text = lineAt(startIndex);
	if (text == null || !scanQuoteListLine(text)) return -1;
	const base = quoteContentColumn(text);
	if (base === null) return -1;
	let last = -1;
	for (let i = startIndex + 1; ; i++) {
		const next = lineAt(i);
		if (next == null) break;
		const col = quoteContentColumn(next);
		if (col === null || col <= base) break;
		last = i;
	}
	return last;
}

/**
 * 引述列表的折叠服务。Obsidian 的 Live Preview 折叠 UI（指示器、折叠态、
 * `…` 占位）统一走 `foldable()`/`foldService`，这里只提供引述列表项的子树
 * 范围，指示器与折叠行为即与普通列表一致。
 */
export const quoteListFoldService: Extension = foldService.of((state, lineStart) => {
	const line = state.doc.lineAt(lineStart);
	const endIndex = quoteListFoldEnd(
		(i) => (i < state.doc.lines ? state.doc.line(i + 1).text : null),
		line.number - 1,
	);
	if (endIndex < 0) return null;
	const last = state.doc.line(endIndex + 1);
	return last.to > line.to ? { from: line.to, to: last.to } : null;
});

/** 原生编辑器 Live Preview 的引述列表渲染扩展。 */
export const quoteListEditorExtension: Extension = ViewPlugin.fromClass(
	class implements PluginValue {
		decorations: DecorationSet = Decoration.none;
		constructor(view: EditorView) {
			this.compute(view);
		}
		update(u: ViewUpdate): void {
			// 视口/文档/选区变化、语法树长高、live-preview ↔ 源码模式切换
			// （后者只翻转 editorLivePreviewField）都要重算；只扫可视行，成本与
			// 文档大小解耦。
			this.compute(u.view);
		}
		private compute(view: EditorView): void {
			const livePreview = view.state.field(editorLivePreviewField, false);
			if (view.state.facet(mdEmojiBypass) || !livePreview) {
				this.decorations = Decoration.none;
				return;
			}
			const doc = view.state.doc;
			const codeRanges = codeRangesInView(view);
			const builder = new RangeSetBuilder<Decoration>();
			for (const vr of view.visibleRanges) {
				let pos = vr.from;
				while (pos <= vr.to) {
					const line = doc.lineAt(pos);
					const hit = scanQuoteListLine(line.text);
					if (hit && !codeRanges.some((c) => line.from < c.to && line.to > c.from)) {
						builder.add(
							line.from,
							line.from,
							Decoration.line({
								class: 'vt-quote-list-line',
								attributes: { 'data-vt-ql-indent': String(hit.indentLevel) },
							}),
						);
						// 直接复用 Obsidian 自己的列表标记类，而不是自造 widget：
						// `.list-bullet` 会把标记字符变透明、用 ::after 画主题圆点
						// （大小/颜色/形状与普通列表完全一致），`.list-number` 保留
						// 序号文本。标记仍是文档里的真文本——光标、点选、复制、
						// 回车续列表的行为都与普通列表一样，也没有 contenteditable
						// =false 的替换 widget 在点击时消失的问题。
						builder.add(
							line.from + hit.markerFrom,
							line.from + (hit.ordered ? hit.markerEnd : hit.markerTo),
							Decoration.mark({ class: hit.ordered ? 'list-number' : 'list-bullet' }),
						);
					}
					if (line.to >= vr.to) break;
					pos = line.to + 1;
				}
			}
			this.decorations = builder.finish();
		}
	},
	{ decorations: (v) => v.decorations },
);
