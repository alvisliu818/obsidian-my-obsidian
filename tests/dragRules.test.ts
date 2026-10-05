/**
 * Drag & drop rules: band resolution, legality, no-op detection, cross-file
 * planning. These are the decisions behind the interaction — the DOM wiring in
 * `interactions/dnd.ts` is not under test here, but every rule it consults is.
 */

import { describe, expect, it } from 'vitest';
import { createBlock, type Block } from '../src/types';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';
import {
  linkParents,
  moveBlock,
  prependChild,
  registerRoots,
  unregisterRoots,
} from '../src/core/treeOps';
import {
  AFTER_BAND,
  BEFORE_BAND,
  EDGE_ZONE_PX,
  MAX_SCROLL_STEP,
  REFUSAL_HINTS,
  bandAt,
  canDrop,
  canStartDrag,
  edgeDropTarget,
  edgeScrollStep,
  isNoopGroupMove,
  isNoopMove,
  planCrossFile,
  resolveBand,
  transferableBlocks,
} from '../src/features/dragRules';

/** roots: [a, b, c] with a child under b. Registered so top-level siblings resolve. */
function tree(): { roots: Block[]; a: Block; b: Block; b1: Block; c: Block } {
  const a = createBlock('a');
  const b = createBlock('b');
  const b1 = createBlock('b1');
  const c = createBlock('c');
  b.children.push(b1);
  const roots = [a, b, c];
  linkParents(roots);
  // moveBlock/removeBlock resolve a top-level block's container through this
  // registry — without it they operate on an empty list and silently no-op.
  registerRoots(roots);
  return { roots, a, b, b1, c };
}

describe('bandAt', () => {
  const rect = { top: 100, height: 40 }; // 100..140

  it('splits the row into before / child / after', () => {
    expect(bandAt(100, rect)).toBe('before');
    expect(bandAt(100 + rect.height * BEFORE_BAND - 1, rect)).toBe('before');
    expect(bandAt(120, rect)).toBe('child');
    expect(bandAt(100 + rect.height * AFTER_BAND + 1, rect)).toBe('after');
    expect(bandAt(140, rect)).toBe('after');
  });

  it('degrades the middle band to `after` for a raw block', () => {
    // A verbatim block cannot hold children — dropping "into" a table would
    // have nowhere to put the dragged subtree.
    expect(bandAt(120, rect, 'raw')).toBe('after');
    expect(bandAt(120, rect, 'list')).toBe('child');
  });

  it('never divides by zero', () => {
    expect(bandAt(100, { top: 100, height: 0 })).toBe('after');
    expect(bandAt(100, { top: 100, height: -5 })).toBe('after');
  });
});

describe('canDrop', () => {
  it('refuses without a source or a target', () => {
    const { c } = tree();
    expect(canDrop([], c)).toEqual({ ok: false, reason: 'no-source' });
    expect(canDrop([createBlock('x')], null)).toEqual({ ok: false, reason: 'no-source' });
  });

  it('refuses self and own descendants', () => {
    const { b, b1 } = tree();
    expect(canDrop([b], b)).toEqual({ ok: false, reason: 'self' });
    expect(canDrop([b], b1)).toEqual({ ok: false, reason: 'own-descendant' });
    // The other direction is fine: dropping a parent onto its own child is
    // the "move out" case only when the child is not inside the payload.
    expect(canDrop([b1], b).ok).toBe(true);
  });

  it('refuses a target that is another member of the same drag group', () => {
    const { a, b } = tree();
    const group = [a, b];
    // Dragging [a] with group [a, b] onto b would move b inside the payload.
    expect(canDrop([a], b, group)).toEqual({ ok: false, reason: 'in-drag-group' });
    // Dragging the group as a whole onto an outsider is fine.
    expect(canDrop(group, tree().c, group).ok).toBe(true);
  });

  it('allows a legal move', () => {
    const { a, c } = tree();
    expect(canDrop([a], c)).toEqual({ ok: true });
  });

  it('has a hint for every refusal', () => {
    for (const reason of Object.keys(REFUSAL_HINTS) as (keyof typeof REFUSAL_HINTS)[]) {
      expect(REFUSAL_HINTS[reason].length).toBeGreaterThan(0);
    }
  });
});

describe('isNoopMove', () => {
  it('detects a drop that changes nothing', () => {
    const { a, b, c } = tree();
    // a is immediately before b
    expect(isNoopMove(a, b, 'before')).toBe(true);
    expect(isNoopMove(b, a, 'after')).toBe(true);
    // b's first child is b1, so dropping b before b1 is a no-op
    const b1 = b.children[0];
    expect(isNoopMove(b1, b, 'child')).toBe(true);
    expect(isNoopMove(a, c, 'before')).toBe(false);
    expect(isNoopMove(a, c, 'after')).toBe(false);
  });
});

