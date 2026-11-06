/**
 * 选区浮出工具栏定位纯函数回归（思源 selectionElementPosition.test.ts 用例
 * 原值移植，2026-10-26）：上方优先、放不下翻下方、边界钳制、既有浮层避让。
 */

import { describe, expect, it } from 'vitest';
import {
  getSelectionElementAvailableHeight,
  getSelectionElementY,
} from '../src/interactions/formatToolbar';

const options = {
  elementHeight: 120,
  rangeTop: 300,
  rangeBottom: 320,
  topBoundary: 20,
  bottomBoundary: 700,
  gap: 4,
  isBottom: false,
};

describe('getSelectionElementY（思源移植）', () => {
  it('上方优先且空间充足时放选区上方', () => {
    // 300 - 120 - 4 = 176 ≥ topBoundary 20
    expect(getSelectionElementY(options)).toBe(176);
  });

  it('上方放不下时翻到选区下方', () => {
    expect(getSelectionElementY({ ...options, rangeTop: 100, rangeBottom: 120 })).toBe(124);
  });

  it('两侧都放不下时钳回下边界内（思源 min 分支）', () => {
    // aboveRange=-24 < topBoundary; min(belowRange=124, 200-120=80) = 80
    expect(
      getSelectionElementY({ ...options, rangeTop: 100, rangeBottom: 120, bottomBoundary: 200 }),
    ).toBe(80);
  });

  it('isBottom=true 优先下方', () => {
    expect(getSelectionElementY({ ...options, isBottom: true })).toBe(324);
  });
});

describe('getSelectionElementAvailableHeight（思源移植）', () => {
  it('无浮层时按选区两侧净空取大', () => {
    expect(getSelectionElementAvailableHeight(options)).toBe(376); // 700-320-4
  });

  it('上方有工具栏时顶部让位（思源用例原值）', () => {
    expect(getSelectionElementAvailableHeight({ ...options, toolbarTop: 260, toolbarBottom: 290 })).toBe(376);
  });
});
