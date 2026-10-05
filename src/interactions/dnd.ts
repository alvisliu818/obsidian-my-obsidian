/**
 * Block drag & drop, delegated on the tree element.
 *  - Desktop: HTML5 DnD from the .block-controls handle.
 *  - Touch/pen: pointer-based fallback (HTML5 DnD is unreliable on mobile) —
 *    a floating ghost follows the finger, drop zones use the same three-band
 *    indicator, and the pending drag is cancelled by an 8px jitter so taps
 *    still toggle collapse as usual.
 *
 * Drop zones (Logseq-style three-band, see features/dragRules.ts):
 *   - top 25% of target block  → insert before (same level)
 *   - bottom 25%               → insert after (same level)
 *   - middle 50%               → insert as first child
 *
 * A `raw` (verbatim) block cannot hold children, so its middle band degrades
 * to `after` instead of silently discarding the dragged subtree on save.
 *
 * Cross-file: the document-level listeners below catch drops that land in
 * ANOTHER open block-editor view (or on a file row in Obsidian's own file
 * explorer) — the per-tree handlers only ever see their own tree.
 */

import { Notice, TFile, type App } from 'obsidian';
import { VIEW_TYPE_BLOCK_EDITOR, type BlockEditorView } from '../view/BlockEditorView';
import { blockFromEl, findBlockEl } from '../blocks/renderTree';
import { parseDocument } from '../core/parser';
import { serializeBlockContent } from '../core/serializer';
import { isDescendant } from '../core/treeOps';
import { blockSummary, type Block } from '../types';
import {
  bandAt,
  canDrop,
  canStartDrag,
  edgeDropTarget,
  edgeScrollStep,
  isNoopMove,
  planCrossFile,
  resolveBand,
  transferableBlocks,
  type DropBand,
} from '../features/dragRules';

/** The blocks currently in flight (one entry per drag, group-aware). */
let dragged: Block[] = [];
/** The set the drag started from — its members are not valid drop targets. */
let dragGroup: Block[] = [];
/** The view the drag started in (null once it left every block editor). */
let dragOrigin: BlockEditorView | null = null;
/**
 * The dimmed source rows. Element references, not blocks: after a drop the
 * blocks are re-parented and their rows rebuilt, so looking them up again would
 * miss the rows that are still on screen (a cancelled drag leaves them dimmed
 * forever otherwise).
 */
let dragSourceEls: HTMLElement[] = [];

function markDragSource(blocks: readonly Block[]): void {
  clearDragSource();
  for (const b of blocks) {
    const el = findBlockEl(b);
    if (!el) continue;
    el.classList.add('is-dragging-src');
    dragSourceEls.push(el);
  }
}

function clearDragSource(): void {
  for (const el of dragSourceEls) el.classList.remove('is-dragging-src');
  dragSourceEls = [];
}

const INDICATOR_CLASSES = ['drop-before', 'drop-after', 'drop-child'];
const TOUCH_DRAG_THRESHOLD_PX = 10;
/** MIME used to recognise our own drag on foreign targets (file explorer). */
const LOGSEQ_MIME = 'application/x-obsidian-logseq-blocks';

function clearIndicators(...trees: (HTMLElement | null | undefined)[]): void {
  const roots = new Set<HTMLElement>();
  for (const t of trees) {
    if (!t) continue;
    roots.add(t);
    for (const el of t.querySelectorAll('.' + INDICATOR_CLASSES.join(',.'))) {
      el.removeClass(...INDICATOR_CLASSES);
    }
  }
  // Indicators may live in a DIFFERENT view's tree (cross-file hover).
  for (const el of document.querySelectorAll('.' + INDICATOR_CLASSES.join(',.'))) {
    if (![...roots].some((r) => r.contains(el))) el.removeClass(...INDICATOR_CLASSES);
  }
}

/**
 * Three-band drop position from a viewport Y coordinate, with illegal bands
 * resolved: a verbatim block can never land as a child (see resolveBand), so
 * its middle band falls back to `after` instead of corrupting the outline.
 */
function dropPositionAt(clientY: number, target: Block, payload: readonly Block[]): DropBand | null {
  const wrap = findBlockEl(target);
  const main = wrap?.querySelector(':scope > .block-main');
  const rect = main
    ? (main as HTMLElement).getBoundingClientRect()
    : { top: 0, height: 0 };
  return resolveBand(bandAt(clientY, rect, target.kind), target, payload);
}

