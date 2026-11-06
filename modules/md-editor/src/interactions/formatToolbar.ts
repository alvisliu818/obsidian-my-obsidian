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
 * - 按钮态：activeMarksAt（批次 28 起为语法树交集正解——按钮亮灭必须
 *   等于点击会发生什么）。思源 inlineFormat.ts 的交集算法按 DOM data-type
 *   算覆盖，我们侧用 Lezer 语法树对每个文本段求覆盖节点类型交集，
 *   `**x**` 双亮等 hug 近似病例已系统性根治。
 * - 隐藏：选区塌缩（updateListener 守卫）/ 编辑器 blur / 滚动 / 点击工具栏外。
 *   点击按钮不触发这些（bar 上 mousedown preventDefault 保住焦点与选区），
 *   连续套格式时条不消失、按钮态即时刷新（思源同款链式体验）。
 *
 * 视觉层无需本模块负责：livePreview 已把 `**x**` 渲染成粗体并隐藏标记符。
 */

import { Notice, setIcon } from 'obsidian';
import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import {
  FORMAT_MARKS,
  activeMarksAt,
  clearFormatting,
  memoToggleSelection,
  toggleMarkerPairFor,
  wrapSelection,
} from './textSelectionMenu';
import { isMemoSpanAt } from './inlineMemo';

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

// ---------------------------------------------------------------------------
// 格式刷（思源 FormatPainter.ts 流程 + formatPainterCore 语义，类型口径）
// ---------------------------------------------------------------------------
//
// 思源取色按 DOM 分段求交集（FORMAT_PAINTER_TYPES + 内联样式）；我们无样式
// 表示（纯 markdown），快照 = 当前选区的标记集（批次 28 起与按钮态同为
// 语法树交集口径：亮着的按钮就是会被取走的格式）。应用 = clearFormatting +
// 逐类型重放，与思源 applyMark("clear") + applyMark(type) 同序。
// 字体族/字号/颜色等样式刷不移植——模型无对应表示。

let painterMarks: string[] | null = null; // null = 未激活
let painterContinuous = false;
let painterOffEsc: (() => void) | null = null;

/** 格式刷是否激活（once 取色后 / continuous 期间）。 */
export function isFormatPainterActive(): boolean {
  return painterMarks !== null;
}

/** 取色：选区上的标记集（activeMarksAt 口径 = 按钮态口径，含嵌套排除）。 */
export function takePainterSnapshot(view: EditorView): string[] {
  return activeMarksAt(view);
}

/** 应用：先清空目标格式再重放快照（思源 applyMark("clear") + applyMark(type) 同序）。 */
export function applyPainter(view: EditorView, marks: string[]): void {
  clearFormatting(view);
  for (const m of marks) {
    if (m === COMMENT_MARK) {
      toggleMarkerPairFor(view, COMMENT_MARK);
      continue;
    }
    const btn = FORMAT_BUTTONS.find((x) => x.mark === m);
    if (btn) toggleMarkerPairFor(view, btn.mark, btn.alt);
  }
}

/** 激活（思源 activate）：隐藏条，下一次选区直接应用。 */
export function activatePainter(view: EditorView, continuous: boolean): void {
  painterMarks = takePainterSnapshot(view);
  painterContinuous = continuous;
  hideFormatToolbar();
  painterOffEsc = attach(document, 'keydown', (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') deactivatePainter();
  }, true);
  new Notice(continuous ? '格式刷：连续模式（Esc 退出）' : '格式刷已取格式，选中文本即应用');
}

export function deactivatePainter(): void {
  painterMarks = null;
  painterContinuous = false;
  painterOffEsc?.();
  painterOffEsc = null;
}

/** 逐按钮刷新 is-current（与点击动作的 hug 判定同口径）。 */
function refreshStates(view: EditorView): void {
  if (!bar) return;
  const active = activeMarksAt(view); // 与点击动作的解包判定同口径(含嵌套排除)
  const sel = view.state.selection.main;
  // memo 按钮态=选区精确落在 ((...)) 对内（isMemoSpanAt 口径 = 点击动作的
  // unwrap 判定同口径）。
  const memoActive = !sel.empty && isMemoSpanAt(view.state.doc, sel.from, sel.to);
  bar.querySelectorAll<HTMLElement>('.lg-fmt-bar__btn').forEach((btn) => {
    const mark = btn.dataset.mark ?? '';
    const kind = btn.dataset.kind ?? '';
    if (kind === 'memo') {
      btn.classList.toggle('is-current', memoActive);
      return;
    }
    // 无标记按钮（link/blockref/painter/clear）没有亮灭态可刷新。
    if (!mark && kind !== 'comment') return;
    btn.classList.toggle('is-current', active.includes(mark));
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
  // 链接/块引用(思源工具栏 a / block-ref 按钮的我们侧等价):包裹后光标落在
  // 标记内,URL/引用目标由用户接着键入(块引用内键入会触发块提示补全)。
  addBtn('lucide-link', 'Link', 'link', () => wrapSelection(view, '[', ']()'));
  addBtn('lucide-link-2', 'Block ref', 'blockref', () => wrapSelection(view, '((', '))'));
  // 行内备注（思源 InlineMemo 按钮对应，批次 27）：与块引用共享 `((...))` 语法
  // 对，按内容形态区分——UUID 是块引用，其余是备注（见 interactions/inlineMemo）。
  addBtn('lucide-sticky-note', 'Memo', 'memo', () => memoToggleSelection(view));
  addBtn('lucide-eraser', 'Clear formatting', 'clear', () => clearFormatting(view));
  // 格式刷:单击一次 / 双击连续(思源 FormatPainter 的 TIMEOUT_DBLCLICK 区分)。
  // 独立建钮:click 事件需要 detail,addBtn 的闭包不带。
  const painterBtn = document.createElement('div');
  painterBtn.className = 'lg-fmt-bar__btn';
  painterBtn.dataset.kind = 'painter';
  painterBtn.setAttribute('aria-label', 'Format painter(双击连续模式)');
  setIcon(painterBtn, 'lucide-paint-roller');
  let clickTimer: number | undefined;
  painterBtn.addEventListener('click', (e) => {
    e.preventDefault();
    window.clearTimeout(clickTimer);
    if (e.detail > 1) {
      activatePainter(view, true);
      return;
    }
    clickTimer = window.setTimeout(() => activatePainter(view, false), 250);
  });
  el.appendChild(painterBtn);
  document.body.appendChild(el);
  return el;
}

/**
 * 显示/刷新（门禁已在触发端：mouseup/dblclick + 非空选区）。坐标全视口系：
 * coordsAtPos 返回视口坐标，scrollDOM 的 rect 也是，fixed 定位直接可用。
 */
export function showFormatToolbar(view: EditorView, multiClick: boolean): void {
  // 格式刷激活中：这次 mouseup 选区就是应用目标（思源激活后隐藏工具条，
  // 下一次选区直接 applyFormatPainter）；once 应用即退出，continuous 继续。
  if (painterMarks !== null) {
    applyPainter(view, painterMarks);
    if (!painterContinuous) deactivatePainter();
    return;
  }
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

function attach(target: EventTarget, type: string, fn: (ev: never) => void, capture = false): () => void {
  target.addEventListener(type, fn as EventListener, capture);
  return () => target.removeEventListener(type, fn as EventListener, capture);
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
