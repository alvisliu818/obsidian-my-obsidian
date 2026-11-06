// 块选择模式键分类:Alt+Shift+↑↓ 扩选同义键(思源 expandUp/Down 键位)
// 与既有裸键面的边界。
import { describe, expect, it } from 'vitest';
import { classifySelectionModeKey, classifyGlobalKey } from './hotkeys';

const mod = (o: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}) => ({
  ctrl: false,
  meta: false,
  shift: false,
  alt: false,
  ...o,
});

describe('classifySelectionModeKey(选择态键面)', () => {
  it('Alt+Shift+↑↓ → 扩选(思源 expandUp/Down 键位的同义扩展)', () => {
    expect(classifySelectionModeKey('ArrowUp', mod({ alt: true, shift: true }))).toEqual({ kind: 'extend', dir: -1 });
    expect(classifySelectionModeKey('ArrowDown', mod({ alt: true, shift: true }))).toEqual({ kind: 'extend', dir: 1 });
  });

  it('Alt 无 Shift 不接管(Alt+↑↓ 是跳块键)', () => {
    expect(classifySelectionModeKey('ArrowUp', mod({ alt: true }))).toEqual({ kind: 'none' });
    expect(classifySelectionModeKey('ArrowDown', mod({ alt: true }))).toEqual({ kind: 'none' });
  });

  it('Mod 组合不接管', () => {
    expect(classifySelectionModeKey('ArrowUp', mod({ ctrl: true, alt: true, shift: true }))).toEqual({ kind: 'none' });
    expect(classifySelectionModeKey('ArrowDown', mod({ meta: true, alt: true, shift: true }))).toEqual({ kind: 'none' });
  });

  it('Shift+↑↓ 扩选原语义不变', () => {
    expect(classifySelectionModeKey('ArrowUp', mod({ shift: true }))).toEqual({ kind: 'extend', dir: -1 });
    expect(classifySelectionModeKey('ArrowDown', mod({ shift: true }))).toEqual({ kind: 'extend', dir: 1 });
  });
});

describe('classifyGlobalKey(Ctrl+A 二段式的全局侧)', () => {
  it('非编辑态有选中时 Mod+a → bulk select-all(bulkSelection 开;无选中时不接管——先用点击起选)', () => {
    expect(classifyGlobalKey('a', mod({ ctrl: true }), { hasSelection: true, editing: false })).toEqual({
      kind: 'bulk',
      op: 'select-all',
    });
    expect(classifyGlobalKey('a', mod({ ctrl: true }), { hasSelection: false, editing: false })).toEqual({
      kind: 'none',
    });
  });

  it('编辑态 Mod+a 不归全局(第一段归 CM 文本全选,第二段由块键面接管)', () => {
    expect(classifyGlobalKey('a', mod({ ctrl: true }), { hasSelection: true, editing: true })).toEqual({ kind: 'none' });
  });
});
