/**
 * 异步插入位置骨架（思源 upload/insertPosition.ts 行为移植，2026-10-26）。
 *
 * 思源在异步工作（读剪贴板、上传、网络转换）前捕获 Range 与两端容器，
 * 之后每次 await 回来都验活：editorElement.contains(startContainer) 不再
 * 成立就放弃（restore 函数做兜底恢复）。我们是块模型 + CM6，三步对应：
 *
 *   捕获 capture —— 焦点块引用 + CM 文本偏移 + CM 实例
 *   验活 isAlive —— CM 还连着 DOM；块非空时还要仍在宿主可见树中
 *   恢复 restore —— 验活通过时把焦点与光标落回捕获位置
 *
 * 任何「先 await 后插入」的路径都应走这三步；同步粘贴（paste 事件内直接
 * mutate）不需要。
 */

import type { EditorView } from '@codemirror/view';
import type { Block } from '../types';
import type { BlockRenderHost } from '../blocks/renderHost';

export interface PasteInsertPosition {
  /**
   * 捕获时的焦点块。embed 就地编辑会话里焦点块不在宿主可见树中，为
   * null——验活退化为 CM 连通性，恢复（focusBlock）不支持。
   */
  block: Block | null;
  /** CM 文档偏移（捕获时刻的 selection.main.head）。 */
  offset: number;
  view: EditorView;
}

/**
 * 捕获插入位。默认捕获 host 的焦点块与焦点 CM；embed 会话显式传入
 * embedEdit.view（此时焦点块允许为 null）。普通会话连焦点块都没有时返回
 * null（调用方放弃或同步处理）。
 */
export function capturePasteInsertPosition(host: BlockRenderHost, view?: EditorView): PasteInsertPosition | null {
  const v = view ?? host.focusedView;
  if (!v) return null;
  const block = host.focusedBlock;
  if (!block && host.embedEdit?.view !== v) return null;
  return { block, offset: v.state.selection.main.head, view: v };
}

/** 块对象身份在可见树中的走查（根级 + 全部嵌套）。 */
function blockInTree(roots: readonly Block[], target: Block): boolean {
  const stack = [...roots];
  while (stack.length) {
    const b = stack.pop()!;
    if (b === target) return true;
    stack.push(...b.children);
  }
  return false;
}

/**
 * 验活：捕获的 CM 实例仍挂在文档上（blur 提交链会卸载 CM），且捕获的块
 * （非 embed 会话）还在宿主的可见树里——提交/重建后旧树引用失效。等价于
 * 思源的 editorElement.contains(start/endContainer)。
 */
export function isPasteInsertPositionAlive(host: BlockRenderHost, pos: PasteInsertPosition): boolean {
  if (!pos.view.dom.isConnected) return false;
  return pos.block === null || blockInTree(host.visibleRoots, pos.block);
}

/**
 * 恢复：验活通过时把焦点与光标落回捕获位置（偏移钳到当前文档长度——
 * 验活只证明块身份，不证明文本未变）。embed 会话（block 为 null）不支持
 * 恢复，返回 false。失败时调用方放弃或兜底。
 */
export function restorePasteInsertPosition(host: BlockRenderHost, pos: PasteInsertPosition): boolean {
  if (!pos.block || !isPasteInsertPositionAlive(host, pos)) return false;
  const len = pos.view.state.doc.length;
  host.focusBlock(pos.block, Math.min(pos.offset, len));
  return true;
}
