/**
 * Snapshot-based undo/redo stack for block-level (structural) operations.
 * In-block text edits are handled by CM6's own history; the view pushes a
 * full serialized snapshot whenever a structural mutation (or a blur-commit
 * that changed text) happens.
 *
 * 内存预算(2026-11-19):cap=100 对小文档无感,但快照是全文串——2MB 文档
 * 的最坏驻留 ~200MB/视图。加 24MB 字节预算:超大文档按体积收敛快照数
 * (2MB 文档 ≈ 12 份),小文档行为不变。UTF-16 按 2 字节/字符粗算。
 */

const BYTE_BUDGET = 24 * 1024 * 1024;

export class UndoStack {
  private undoBuf: string[] = [];
  private redoBuf: string[] = [];
  private undoBytes = 0;
  private redoBytes = 0;
  constructor(private cap = 100) {}

  private static bytes(s: string): number {
    return s.length * 2;
  }

  private trimUndo(): void {
    while (this.undoBuf.length > 1 && (this.undoBuf.length > this.cap || this.undoBytes > BYTE_BUDGET)) {
      this.undoBytes -= UndoStack.bytes(this.undoBuf[0]);
      this.undoBuf.shift();
    }
  }

  push(snapshot: string): void {
    if (this.undoBuf[this.undoBuf.length - 1] === snapshot) return;
    this.undoBuf.push(snapshot);
    this.undoBytes += UndoStack.bytes(snapshot);
    this.trimUndo();
    this.redoBuf = [];
    this.redoBytes = 0;
  }

  get canUndo(): boolean {
    return this.undoBuf.length > 0;
  }

  get canRedo(): boolean {
    return this.redoBuf.length > 0;
  }

  /** Pop the previous snapshot; `current` is stashed for redo. */
  undoPop(current: string): string | null {
    const snap = this.undoBuf.pop();
    if (snap === undefined) return null;
    this.undoBytes -= UndoStack.bytes(snap);
    this.redoBuf.push(current);
    this.redoBytes += UndoStack.bytes(current);
    return snap;
  }

  /** Pop the next redo snapshot; `current` is stashed for undo. */
  redoPop(current: string): string | null {
    const snap = this.redoBuf.pop();
    if (snap === undefined) return null;
    this.redoBytes -= UndoStack.bytes(snap);
    this.undoBuf.push(current);
    this.undoBytes += UndoStack.bytes(current);
    this.trimUndo();
    return snap;
  }

  clear(): void {
    this.undoBuf = [];
    this.redoBuf = [];
    this.undoBytes = 0;
    this.redoBytes = 0;
  }
}
