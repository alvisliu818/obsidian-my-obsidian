/**
 * Guide-line layout calibration.
 *
 * The children guide line must keep the SAME gap past the nodes on BOTH ends:
 * the top sits GUIDE_END_GAP past the parent block's dot, the bottom sits the
 * same gap past the NEXT block (next sibling, or the next sibling of an
 * ancestor) — a line that stopped at its own last descendant left the
 * following block far below its bottom end, which read as two different
 * distances. CSS alone cannot do this: the line anchors to the parent wrap and
 * knows nothing about wrap heights, multi-line descendants or following
 * siblings. So after each render we measure the real geometry and pin both
 * ends with inline px offsets. A ResizeObserver on the tree container re-runs
 * the calibration whenever any layout change (fold/unfold, edits, font/zoom)
 * resizes the tree — absolute-positioned lines never resize it back, so the
 * observer cannot feed back into itself.
 */

/** ::before dot is a 6px circle → 3px radius. */
export const GUIDE_DOT_RADIUS = 3;
/** Same visual gap kept on BOTH ends of the line (past the dot's radius). */
export const GUIDE_END_GAP = 3;

/**
 * Pin top/bottom of every guide line under `root` so both ends sit exactly
 * GUIDE_END_GAP past their dots. Safe to call repeatedly; pure measurement +
 * inline styles, no DOM structure changes.
 */
export function layoutGuideLines(root: ParentNode): void {
  const lines = root.querySelectorAll<HTMLDivElement>('.block-children-left-border');
  lines.forEach((line) => {
    if (getComputedStyle(line).display === 'none') return; // folded: hidden
    // The line's positioned ancestor is the PARENT block's wrap (the
    // children container deliberately is not position:relative).
    const parentWrap = line.closest<HTMLElement>('.block-wrap');
    if (!parentWrap) return;
    const parentCy = dotCenterY(parentWrap);
    if (parentCy === null) return;
    // The block the bottom end has to look at: the next sibling (or the next
    // sibling of an ancestor). Falling back to the deepest visible descendant
    // only when the subtree is the last thing in the document.
    const nextWrap = nextBlockAfter(parentWrap);
    const nextCy = nextWrap ? dotCenterY(nextWrap) : null;
    const bottomAnchor = nextCy ?? deepestVisibleCy(parentWrap) ?? parentCy;
    const wrapRect = parentWrap.getBoundingClientRect();
    const topPx = parentCy + GUIDE_DOT_RADIUS + GUIDE_END_GAP - wrapRect.top;
    // Negative is fine: the line may extend past its own wrap to reach the
    // following block (it lives in the indent gutter, so nothing overlaps).
    const bottomPx = wrapRect.bottom - (bottomAnchor - GUIDE_DOT_RADIUS - GUIDE_END_GAP);
    line.style.top = `${topPx}px`;
    line.style.bottom = `${bottomPx}px`;
  });
}

/**
 * Vertical center of a block's controls row — the bullet dot's center (the
 * 16px bullet box is vertically centered in the 1.55em controls row). Works
 * for raw blocks too (their empty spacer slot shares the same center).
 */
function dotCenterY(wrap: HTMLElement): number | null {
  const controls = wrap.querySelector<HTMLElement>(':scope > .block-main > .block-controls');
  if (!controls) return null;
  const r = controls.getBoundingClientRect();
  return r.top + r.height / 2;
}

/** Center y of the deepest last visible descendant (document-end fallback). */
function deepestVisibleCy(wrap: HTMLElement): number | null {
  let deepest: HTMLElement = wrap;
  for (;;) {
    const next = deepest.querySelector<HTMLElement>(
      ':scope > .block-children-container:not(.is-collapsed) > .block-children > .block-wrap:last-child',
    );
    if (!next) break;
    deepest = next;
  }
  return dotCenterY(deepest);
}

/**
 * The block rendered right AFTER `wrap`'s whole subtree: its next sibling,
 * else the next sibling of the closest ancestor that has one (that is the
 * block the guide's bottom end has to look at).
 */
function nextBlockAfter(wrap: HTMLElement): HTMLElement | null {
  let node: HTMLElement = wrap;
  for (;;) {
    const next = node.nextElementSibling;
    if (next instanceof HTMLElement && next.classList.contains('block-wrap')) return next;
    // climb one level: .block-children > .block-children-container > parent wrap
    const cc = node.parentElement?.parentElement ?? null;
    const parent = cc?.parentElement ?? null;
    if (!(parent instanceof HTMLElement) || !parent.classList.contains('block-wrap')) return null;
    node = parent;
  }
}

const watchers = new WeakMap<HTMLElement, ResizeObserver>();

/**
 * Observe the tree container and recalibrate the guide lines whenever its
 * size changes (render, fold/unfold, multi-line edits, font/zoom changes).
 * Observing ONE container covers every render path — full renders, incremental
 * patchBlockSubtree/patchSiblingList updates, and load-more growth — because
 * all of them resize the tree. Idempotent: a second call replaces the watch.
 */
export function watchGuideLayout(container: HTMLElement): void {
  unwatchGuideLayout(container);
  let scheduled = 0;
  const ro = new ResizeObserver(() => {
    cancelAnimationFrame(scheduled);
    scheduled = requestAnimationFrame(() => layoutGuideLines(container));
  });
  ro.observe(container); // fires once immediately → covers the initial render
  watchers.set(container, ro);
}

/** Stop watching (view unload); safe on never-watched containers. */
export function unwatchGuideLayout(container: HTMLElement): void {
  watchers.get(container)?.disconnect();
  watchers.delete(container);
}
