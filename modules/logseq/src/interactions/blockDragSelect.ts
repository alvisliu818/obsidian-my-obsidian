/**
 * 块框选手势骨架（思源 blockDragSelectionGesture.ts 移植，2026-10-26，鼠标路径）。
 *
 * 静态树上按下 → 找起始块 → 移动跨块 → select(start, end) 逐帧重画范围 →
 * 松手 finish。Esc / 拖拽开始 / 窗口失焦 / 输入法组合全部取消；拖选后的
 * 尾随 click 被抑制 500ms（不然它会走块点击链清掉刚画好的选择）。滚动中
 * 用 document 捕获阶段监听（scroll 不冒泡但捕获可达）重算落点。
 *
 * 触摸路径不移植（桌面插件）；SiYuan 的 canStart「触摸或非可编辑宿主」
 * 口径在我们侧等价于「非编辑态」——编辑中的块拖动是 CM 文本选区，由调用
 * 方的 canStart 把关。范围切片与标记落位都是回调（visibleRange + 选择态
 * 字段在 BlockEditorView），这里只管手势状态机。
 *
 * 移植时去掉的 SiYuan 专属分支：触摸长按阈值 / 多选模式工具条 / 越界滚动
 * 驱动（dragOverScroll）——我们用原生滚动 + scroll 重算覆盖常见场景。
 */

import type { Block } from '../types';

export interface BlockDragSelectHit {
  block: Block;
  /** 命中块的 DOM 元素：起始块存活校验用（模型块无 isConnected）。 */
  el: HTMLElement;
}

export interface BlockDragSelectOptions {
  /** 每次移动都复检（思源 update 里的 canStart 同位）：编辑态开始即取消。 */
  canStart: () => boolean;
  getStartBlock: (target: HTMLElement) => BlockDragSelectHit | null;
  getBlockAtPoint: (x: number, y: number) => BlockDragSelectHit | null;
  select: (start: Block, end: Block) => void;
  finish: (cancelled: boolean) => void;
}

export function bindBlockDragSelect(element: HTMLElement, o: BlockDragSelectOptions): () => void {
  const ownerDoc = element.ownerDocument;
  const ownerWin = ownerDoc.defaultView ?? window;
  let gesture: { block: Block; el: HTMLElement; x: number; y: number; active: boolean } | null = null;
  let suppressClickUntil = 0;

  const finish = (cancelled: boolean): void => {
    const prev = gesture;
    gesture = null;
    ownerDoc.removeEventListener('mousemove', onMouseMove, true);
    ownerDoc.removeEventListener('mouseup', onMouseUp, true);
    ownerDoc.removeEventListener('keydown', onKeyDown, true);
    ownerDoc.removeEventListener('dragstart', onDragStart, true);
    ownerDoc.removeEventListener('scroll', onScroll, true);
    ownerWin.removeEventListener('blur', onCancel);
    if (prev?.active) {
      suppressClickUntil = Date.now() + 500;
      o.finish(cancelled);
    }
  };
  const onCancel = (): void => finish(true);
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') finish(true);
  };
  const onDragStart = (ev: DragEvent): void => {
    if (gesture?.active) ev.preventDefault();
    else finish(true);
  };
  const onScroll = (): void => {
    if (gesture?.active && update(gesture.x, gesture.y)) {
      /* 滚动后重算落点（拖到视口边缘的原生滚动场景） */
    }
  };

  const update = (x: number, y: number): boolean => {
    if (!gesture || !element.contains(gesture.el) || !o.canStart()) {
      finish(true);
      return false;
    }
    const hit = o.getBlockAtPoint(x, y);
    // 未激活时不认单块（按下后原地微动不算框选，思源 allowSingleBlock=false）
    if (!gesture.active && (!hit || hit.block === gesture.block)) return false;
    gesture.active = true;
    gesture.x = x;
    gesture.y = y;
    if (hit) o.select(gesture.block, hit.block);
    return true;
  };

  const onMouseMove = (ev: MouseEvent): void => {
    if ((ev.buttons & 1) === 0) {
      finish(false);
    } else if (update(ev.clientX, ev.clientY)) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  };
  const onMouseUp = (ev: MouseEvent): void => {
    const active = gesture?.active;
    finish(false);
    if (active) {
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  };

  const onMouseDown = (ev: MouseEvent): void => {
    if (
      ev.defaultPrevented ||
      ev.button !== 0 ||
      ev.detail > 1 || // 双击/三击是文本选区语义
      ev.shiftKey ||
      ev.ctrlKey ||
      ev.metaKey ||
      ev.altKey
    ) {
      return;
    }
    finish(true);
    if (!o.canStart()) return;
    const hit = o.getStartBlock(ev.target as HTMLElement);
    if (!hit) return;
    gesture = { block: hit.block, el: hit.el, x: ev.clientX, y: ev.clientY, active: false };
    ownerDoc.addEventListener('mousemove', onMouseMove, true);
    ownerDoc.addEventListener('mouseup', onMouseUp, true);
    ownerDoc.addEventListener('keydown', onKeyDown, true);
    ownerDoc.addEventListener('dragstart', onDragStart, true);
    ownerDoc.addEventListener('scroll', onScroll, true);
    ownerWin.addEventListener('blur', onCancel);
  };

  const onClick = (ev: MouseEvent): void => {
    // 框选松手后的尾随 click 不走块点击链（否则清掉刚画好的选择）。
    if (Date.now() < suppressClickUntil) {
      suppressClickUntil = 0;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }
  };
  const onCompositionStart = (): void => finish(true);

  element.addEventListener('mousedown', onMouseDown);
  element.addEventListener('click', onClick, true);
  element.addEventListener('compositionstart', onCompositionStart);
  return () => {
    finish(true);
    element.removeEventListener('mousedown', onMouseDown);
    element.removeEventListener('click', onClick, true);
    element.removeEventListener('compositionstart', onCompositionStart);
  };
}
