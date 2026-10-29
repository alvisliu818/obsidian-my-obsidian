/**
 * 场景二 清洗 — 列表合并（行级适配版）。
 *
 * 移植自 siyuan-doc-assist src/core/list-block-merge-core.ts，适配差异：
 * - 思源按"块"合并（多块 -> 一个列表块，其余块删除），此处按"行"合并：
 *   选区内的段落行转为列表项，既有列表行规范化 marker，嵌套列表行保留；
 * - 有序/无序由选区第一行非空列表行决定（`1. ` 开头即有序）；
 * - 代码块（```/~~~）内的行原样保留。
 */

import { isFenceLine } from "./cleanup-text";

export type ListMergeResult = {
	text: string;
	hasChanges: boolean;
	isOrdered: boolean;
	/** 段落组转为列表项的数量 */
	convertedParagraphGroups: number;
	/** marker 被规范化的既有列表行数 */
	normalizedListLines: number;
	/** 缩进为列表项续行的行数 */
	continuationLines: number;
	/** 删除的行数（空行 / 剪藏残留圆点行） */
	removedLines: number;
	resultItemCount: number;
};

const LIST_MARKER_REGEX = /^(\s*)([-+*]|\d+\.)\s+(.+)$/;
const BULLET_ONLY_REGEX = /^\s*[•·●]\s*$/;
const ORDERED_LINE_REGEX = /^\s*\d+\.\s/;

export function isOrderedListText(text: string): boolean {
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) continue;
		return ORDERED_LINE_REGEX.test(line);
	}
	return false;
}

function countListItems(lines: string[]): number {
	return lines.filter((line) => LIST_MARKER_REGEX.test(line)).length;
}

/**
 * 把选区文本合并为规范列表：
 * - 段落行 -> 列表项（组内第一行加 marker，其余行缩进为续行）；
 * - 顶格列表行 -> 规范化 marker（有序重编号 / 无序统一 `- `）；
 * - 缩进列表行 -> 保留原缩进与 marker；
 * - 空行与孤立圆点行（`•`）删除。
 */
export function mergeSelectionIntoList(text: string): ListMergeResult {
	const source = text || "";
	const lines = source.replace(/\r\n/g, "\n").split("\n");
	const isOrdered = isOrderedListText(source);

	let convertedParagraphGroups = 0;
	let normalizedListLines = 0;
	let continuationLines = 0;
	let removedLines = 0;
	const state = { index: 1 };
	const output: string[] = [];

	let inFence = false;
	let fenceChar = "";
	let fenceLen = 0;
	/** 上一输出行是否为段落组内的续行候选（即上一行是段落行） */
	let prevWasPlainLine = false;
	/** 当前段落组首行使用的 marker（决定续行缩进宽度） */
	let currentMarkerIndent = "";

	for (const rawLine of lines) {
		const line = rawLine.replace(/\s+$/, "");

		const fence = isFenceLine(line);
		if (fence) {
			const markerChar = fence.marker[0];
			if (!inFence) {
				inFence = true;
				fenceChar = markerChar;
				fenceLen = fence.length;
			} else if (markerChar === fenceChar && fence.length >= fenceLen) {
				inFence = false;
				fenceChar = "";
				fenceLen = 0;
			}
			output.push(line);
			prevWasPlainLine = false;
			continue;
		}
		if (inFence) {
			output.push(line);
			prevWasPlainLine = false;
			continue;
		}

		if (!line.trim()) {
			removedLines += 1;
			prevWasPlainLine = false;
			continue;
		}

		if (BULLET_ONLY_REGEX.test(line)) {
			removedLines += 1;
			prevWasPlainLine = false;
			continue;
		}

		const listMatch = line.match(LIST_MARKER_REGEX);
		if (listMatch) {
			const indent = listMatch[1] || "";
			const originalMarker = listMatch[2] || "-";
			const content = (listMatch[3] || "").trim();
			if (!indent) {
				const emitMarker = isOrdered ? `${state.index++}. ` : "- ";
				const normalized = `${emitMarker}${content}`;
				if (normalized !== line) {
					normalizedListLines += 1;
				}
				output.push(normalized);
				currentMarkerIndent = " ".repeat(emitMarker.length);
			} else {
				output.push(`${indent}${originalMarker} ${content}`);
				currentMarkerIndent = " ".repeat((indent + originalMarker + " ").length);
			}
			prevWasPlainLine = false;
			continue;
		}

		// 段落行：组内首行转为列表项，后续行缩进为续行
		if (!prevWasPlainLine) {
			const marker = isOrdered ? `${state.index++}. ` : "- ";
			output.push(`${marker}${line.trim()}`);
			currentMarkerIndent = " ".repeat(marker.length);
			convertedParagraphGroups += 1;
			prevWasPlainLine = true;
		} else {
			output.push(`${currentMarkerIndent}${line.trim()}`);
			continuationLines += 1;
		}
	}

	const next = output.join("\n");
	const hasChanges = next !== source;

	return {
		text: next,
		hasChanges,
		isOrdered,
		convertedParagraphGroups,
		normalizedListLines,
		continuationLines,
		removedLines,
		resultItemCount: countListItems(output),
	};
}
