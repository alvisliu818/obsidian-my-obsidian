/**
 * 围栏（``` / ~~~）逐行扫描的统一实现——此前三处手写同一状态机
 * （renderTree.withTableSeparation / editor.livePreview / features.emojiShortcodes），
 * 闭合判定细节已经出现漂移风险（trimStart 前缀匹配 vs 精确正则）。
 * 本文件是唯一实现：纯函数，零依赖（core 层,可 node 直测）。
 *
 * 语义（与三处旧实现一致）：
 *  - 围栏开：行首（可缩进）``` 或 ~~~，marker 为三连字符本身；
 *  - 围栏闭：trimStart 后以**同一 marker** 开头的行；
 *  - 围栏内的 ```/~~~ 开行不再切换 marker（嵌套围栏不支持,与旧行为一致）。
 */

/** 行首（可缩进）围栏开标记。 */
export const FENCE_OPEN_RE = /^\s*(```|~~~)/;

/** 逐行回调：lineText = 该行文本；insideFence = 该行是否处于围栏内部；
 *  n = 1 起的行号（调用方自行映射到自己的行模型）。 */
export type FenceLineVisitor = (lineText: string, insideFence: boolean, n: number) => void;

/**
 * 对 lineCount 行逐行调用 visit,维护围栏开/闭状态。
 * lineAt(n) 返回 1 起行号对应的行文本。
 */
export function scanLinesWithFences(
	lineAt: (n: number) => string,
	lineCount: number,
	visit: FenceLineVisitor,
): void {
	let inFence = false;
	let fenceMarker = '';
	for (let n = 1; n <= lineCount; n++) {
		const text = lineAt(n);
		const open = FENCE_OPEN_RE.exec(text);
		if (open && !inFence) {
			inFence = true;
			fenceMarker = open[1];
			visit(text, false, n);
			continue;
		}
		if (inFence && text.trimStart().startsWith(fenceMarker)) {
			inFence = false;
			visit(text, false, n);
			continue;
		}
		visit(text, inFence, n);
	}
}

/** 便捷包装:把行文本切进「围栏内/外」两个桶（索引 0 起,与 Array 一致）。 */
export function splitByFences(
	lines: readonly string[],
): { outside: Array<{ text: string; index: number }>; inside: Array<{ text: string; index: number }> } {
	const outside: Array<{ text: string; index: number }> = [];
	const inside: Array<{ text: string; index: number }> = [];
	scanLinesWithFences((n) => lines[n - 1] ?? '', lines.length, (text, inFence, n) => {
		(inFence ? inside : outside).push({ text, index: n - 1 });
	});
	return { outside, inside };
}
