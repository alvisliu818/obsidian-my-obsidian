/**
 * Drag & drop rules — pure logic, no DOM.
 *
 * The interaction itself lives in `interactions/dnd.ts`; everything that is a
 * *decision* rather than a side effect lives here so it can be unit-tested:
 * which band of a target row the pointer is in, whether a drop is legal at all,
 * and what a cross-file move means for both documents.
 *
 * Three-band drop zones (Logseq parity):
 *   - top 25%    → insert before (same level)
 *   - bottom 25% → insert after (same level)
 *   - middle 50% → insert as first child
 *
 * Pure logic — no obsidian import.
 */

import type { Block } from '../types';
import { isDescendant, siblingsOf, type MovePosition } from '../core/treeOps';

export type DropBand = MovePosition;

export interface Rect {
  top: number;
  height: number;
}

/** Fractions of the target row that map to before / child / after. */
export const BEFORE_BAND = 0.25;
export const AFTER_BAND = 0.75;

/**
 * Which drop zone a viewport Y coordinate falls in.
 *
 * A `raw` (verbatim) block cannot host children, so its middle band degrades
 * to `after` — dropping "into" a table would have nowhere to put the block and
 * would silently drop the subtree on the next save.
 */
export function bandAt(clientY: number, rect: Rect, kind: Block['kind'] = 'list'): DropBand {
  if (rect.height <= 0) return 'after';
  const rel = (clientY - rect.top) / rect.height;
  if (rel < BEFORE_BAND) return 'before';
  if (rel > AFTER_BAND) return 'after';
  return kind === 'list' ? 'child' : 'after';
}

/**
 * Resolve the actual drop band, downgrading or refusing illegal ones.
 *
 * A **verbatim** payload is the constrained case, and it is a property of the
 * file format rather than of the editor:
 *
 *  - `serializeBlock` emits a raw block's text with no indentation. A raw
 *    block that ends up NESTED — as a child, or even as a sibling of a nested
 *    bullet — is written flush-left, and re-parsing yields a *root* block. The
 *    block silently escapes the position it was dropped on, and the outline
 *    around it is reordered.
 *  - Indenting it instead does not help: the parser folds an indented non-list
 *    region into the parent block's text as soft lines, so the block's own
 *    identity disappears rather than nesting.
 *
 * There is no encoding of "verbatim block below the root level" in this
 * format. So a verbatim payload may only land as a **root-level sibling**:
 *
 *  - target has no parent  → `before` / `after` is legal, `child` degrades to
 *    `after` (the user aimed at the row, and "just below it" is what they meant)
 *  - target is nested      → null: there is no legal position, the drop is
 *    refused rather than allowed to corrupt the outline
 *
 * A list payload keeps the ordinary three-band behaviour.
 */
export function resolveBand(
  band: DropBand,
  target: Block,
  dragged: readonly Block[],
): DropBand | null {
  const verbatim = dragged.some((b) => b.kind === 'raw');
  if (!verbatim) {
    if (band !== 'child') return band;
    return target.kind === 'list' ? 'child' : 'after';
  }
  if (target.parent !== null) return null;
  return band === 'child' ? 'after' : band;
}

/** Why a drop was refused — surfaced as a cursor / no-op, never silent. */
export type DropRefusal = 'no-source' | 'self' | 'own-descendant' | 'in-drag-group' | 'same-place';

export interface DropCheck {
  ok: boolean;
  reason?: DropRefusal;
}

/**
 * Is dropping `dragged` onto `target` legal?
 *
 * Beyond the obvious self/descendant rules, a *group* drag (multi-selection)
 * must not accept any of its own members as a target: they are already part of
 * the payload and would be moved twice.
 */
export function canDrop(
  dragged: readonly Block[],
  target: Block | null,
  group: readonly Block[] = dragged,
): DropCheck {
  if (dragged.length === 0) return { ok: false, reason: 'no-source' };
  if (!target) return { ok: false, reason: 'no-source' };
  if (dragged.includes(target)) return { ok: false, reason: 'self' };
  // Dropping a subtree into itself would detach the subtree from the document.
  for (const d of dragged) {
    if (isDescendant(d, target)) return { ok: false, reason: 'own-descendant' };
  }
  // Another member of the same drag group is not a destination.
  if (group.length > 1 && group.includes(target) && !dragged.includes(target)) {
    return { ok: false, reason: 'in-drag-group' };
  }
  return { ok: true };
}

/**
 * Would this move land the block exactly where it already is? A no-op drop
 * still costs a re-render, and the indicator flashing then nothing happening
 * reads as a bug.
 */
export function isNoopMove(b: Block, target: Block, pos: DropBand): boolean {
  if (pos === 'child') return b.parent === target && target.children[0] === b;
  // siblingsOf, not b.parent?.children: a top-level block has no parent, and
  // its container array is only reachable through the treeOps registry.
  const sibs = siblingsOf(b);
  const i = sibs.indexOf(b);
  if (i < 0) return false;
  // "before target" is a no-op when target already sits directly after b;
  // "after target" is a no-op when target already sits directly before b.
  if (pos === 'before') return sibs[i + 1] === target;
  if (pos === 'after') return sibs[i - 1] === target;
  return false;
}

