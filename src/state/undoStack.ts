/**
 * Snapshot-based undo/redo stack for block-level (structural) operations.
 * In-block text edits are handled by CM6's own history; the view pushes a
 * full serialized snapshot whenever a structural mutation (or a blur-commit
 * that changed text) happens.
 */

export class UndoStack {
  private undoBuf: string[] = [];
  private redoBuf: string[] = [];
  constructor(private cap = 100) {}

  push(snapshot: string): void {
    if (this.undoBuf[this.undoBuf.length - 1] === snapshot) return;
    this.undoBuf.push(snapshot);
    if (this.undoBuf.length > this.cap) this.undoBuf.shift();
    this.redoBuf = [];
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
    this.redoBuf.push(current);
    return snap;
  }

  /** Pop the next redo snapshot; `current` is stashed for undo. */
  redoPop(current: string): string | null {
    const snap = this.redoBuf.pop();
    if (snap === undefined) return null;
    this.undoBuf.push(current);
    return snap;
  }

  clear(): void {
    this.undoBuf = [];
    this.redoBuf = [];
  }
}
