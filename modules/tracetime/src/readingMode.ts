import { MarkdownPostProcessorContext } from "obsidian";
import { BlockType } from "./blocks";
import { formatTimestamp } from "./format";
import type { Tracker } from "./tracker";
import type { TraceTimeSettings } from "./settings";

function lineOf(lineStarts: number[], offset: number): number {
	let lo = 0;
	let hi = lineStarts.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (lineStarts[mid] <= offset) lo = mid + 1;
		else hi = mid;
	}
	return lo - 1;
}

/**
 * 阅读模式显示：每个 section 一个 overlay 浮层，时间标签绝对定位，
 * 不侵入正文 DOM。块与渲染元素的对应是近似匹配（按顺序配对
 * section 行范围内的块与顶层子元素），对常规文档足够准确。
 */
export function createReadingPostProcessor(tracker: Tracker, getSettings: () => TraceTimeSettings) {
	return (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
		const st = tracker.getState(ctx.sourcePath);
		if (!st) {
			// 状态是异步加载的：触发建索引，完成后由 refreshViews 触发重渲染
			tracker.ensureFile(ctx.sourcePath);
			return;
		}
		const info = ctx.getSectionInfo(el);
		if (!info) return;
		const lineStarts = tracker.getLineStarts(st);
		if (!lineStarts) return;

		const blocks = st.index.blocks.filter((b) => {
			if (b.type === BlockType.Frontmatter) return false;
			const line = lineOf(lineStarts, b.from);
			return line >= info.lineStart && line <= info.lineEnd;
		});
		if (blocks.length === 0) return;

		el.addClass("tracetime-section");
		const overlay = el.createDiv({ cls: "tracetime-overlay" });
		overlay.toggleClass("tracetime-compact", getSettings().compactLabels);
		const elRect = el.getBoundingClientRect();

		const children = Array.from(el.children).filter(
			(c): c is HTMLElement => c.instanceOf(HTMLElement) && c !== overlay
		);
		let bi = 0;
		const vertical = getSettings().labelVertical;
		for (const child of children) {
			if (bi >= blocks.length) break;
			const b = blocks[bi++];
			const label = overlay.createDiv({ cls: "tracetime-label" });
			label.createSpan({ cls: "tracetime-label-dot" });
			label.createSpan({ cls: "tracetime-label-text", text: formatTimestamp(b.modifiedAt, getSettings()) });
			// 垂直锚点：首行/末行取该行行内居中（行高近似），中间取整个块的垂直居中
			const r = child.getBoundingClientRect();
			const lineHeight = parseFloat(getComputedStyle(child).lineHeight) || 18;
			const relTop = r.top - elRect.top;
			const top =
				vertical === "middle"
					? relTop + r.height / 2
					: vertical === "end"
						? relTop + r.height - lineHeight / 2
						: relTop + lineHeight / 2;
			label.style.top = `${top}px`;
		}
	};
}
