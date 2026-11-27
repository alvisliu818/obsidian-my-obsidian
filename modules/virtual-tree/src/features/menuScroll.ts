import type { Menu } from 'obsidian';

type ItemLike = { dom?: HTMLElement; submenu?: Menu };

/** 隐藏滚动条样式只注入一次（类名同时给到 ::-webkit-scrollbar 与 scrollbar-width）。 */
const SCROLLBAR_STYLE_ID = 'lgp-menu-scrollbar-hide';
const SCROLLBAR_CLASS = 'lgp-menu-wheel-scroll';

function ensureScrollbarHidden(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(SCROLLBAR_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = SCROLLBAR_STYLE_ID;
  style.textContent =
    `.${SCROLLBAR_CLASS} .menu-scroll{scrollbar-width:none;}` +
    `.${SCROLLBAR_CLASS} .menu-scroll::-webkit-scrollbar{display:none;width:0;height:0;}`;
  document.head.appendChild(style);
}

/**
 * 右键菜单不要跟着光标自动滚动（2026-11-27 用户要求：滚动交给滚轮）。
 *
 * 桌面版 Obsidian 给 `.menu-scroll` 注册了一个 mousemove 监听（把光标的 Y
 * 坐标映射成 scrollTop），长菜单里光标一动菜单就自己滚；另外悬停选中还会对
 * 菜单项 `scrollIntoView({ block: 'nearest' })`。这里两者都关掉，并把滚动
 * 容器改成可滚动（桌面默认 overflow:hidden，滚轮本来是滚不动的），同时隐藏
 * 滚动条——只保留滚轮。
 *
 * 只作用于传进来的这个菜单（子菜单递归），库里的其它菜单不受影响。
 */
export function disableMenuHoverAutoScroll(menu: Menu): void {
  const internals = menu as unknown as {
    dom?: HTMLElement;
    scrollEl?: HTMLElement;
    items?: ItemLike[];
  };
  // 移动端菜单是底部抽屉（自己带滑动与 60vh 限高），不动它的样式
  const mobile = typeof document !== 'undefined' && document.body?.classList.contains('is-mobile');
  const scroll = internals.scrollEl;
  if (!mobile && scroll) {
    // 吞掉 Obsidian 的「光标 Y → scrollTop」监听，只放行其它事件
    const el = scroll as unknown as {
      addEventListener: (type: string, listener: unknown, options?: unknown) => void;
    };
    const nativeAdd = el.addEventListener;
    el.addEventListener = (type, listener, options) => {
      if (type === 'mousemove') return;
      nativeAdd.call(scroll, type, listener, options);
    };
    // 桌面默认 overflow:hidden 滚轮无效：放开纵向滚动并限高，滚轮即可滚动
    scroll.style.overflowY = 'auto';
    scroll.style.maxHeight = 'calc(100vh - 16px)';
    scroll.style.overscrollBehavior = 'contain';
    // 不显示滚动条：类名走注入的样式，内联兼容不支持 ::-webkit-scrollbar 规则的环境
    internals.dom?.classList.add(SCROLLBAR_CLASS);
    scroll.style.scrollbarWidth = 'none';
    ensureScrollbarHidden();
  }
  // 悬停选中别把菜单项滚进视野（否则光标走到边缘会跳一格）
  for (const item of internals.items ?? []) {
    const dom = item.dom as (HTMLElement & { scrollIntoView: (...args: unknown[]) => void }) | undefined;
    if (dom) dom.scrollIntoView = () => undefined;
    if (item.submenu) disableMenuHoverAutoScroll(item.submenu);
  }
}
