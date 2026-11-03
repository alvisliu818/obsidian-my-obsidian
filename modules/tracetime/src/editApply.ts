import type { ChangeSet, Text } from "@codemirror/state";
import { makeBlockId, parseBlocks, LIST_RE } from "./blocks";
import { BlockIndex, BlockTimes, reconcileBlocks, seedHistory } from "./blockIndex";

const MAX_WINDOW_BYTES = 32 * 1024; // 增量窗口最大扩展
const FENCE_SCAN_LINES = 2000; // 围栏状态回溯扫描上限

function isFenceLine(text: string): boolean {
	const t = text.trimStart();
	return t.startsWith("```") || t.startsWith("~~~");
}

/**
 * 编辑窗口扩展：从变更范围向前后扩到空行/结构边界；
 * 处于代码围栏内则扩到完整围栏；覆盖 frontmatter 则扩到完整 frontmatter。
 */
export function expandEditWindow(doc: Text, from: number, to: number): { from: number; to: number } {
	let startLine = doc.lineAt(from).number;
	let endLine = doc.lineAt(to).number;

	const sizeOk = () => doc.line(endLine).to - doc.line(startLine).from < MAX_WINDOW_BYTES;

	// 大纲列表（Logseq md）没有空行分隔：列表行同样是块边界，
	// 否则无空行文档的每次编辑都会把窗口扩到整个文件。
	const atBoundary = (text: string) => text.trim() === "" || LIST_RE.test(text);

	while (startLine > 1 && !atBoundary(doc.line(startLine - 1).text) && sizeOk()) startLine--;
	while (endLine < doc.lines && !atBoundary(doc.line(endLine + 1).text) && sizeOk()) endLine++;

	// 窗口起点处于围栏内：扩到完整代码块
	let inside = 0;
	const scanFrom = Math.max(1, startLine - FENCE_SCAN_LINES);
	for (let l = scanFrom; l < startLine; l++) {
		if (isFenceLine(doc.line(l).text)) inside ^= 1;
	}
	if (inside === 1) {
		let l = startLine - 1;
		while (l >= scanFrom && !isFenceLine(doc.line(l).text)) l--;
		if (l >= 1) startLine = l;
		let e = endLine;
		while (e < doc.lines && !isFenceLine(doc.line(e).text)) e++;
		endLine = Math.min(e, doc.lines);
	} else {
		// 窗口内部围栏不平衡：向后扩到闭合
		let balance = 0;
		for (let l = startLine; l <= endLine; l++) {
			if (isFenceLine(doc.line(l).text)) balance ^= 1;
		}
		while (balance === 1 && endLine < doc.lines) {
			endLine++;
			if (isFenceLine(doc.line(endLine).text)) balance ^= 1;
		}
	}

	// frontmatter：重叠即扩到完整 frontmatter
	if (doc.line(1).text.trim() === "---") {
		let fm = 2;
		while (fm <= doc.lines && doc.line(fm).text.trim() !== "---") fm++;
		if (fm <= doc.lines && startLine <= fm) {
			startLine = 1;
			endLine = Math.max(endLine, fm);
		}
	}

	return { from: doc.line(startLine).from, to: doc.line(endLine).to };
}

/**
 * 编辑器内增量更新路径（每次按键走这里，目标 P95 < 2ms）：
 * ChangeSet → 扩展窗口 → 只重解析窗口 → 替换索引区间 → 标记脏块。
 *
 * 新文档窗口映回旧文档范围必须走 changes.invert(startDoc)——
 * 直接用 mapPos 正方向映射会把新坐标当旧坐标用，编辑发生在文档末尾、
 * 窗口右缘超出旧文档长度时抛 RangeError（曾导致索引损坏、标签全消失）。
 * 返回是否有块时间戳被刷新（供调用方决定标脏）。
 */
export function applyEditToIndex(
	st: { index: BlockIndex; history: Map<bigint, BlockTimes> },
	startDoc: Text,
	doc: Text,
	changes: ChangeSet,
	nowMin: number
): boolean {
	let newFrom = Number.MAX_SAFE_INTEGER;
	let newTo = 0;
	changes.iterChanges((_fA, _tA, fB, tB) => {
		if (fB < newFrom) newFrom = fB;
		if (tB > newTo) newTo = tB;
	});
	if (newFrom > newTo) return false;

	let win = expandEditWindow(doc, newFrom, newTo);
	const inv = changes.invert(startDoc);
	let oldFrom = inv.mapPos(win.from, -1);
	let oldTo = inv.mapPos(win.to, -1);

	// 吞并部分重叠的块，保证索引一致性
	const overlapped = st.index.queryOverlapping(oldFrom, oldTo);
	if (overlapped.length > 0) {
		const first = overlapped[0];
		const last = overlapped[overlapped.length - 1];
		if (first.from < oldFrom) oldFrom = first.from;
		if (last.to > oldTo) oldTo = last.to;
		win = { from: changes.mapPos(oldFrom, 1), to: changes.mapPos(oldTo, 1) };
	}

	const parsed = parseBlocks(doc.sliceString(win.from, win.to), win.from, nowMin, makeBlockId);
	const removed = st.index.queryOverlapping(oldFrom, oldTo);
	const merged = reconcileBlocks(removed, parsed, nowMin, st.history);

	const delta = win.to - win.from - (oldTo - oldFrom);
	st.index.replaceWindow(oldFrom, oldTo, merged.blocks, delta);
	seedHistory(st.history, merged.blocks);

	return merged.changed;
}
