/**
 * 块选择模式的纯逻辑(思源 blockSelection.ts 移植,2026-10-26)。
 *
 * 思源在 contenteditable DOM 上用 select-mode/select 两个类 + select-start/end
 * 属性承载状态;我们是 CM6 块编辑器,状态放 BlockEditorView 的字段
 * (selectionAnchor/selExtendEnd/selectedBlocks),这里只留与 DOM 无关的算法:
 * toggle 的祖先/后代互斥、连续性校验、删除后光标候选定位。
 * 行为规格 = 思源 app/src/protyle/wysiwyg/blockSelection.ts(含其测试用例)。
 */

import type { Block } from '../types';

/** `ancestor` 是否在 `b` 的父链上(思源 Element.contains 的模型版)。 */
export function blockContains(ancestor: Block, b: Block): boolean {
  let p = b.parent;
  while (p) {
    if (p === ancestor) return true;
    p = p.parent;
  }
  return false;
}

/**
 * Space 切换(思源 getBlockSelectionToggle):目标已在标记集 → 移除;
 * 否则加入,并剔除与它互为祖先/后代的既有标记——父子同选没有意义,
 * 批量操作按顶层走,留着被包含的标记只会让视觉与语义打架。
 * 返回新数组,不改入参。
 */
export function toggleBlockSelection(selected: Block[], target: Block): Block[] {
  if (selected.includes(target)) {
    return selected.filter((b) => b !== target);
  }
  return selected
    .filter((b) => !blockContains(b, target) && !blockContains(target, b))
    .concat(target);
}

/**
 * 连续性校验(思源 isContinuousBlockSelection):去重后每对相邻块都必须
 * 被 `next` 直接连起来。用于 Shift 扩选前判断既有标记是否还是一条可见
 * 区间——点击产生的跨越式多选不算连续,扩选要从锚点单块重来。
 */
export function isContinuousSelection(
  blocks: Block[],
  next: (b: Block) => Block | null,
): boolean {
  const unique = [...new Set(blocks)];
  if (unique.length === 0) return false;
  return unique.every((b, i) => i === unique.length - 1 || next(b) === unique[i + 1]);
}

export type DeleteSide = 'before' | 'after';

/**
 * 删除后光标落点(思源 getDeleteSelectionCandidate):删除选中块后,光标
 * 应落在删除区间外侧最近的存活块上——Backspace 语义向后看(先前块行尾,
 * 没有再后块行首),Delete 向前看(先后块行首,没有再前块行尾)。
 * 行走时跳过也在删除集里的块(含其子块),带访问环检测防 next 链成环。
 * 全部块都在删除集里时返回 undefined(删光后无处落光标)。
 */
export function deleteCandidate(
  targets: Block[],
  type: 'Delete' | 'Backspace',
  getPrevious: (b: Block) => Block | null,
  getNext: (b: Block) => Block | null,
): { block: Block; side: DeleteSide } | undefined {
  const deduped = [...new Set(targets)];
  if (deduped.length === 0) return undefined;
  const isDeleted = (b: Block) =>
    deduped.some((t) => t === b || blockContains(t, b));
  const findCandidate = (
    start: Block,
    getAdjacent: (b: Block) => Block | null,
  ): Block | undefined => {
    const visited = new Set<Block>();
    let candidate = getAdjacent(start);
    while (candidate && (isDeleted(candidate) || visited.has(candidate))) {
      if (visited.has(candidate)) return undefined;
      visited.add(candidate);
      candidate = getAdjacent(candidate);
    }
    return candidate ?? undefined;
  };
  const first = deduped[0];
  const last = deduped[deduped.length - 1];
  if (type === 'Backspace') {
    const prev = findCandidate(first, getPrevious);
    if (prev) return { block: prev, side: 'before' };
    const next = findCandidate(last, getNext);
    return next ? { block: next, side: 'after' } : undefined;
  }
  const next = findCandidate(last, getNext);
  if (next) return { block: next, side: 'after' };
  const prev = findCandidate(first, getPrevious);
  return prev ? { block: prev, side: 'before' } : undefined;
}