/**
 * Is a GROUP drop a no-op?
 *
 * Every member has to be a no-op, not just one of them. In `[a, b, c]` a drag
 * of `[a, c]` onto `b`'s after-band leaves `c` exactly where it was, but `a`
 * still has to travel — and the group as a whole produces a different order
 * (`[b, a, c]`). Refusing because *some* member is stationary makes a legal,
 * meaningful drop silently do nothing, which is exactly the "the indicator
 * flashed and nothing happened" symptom `isNoopMove` exists to prevent.
 */
export function isNoopGroupMove(
  dragged: readonly Block[],
  target: Block,
  pos: DropBand,
): boolean {
  if (dragged.length === 0) return true;
  return dragged.every((b) => isNoopMove(b, target, pos));
}

/**
 * Can this block start a drag at all? An empty block with no children has
 * nothing to move.
 *
 * The parentheses are load-bearing: `&&` binds tighter than `||`, so the
 * unparenthesised form reads as "has text, or (is non-null and has children)"
 * — which happens to be equivalent today, but the moment a second `||` term
 * is added it stops being. Written out so the intent survives editing.
 */
export function canStartDrag(b: Block | null): b is Block {
  if (!b) return false;
  return b.text.trim() !== '' || b.children.length > 0;
}

// ---------------------------------------------------------------------------
// Cross-file moves
// ---------------------------------------------------------------------------

/**
 * A drop that crosses files: the block is *cut* from the source document and
 * *pasted* into the target's. Both documents are mutated, so the caller must
 * mark both dirty — forgetting the source is how a duplicate appears.
 */
export interface CrossFilePlan {
  /** File the blocks leave. */
  fromPath: string;
  /** File the blocks land in. */
  toPath: string;
  /** True when source and target are the same note (a plain reorder). */
  same: boolean;
}

export function planCrossFile(fromPath: string, toPath: string): CrossFilePlan {
  return { fromPath, toPath, same: fromPath === toPath };
}

/**
 * Which of the dragged blocks survive a move into `toPath`?
 *
 * A `raw` (verbatim) block is the whole top-level region it lives in, so
 * moving one into another page is fine — but a *page-properties* block is
 * bound to its file's frontmatter and must never travel.
 */
export function transferableBlocks(blocks: readonly Block[]): Block[] {
  return blocks.filter((b) => !b.frontmatter);
}

/** The message shown when a drag is refused for a stated reason. */
export const REFUSAL_HINTS: Record<DropRefusal, string> = {
  'no-source': 'Nothing to drop here',
  self: 'A block cannot be dropped on itself',
  'own-descendant': 'A block cannot be dropped inside itself',
  'in-drag-group': 'That block is part of the same drag',
  'same-place': 'Already there',
};

// ---------------------------------------------------------------------------
// Auto-scroll while dragging
// ---------------------------------------------------------------------------

/** Distance from the container edge where auto-scroll kicks in, in px. */
export const EDGE_ZONE_PX = 56;
/** Fastest scroll step, in px per frame. */
export const MAX_SCROLL_STEP = 18;

/**
 * Pixels to scroll per animation frame for a pointer inside `rect`.
 *
 * Negative scrolls up, positive down, 0 means "outside the edge zones" — the
 * caller then stops the loop. Magnitude ramps linearly from 0 at the zone
 * boundary to MAX_SCROLL_STEP right at the container edge, so a drag that
 * merely grazes the edge does not jerk.
 */
export function edgeScrollStep(clientY: number, rect: Rect): number {
  const intoTop = rect.top + EDGE_ZONE_PX - clientY;
  if (intoTop > 0) {
    return -Math.min(MAX_SCROLL_STEP, Math.ceil((intoTop / EDGE_ZONE_PX) * MAX_SCROLL_STEP));
  }
  const intoBottom = clientY - (rect.top + rect.height - EDGE_ZONE_PX);
  if (intoBottom > 0) {
    return Math.min(MAX_SCROLL_STEP, Math.ceil((intoBottom / EDGE_ZONE_PX) * MAX_SCROLL_STEP));
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Dropping on empty space (the area below the last block)
// ---------------------------------------------------------------------------

export interface EdgeDrop {
  target: Block;
  pos: DropBand;
}

/**
 * Where a drop that lands on NO block should go: above the outline's midpoint
 * inserts before the first visible block, below it appends after the last.
 *
 * Without this the empty area under a short page is a dead zone — there is no
 * way to append a block to the end of the note by dragging.
 */
export function edgeDropTarget(
  roots: readonly Block[],
  rect: Rect,
  clientY: number,
): EdgeDrop | null {
  if (roots.length === 0 || rect.height <= 0) return null;
  const first = roots[0];
  const last = roots[roots.length - 1];
  if (!first || !last) return null;
  return clientY < rect.top + rect.height / 2
    ? { target: first, pos: 'before' }
    : { target: last, pos: 'after' };
}
