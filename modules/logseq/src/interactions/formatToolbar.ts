/**
 * 选区浮出格式工具栏（思源 toolbar/index.ts render 门禁 + selectionElementPosition.ts
 * 定位纯函数，2026-10-26 第四批）。
 *
 * 与思源的对应关系：
 * - 门禁：mouseup/dblclick 且选区非空才显示（键盘扩选不触发，思源同款）；
 *   代码块/移动端不显示——我们的代码块走 Monaco（不经过 CM contentDOM），
 *   天然不触发；嵌入编辑器未接线（思源也只在 wysiwyg 主编辑器）。
 * - 定位：优先选区上方 gap=4（多击 2），放不下翻到下方，越界钳回滚动容器
 *   （getSelectionElementY 纯函数移植，含既有工具栏避让的参数位——我们只有
 *   一层，toolbarTop/Bottom 留空即可）。
 * - 按钮态：isWrapped（与 wrapSelection 的解包条件一致——按钮亮灭必须
 *   等于点击会发生什么）。思源 inlineFormat.ts 的交集算法按 DOM data-type
 *   算覆盖，我们侧动作按 hug 边界判，交集口径与动作对齐才是诚实状态。
 * - 隐藏：选区塌缩（updateListener 守卫）/ 编辑器 blur / 滚动 / 点击工具栏外。
 *   点击按钮不触发这些（bar 上 mousedown preventDefault 保住焦点与选区），
 *   连续套格式时条不消失、按钮态即时刷新（思源同款链式体验）。
 *
 * 视觉层无需本模块负责：livePreview 已把 `**x**` 渲染成粗体并隐藏标记符。
 */

import { setIcon } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import {
  FORMAT_MARKS,
  clearFormatting,
  isWrapped,
  toggleMarkerPairFor,
} from './textSelectionMenu';

// ---------------------------------------------------------------------------
// 定位纯函数（思源 selectionElementPosition.ts 移植，坐标一律视口系）
// ---------------------------------------------------------------------------

export interface SelectionElementPositionOptions {
  elementHeight: number;
  rangeTop: number;
  rangeBottom: number;
  topBoundary: number;
  bottomBoundary: number;
  gap: number;
  isBottom: boolean;
  /** 既有浮层（如子面板）的上下缘：留给完整移植，我们当前只一层传 undefined。 */
  toolbarTop?: number;
  toolbarBottom?: number;
}

export const getSelectionElementAvailableHeight = (options: SelectionElementPositionOptions): number => {
  const toolbarAbove = typeof options.toolbarBottom === 'number' && options.toolbarBottom <= options.rangeTop;
  const toolbarBelow = typeof options.toolbarTop === 'number' && options.toolbarTop >= options.rangeBottom;
  const top = toolbarAbove ? (options.toolbarTop as number) : options.rangeTop;
  const bottom = toolbarBelow ? (options.toolbarBottom as number) : options.rangeBottom;
  return Math.max(
    top - options.topBoundary - options.gap,
    options.bottomBoundary - bottom - options.gap,
    0,
  );
};

export const getSelectionElementY = (options: SelectionElementPositionOptions): number => {
  const aboveRange = options.rangeTop - options.elementHeight - options.gap;
  const belowRange = options.rangeBottom + options.gap;
  if (typeof options.toolbarTop === 'number' && typeof options.toolbarBottom === 'number') {
    if (options.toolbarBottom <= options.rangeTop) {
      const aboveToolbar = options.toolbarTop - options.elementHeight - options.gap;
      return aboveToolbar >= options.topBoundary
        ? aboveToolbar
        : Math.min(belowRange, options.bottomBoundary - options.elementHeight);
    }
    if (options.toolbarTop >= options.rangeBottom) {
      const belowToolbar = options.toolbarBottom + options.gap;
      return belowToolbar + options.elementHeight <= options.bottomBoundary
        ? belowToolbar
        : Math.max(aboveRange, options.topBoundary);
    }
  }
  return options.isBottom
    ? (belowRange + options.elementHeight <= options.bottomBoundary
        ? belowRange
        : Math.max(aboveRange, options.topBoundary))
    : (aboveRange >= options.topBoundary
        ? aboveRange
        : Math.min(belowRange, options.bottomBoundary - options.elementHeight));
};

// ---------------------------------------------------------------------------
// 单例条
// ---------------------------------------------------------------------------

const COMMENT_MARK = '%%';
let bar: HTMLElement | null = null;
/** 当前条的宿主视图（隐藏监听都挂在它身上）。 */
let barView: EditorView | null = null;
let hideListeners: Array<() => void> = [];

/** 浮出条按钮集：FORMAT_MARKS + bold/italic 的 alt 标记（toggle 要能解 `__x__`）。 */
const FORMAT_BUTTONS: Array<{ icon: string; title: string; mark: string; markEnd: string; alt?: string }> = [
  ...FORMAT_MARKS.map(([title, icon, mark, markEnd]) => ({
    icon,
    title,
    mark,
    markEnd,
    alt: title === 'Bold' ? '__' : title === 'Italic' ? '_' : undefined,
  })),
];

/** 隐藏（幂等）。 */
export function hideFormatToolbar(): void {
  for (const off of hideListeners) off();
  hideListeners = [];
  barView = null;
  bar?.remove();
  bar = null;
}

export function isFormatToolbarVisible(): boolean {
  return bar !== null;
}

