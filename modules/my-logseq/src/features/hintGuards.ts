/**
 * 补全提示守卫（思源 hint 模块规则移植，2026-10-26 第五批）。
 *
 * 三条思源行为规格：
 * 1. 行内代码内不触发（hint/index.ts:300-304）：caret 落在行内 code span
 *    （data-type=code）里，一切提示隐藏。我们侧 caret 在 `` `x` `` span
 *    内（含标记符本身）即抑制；代码块走 Monaco 不经过 CM 源，天然覆盖。
 * 2. 标题光标 ≤ # 数不触发 tag（hint/index.ts:311-321，issue 7933）：标题行
 *    里 caret 之前的字符全是 `#` 时不弹 tag 提示——正在敲的前缀不算标签。
 * 3. 上个提示未结束其他触发符不得打断（blockHintRange.ts
 *    shouldIgnoreHintTrigger）：块引用/维基链查询（`((`/`[[`）未收口时，
 *    `/`、`#` 等新触发符不得抢焦点。我们侧做成无状态检查：caret 处存在
 *    未收口的块提示查询时，slash/tag 类源返回 null（CM 多源合并会把两个
 *    菜单的结果混成一列，正是思源这条规则要防的）。
 *
 * blockHintRange.ts 的 getBlockRefStaticText / shouldCaptureHintUndoFocus
 * 依赖思源的 DOM fill 流程，无我们侧对应物，不移植。
 */

import type { EditorState } from '@codemirror/state';

// ---------------------------------------------------------------------------
// 思源 blockHintRange.ts 移植（纯文本函数，测试用例逐条对照）
// ---------------------------------------------------------------------------

/** 触发符偏移：有闭口符跟在 caret 后时取最新重叠触发，否则处理三连触发。 */
export const getBlockHintTriggerOffset = (
  textBeforeCaret: string,
  textAfterCaret: string,
  splitChar: string,
  endSplit: string,
): number => {
  const latestOffset = textBeforeCaret.lastIndexOf(splitChar);
  if (latestOffset < 0 || textAfterCaret.startsWith(endSplit)) {
    return latestOffset;
  }
  const tripleOffset = textBeforeCaret.lastIndexOf(splitChar + splitChar.substring(0, 1));
  return tripleOffset > -1 ? Math.min(latestOffset, tripleOffset) : latestOffset;
};

/** caret 处是否是一段未收口的合法查询：触发符存在、查询不以空白开头、不超长。 */
export const isBlockHintQueryAtCaret = (
  textBeforeCaret: string,
  textAfterCaret: string,
  splitChar: string,
  endSplit: string,
  maxLength: number,
): boolean => {
  const triggerOffset = getBlockHintTriggerOffset(textBeforeCaret, textAfterCaret, splitChar, endSplit);
  if (triggerOffset < 0) {
    return false;
  }
  const query = textBeforeCaret.substring(triggerOffset + splitChar.length);
  return query.trimStart() === query && query.length < maxLength;
};

/**
 * 「上个提示未结束其他触发符不得打断」（思源 shouldIgnoreHintTrigger）：
 * 活动提示是块提示（`((`/`[[`）时，新的 `:`/`#`/`/`/`、` 触发不得打断；
 * `#` 活动时 `/`、`、` 不得打断。
 */
export const shouldIgnoreHintTrigger = (
  activeHint: string,
  candidateHint: string,
  blockHintKeys: string[],
): boolean => {
  if (blockHintKeys.includes(activeHint) && [':', '#', '/', '、'].includes(candidateHint)) {
    return true;
  }
  return activeHint === '#' && ['/', '、'].includes(candidateHint);
};

// ---------------------------------------------------------------------------
// CM 适配守卫（EditorState + 偏移 → 布尔）
// ---------------------------------------------------------------------------

/** 我们的块提示键（思源 BLOCK_HINT_KEYS 的子集：`((` 块引用、`[[` 维基链）。 */
export const BLOCK_HINT_KEYS: Array<{ split: string; close: string }> = [
  { split: '((', close: '))' },
  { split: '[[', close: ']]' },
];

/** 行内代码查询上限沿思源 SIZE_TITLE 量级。 */
const HINT_QUERY_MAX = 512;

/**
 * caret 是否落在当前行的行内 code span 内（含标记符本身）。
 * 只扫闭合的 `` `x` `` 对——未闭合的半个反引号不是代码（思源 DOM 版只认
 * 已渲染 span，同语义）。
 */
export function isCaretInInlineCode(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  const col = pos - line.from;
  const re = /`[^`\n]*`/g;
  for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
    if (col >= m.index && col <= m.index + m[0].length) return true;
  }
  return false;
}

/**
 * 标题前缀守卫（思源 issue 7933）：标题行（`#{1,6} ` 开头）里 caret 之前
 * 的字符全是 `#` 时不触发 tag——正在敲的前缀不是标签。
 */
export function isCaretInHeadingPrefix(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  if (!/^#{1,6} /.test(line.text)) return false;
  const col = pos - line.from;
  return line.text.startsWith('#'.repeat(col));
}

/**
 * caret 是否落在 `#tag` 记号里（思源 data-type=tag 祖先的文本近似）。
 * `#` 后至少一个标签字符且前面是行首/空白/括号——URL 锚点等文本级近似
 * 误差已知（思源用语义 span，无误差）。
 */
export function isCaretInTag(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  const col = pos - line.from;
  const re = /(^|[\s([])#[\p{L}\d_\/-]+/gu;
  for (let m = re.exec(line.text); m; m = re.exec(line.text)) {
    const start = m.index + m[1].length;
    if (col > start && col <= m.index + m[0].length) return true;
  }
  return false;
}

/**
 * caret 处是否有未收口的块提示查询（`((que…` / `[[que…`）。
 * 有 → slash/tag 类新触发不得打断（规则 3 的无状态版）。
 */
export function unfinishedBlockHintAt(state: EditorState, pos: number): string | null {
  const line = state.doc.lineAt(pos);
  const col = pos - line.from;
  const after = line.text.slice(col);
  for (const { split, close } of BLOCK_HINT_KEYS) {
    if (!isBlockHintQueryAtCaret(line.text.slice(0, col), after, split, close, HINT_QUERY_MAX)) continue;
    const triggerOffset = line.text.slice(0, col).lastIndexOf(split);
    const query = line.text.slice(triggerOffset + split.length, col);
    // 查询里已手敲了闭口符 → 提示已结束（shouldIgnoreHintTrigger 只在提示
    // 真开着时才拦；思源 canResume 的「闭口符入查询」是它有状态的所有权，
    // 我们的无状态跨源打断取更严的一支）。
    if (query.includes(close)) continue;
    return split;
  }
  return null;
}

/**
 * 源级守卫汇总：行内代码内一切提示不触发；未收口块提示处非块提示源
 * （`/` `#`）不触发。blockHint 传 true 表示调用方本身是块提示源
 * （`[[`/`((`，不受规则 3 约束）。
 */
export function hintSuppressedAt(state: EditorState, pos: number, blockHint: boolean): boolean {
  if (isCaretInInlineCode(state, pos)) return true;
  if (!blockHint && unfinishedBlockHintAt(state, pos) !== null) return true;
  return false;
}
