/**
 * 场景二 清洗 — 删区间（行级适配版）。
 *
 * 移植自 siyuan-doc-assist：
 * - 断尾求真：findDeleteFromCurrentBlockIds —— 从当前块（含）删除到文档末尾；
 * - 删前段：findDeleteFromStartToCurrentBlockIds —— 从正文起点（或保护分隔线之后）
 *   删除到当前段落末行（含当前段落）。
 *
 * 适配差异：
 * - 思源块索引 -> Markdown 行模型：以"段落"为单元（向上/向下按块边界扩展）；
 * - frontmatter（文档开头 --- 包裹区）视为保护内容，永不删除；
 * - OPENING_SEPARATOR_WINDOW=10：frontmatter 之后的前 10 行内从后往前找 `---`
 *   分隔线，找到则从分隔线之后开始删（分隔线与文首信息保留）。
 */

export type DeleteRangeResult = {
	/** 变换后的完整文本 */
	text: string;
	/** 删除起始行号（基于原文，0 起） */
	deletedFromLine: number;
	/** 删除结束行号（含，基于原文）；无删除时为 -1 */
	deletedToLine: number;
	deletedLineCount: number;
	/** 删前段：命中的保护分隔线行号（未找到为 null） */
	separatorLineIndex: number | null;
};

const OPENING_SEPARATOR_WINDOW = 10;
const ATX_HEADING_REGEX = /^#{1,6}\s/;
const LIST_ITEM_REGEX = /^\s*(?:[-+*]|\d+\.)\s+/;
const QUOTE_LINE_REGEX = /^\s*>/;
const FENCE_LINE_REGEX = /^\s*(?:`{3,}|~{3,})/;
const SEPARATOR_LINE_REGEX = /^\s*-{3,}\s*$/;

export const EMPTY_DELETE_RANGE_RESULT: DeleteRangeResult = {
	text: "",
	deletedFromLine: -1,
	deletedToLine: -1,
	deletedLineCount: 0,
	separatorLineIndex: null,
};

/** 返回 frontmatter 闭合 `---` 的行号；无 frontmatter 返回 null。 */
export function findFrontmatterEndLineIndex(lines: string[]): number | null {
	if (lines.length < 2) return null;
	if (lines[0].trim() !== "---") return null;
	for (let i = 1; i < lines.length; i++) {
		if (lines[i].trim() === "---") {
			return i;
		}
	}
	return null;
}

function isBlockBoundaryLine(line: string): boolean {
	if (!line.trim()) return true;
	return (
		ATX_HEADING_REGEX.test(line) ||
		FENCE_LINE_REGEX.test(line) ||
		LIST_ITEM_REGEX.test(line) ||
		QUOTE_LINE_REGEX.test(line) ||
		SEPARATOR_LINE_REGEX.test(line)
	);
}

/**
 * 当前光标行所在段落的起始行：
 * 从 currentIndex 向上扩展，直到上一行是空行 / 标题 / 围栏 / 列表项 / 引用 / 分隔线。
 */
export function findParagraphStartLine(lines: string[], currentIndex: number): number {
	let start = Math.max(0, Math.min(currentIndex, lines.length - 1));
	while (start > 0 && !isBlockBoundaryLine(lines[start - 1])) {
		start -= 1;
	}
	return start;
}

/**
 * 当前光标行所在段落的结束行：
 * 从 currentIndex 向下扩展，直到下一行是空行 / 标题 / 围栏 / 列表项 / 引用 / 分隔线。
 */
export function findParagraphEndLine(lines: string[], currentIndex: number): number {
	let end = Math.max(0, Math.min(currentIndex, lines.length - 1));
	while (end < lines.length - 1 && !isBlockBoundaryLine(lines[end + 1])) {
		end += 1;
	}
	return end;
}

/**
 * 断尾求真：从当前段落（含）删除到文档末尾。
 */
export function buildDeleteFromCurrentToEnd(text: string, currentLineIndex: number): DeleteRangeResult {
	const lines = (text || "").replace(/\r\n/g, "\n").split("\n");
	if (!lines.length) {
		return { ...EMPTY_DELETE_RANGE_RESULT, text: text || "" };
	}

	const frontmatterEnd = findFrontmatterEndLineIndex(lines);
	const paragraphStart = findParagraphStartLine(lines, currentLineIndex);
	const deleteStart = Math.max(paragraphStart, frontmatterEnd === null ? 0 : frontmatterEnd + 1);
	if (deleteStart > lines.length - 1) {
		return { ...EMPTY_DELETE_RANGE_RESULT, text: text || "" };
	}

	const deletedFromLine = deleteStart;
	const deletedToLine = lines.length - 1;
	const next = lines.slice(0, deleteStart).join("\n");

	return {
		text: next,
		deletedFromLine,
		deletedToLine,
		deletedLineCount: deletedToLine - deletedFromLine + 1,
		separatorLineIndex: null,
	};
}

/**
 * 删前段：从正文起点（或保护分隔线之后）删除到当前段落末行（含当前段落）。
 * - frontmatter 永不删除；
 * - frontmatter 之后前 OPENING_SEPARATOR_WINDOW 行内从后往前找 `---` 分隔线，
 *   找到则分隔线保留、从其下一行开始删。
 */
export function buildDeleteFromStartToCurrent(text: string, currentLineIndex: number): DeleteRangeResult {
	const lines = (text || "").replace(/\r\n/g, "\n").split("\n");
	if (!lines.length) {
		return { ...EMPTY_DELETE_RANGE_RESULT, text: text || "" };
	}

	const frontmatterEnd = findFrontmatterEndLineIndex(lines);
	let deleteStart = frontmatterEnd === null ? 0 : frontmatterEnd + 1;

	// 光标落在 frontmatter 内时拒绝删除（防御）
	if (frontmatterEnd !== null && currentLineIndex <= frontmatterEnd) {
		return { ...EMPTY_DELETE_RANGE_RESULT, text: text || "" };
	}

	let separatorLineIndex: number | null = null;
	const windowEnd = Math.min(deleteStart + OPENING_SEPARATOR_WINDOW, currentLineIndex);
	for (let i = windowEnd - 1; i >= deleteStart; i--) {
		if (SEPARATOR_LINE_REGEX.test(lines[i]) && i < currentLineIndex) {
			separatorLineIndex = i;
			deleteStart = i + 1;
			break;
		}
	}

	const paragraphEnd = findParagraphEndLine(lines, currentLineIndex);
	if (deleteStart > paragraphEnd) {
		return { ...EMPTY_DELETE_RANGE_RESULT, text: text || "" };
	}

	const deletedFromLine = deleteStart;
	const deletedToLine = paragraphEnd;
	const next = [...lines.slice(0, deleteStart), ...lines.slice(paragraphEnd + 1)].join("\n");

	return {
		text: next,
		deletedFromLine,
		deletedToLine,
		deletedLineCount: deletedToLine - deletedFromLine + 1,
		separatorLineIndex,
	};
}
