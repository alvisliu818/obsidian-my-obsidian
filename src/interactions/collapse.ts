/**
 * Block collapse state operations.
 * Collapse is persisted via the Logseq `collapsed:: true` block property.
 */

import type { Block } from '../types';
import { isCollapsed, setCollapsed } from '../types';

/**
 * True when EVERY level of b's subtree is folded (all children and deeper
 * descendants carry the collapsed state). The guide-line toggle expands only
 * a fully folded subtree; any unfolded level means the click folds instead.
 * Childless blocks are vacuously folded — collapseLevels never sets the flag
 * on them (nothing to hide), so requiring it here would jam the toggle.
 */
export function isSubtreeFullyFolded(b: Block): boolean {
  return b.children.every(
    (c) => c.children.length === 0 || (isCollapsed(c) && isSubtreeFullyFolded(c)),
  );
}

export function toggleCollapse(b: Block): void {
  setCollapsed(b, b.props['collapsed'] !== 'true');
}

/**
 * Guide-line fold: fold the content INSIDE the clicked block's guide — the
 * direct children (level 1) carry the collapsed property so their subtrees
 * hide while the children themselves stay visible as folded rows. The clicked
 * block itself is NOT folded. `levels` = how many levels carry the folded
 * state (direct children = level 1); 0 = all levels below the clicked block.
 * Blocks without children are skipped. Folding deeper than 1 means a later
 * expand reveals already-folded inner levels (drill-down).
 */
export function collapseLevels(root: Block, levels: number): void {
  const walk = (b: Block, depth: number) => {
    if (b.children.length === 0) return;
    setCollapsed(b, true);
    if (levels > 0 && depth >= levels) return;
    b.children.forEach((c) => walk(c, depth + 1));
  };
  root.children.forEach((c) => walk(c, 1));
}

/**
 * Guide-line unfold: clear the folded state down to `levels` levels below the
 * clicked block (direct children = level 1); 0 = all levels. The clicked
 * block itself is not touched here. Deeper blocks keep their own fold state,
 * so 1 = "open one step".
 */
export function expandLevels(root: Block, levels: number): void {
  const walk = (b: Block, depth: number) => {
    setCollapsed(b, false);
    if (levels > 0 && depth >= levels) return;
    b.children.forEach((c) => walk(c, depth + 1));
  };
  root.children.forEach((c) => walk(c, 1));
}

export function collapseAll(roots: Block[]): void {
  const walk = (b: Block) => {
    if (b.children.length > 0) {
      setCollapsed(b, true);
      b.children.forEach(walk);
    }
  };
  roots.forEach(walk);
}

export function expandAll(roots: Block[]): void {
  const walk = (b: Block) => {
    setCollapsed(b, false);
    b.children.forEach(walk);
  };
  roots.forEach(walk);
}