describe('isNoopGroupMove', () => {
  it('refuses only when EVERY member is stationary', () => {
    // roots: [a, b, c] — `c` already sits directly after `b`.
    const { a, b, c } = tree();
    expect(isNoopGroupMove([c], b, 'after')).toBe(true);
    // Adding `a` makes the drop meaningful again: the group as a whole
    // reorders to [b, a, c]. Refusing here because `c` alone is a no-op is
    // what made a legal group drag silently do nothing.
    expect(isNoopGroupMove([a, c], b, 'after')).toBe(false);
  });

  it('treats an empty payload as nothing to do', () => {
    const { b } = tree();
    expect(isNoopGroupMove([], b, 'after')).toBe(true);
  });

  it('agrees with the single-block rule for one member', () => {
    const { a, b, c } = tree();
    for (const pos of ['before', 'after', 'child'] as const) {
      expect(isNoopGroupMove([a], c, pos)).toBe(isNoopMove(a, c, pos));
    }
    void b;
  });
});

describe('canStartDrag', () => {
  it('needs something to carry', () => {
    expect(canStartDrag(createBlock('text'))).toBe(true);
    expect(canStartDrag(createBlock(''))).toBe(false);
    const parent = createBlock('');
    parent.children.push(createBlock('child'));
    expect(canStartDrag(parent)).toBe(true);
    expect(canStartDrag(null)).toBe(false);
  });
});

describe('transferableBlocks', () => {
  it('never carries the page-properties block across files', () => {
    const normal = createBlock('note');
    const fm = createBlock('title: x');
    fm.frontmatter = true;
    expect(transferableBlocks([normal, fm])).toEqual([normal]);
  });
});

describe('planCrossFile', () => {
  it('flags a same-file drag as a plain reorder', () => {
    expect(planCrossFile('a.md', 'a.md').same).toBe(true);
    expect(planCrossFile('a.md', 'b.md')).toEqual({ fromPath: 'a.md', toPath: 'b.md', same: false });
  });
});

describe('group move keeps the document consistent', () => {
  it('moving two siblings together lands them in original order', () => {
    const { roots, a, b, c } = tree();
    for (const blk of [a, b]) moveBlock(blk, c, 'before');
    expect(roots.map((r) => r.text)).toEqual(['a', 'b', 'c']);
    unregisterRoots(roots);
  });

  it('moving a parent and its child together keeps both', () => {
    const { roots, b, b1, c } = tree();
    // Outermost first, exactly how dropBlocks orders the payload.
    moveBlock(b, c, 'after');
    moveBlock(b1, b, 'child');
    expect(roots.map((r) => r.text)).toEqual(['a', 'c', 'b']);
    expect(b.children.map((r) => r.text)).toEqual(['b1']);
    unregisterRoots(roots);
  });

  it('refuses to move a block into its own descendant', () => {
    const { roots, b, b1 } = tree();
    expect(moveBlock(b, b1, 'child')).toBe(false);
    expect(b.children.map((c) => c.text)).toEqual(['b1']);
    unregisterRoots(roots);
  });
});

describe('prependChild', () => {
  it('keeps parent pointers in sync', () => {
    const { roots, b, c } = tree();
    prependChild(b, c);
    expect(c.parent).toBe(b);
    expect(b.children[0]).toBe(c);
    unregisterRoots(roots);
  });
});

describe('edgeScrollStep', () => {
  const rect = { top: 0, height: 600 };

  it('is zero away from the edges', () => {
    expect(edgeScrollStep(300, rect)).toBe(0);
    expect(edgeScrollStep(EDGE_ZONE_PX, rect)).toBe(0);
    expect(edgeScrollStep(600 - EDGE_ZONE_PX, rect)).toBe(0);
  });

  it('scrolls up above the top zone and down below the bottom one', () => {
    expect(edgeScrollStep(10, rect)).toBeLessThan(0);
    expect(edgeScrollStep(590, rect)).toBeGreaterThan(0);
  });

  it('ramps up to the cap at the very edge and never past it', () => {
    expect(edgeScrollStep(0, rect)).toBe(-MAX_SCROLL_STEP);
    expect(edgeScrollStep(600, rect)).toBe(MAX_SCROLL_STEP);
    expect(Math.abs(edgeScrollStep(5, rect))).toBeLessThanOrEqual(MAX_SCROLL_STEP);
  });

  it('is monotonic — further in means faster', () => {
    const near = Math.abs(edgeScrollStep(20, rect));
    const far = Math.abs(edgeScrollStep(2, rect));
    expect(far).toBeGreaterThan(near);
  });
});

