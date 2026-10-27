import { describe, expect, it } from 'vitest';
import {
  capForIndex,
  planScrollRestore,
  scrollHeightReady,
  SCROLL_READY_MAX_TRIES,
  SCROLL_READY_TOLERANCE,
} from '../src/core/scrollRestore';

describe('planScrollRestore', () => {
  it('accepts a well-formed scroll state', () => {
    expect(planScrollRestore({ top: 2500, idx: 17 })).toEqual({ top: 2500, idx: 17 });
  });
  it('floors a fractional idx', () => {
    expect(planScrollRestore({ top: 100, idx: 3.7 })).toEqual({ top: 100, idx: 3 });
  });
  it('rejects non-object / missing fields', () => {
    expect(planScrollRestore(null)).toBeNull();
    expect(planScrollRestore(undefined)).toBeNull();
    expect(planScrollRestore('scroll')).toBeNull();
    expect(planScrollRestore({})).toBeNull();
    expect(planScrollRestore({ top: 100 })).toBeNull();
    expect(planScrollRestore({ idx: 3 })).toBeNull();
  });
  it('rejects negative / non-finite values', () => {
    expect(planScrollRestore({ top: -5, idx: 0 })).toBeNull();
    expect(planScrollRestore({ top: 0, idx: -1 })).toBeNull();
    expect(planScrollRestore({ top: Number.NaN, idx: 0 })).toBeNull();
    expect(planScrollRestore({ top: Number.POSITIVE_INFINITY, idx: 0 })).toBeNull();
    expect(planScrollRestore({ top: 10, idx: Number.NaN })).toBeNull();
    expect(planScrollRestore({ top: '2500', idx: 3 })).toBeNull();
    expect(planScrollRestore({ top: 2500, idx: '3' })).toBeNull();
  });
});

describe('capForIndex', () => {
  it('matches the ensureCapFor window formula', () => {
    expect(capForIndex(0, 150)).toBe(150);
    expect(capForIndex(149, 150)).toBe(299);
    expect(capForIndex(980, 150)).toBe(1130);
  });
});

describe('scrollHeightReady', () => {
  const CH = 640; // clientHeight
  it('ready when scrollable height covers the target', () => {
    expect(scrollHeightReady(10000, CH, 2500)).toBe(true);
  });
  it('ready within the tolerance band (target minus tolerance)', () => {
    // 可滚高度(scrollHeight - CH) = target - 容差 → 恰好达标
    expect(scrollHeightReady(2500 - SCROLL_READY_TOLERANCE + CH, CH, 2500)).toBe(true);
  });
  it('not ready below the tolerance band', () => {
    expect(scrollHeightReady(2500 - SCROLL_READY_TOLERANCE - 41 + CH, CH, 2500)).toBe(false);
  });
  it('short document never becomes ready (external shrink case)', () => {
    expect(scrollHeightReady(2000, CH, 2500)).toBe(false);
  });
  it('zero target is always ready', () => {
    expect(scrollHeightReady(CH, CH, 0)).toBe(true);
  });
});

describe('retry bound constant', () => {
  it('bounded so a shrunken doc cannot loop bumpScrollCap forever', () => {
    expect(SCROLL_READY_MAX_TRIES).toBeGreaterThan(0);
    expect(SCROLL_READY_MAX_TRIES).toBeLessThanOrEqual(20);
  });
});