function showIndicator(treeEl: HTMLElement, target: Block, pos: DropBand): void {
  const wrap = findBlockEl(target);
  if (!wrap) return;
  if (wrap.hasClass('drop-' + pos)) return;
  clearIndicators(treeEl);
  wrap.addClass('drop-' + pos);
}

// ---------------------------------------------------------------------------
// Touch / pen drag (pointer events)
// ---------------------------------------------------------------------------

interface TouchDrag {
  pointerId: number;
  /** Every block in the drag — a multi-selection drags as a group here too. */
  blocks: Block[];
  ghost: HTMLElement;
  target: Block | null;
  pos: DropBand | null;
}

let touchPending: { pointerId: number; block: Block; x: number; y: number } | null = null;
let touchDrag: TouchDrag | null = null;
/** Suppresses one click after a completed touch drag (stop toggle-collapse). */
let suppressClickUntil = 0;

function startTouchDrag(ev: PointerEvent, block: Block, blocks: Block[]): void {
  const ghost = document.createElement('div');
  ghost.className = 'block-drag-ghost';
  ghost.setText(blocks.length > 1 ? `${blocks.length} blocks` : blockSummary(block) || '(empty block)');
  ghost.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY - 16}px)`;
  document.body.appendChild(ghost);
  markDragSource(blocks);
  document.body.classList.add('block-touch-dragging');
  touchDrag = { pointerId: ev.pointerId, blocks, ghost, target: null, pos: null };
  suppressClickUntil = Date.now() + 400;
  ev.preventDefault();
}

function moveTouchDrag(treeEl: HTMLElement, host: BlockEditorView, ev: PointerEvent): void {
  const d = touchDrag;
  if (!d) return;
  d.ghost.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY - 16}px)`;
  updateEdgeScroll(treeEl, ev.clientY);
  const hit = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
  const target = blockFromEl(hit);
  if (target && canDrop(d.blocks, target, d.blocks).ok) {
    const pos = dropPositionAt(ev.clientY, target, d.blocks);
    d.target = pos ? target : null;
    d.pos = pos;
    if (target && pos) showIndicator(treeEl, target, pos);
    else clearIndicators(treeEl);
  } else if (!target) {
    // Empty space below the outline → append to the end of the note.
    const edge = edgeDropFor(treeEl, host, ev.clientY);
    d.target = edge?.target ?? null;
    d.pos = edge?.pos ?? null;
    if (edge) showEdgeIndicator(edge.target, edge.pos);
    else clearIndicators(treeEl);
  } else {
    d.target = null;
    d.pos = null;
    clearIndicators(treeEl);
  }
  ev.preventDefault();
}

function endTouchDrag(treeEl: HTMLElement, host: BlockEditorView, cancelled: boolean): void {
  const d = touchDrag;
  touchDrag = null;
  touchPending = null;
  stopEdgeScroll();
  if (d) {
    d.ghost.remove();
    if (!cancelled && d.target && d.pos) host.dropBlocks(d.blocks, d.target, d.pos);
  }
  clearDragSource();
  document.body.classList.remove('block-touch-dragging');
  clearIndicators(treeEl);
}

// ---------------------------------------------------------------------------
// Public wiring
// ---------------------------------------------------------------------------

/** The blocks a drag starting on `b` should carry (its whole selection). */
function dragPayloadFor(host: BlockEditorView, b: Block): Block[] {
  const tops = host.topSelectedBlocks();
  if (tops.includes(b) && tops.length > 1) return tops;
  return [b];
}

