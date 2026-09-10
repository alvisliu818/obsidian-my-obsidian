/**
 * Block drag & drop, delegated on the tree element.
 *  - Desktop: HTML5 DnD from the .block-controls handle.
 *  - Touch/pen: pointer-based fallback (HTML5 DnD is unreliable on mobile) —
 *    a floating ghost follows the finger, drop zones use the same three-band
 *    indicator, and the pending drag is cancelled by an 8px jitter so taps
 *    still toggle collapse as usual.
 *
 * Drop zones (Logseq-style three-band):
 *   - top 25% of target block  → insert before (same level)
 *   - bottom 25%               → insert after (same level)
 *   - middle 50%               → insert as first child
 */

import type { BlockEditorView } from '../view/BlockEditorView';
import { blockFromEl, findBlockEl } from '../blocks/renderTree';
import { serializeBlockContent } from '../core/serializer';
import { isDescendant, type MovePosition } from '../core/treeOps';
import { blockSummary, type Block } from '../types';

let dragged: Block | null = null;

const INDICATOR_CLASSES = ['drop-before', 'drop-after', 'drop-child'];
const TOUCH_DRAG_THRESHOLD_PX = 10;

function clearIndicators(treeEl: HTMLElement): void {
  for (const el of treeEl.querySelectorAll('.' + INDICATOR_CLASSES.join(',.'))) {
    el.removeClass(...INDICATOR_CLASSES);
  }
}

/** Three-band drop position from a viewport Y coordinate. */
function dropPositionAt(clientY: number, target: Block): MovePosition {
  const wrap = findBlockEl(target);
  const main = wrap?.querySelector(':scope > .block-main');
  if (!main) return 'after';
  const rect = (main as HTMLElement).getBoundingClientRect();
  const rel = (clientY - rect.top) / Math.max(rect.height, 1);
  if (rel < 0.25) return 'before';
  if (rel > 0.75) return 'after';
  return target.kind === 'list' ? 'child' : 'after';
}

function validDropTarget(d: Block, target: Block | null): target is Block {
  return !!target && target !== d && target.kind === 'list' && !isDescendant(d, target);
}

function showIndicator(treeEl: HTMLElement, target: Block, pos: MovePosition): void {
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
  block: Block;
  ghost: HTMLElement;
  target: Block | null;
  pos: MovePosition | null;
}

let touchPending: { pointerId: number; block: Block; x: number; y: number } | null = null;
let touchDrag: TouchDrag | null = null;
/** Suppresses one click after a completed touch drag (stop toggle-collapse). */
let suppressClickUntil = 0;

function startTouchDrag(ev: PointerEvent, block: Block): void {
  const ghost = document.createElement('div');
  ghost.className = 'block-drag-ghost';
  ghost.setText(blockSummary(block) || '(empty block)');
  ghost.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY - 16}px)`;
  document.body.appendChild(ghost);
  findBlockEl(block)?.classList.add('is-dragging-src');
  document.body.classList.add('block-touch-dragging');
  touchDrag = { pointerId: ev.pointerId, block, ghost, target: null, pos: null };
  suppressClickUntil = Date.now() + 400;
  ev.preventDefault();
}

function moveTouchDrag(treeEl: HTMLElement, ev: PointerEvent): void {
  const d = touchDrag;
  if (!d) return;
  d.ghost.style.transform = `translate(${ev.clientX + 8}px, ${ev.clientY - 16}px)`;
  const hit = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
  const target = blockFromEl(hit);
  if (validDropTarget(d.block, target)) {
    d.target = target;
    d.pos = dropPositionAt(ev.clientY, target);
    showIndicator(treeEl, target, d.pos);
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
  if (d) {
    d.ghost.remove();
    findBlockEl(d.block)?.classList.remove('is-dragging-src');
    if (!cancelled && d.target && d.pos) host.dropBlock(d.block, d.target, d.pos);
  }
  document.body.classList.remove('block-touch-dragging');
  clearIndicators(treeEl);
}

// ---------------------------------------------------------------------------
// Public wiring
// ---------------------------------------------------------------------------

export function attachDnd(treeEl: HTMLElement, host: BlockEditorView): void {
  // --- Desktop: HTML5 DnD ---
  treeEl.addEventListener('dragstart', (ev) => {
    const target = ev.target as HTMLElement;
    // Only drags initiated from the controls zone move blocks.
    if (!target.closest('.block-controls')) return;
    const b = blockFromEl(target);
    if (!b || b.kind !== 'list' || !ev.dataTransfer) return;
    dragged = b;
    ev.dataTransfer.setData('text/plain', serializeBlockContent(b));
    ev.dataTransfer.effectAllowed = 'move';
  });

  treeEl.addEventListener('dragover', (ev) => {
    if (!dragged) return;
    const target = blockFromEl(ev.target as HTMLElement);
    if (!validDropTarget(dragged, target)) {
      clearIndicators(treeEl);
      return;
    }
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    showIndicator(treeEl, target, dropPositionAt(ev.clientY, target));
  });

  treeEl.addEventListener('drop', (ev) => {
    if (!dragged) return;
    const target = blockFromEl(ev.target as HTMLElement);
    clearIndicators(treeEl);
    if (!validDropTarget(dragged, target)) return;
    ev.preventDefault();
    const pos = dropPositionAt(ev.clientY, target);
    const d = dragged;
    dragged = null;
    host.dropBlock(d, target, pos);
  });

  treeEl.addEventListener('dragend', () => {
    dragged = null;
    clearIndicators(treeEl);
  });

  treeEl.addEventListener('dragleave', (ev) => {
    if (!treeEl.contains(ev.relatedTarget as Node)) clearIndicators(treeEl);
  });

  // --- Touch / pen: pointer-based drag ---
  treeEl.addEventListener(
    'pointerdown',
    (ev) => {
      if (ev.pointerType === 'mouse') return;
      const target = ev.target as HTMLElement;
      if (!target.closest('.block-controls')) return;
      const b = blockFromEl(target);
      if (!b || b.kind !== 'list') return;
      touchPending = { pointerId: ev.pointerId, block: b, x: ev.clientX, y: ev.clientY };
    },
    { passive: true },
  );

  window.addEventListener(
    'pointermove',
    (ev) => {
      if (touchDrag) {
        if (ev.pointerId === touchDrag.pointerId) moveTouchDrag(treeEl, ev);
        return;
      }
      const p = touchPending;
      if (!p || ev.pointerId !== p.pointerId) return;
      const dist = Math.hypot(ev.clientX - p.x, ev.clientY - p.y);
      if (dist >= TOUCH_DRAG_THRESHOLD_PX) startTouchDrag(ev, p.block);
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