describe('edgeDropTarget', () => {
  it('appends after the last block when dropped below the outline', () => {
    const { roots, a, c } = tree();
    const rect = { top: 0, height: 400 };
    expect(edgeDropTarget(roots, rect, 399)).toEqual({ target: c, pos: 'after' });
    expect(a).toBe(roots[0]);
    unregisterRoots(roots);
  });

  it('inserts before the first block when dropped in the upper empty area', () => {
    const { roots, a } = tree();
    expect(edgeDropTarget(roots, { top: 0, height: 400 }, 10)).toEqual({
      target: a,
      pos: 'before',
    });
    unregisterRoots(roots);
  });

  it('has no target for an empty page or a collapsed rect', () => {
    expect(edgeDropTarget([], { top: 0, height: 400 }, 200)).toBe(null);
    const { roots } = tree();
    expect(edgeDropTarget(roots, { top: 0, height: 0 }, 200)).toBe(null);
    unregisterRoots(roots);
  });

  it('honours zoom: only the visible roots are offered', () => {
    const { roots, b } = tree();
    // Zoomed into b, the visible outline is b's subtree only.
    const zoomed = [b];
    expect(edgeDropTarget(zoomed, { top: 0, height: 400 }, 399)).toEqual({
      target: b,
      pos: 'after',
    });
    unregisterRoots(roots);
  });
});

// ---------------------------------------------------------------------------
// Verbatim blocks: the format cannot nest them, so the drop must not try.
// ---------------------------------------------------------------------------

/** A verbatim block: the serializer writes its text with no indentation. */
function verbatim(text = '| A | B |\n| --- | --- |\n| 1 | 2 |'): Block {
  const b = createBlock(text);
  b.kind = 'raw';
  return b;
}

describe('resolveBand', () => {
  it('keeps the ordinary three bands for a list payload', () => {
    const { roots, a, c } = tree();
    const list = createBlock('list payload');
    expect(resolveBand('before', a, [list])).toBe('before');
    expect(resolveBand('child', a, [list])).toBe('child');
    expect(resolveBand('after', c, [list])).toBe('after');
    unregisterRoots(roots);
  });

  it('degrades the middle band to `after` when nesting a verbatim block', () => {
    const { roots, a } = tree();
    // The user aimed at the row; "just below it" is a legal, useful reading.
    expect(resolveBand('child', a, [verbatim()])).toBe('after');
    unregisterRoots(roots);
  });

  it('allows a verbatim block as a ROOT-level sibling', () => {
    const { roots, a, c } = tree();
    expect(resolveBand('before', a, [verbatim()])).toBe('before');
    expect(resolveBand('after', c, [verbatim()])).toBe('after');
    unregisterRoots(roots);
  });

  it('refuses any placement under a nested target', () => {
    // Nesting a verbatim block — even as a SIBLING of a nested bullet — writes
    // it flush-left, so it re-parses as a root block and the outline is
    // reordered. There is no legal position, so the drop is refused.
    const { roots, b, b1 } = tree();
    expect(resolveBand('before', b1, [verbatim()])).toBe(null);
    expect(resolveBand('after', b1, [verbatim()])).toBe(null);
    expect(resolveBand('child', b1, [verbatim()])).toBe(null);
    // Refusing must leave the outline exactly as it was.
    expect(roots.map((r) => r.text)).toEqual(['a', 'b', 'c']);
    expect(b.children.map((r) => r.text)).toEqual(['b1']);
    unregisterRoots(roots);
  });

  it('one verbatim member is enough to constrain the whole payload', () => {
    const { roots, a } = tree();
    expect(resolveBand('child', a, [createBlock('list'), verbatim()])).toBe('after');
    expect(resolveBand('child', b1Of(roots), [verbatim(), createBlock('x')])).toBe(null);
    unregisterRoots(roots);
  });

  it('refuses an edge drop onto a ZOOMED outline, whose roots have a parent', () => {
    // While zoomed, `visibleRoots` is `zoomed.children` — not the document
    // root list. Its members have `parent = zoomed`, so the empty-space drop
    // path would otherwise append a verbatim block BELOW the root level, where
    // `serializeBlock` writes it flush-left and it re-parses as a root block.
    // `edgeDropFor` has to run the edge band through resolveBand for this.
    const { roots, b } = tree();
    const zoomedChild = b.children[0];
    expect(zoomedChild.parent).toBe(b);
    expect(resolveBand('after', zoomedChild, [verbatim()])).toBe(null);
    expect(resolveBand('before', zoomedChild, [verbatim()])).toBe(null);
    unregisterRoots(roots);
  });
});

/** The first child of the second root, or a throwaway block. */
function b1Of(roots: Block[]): Block {
  return roots[1]?.children[0] ?? createBlock('fallback');
}

describe('verbatim blocks survive a drag that only moves them sideways', () => {
  it('a root-level move round-trips through the file unchanged', () => {
    const doc = parseDocument('- parent\n- sibling\n');
    registerRoots(doc.blocks);
    const table = verbatim();
    // The drop: table lands between the two root blocks.
    doc.blocks.splice(1, 0, table);
    linkParents(doc.blocks);
    const re = parseDocument(serializeDocument(doc));
    // Still three roots, still a verbatim block in the middle, text intact.
    expect(re.blocks.map((b) => b.kind)).toEqual(['list', 'raw', 'list']);
    expect(re.blocks[1].text).toBe(table.text);
    expect(re.blocks[1].children).toEqual([]);
    unregisterRoots(doc.blocks);
  });
});