export function attachDnd(treeEl: HTMLElement, host: BlockEditorView): void {
  // --- Desktop: HTML5 DnD ---
  treeEl.addEventListener('dragstart', (ev) => {
    const target = ev.target as HTMLElement;
    // Only drags initiated from the controls zone move blocks.
    if (!target.closest('.block-controls')) return;
    const b = blockFromEl(target);
    if (!canStartDrag(b)) return;
    dragged = transferableBlocks(dragPayloadFor(host, b));
    if (dragged.length === 0) return;
    dragGroup = dragged;
    dragOrigin = host;
    ev.dataTransfer?.setData('text/plain', serializeBlockContent(dragged[0]));
    // Foreign targets (Obsidian's file explorer) only accept a drop when a
    // non-standard MIME is present — text/plain alone would let the block text
    // be pasted as a new file.
    ev.dataTransfer?.setData(LOGSEQ_MIME, dragged.length === 1 ? dragged[0].props['id'] ?? '' : '');
    ev.dataTransfer!.effectAllowed = 'move';
    // Desktop drags had no source feedback at all (only the touch path dimmed
    // the row), so a multi-block drag looked like it was moving one block.
    for (const b of dragged) findBlockEl(b)?.classList.add('is-dragging-src');
    // Multiple blocks: the native drag image would be the row under the
    // pointer only, which misleads when the payload is a group.
    if (dragged.length > 1) {
      const ghost = document.createElement('div');
      ghost.className = 'block-drag-ghost';
      ghost.setText(`${dragged.length} blocks`);
      ghost.style.transform = 'translate(-9999px, -9999px)';
      document.body.appendChild(ghost);
      ev.dataTransfer?.setDragImage(ghost, 10, 10);
      setTimeout(() => ghost.remove(), 0);
    }
  });

  treeEl.addEventListener('dragover', (ev) => {
    if (dragged.length === 0) return;
    // Keep the outline scrolling while the pointer rests near an edge —
    // otherwise drop targets past the fold are unreachable.
    updateEdgeScroll(treeEl, ev.clientY);
    const target = blockFromEl(ev.target as HTMLElement);
    if (!target || !canDrop(dragged, target, dragGroup).ok) {
      // No block under the pointer: the empty area below the outline is a
      // valid destination (append to the end of the note).
      const edge = target ? null : edgeDropFor(treeEl, host, ev.clientY);
      if (edge) {
        ev.preventDefault();
        if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
        showEdgeIndicator(edge.target, edge.pos);
      } else {
        clearIndicators(treeEl);
      }
      return;
    }
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    const pos = dropPositionAt(ev.clientY, target, dragged);
    if (pos) showIndicator(treeEl, target, pos);
    else clearIndicators(treeEl);
  });

  treeEl.addEventListener('drop', (ev) => {
    if (dragged.length === 0) return;
    stopEdgeScroll();
    const target = blockFromEl(ev.target as HTMLElement);
    const check = target ? canDrop(dragged, target, dragGroup) : { ok: false as const };
    const edge = target ? null : edgeDropFor(treeEl, host, ev.clientY);
    const pos = check.ok && target ? dropPositionAt(ev.clientY, target, dragged) : edge?.pos ?? null;
    const dest = target ?? edge?.target ?? null;
    clearIndicators(treeEl);
    if (!dest || !pos) return;
    if (dragged.some((b) => b === dest || isDescendant(b, dest))) return;
    if (dragged.some((b) => isNoopMove(b, dest, pos))) return;
    ev.preventDefault();
    const payload = dragged;
    dragged = [];
    dragGroup = [];
    host.dropBlocks(payload, dest, pos);
  });

  treeEl.addEventListener('dragend', () => {
    stopEdgeScroll();
    dragged = [];
    dragGroup = [];
    dragOrigin = null;
    clearIndicators(treeEl);
  });

  treeEl.addEventListener('dragleave', (ev) => {
    if (treeEl.contains(ev.relatedTarget as Node)) return;
    stopEdgeScroll();
    clearIndicators(treeEl);
  });

  attachCrossViewDnd(host);

  // --- Touch / pen: pointer-based drag ---
  treeEl.addEventListener(
    'pointerdown',
    (ev) => {
      if (ev.pointerType === 'mouse') return;
      const target = ev.target as HTMLElement;
      if (!target.closest('.block-controls')) return;
      const b = blockFromEl(target);
      if (!canStartDrag(b)) return;
      touchPending = { pointerId: ev.pointerId, block: b, x: ev.clientX, y: ev.clientY };
    },
    { passive: true },
  );

  window.addEventListener(
    'pointermove',
    (ev) => {
      if (touchDrag) {
        if (ev.pointerId === touchDrag.pointerId) moveTouchDrag(treeEl, host, ev);
        return;
      }
      const p = touchPending;
      if (!p || ev.pointerId !== p.pointerId) return;
      const dist = Math.hypot(ev.clientX - p.x, ev.clientY - p.y);
      if (dist >= TOUCH_DRAG_THRESHOLD_PX) {
        // Same payload rule as the desktop path: a drag that starts inside a
        // multi-selection carries the whole selection.
        const blocks = transferableBlocks(dragPayloadFor(host, p.block));
        if (blocks.length > 0) startTouchDrag(ev, p.block, blocks);
      }
    },
    { passive: false },
  );

  const finish = (cancelled: boolean) => (ev: PointerEvent): void => {
    if (touchDrag && ev.pointerId === touchDrag.pointerId) endTouchDrag(treeEl, host, cancelled);
    else if (touchPending && ev.pointerId === touchPending.pointerId) touchPending = null;
  };
  window.addEventListener('pointerup', finish(false), { passive: true });
  window.addEventListener('pointercancel', finish(true), { passive: true });

  // Swallow the click that follows a completed touch drag (it would otherwise
  // toggle collapse / marker on the block the finger last touched).
  treeEl.addEventListener(
    'click',
    (ev) => {
      if (Date.now() < suppressClickUntil && (ev.target as HTMLElement).closest('.block-controls')) {
        ev.stopPropagation();
        ev.preventDefault();
      }
    },
    true,
  );
}

