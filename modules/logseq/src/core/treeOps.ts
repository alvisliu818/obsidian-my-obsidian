/**
 * Pure tree operations on the block forest.
 * All functions mutate the tree in place while keeping `parent` pointers
 * consistent; they never touch the DOM or Obsidian APIs (unit-testable).
 */

import { Block, Marker, MARKERS, createBlock, ensureId } from '../types';
import { blockTypeOf } from '../blocks/blockTypes';

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

/**
 * Is `b` still part of the forest rooted at `roots` — at ANY depth?
 *
 * Identity against the root array alone is not enough: a nested block is a
 * member of the document but not of `roots`, so a caller filtering candidates
 * with `roots.includes(b)` silently drops every non-top-level block. That is
 * how "extract this sub-block to its own page" ended up doing nothing at all
 * for any block below the first level, with no error to show for it.
 *
 * Structural, not registry-based: it answers "is this object still in the
 * document", which is exactly the question a caller holding a stale block
 * reference needs answered.
 */
export function containsBlock(roots: readonly Block[], b: Block): boolean {
  if (!b) return false;
  for (const r of roots) {
    if (r === b) return true;
    if (findListContaining(r.children, b)) return true;
  }
  return false;
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

/**
 * The block a Shift+click range should grow from.
 *
 * `lastClicked` is the anchor when the user built the selection by clicking
 * blocks. But the very first Shift+click often happens while a block is still
 * being edited — the click never went through `selectFromClick`, so
 * `lastClicked` is still null and the range silently collapses to the clicked
 * block, dropping the block the user was typing in. The focused block is the
 * anchor the user actually sees, so it is the fallback.
 *
 * Returns null when neither anchor is in the visible sequence (e.g. the block
 * being edited sits inside a sub-tree the user collapsed in between).
 */
export function rangeAnchor(
  roots: Block[],
  lastClicked: Block | null,
  focused: Block | null,
): Block | null {
  const seq = flattenVisible(roots);
  if (lastClicked && seq.includes(lastClicked)) return lastClicked;
  if (focused && seq.includes(focused)) return focused;
  return null;
}

/**
 * Every block between `anchor` and `target` inclusive, in visible order.
 * Returns null when either end is not in the visible sequence.
 */
export function visibleRange(roots: Block[], anchor: Block, target: Block): Block[] | null {
  const seq = flattenVisible(roots);
  const from = seq.indexOf(anchor);
  const to = seq.indexOf(target);
  if (from < 0 || to < 0) return null;
  return seq.slice(Math.min(from, to), Math.max(from, to) + 1);
}

export function insertAfter(target: Block, b: Block): void {
  const sibs = siblingsOf(target);
  const idx = sibs.indexOf(target);
  sibs.splice(idx + 1, 0, b);
  b.parent = target.parent;
  reindexRoots(b);
}

export function insertBefore(target: Block, b: Block): void {
  const sibs = siblingsOf(target);
  const idx = sibs.indexOf(target);
  sibs.splice(idx, 0, b);
  b.parent = target.parent;
  reindexRoots(b);
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

/**
 * 保真模式的转换点：把逐字段的普通段落/标题提升为大纲块。
 * 代码、表格、公式、媒体等没有大纲形态，返回 false（调用方应放弃缩进）。
 * 已经是大纲块时原样返回 true。
 */
export function promoteRawToOutline(b: Block): boolean {
  if (b.kind !== 'raw') return true;
  const t = blockTypeOf(b);
  if (t !== 'paragraph' && t !== 'heading') return false;
  b.kind = 'list';
  return true;
}

/**
 * 缩进，并保证父块是大纲块：前一个兄弟是逐字段段落/标题时先提升它
 * （Tab 是显式结构操作）。没有前一个兄弟、或前一个兄弟是不能提升的逐字段
 * （代码/表格/公式）时返回 false。
 */
export function indentBlock(b: Block): boolean {
  const sibs = siblingsOf(b);
  const idx = sibs.indexOf(b);
  if (idx <= 0) return false;
  const prev = sibs[idx - 1];
  if (!promoteRawToOutline(prev)) return false;
  return indent(b);
}

/**
 * Resolve the sibling array of b by scanning `roots` (structure-first, no registry).
 */
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
 * Strip the common leading indent (spaces) from every non-blank line, keeping
 * deeper indentation as the content's own. Enter uses this when the tail of a
 * raw block becomes a new outline block: orphaned fences in Logseq exports
 * sit at a fixed file indent; removing it puts the fence at the block's
 * content column so it re-parses as an in-block fence (and renders as a code
 * block) after the round-trip.
 */
export function dedentCommon(text: string): string {
  const lines = text.split('\n');
  let min = Infinity;
  for (const l of lines) {
    if (l.trim() === '') continue;
    const w = /^ */.exec(l)?.[0].length ?? 0;
    if (w < min) min = w;
  }
  if (!Number.isFinite(min) || min === 0) return text;
  return lines.map((l) => (l.trim() === '' ? l : l.slice(min))).join('\n');
}

/** Drop leading/trailing blank (whitespace-only) lines; interior lines stay. */
export function stripBlankEdges(text: string): string {
  const lines = text.split('\n');
  let a = 0;
  let z = lines.length;
  while (a < z && lines[a].trim() === '') a++;
  while (z > a && lines[z - 1].trim() === '') z--;
  return lines.slice(a, z).join('\n');
}

/**
 * Enter on a raw (non-outline) block: the block becomes outline blocks —
 * the head converts to a list block in place, the tail becomes a new list
 * sibling below (empty text when the caret sits at the very end). Edge blank
 * lines and the common indent never survive the conversion (Logseq: the
 * outline owns everything; raw is a render-time state, not a persistent one).
 * The caret target is always the tail block.
 */
export function splitRawToOutline(b: Block, offset: number): Block {
  const head = stripBlankEdges(b.text.slice(0, offset));
  const tail = stripBlankEdges(dedentCommon(b.text.slice(offset)));
  b.kind = 'list';
  // Caret at the block start (empty head): Logseq just converts the block in
  // place — no empty outline block is left behind, caret stays on b.
  if (head === '') {
    b.text = tail;
    return b;
  }
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

/**
 * Merge the NEXT visible block into b (Delete at block end) — the forward
 * twin of mergeWithPrev. On an empty block this deletes the empty row: the
 * next block's content fills it and the next block disappears. Returns b
 * (caret stays at the join point), or null when there is no next visible
 * block.
 */
export function mergeWithNext(roots: Block[], b: Block): Block | null {
  const next = nextVisible(roots, b);
  if (!next) return null;
  b.text += next.text;
  const kids = next.children.slice();
  for (const k of kids) {
    b.children.push(k);
    k.parent = b;
  }
  next.children = [];
  removeBlock(next);
  return b;
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
 * Point a top-level block's sibling-list cache at the array it now lives in.
 *
 * `siblingsOf` resolves a top-level block's container through
 * `forestRootsCache`, which is a WeakMap set when the view registers its
 * roots. A block that MOVES between positions — or, for a cross-file drop,
 * between documents — keeps its old entry, so the next `siblingsOf` hands back
 * an array the block is no longer in. Every later `removeBlock`/`indent` on it
 * then edits the wrong list: the block survives a delete, or appears twice.
 *
 * The cache is only consulted for parentless blocks, so re-pointing on every
 * re-parent keeps it correct without invalidating anything else.
 */
function reindexRoots(b: Block): void {
  if (b.parent) {
    forestRootsCache.delete(b);
    return;
  }
  // Find the array this block now belongs to among the registered forests.
  for (const arr of rootArrays) {
    if (arr.includes(b)) {
      forestRootsCache.set(b, arr);
      return;
    }
  }
  forestRootsCache.delete(b);
}

/**
 * Move a GROUP of blocks into one position, preserving their relative order.
 *
 * Looping `moveBlock` is wrong: each call inserts directly adjacent to the
 * target, so the next member pushes the previous one further out — dropping
 * [a, b] after `c` yields [c, b, a], exactly reversed. Inserting them one by
 * one at a moving anchor (or as a contiguous run) keeps the order.
 *
 * Members that are descendants of another member are dropped: they travel
 * inside their ancestor and re-inserting them would detach the subtree.
 * Returns the blocks actually moved.
 */
export function moveBlockGroup(
  blocks: readonly Block[],
  target: Block,
  pos: MovePosition,
): Block[] {
  // Any member that cannot be legally placed makes the WHOLE drop incoherent:
  // moving half a selection is more surprising than not moving at all, and the
  // user aimed at one target for the whole group.
  for (const b of blocks) {
    if (!b || b === target) return [];
    // A member that contains the target could only be dropped inside itself.
    if (isDescendant(b, target)) return [];
  }
  // Members nested in another member travel inside their ancestor; inserting
  // them separately would detach the subtree.
  const movers = blocks.filter((b) => !blocks.some((o) => o !== b && isDescendant(o, b)));
  if (movers.length === 0) return [];

  if (pos === 'child') {
    // A run of first children, in order.
    const kids = target.children;
    for (const b of movers) removeBlock(b);
    kids.splice(0, 0, ...movers);
    for (const b of movers) b.parent = target;
    return movers;
  }

  const sibs = siblingsOf(target);
  if (pos === 'before' && sibs.indexOf(target) < 0) return [];
  for (const b of movers) removeBlock(b);
  // Removal may have shifted the target's index, so it is re-found AFTER the
  // removals rather than trusting a position computed before them.
  const nowSibs = siblingsOf(target);
  const at = pos === 'before' ? nowSibs.indexOf(target) : nowSibs.indexOf(target) + 1;
  if (at < 0) return [];
  nowSibs.splice(at, 0, ...movers);
  const parent = target.parent;
  for (const b of movers) {
    b.parent = parent;
    reindexRoots(b);
  }
  return movers;
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
