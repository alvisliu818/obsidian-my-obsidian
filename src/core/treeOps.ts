/**
 * Pure tree operations on the block forest.
 * All functions mutate the tree in place while keeping `parent` pointers
 * consistent; they never touch the DOM or Obsidian APIs (unit-testable).
 */

import { Block, Marker, MARKERS, createBlock, ensureId } from '../types';

export function siblingsOf(b: Block): Block[] {
  if (b.parent) return b.parent.children;
  // Top-level block: resolve its container array via the registry below.
  const cached = forestRootsCache.get(b);
  if (cached) return cached;
  // Last-node indent fix: blocks CREATED or PROMOTED after the last
  // registerRoots call (Enter/split at the end of the page, outdent/move to
  // top level) have no cache entry — scan the registered root arrays for
  // structural membership instead of silently returning [].
  for (const arr of rootArrays) {
    const hit = findListContaining(arr, b);
    if (hit) {
      forestRootsCache.set(b, hit);
      return hit;
    }
  }
  return [];
}

/** Depth-first search for the sibling list that contains b. */
function findListContaining(list: Block[], b: Block): Block[] | null {
  if (list.includes(b)) return list;
  for (const r of list) {
    const hit = findListContaining(r.children, b);
    if (hit) return hit;
  }
  return null;
}

/** Every root array the view has registered (strong refs, view-lifetime). */
const rootArrays = new Set<Block[]>();

/** Side-channel mapping root block -> top-level array it lives in (set by the view). */
const forestRootsCache = new WeakMap<Block, Block[]>();

export function registerRoots(roots: Block[]): void {
  rootArrays.add(roots);
  for (const r of roots) forestRootsCache.set(r, roots);
}

export function unregisterRoots(roots: Block[]): void {
  rootArrays.delete(roots);
  for (const r of roots) forestRootsCache.delete(r);
}

export function findBlockById(roots: Block[], id: string): Block | null {
  for (const r of roots) {
    const hit = findBlockIn(r, id);
    if (hit) return hit;
  }
  return null;
}

function findBlockIn(b: Block, id: string): Block | null {
  if (b.props['id'] === id && id !== '') return b;
  for (const c of b.children) {
    const hit = findBlockIn(c, id);
    if (hit) return hit;
  }
  return null;
}

export function pathToRoot(b: Block): Block[] {
  const chain: Block[] = [];
  let cur: Block | null = b;
  while (cur) {
    chain.unshift(cur);
    cur = cur.parent;
  }
  return chain;
}

/**
 * Walk a child-index path down from `root` (`[]` = the root itself).
 * Used to address blocks of an embedded sub-tree, which may have no id.
 * Returns null when the path does not resolve (structure changed).
 */
export function blockAtPath(root: Block, path: number[]): Block | null {
  let b: Block | null = root;
  for (const i of path) {
    b = b?.children[i] ?? null;
  }
  return b;
}

export function isDescendant(ancestor: Block, b: Block): boolean {
  let cur: Block | null = b;
  while (cur) {
    if (cur === ancestor) return true;
    cur = cur.parent;
  }
  return false;
}

/** Flattened visible block sequence (collapsed sub-trees skipped). */
export function flattenVisible(roots: Block[]): Block[] {
  const out: Block[] = [];
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      out.push(b);
      const collapsed = b.props['collapsed'] === 'true';
      if (!collapsed) walk(b.children);
    }
  };
  walk(roots);
  return out;
}

export function nextVisible(roots: Block[], b: Block): Block | null {
  const seq = flattenVisible(roots);
  const idx = seq.indexOf(b);
  return idx >= 0 && idx + 1 < seq.length ? seq[idx + 1] : null;
}

export function prevVisible(roots: Block[], b: Block): Block | null {
  const seq = flattenVisible(roots);
  const idx = seq.indexOf(b);
  return idx > 0 ? seq[idx - 1] : null;
}

export function insertAfter(target: Block, b: Block): void {
  const sibs = siblingsOf(target);
  const idx = sibs.indexOf(target);
  sibs.splice(idx + 1, 0, b);
  b.parent = target.parent;
}

export function insertBefore(target: Block, b: Block): void {
  const sibs = siblingsOf(target);
  const idx = sibs.indexOf(target);
  sibs.splice(idx, 0, b);
  b.parent = target.parent;
}

/** Append as last child of parent. */
export function appendChild(parent: Block, b: Block): void {
  parent.children.push(b);
  b.parent = parent;
}

/** Insert as first child of parent. */
export function prependChild(parent: Block, b: Block): void {
  parent.children.unshift(b);
  b.parent = parent;
}

export function removeBlock(b: Block): Block[] {
  const sibs = siblingsOf(b);
  const idx = sibs.indexOf(b);
  if (idx >= 0) sibs.splice(idx, 1);
  b.parent = null;
  return sibs;
}

/**
 * Indent: block becomes the last child of its previous sibling.
 * Returns false when there is no previous sibling (already first).
 *
 * Last-node fix: for a top-level block whose roots array is NOT in the
 * registry (e.g. the view replaced `doc.blocks` and render() has not yet
 * re-registered, or the block was created after clear()), the previous
 * sibling can still be resolved structurally: ask the caller's array —
 * here we accept an optional `roots` hint and fall back to scanning the
 * registry chain. Without a hint and without registration we must bail out
 * (return false) WITHOUT corrupting anything.
 */
export function indent(b: Block, roots?: Block[]): boolean {
  const sibs = roots ? (siblingsIn(b, roots) ?? []) : siblingsOf(b);
  const idx = sibs.indexOf(b);
  if (idx <= 0) return false;
  const prev = sibs[idx - 1];
  sibs.splice(idx, 1);
  prev.children.push(b);
  b.parent = prev;
  return true;
}

