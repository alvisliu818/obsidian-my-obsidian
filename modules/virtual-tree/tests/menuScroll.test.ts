/**
 * 右键菜单滚动行为（2026-11-27 用户要求：不追光标、用滚轮）：
 *  - 桌面菜单吞掉 Obsidian 注册在 .menu-scroll 上的 mousemove（光标 Y → scrollTop）
 *  - 滚动容器放开纵向滚动并限高，滚轮能滚
 *  - 每个菜单项（含子菜单）的 scrollIntoView 换成空实现
 */

import { describe, expect, it, vi } from 'vitest';
import type { Menu } from 'obsidian';
import { disableMenuHoverAutoScroll } from '../src/features/menuScroll';

function fakeScroll() {
  return {
    addEventListener: vi.fn(),
    style: {} as Record<string, string>,
  };
}
function fakeItem() {
  return { dom: { scrollIntoView: vi.fn() } as unknown as HTMLElement };
}

describe('disableMenuHoverAutoScroll', () => {
  it('swallows the cursor-driven mousemove and makes the container wheel-scrollable', () => {
    const scroll = fakeScroll();
    // 补丁会接管 addEventListener，调用记录留在原来的实现上
    const nativeAdd = scroll.addEventListener;
    const menu = { scrollEl: scroll, items: [] } as unknown as Menu;

    disableMenuHoverAutoScroll(menu);

    expect(scroll.style.overflowY).toBe('auto');
    expect(scroll.style.maxHeight).toBe('calc(100vh - 16px)');
    expect(scroll.style.overscrollBehavior).toBe('contain');

    const el = scroll as unknown as {
      addEventListener: (type: string, listener: unknown) => void;
    };
    el.addEventListener('mousemove', () => undefined);
    expect(nativeAdd).not.toHaveBeenCalled();
    el.addEventListener('click', () => undefined);
    expect(nativeAdd).toHaveBeenCalledTimes(1);
  });

  it('neutralises scrollIntoView on every item and submenu item', () => {
    const subItem = fakeItem();
    const submenu = { items: [subItem] } as unknown as Menu;
    const item = { ...fakeItem(), submenu };
    const menu = { scrollEl: fakeScroll(), items: [item] } as unknown as Menu;

    disableMenuHoverAutoScroll(menu);

    expect(() => item.dom.scrollIntoView()).not.toThrow();
    expect(() => subItem.dom.scrollIntoView()).not.toThrow();
  });

  it('leaves mobile menus untouched', () => {
    const scroll = fakeScroll();
    Object.defineProperty(globalThis, 'document', {
      value: { body: { classList: { contains: (c: string) => c === 'is-mobile' } } },
      configurable: true,
    });
    try {
      disableMenuHoverAutoScroll({ scrollEl: scroll, items: [] } as unknown as Menu);
      expect(scroll.style.overflowY).toBeUndefined();
      expect(scroll.addEventListener).not.toHaveBeenCalled();
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });
});
