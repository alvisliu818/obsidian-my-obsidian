import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dragOverScroll, stopScrollAnimation } from '../src/interactions/dragOverScroll';

/**
 * node 环境手搓 stub（jsdom 缺失——同 tableWidths.test.ts 惯例）：
 * rAF 收集 callback 由测试手动 tick 推进；element 只实现 scroll/scrollLeft/scrollTop。
 */

type RafCb = (t: number) => void;

const makeEl = (): { el: Element; scrolled: number[] } => {
  const state = { scrollTop: 0, scrollLeft: 0 };
  const scrolled: number[] = [];
  const el = {
    get scrollTop() { return state.scrollTop; },
    set scrollTop(v: number) { state.scrollTop = v; },
    get scrollLeft() { return state.scrollLeft; },
    set scrollLeft(v: number) { state.scrollLeft = v; },
    scroll(opts: { top?: number; left?: number }) {
      if (opts.left !== undefined) state.scrollLeft = opts.left;
      if (opts.top !== undefined) state.scrollTop = opts.top;
      scrolled.push(opts.left ?? opts.top ?? 0);
    },
  } as unknown as Element;
  return { el, scrolled };
};

describe('dragOverScroll', () => {
  let rafCbs: Map<number, RafCb>;
  let nextId: number;
  const tick = (t: number): void => {
    const snapshot = [...rafCbs.entries()];
    rafCbs.clear();
    for (const [, cb] of snapshot) cb(t);
  };

  beforeEach(() => {
    rafCbs = new Map();
    nextId = 0;
    (globalThis as { requestAnimationFrame: (cb: RafCb) => number }).requestAnimationFrame = (cb) => {
      nextId += 1;
      rafCbs.set(nextId, cb);
      return nextId;
    };
    (globalThis as { cancelAnimationFrame: (id: number) => void }).cancelAnimationFrame = (id) => {
      rafCbs.delete(id);
    };
    stopScrollAnimation();
  });

  afterEach(() => {
    stopScrollAnimation();
  });

  const RECT = { left: 0, right: 800, top: 0, bottom: 600 };

  it('pointer pressed into the bottom edge band starts a downward rAF scroll', () => {
    const { el, scrolled } = makeEl();
    dragOverScroll({ clientX: 400, clientY: RECT.bottom - 10 }, RECT, el);
    expect(rafCbs.size).toBe(1);
    tick(1000);
    tick(1064); // 64ms × space/64 = space px
    expect(scrolled.length).toBe(2);
    expect(scrolled[1]).toBeGreaterThan(scrolled[0]);
  });

  it('pointer pressed into the top edge band scrolls upward (negative space)', () => {
    const { el, scrolled } = makeEl();
    (el as unknown as { scrollTop: number }).scrollTop = 100;
    dragOverScroll({ clientX: 400, clientY: RECT.top + 10 }, RECT, el);
    tick(1000);
    tick(1064);
    const delta = scrolled[1] - scrolled[0];
    expect(delta).toBeLessThan(0);
  });

  it('deeper press = faster scroll (space scales with press depth)', () => {
    const a = makeEl();
    const b = makeEl();
    dragOverScroll({ clientX: 400, clientY: RECT.bottom - 20 }, RECT, a.el); // 4px 压深
    tick(1000); tick(1064);
    const dA = a.scrolled[1] - a.scrolled[0];
    stopScrollAnimation();

    dragOverScroll({ clientX: 400, clientY: RECT.bottom - 6 }, RECT, b.el); // 18px 压深
    tick(2000); tick(2064);
    const dB = b.scrolled[1] - b.scrolled[0];
    expect(dB).toBeCloseTo(dA * (18 / 4), 5);
  });

  it('pointer back inside the content area stops the animation', () => {
    const { el, scrolled } = makeEl();
    dragOverScroll({ clientX: 400, clientY: RECT.bottom - 10 }, RECT, el);
    tick(1000);
    expect(rafCbs.size).toBe(1); // 动画挂起
    dragOverScroll({ clientX: 400, clientY: 300 }, RECT, el); // 中部 → 停
    expect(rafCbs.size).toBe(0);
    const n = scrolled.length;
    tick(2000);
    expect(scrolled.length).toBe(n); // 再 tick 不滚
  });

  it('switching target element restarts the animation on the new element', () => {
    const a = makeEl();
    const b = makeEl();
    dragOverScroll({ clientX: 400, clientY: RECT.bottom - 10 }, RECT, a.el);
    tick(1000);
    dragOverScroll({ clientX: 400, clientY: RECT.bottom - 10 }, RECT, b.el);
    tick(1064);
    expect(a.scrolled.length).toBe(1); // 旧元素只滚了一帧
    expect(b.scrolled.length).toBe(1); // 新元素接管
    expect(rafCbs.size).toBe(1);
  });

  it('horizontal direction scrolls scrollLeft', () => {
    const { el, scrolled } = makeEl();
    dragOverScroll({ clientX: RECT.right - 8, clientY: 300 }, RECT, el, 'x');
    tick(1000); tick(1064);
    expect(scrolled.length).toBe(2);
    expect(scrolled[1]).toBeGreaterThan(scrolled[0]);
  });

  it('stopScrollAnimation cancels the pending frame', () => {
    const { el, scrolled } = makeEl();
    dragOverScroll({ clientX: 400, clientY: RECT.bottom - 10 }, RECT, el);
    tick(1000);
    stopScrollAnimation();
    const n = scrolled.length;
    tick(2000);
    expect(scrolled.length).toBe(n);
    expect(rafCbs.size).toBe(0);
  });

  it('pointer inside band but rAF already running for same element keeps single animation', () => {
    const { el, scrolled } = makeEl();
    dragOverScroll({ clientX: 400, clientY: RECT.bottom - 10 }, RECT, el);
    dragOverScroll({ clientX: 400, clientY: RECT.bottom - 4 }, RECT, el); // 同元素再触发
    expect(rafCbs.size).toBe(1);
    tick(1000); tick(1064);
    expect(scrolled.length).toBe(2); // 未重启，动画连续
  });
});
