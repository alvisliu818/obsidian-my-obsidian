/**
 * 拖拽/框选越界自动滚动（思源 boot/globalEvent/dragover.ts 1:1 移植，批次 21）。
 *
 * 指针压入滚动容器上/下（或左/右）SIZE_SCROLL_TB 边缘带时启动 rAF 滚动动画；
 * 每帧滚动量 = elapsed × space / 64——space 是指针压入边缘带的深度（px），
 * 越深滚越快；回到内容区或换目标容器/方向即停。
 *
 * 不移植思源的 cancelDrag（ghost 清理，属其拖拽 ghost 体系）；模块级状态
 * 是单例——同屏一次只有一个滚动动画（与思源一致）。
 */

const SIZE_SCROLL_TB = 24; // 思源 Constants.SIZE_SCROLL_TB：上/下（左/右）边缘带宽

const dragoverScroll: {
  animationId?: number;
  element?: Element;
  space?: number; // 负 = 向上/向左；正 = 向下/向右
  direction?: 'x' | 'y';
  lastTime?: number;
} = {};

export const stopScrollAnimation = (): void => {
  if (dragoverScroll.animationId !== undefined && dragoverScroll.animationId !== null) {
    cancelAnimationFrame(dragoverScroll.animationId);
  }
  dragoverScroll.animationId = undefined;
  dragoverScroll.element = undefined;
  dragoverScroll.space = undefined;
  dragoverScroll.direction = undefined;
  dragoverScroll.lastTime = undefined;
};

const scrollAnimation = (timestamp: number): void => {
  if (dragoverScroll.element === undefined || dragoverScroll.space === undefined) {
    dragoverScroll.animationId = undefined;
    return;
  }
  if (dragoverScroll.lastTime === undefined) {
    dragoverScroll.lastTime = timestamp - 8;
  }
  const distance = ((timestamp - dragoverScroll.lastTime) * dragoverScroll.space) / 64;
  if (dragoverScroll.direction === 'x') {
    dragoverScroll.element.scroll({ left: dragoverScroll.element.scrollLeft + distance });
  } else {
    dragoverScroll.element.scroll({ top: dragoverScroll.element.scrollTop + distance });
  }
  // 使用 requestAnimationFrame 继续动画
  dragoverScroll.animationId = requestAnimationFrame(scrollAnimation);
  dragoverScroll.lastTime = timestamp;
};

export const dragOverScroll = (
  moveEvent: { clientX: number; clientY: number },
  contentRect: { left: number; right: number; top: number; bottom: number },
  element: Element,
  direction: 'x' | 'y' = 'y',
): void => {
  const clientPosition = direction === 'x' ? moveEvent.clientX : moveEvent.clientY;
  const start = direction === 'x' ? contentRect.left : contentRect.top;
  const end = direction === 'x' ? contentRect.right : contentRect.bottom;
  const dragToStart = clientPosition < start + SIZE_SCROLL_TB;
  if (dragToStart || clientPosition > end - SIZE_SCROLL_TB) {
    if (
      dragoverScroll.animationId !== undefined &&
      (dragoverScroll.element !== element || dragoverScroll.direction !== direction)
    ) {
      stopScrollAnimation();
    }
    dragoverScroll.space = dragToStart
      ? clientPosition - start - SIZE_SCROLL_TB
      : clientPosition - end + SIZE_SCROLL_TB;
    if (dragoverScroll.animationId === undefined) {
      dragoverScroll.element = element;
      dragoverScroll.direction = direction;
      dragoverScroll.animationId = requestAnimationFrame(scrollAnimation);
    }
  } else {
    // 离开滚动区域时停止滚动
    stopScrollAnimation();
  }
};
