// UndoStack 字节预算(2026-11-19):cap=100 对超大文档最坏 ~200MB/视图——
// 24MB 预算收敛快照数,小文档行为不变(cap 主导)。
import { describe, expect, it } from 'vitest';
import { UndoStack } from '../src/state/undoStack';

describe('UndoStack 字节预算', () => {
  it('小文档:cap 主导(100 份内不裁)', () => {
    const s = new UndoStack();
    for (let i = 0; i < 100; i++) s.push('x'.repeat(1000) + String(i).padStart(4, '0'));
    let undoable = 0;
    while (s.canUndo) {
      s.undoPop('cur');
      undoable++;
    }
    expect(undoable).toBe(100);
  });

  it('超大文档:预算收敛(2MB 快照只留 ~12 份,而非 100 份 200MB)', () => {
    const s = new UndoStack();
    const big = 'y'.repeat(1024 * 1024); // 1MB UTF-16 ≈ 2MB
    for (let i = 0; i < 100; i++) s.push(big + String(i).padStart(4, '0'));
    let undoable = 0;
    while (s.canUndo) {
      s.undoPop('cur');
      undoable++;
    }
    expect(undoable).toBeLessThanOrEqual(12);
    expect(undoable).toBeGreaterThanOrEqual(10);
  });

  it('undo→redo 链上 redoBuf 同样受预算约束', () => {
    const s = new UndoStack();
    const big = 'z'.repeat(1024 * 1024);
    for (let i = 0; i < 40; i++) s.push(big + String(i).padStart(4, '0'));
    // 全部 undo 掉,redoBuf 攒 40 份大快照 → redoPop 回灌 undoBuf 时被预算裁剪
    let redos = 0;
    while (s.canUndo) {
      s.undoPop('cur-' + redos);
      redos++;
    }
    let redone = 0;
    while (s.canRedo) {
      s.redoPop('cur2');
      redone++;
      if (redone > 60) break; // 防御:预算裁剪后 redo 有限
    }
    expect(redone).toBeLessThanOrEqual(15);
  });

  it('clear 清空字节计数', () => {
    const s = new UndoStack();
    s.push('a'.repeat(1000));
    s.clear();
    expect(s.canUndo).toBe(false);
    expect(s.canRedo).toBe(false);
    s.push('b');
    expect(s.canUndo).toBe(true);
  });

  it('相邻相同快照幂等(原语义保留)', () => {
    const s = new UndoStack();
    s.push('same');
    s.push('same');
    s.push('same');
    let n = 0;
    while (s.canUndo) {
      s.undoPop('x');
      n++;
    }
    expect(n).toBe(1);
  });
});