/** Resolve the sibling array of b by scanning `roots` (structure-first, no registry). */
function siblingsIn(b: Block, roots: Block[]): Block[] | null {
  if (b.parent) return b.parent.children;
  const walk = (list: Block[]): Block[] | null => {
    if (list.includes(b)) return list;
    for (const r of list) {
      const hit = walk(r.children);
      if (hit) return hit;
    }
    return null;
  };
  return walk(roots);
}

/**
 * Outdent: block becomes the next sibling of its parent.
 * Returns false at top level.
 */
export function outdent(b: Block): boolean {
  const parent = b.parent;
  if (!parent) return false;
  const idx = parent.children.indexOf(b);
  parent.children.splice(idx, 1);
  insertAfter(parent, b);
  return true;
}

/**
 * Split block at text offset: current block keeps [0, offset),
 * a new sibling gets [offset, end). Children stay with the current block
 * (Logseq behavior: children stay under the first half).
 * Returns the new block.
 */
export function splitBlock(b: Block, offset: number): Block {
  const text = b.text;
  const head = text.slice(0, offset);
  const tail = text.slice(offset);
  b.text = head;
  const nb = createBlock(tail);
  insertAfter(b, nb);
  return nb;
}

/**
 * Merge block into the previous visible block (Backspace at block start).
 * - text is appended to the previous block's text.
 * - children are re-parented after the previous block (as its trailing children).
 * Returns the previous block (caret should move to the join point), or null
 * when there is no previous visible block.
 */
export function mergeWithPrev(roots: Block[], b: Block): Block | null {
  const prev = prevVisible(roots, b);
  if (!prev) return null;
  const joinOffset = prev.text.length;
  prev.text += b.text;
  // Move children of b to the end of prev's children.
  const kids = b.children.slice();
  for (const k of kids) {
    prev.children.push(k);
    k.parent = prev;
  }
  b.children = [];
  removeBlock(b);
  void joinOffset; // caller recomputes caret after DOM re-render
  return prev;
}

export type MovePosition = 'before' | 'after' | 'child';

/**
 * Move block relative to target. Rejects illegal moves (into itself/descendant).
 * Returns true on success.
 */
export function moveBlock(b: Block, target: Block, pos: MovePosition): boolean {
  if (b === target) return false;
  if (isDescendant(b, target)) return false;
  removeBlock(b);
  if (pos === 'before') insertBefore(target, b);
  else if (pos === 'after') insertAfter(target, b);
  else prependChild(target, b);
  return true;
}

/**
 * Move block up/down among visible sequence (Ctrl+Shift+Arrow).
 * Returns true on success.
 */
export function moveBlockVertically(roots: Block[], b: Block, dir: -1 | 1): boolean {
  const seq = flattenVisible(roots);
  const idx = seq.indexOf(b);
  if (idx < 0) return false;
  const target = seq[idx + dir];
  if (!target || target === b) return false;
  if (dir === -1) {
    // insert before target, unless target is b's parent (then outdent-like is wrong; just skip)
    if (target === b.parent) {
      // b is first child: move before parent
      return moveBlock(b, target, 'before');
    }
    return moveBlock(b, target, 'before');
  }
  // dir === +1
  if (target.parent === b) {
    // target is b's first child: move after target
    return moveBlock(b, target, 'after');
  }
  return moveBlock(b, target, 'after');
}

/** Cycle TODO → DOING → DONE → none → TODO. Mutates and returns the new marker. */
export function cycleMarker(b: Block): Marker {
  const cur = b.marker;
  if (cur === null) {
    b.marker = 'TODO';
    return 'TODO';
  }
  const idx = MARKERS.indexOf(cur);
  const next: Marker = idx === MARKERS.length - 1 ? null : MARKERS[idx + 1];
  b.marker = next;
  return next;
}

/** Rebuild parent pointers for a freshly parsed (or restored) forest. */
export function linkParents(roots: Block[]): void {
  const walk = (b: Block, parent: Block | null) => {
    b.parent = parent;
    for (const c of b.children) walk(c, b);
  };
  for (const r of roots) walk(r, null);
}

/** Deep-clone a block forest (ids preserved). */
export function cloneForest(roots: Block[]): Block[] {
  const cloneBlock = (b: Block, parent: Block | null): Block => {
    const nb: Block = {
      ...b,
      props: { ...b.props },
      children: b.children.map((c) => cloneBlock(c, null)),
      parent,
    };
    nb.children.forEach((c) => (c.parent = nb));
    return nb;
  };
  return roots.map((r) => cloneBlock(r, null));
}

function stripIds(b: Block): void {
  delete b.props['id']; // duplicates must not share ids with the original
  b.children.forEach(stripIds);
}

/** Insert a deep copy of b right after it (ids stripped in the copy). */
export function duplicateBlock(b: Block): Block | null {
  const sibs = siblingsOf(b);
  const idx = sibs.indexOf(b);
  if (idx < 0) return null;
  const copy = cloneForest([b])[0];
  stripIds(copy);
  sibs.splice(idx + 1, 0, copy);
  return copy;
}

/** Give ids to blocks that lack them (used before saving a new reference). */
export function ensureIds(roots: Block[]): void {
  const walk = (b: Block) => {
    ensureId(b);
    b.children.forEach(walk);
  };
  roots.forEach(walk);
}

/**
 * Synthetic root wrapping the top-level blocks — lets path-based addressing
 * (walking `children`) resolve page-level rows uniformly, the same way
 * block-id roots do for ((id)) embeds. Does NOT mutate the blocks.
 */
export function pseudoRootOf(blocks: Block[]): Block {
  const root = createBlock('', null);
  root.children = blocks;
  return root;
}