/** 逐按钮刷新 is-current（与点击动作的 hug 判定同口径）。 */
function refreshStates(view: EditorView): void {
  if (!bar) return;
  bar.querySelectorAll<HTMLElement>('.lg-fmt-bar__btn').forEach((btn) => {
    const mark = btn.dataset.mark ?? '';
    const markEnd = btn.dataset.markEnd ?? '';
    const on = btn.dataset.kind === 'comment' ? isWrapped(view, COMMENT_MARK) : isWrapped(view, mark, markEnd);
    btn.classList.toggle('is-current', on);
  });
}

function buildBar(view: EditorView): HTMLElement {
  const el = document.createElement('div');
  el.className = 'lg-fmt-bar';
  // 点击按钮不得丢焦点/塌缩选区——bar 上拦截 mousedown 默认行为。
  el.addEventListener('mousedown', (e) => e.preventDefault());
  const addBtn = (icon: string, title: string, kind: string, onClick: () => void, mark = '', markEnd = ''): void => {
    const btn = document.createElement('div');
    btn.className = 'lg-fmt-bar__btn';
    btn.dataset.kind = kind;
    btn.dataset.mark = mark;
    btn.dataset.markEnd = markEnd;
    btn.setAttribute('aria-label', title);
    setIcon(btn, icon);
    btn.addEventListener('click', () => {
      onClick();
      refreshStates(view);
      view.focus();
    });
    el.appendChild(btn);
  };
  for (const b of FORMAT_BUTTONS) {
    addBtn(b.icon, b.title, 'md', () => toggleMarkerPairFor(view, b.mark, b.alt), b.mark, b.markEnd);
  }
  addBtn('lucide-percent', 'Comment', 'comment', () => toggleMarkerPairFor(view, COMMENT_MARK), COMMENT_MARK, COMMENT_MARK);
  addBtn('lucide-eraser', 'Clear formatting', 'clear', () => clearFormatting(view));
  document.body.appendChild(el);
  return el;
}

/**
 * 显示/刷新（门禁已在触发端：mouseup/dblclick + 非空选区）。坐标全视口系：
 * coordsAtPos 返回视口坐标，scrollDOM 的 rect 也是，fixed 定位直接可用。
 */
export function showFormatToolbar(view: EditorView, multiClick: boolean): void {
  const sel = view.state.selection.main;
  if (sel.empty) {
    hideFormatToolbar();
    return;
  }
  const from = view.coordsAtPos(sel.from);
  const to = view.coordsAtPos(sel.to);
  if (!from || !to) {
    hideFormatToolbar();
    return;
  }
  const scroller = view.scrollDOM.getBoundingClientRect();
  const gap = multiClick ? 2 : 4; // 思源：isMultipleClick ? 2 : 4
  const rangeTop = Math.min(from.top, to.top);
  const rangeBottom = Math.max(from.bottom, to.bottom);
  if (bar && barView !== view) hideFormatToolbar();
  if (!bar) bar = buildBar(view);
  barView = view;
  const height = bar.offsetHeight;
  const y = getSelectionElementY({
    elementHeight: height,
    rangeTop,
    rangeBottom,
    topBoundary: scroller.top,
    bottomBoundary: scroller.bottom,
    gap,
    isBottom: false,
  });
  const width = bar.offsetWidth;
  // 思源：left = rangeLeft - width/4（多击 /3），横向也钳进容器。
  const divisor = multiClick ? 3 : 4;
  const left = Math.max(scroller.left + 4, Math.min(from.left - width / divisor, scroller.right - width - 4));
  bar.style.left = `${Math.round(left)}px`;
  bar.style.top = `${Math.round(y)}px`;
  refreshStates(view);
  for (const off of hideListeners) off();
  hideListeners = [
    attach(view.contentDOM, 'blur', hideFormatToolbar),
    attach(view.scrollDOM, 'scroll', hideFormatToolbar),
    attach(document.body, 'mousedown', (e: MouseEvent) => {
      if (bar && e.target instanceof Node && !bar.contains(e.target)) hideFormatToolbar();
    }),
  ];
  bar.classList.remove('fn__none');
}

function attach(target: EventTarget, type: string, fn: (ev: never) => void): () => void {
  target.addEventListener(type, fn as EventListener);
  return () => target.removeEventListener(type, fn as EventListener);
}

// ---------------------------------------------------------------------------
// 接线扩展：触发（mouseup/dblclick）+ 选区塌缩守卫
// ---------------------------------------------------------------------------

/** 主编辑器扩展：选区浮出条的触发与生命周期。 */
export function formatToolbarExtension(): Extension {
  return [
    EditorView.domEventHandlers({
      mouseup: (_event, view) => {
        // mouseup 时 CM 的选区已定（拖选在 mousemove 期间落 state），
        // 仍推一个宏任务保险；button 过滤右键。
        const button = _event instanceof MouseEvent ? _event.button : 0;
        const detail = _event instanceof MouseEvent ? _event.detail : 1;
        if (button !== 0) return false;
        setTimeout(() => showFormatToolbar(view, detail > 1), 0);
        return false;
      },
    }),
    EditorView.updateListener.of((u) => {
      // 选区塌缩即隐藏；套格式后选区仍非空 → 条保留、按钮态已由点击刷新
      // （思源链式体验）。
      if (isFormatToolbarVisible() && u.view.state.selection.main.empty) hideFormatToolbar();
    }),
  ];
}