// ---------------------------------------------------------------------------
// Cross-view / cross-file drops
// ---------------------------------------------------------------------------

/** The block-editor view that owns `el`, if any. */
function hostOwning(el: Element | null): BlockEditorView | null {
  let cur: HTMLElement | null = el as HTMLElement | null;
  while (cur) {
    if (cur.classList?.contains('block-editor-tree')) {
      return (cur as HTMLElement & { __logseqHost?: BlockEditorView }).__logseqHost ?? null;
    }
    cur = cur.parentElement;
  }
  return null;
}

/** The vault path of a file row in Obsidian's own file explorer. */
function explorerFileAt(el: Element | null): string | null {
  const row = (el as HTMLElement | null)?.closest('.nav-file-title, .nav-folder-title');
  const path = row?.getAttribute('data-path');
  return path ?? null;
}

/**
 * The file-explorer row currently lit as the drop destination.
 *
 * Tracked as an element so moving from one row to the next un-lights the
 * first: a `dragleave` listener alone leaves the previous row lit, because
 * dragleave fires for internal element transitions too.
 */
let highlightedFileRow: HTMLElement | null = null;

function clearExplorerHighlight(): void {
  highlightedFileRow?.removeClass('logseq-drop-target');
  highlightedFileRow = null;
}

/** Distinct sibling-list owners, in first-seen order (null = the root list). */
function dedupeParents(parents: (Block | null)[]): (Block | null)[] {
  const seen = new Set<Block | null>();
  const out: (Block | null)[] = [];
  for (const p of parents) {
    if (seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Auto-scroll while dragging
// ---------------------------------------------------------------------------

/**
 * HTML5 `dragover` only fires when the pointer MOVES, and pointer events stop
 * when a finger rests on the glass — so a long page has unreachable drop
 * targets near its end. One rAF loop scrolls while the pointer sits in an edge
 * zone, exactly like native drag does.
 */
let scrollLoop: { raf: number; step: number } | null = null;

function scrollerOf(treeEl: HTMLElement | null): HTMLElement | null {
  return (treeEl ?? document.body).closest('.block-editor-scroller') as HTMLElement | null;
}

function startEdgeScroll(container: HTMLElement, step: number): void {
  if (scrollLoop && scrollLoop.step === step) return;
  stopEdgeScroll();
  let last = performance.now();
  const tick = (now: number): void => {
    // Cap dt so a background tab does not scroll by seconds on return.
    const dt = Math.min(now - last, 48) / 16.67;
    last = now;
    const before = container.scrollTop;
    container.scrollTop = before + scrollLoop!.step * dt;
    // Stop at either end: keep looping against a clamped scrollTop would spin.
    if (container.scrollTop !== before) scrollLoop!.raf = requestAnimationFrame(tick);
    else scrollLoop = null;
  };
  scrollLoop = { raf: requestAnimationFrame(tick), step };
}

function stopEdgeScroll(): void {
  if (!scrollLoop) return;
  cancelAnimationFrame(scrollLoop.raf);
  scrollLoop = null;
}

/** Update (or stop) the auto-scroll loop for the current pointer position. */
function updateEdgeScroll(treeEl: HTMLElement | null, clientY: number): void {
  const container = scrollerOf(treeEl);
  if (!container) {
    stopEdgeScroll();
    return;
  }
  const step = edgeScrollStep(clientY, container.getBoundingClientRect());
  if (step === 0) stopEdgeScroll();
  else startEdgeScroll(container, step);
}

// ---------------------------------------------------------------------------
// Empty-space drop
// ---------------------------------------------------------------------------

/**
 * A drop that lands on no block. Returns the neighbouring block instead, so
 * the empty area under a short page appends to the note rather than doing
 * nothing at all.
 */
function edgeDropFor(
  treeEl: HTMLElement,
  host: BlockEditorView,
  clientY: number,
): { target: Block; pos: DropBand } | null {
  const roots = host.visibleRoots;
  const hit = edgeDropTarget(roots, treeEl.getBoundingClientRect(), clientY);
  if (!hit) return null;
  // Respect the same legality rules — the neighbour may still be the source.
  const payload = dragged.length > 0 ? dragged : (touchDrag?.blocks ?? []);
  if (payload.length === 0) return null;
  if (!canDrop(payload, hit.target, payload).ok) return null;
  return hit;
}

/** Show the indicator for an empty-space drop (the row above/below the outline). */
function showEdgeIndicator(target: Block, pos: DropBand): void {
  const wrap = findBlockEl(target);
  if (!wrap) return;
  clearIndicators();
  wrap.addClass('drop-' + pos);
  wrap.addClass('drop-edge');
}

let crossViewBound = false;

/**
 * Drops that land OUTSIDE the originating tree. Attached once per document:
 * the per-tree handlers only receive events for their own subtree, so without
 * this a block could never be dragged into a second note.
 */
function attachCrossViewDnd(host: BlockEditorView): void {
  if (crossViewBound) return;
  crossViewBound = true;
  const treeEl = host.treeRoot();
  (treeEl as HTMLElement & { __logseqHost?: BlockEditorView }).__logseqHost = host;

  document.addEventListener('dragover', (ev) => {
    if (dragged.length === 0) return;
    // Nothing draggable under the pointer any more (moved off a valid row):
    // drop the highlight so a stale target can't be left lit.
    if (!explorerFileAt(ev.target as Element)) clearExplorerHighlight();
    const target = blockFromEl(ev.target as HTMLElement);
    const overOtherTree = !!target && !treeEl.contains(ev.target as Node);
    if (target && overOtherTree) {
      if (!canDrop(dragged, target, dragGroup).ok) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      const owner = hostOwning(target && findBlockEl(target));
      const pos = dropPositionAt(ev.clientY, target, dragged);
      if (owner && pos) showIndicator(owner.treeRoot(), target, pos);
      return;
    }
    // File explorer: highlight the row so the destination is visible.
    if (!target) {
      const path = explorerFileAt(ev.target as Element);
      if (!path) return;
      const dest = host.app.vault.getAbstractFileByPath(path);
      if (!(dest instanceof TFile) || !dest.extension?.toLowerCase().includes('md')) return;
      if (dest.path === dragOrigin?.file?.path) return;
      ev.preventDefault();
      if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
      // Only one row lit at a time: moving from A to B must un-light A.
      clearExplorerHighlight();
      highlightedFileRow = (ev.target as HTMLElement).closest('.nav-file-title');
      highlightedFileRow?.addClass('logseq-drop-target');
    }
  });

  document.addEventListener('dragleave', (ev) => {
    // Leaving the lit row entirely un-lights it; internal element transitions
    // (row → its own title span) must not, or the highlight flickers.
    const to = ev.relatedTarget as Node | null;
    if (highlightedFileRow && (to === null || !highlightedFileRow.contains(to))) {
      clearExplorerHighlight();
    }
  });

  document.addEventListener('drop', async (ev) => {
    if (dragged.length === 0) return;
    stopEdgeScroll();
    const target = blockFromEl(ev.target as HTMLElement);
    const path = explorerFileAt(ev.target as Element);

    // --- drop on a block in another open view ---
    if (target && !treeEl.contains(ev.target as Node)) {
      const check = canDrop(dragged, target, dragGroup);
      if (!check.ok) return;
      const pos = dropPositionAt(ev.clientY, target, dragged);
      if (!pos) return;
      if (dragged.some((b) => isNoopMove(b, target, pos))) return;
      ev.preventDefault();
      const owner = hostOwning(findBlockEl(target));
      const payload = dragged;
      const origin = dragOrigin;
      // The source's own parent pointers are captured BEFORE the move: after
      // `dropBlocks` they point into the destination document, so the source
      // view would have no way to know which sibling lists to rebuild.
      const sourceLists = dedupeParents(payload.map((b) => b.parent));
      dragged = [];
      dragGroup = [];
      clearIndicators();
      if (owner) owner.dropBlocks(payload, target, pos);
      // The source document was mutated too (the blocks left it) but nothing
      // marked it dirty: its file would keep the block on disk — a "move"
      // that silently duplicates. Without this the source never re-saves.
      if (origin && origin !== owner) origin.adoptBlocksMovedAway(sourceLists);
      return;
    }

    // --- drop on a file row in the explorer ---
    if (!target && path) {
      const dest = host.app.vault.getAbstractFileByPath(path);
      if (!(dest instanceof TFile) || !dest.extension?.toLowerCase().includes('md')) return;
      const from = dragOrigin;
      const plan = planCrossFile(from?.file?.path ?? '', dest.path);
      if (plan.same || !from) return;
      ev.preventDefault();
      const payload = dragged;
      dragged = [];
      dragGroup = [];
      clearIndicators();
      clearExplorerHighlight();
      await moveBlocksToFile(from, payload, dest);
    }
  });

  document.addEventListener('dragend', () => {
    dragged = [];
    dragGroup = [];
    dragOrigin = null;
    // A drag that ended outside any tree (Esc, dropped on a non-markdown row)
    // never ran a per-tree dragend, so the dimmed rows and the scroll loop
    // would survive it.
    stopEdgeScroll();
    clearDragSource();
    clearExplorerHighlight();
    clearIndicators();
  });
}

/**
 * Cut blocks out of `from` and append them to `to`.
 *
 * Removal and insertion go through each view's own `mutate`, so both files are
 * marked dirty and both undo stacks get an entry. The markdown stays standard:
 * the blocks are serialized and re-parsed, never written as a blob.
 */
export async function moveBlocksToFile(
  from: BlockEditorView,
  blocks: readonly Block[],
  to: TFile,
): Promise<void> {
  const moving = transferableBlocks(blocks);
  if (moving.length === 0) return;
  const fromPath = from.file?.path;
  if (!fromPath) return;
  if (planCrossFile(fromPath, to.path).same) return;

  // 1. Serialize before detaching (the block tree is still intact).
  const chunks = moving.map((b) => serializeBlockContent(b));

  // 2. Remove from the source.
  from.dropBlocksToNowhere(moving);

  const target = from.app.vault.getAbstractFileByPath(to.path);
  if (!(target instanceof TFile)) {
    new Notice(`Could not write to ${to.path}`);
    return;
  }

  // 3a. The destination is already open in a block editor: insert into that
  // view's model instead of writing the file. Writing the file would race the
  // open view's `onExternalModify`, whose policy is "the editor always wins" —
  // it would re-save its own version and drop the blocks we just wrote.
  const openView = viewShowing(from.app, to.path);
  if (openView) {
    openView.appendBlocksAtEnd(parseDocument(chunks.join('\n')).blocks);
    new Notice(`Moved ${moving.length} block${moving.length > 1 ? 's' : ''} to ${to.basename}`);
    return;
  }

  // 3b. No view holds it — write the markdown directly.
  await from.app.vault.process(target, (data) => {
    const body = data.trimEnd();
    const addition = chunks.map((c) => c.replace(/\n+$/, '')).join('\n');
    return `${body}${body ? '\n' : ''}${addition}\n`;
  });
  new Notice(`Moved ${moving.length} block${moving.length > 1 ? 's' : ''} to ${to.basename}`);
}

/**
 * The block-editor view currently showing `path`, if any.
 *
 * Duck-typed rather than `instanceof`: importing the class as a value would
 * create a cycle (the view imports this module to attach the handlers), and a
 * half-initialised class in a cycle fails silently at the worst moment.
 */
function viewShowing(app: App, path: string): BlockEditorView | null {
  for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_BLOCK_EDITOR)) {
    const v = leaf.view as Partial<BlockEditorView> | null;
    if (v && v.file?.path === path && typeof v.appendBlocksAtEnd === 'function') {
      return v as BlockEditorView;
    }
  }
  return null;
}
