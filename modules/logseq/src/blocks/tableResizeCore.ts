/**
 * Table resize math — grow/shrink a table by dragging its corner handle.
 *
 * PURE LOGIC — no DOM, no `obsidian` import — so it is unit tested under
 * plain node (project rule: anything under test must stay importable).
 *
 * ## Provenance (siyuan batch 19)
 *
 * Ported 1:1 from SiYuan's table resize engine:
 *   - `app/src/protyle/util/tableResize.ts`  (drag count + control placement)
 *   - `app/src/protyle/util/tableColumnWidth.ts` (default column width)
 * The algorithms are kept verbatim (names, rounding, edge cases) so the
 * SiYuan test-suite fixtures transfer unchanged; see
 * `tests/tableResizeCore.test.ts`. The DOM layer (`tableEditor.ts`) decides
 * WHAT the sizes mean — here we only do the math.
 *
 * ## The mental model
 *
 * Dragging produces a pixel DELTA along one axis. That delta is converted to
 * a COUNT of rows/columns:
 *   - growing: every `addedItemSize` pixels adds one item (rounded);
 *   - shrinking: the count follows the EXISTING item boundaries, so the table
 *     collapses one row/column exactly when the pointer passes its real edge.
 * A separate constraint pass then clamps the requested count so shrinking can
 * never cut away non-empty content.
 */

/** Default column width in px — also the width of a freshly added column. */
export const TABLE_DEFAULT_COLUMN_WIDTH = 60;

/**
 * Fallback "one more row" size when the table has no measurable rows yet
 * (SiYuan's add-handle thickness; in SiYuan it doubles as the control's
 * visual size, here it only feeds the growth math).
 */
export const TABLE_ADD_CONTROL_THICKNESS = 16;

/** Pointer must move this far (px, any direction) before a drag activates. */
export const TABLE_RESIZE_DRAG_THRESHOLD = 4;

/** Width a column gets when the table is stretched to a shared width. */
export const getDistributedTableColumnWidth = (widths: number[]) => {
  if (widths.length === 0) {
    return TABLE_DEFAULT_COLUMN_WIDTH;
  }
  return Math.max(TABLE_DEFAULT_COLUMN_WIDTH,
    Math.round(widths.reduce((total, width) => total + width, 0) / widths.length));
};

/** True when a column is at the table default (no explicit width). */
export const isDefaultTableColumnWidth = (width: string, minWidth: string) =>
  !width && minWidth === `${TABLE_DEFAULT_COLUMN_WIDTH}px`;

/**
 * A cell counts as empty when it has no text and no embeds/images/widgets.
 * Zero-width joiners and BOM are editor artefacts, not content.
 */
export const isTableCellContentEmpty = (text: string, hasNonTextContent: boolean) => {
  return !hasNonTextContent && text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim() === "";
};

/**
 * Convert a drag delta to a target row/column count.
 *
 * - `delta >= 0` (grow): `startCount` plus one item per `addedItemSize` px,
 *   rounded — a 60px-wide new column means every 60px of pull adds one.
 * - `delta < 0` (shrink): walk the EXISTING item boundaries. The count drops
 *   to `index` only while the pointer is closer to that boundary than to the
 *   previous one, so items never collapse "halfway" — the table shrinks in
 *   real size steps, not in averaged steps.
 */
export const getTableResizeCount = (startCount: number, delta: number, addedItemSize: number,
                                    existingItemSizes: number[]) => {
  if (delta >= 0) {
    return startCount + Math.max(0, Math.round(delta / Math.max(1, addedItemSize)));
  }
  let count = startCount;
  let boundary = 0;
  let distance = Math.abs(delta);
  for (let index = startCount - 1; index > 0; index--) {
    boundary -= Math.max(1, existingItemSizes[index] || addedItemSize);
    const currentDistance = Math.abs(delta - boundary);
    if (currentDistance >= distance) {
      break;
    }
    distance = currentDistance;
    count = index;
  }
  return count;
};

/**
 * Clamp a requested count so shrinking never destroys content.
 *
 * `minCount` is the hard floor below which items may not be removed (e.g. a
 * row holding text); `invalidCounts` are counts that would split merged cells
 * (SiYuan has those; our GFM tables never do, so we pass an empty set). When
 * shrinking is blocked the count slides UP to the nearest legal value rather
 * than jumping straight back to `startCount`, so a drag past a protected row
 * lands on it instead of doing nothing.
 */
export const constrainTableResizeCount = (requestedCount: number, startCount: number, minCount: number,
                                          invalidCounts: Set<number>) => {
  if (requestedCount >= startCount) {
    return requestedCount;
  }
  for (let count = Math.max(minCount, requestedCount); count < startCount; count++) {
    if (!invalidCounts.has(count)) {
      return count;
    }
  }
  return startCount;
};

/**
 * Centre a resize control on `edge`, kept fully inside the viewport.
 * Used for SiYuan's floating handles; kept for parity (our corner handle is
 * clamped by CSS instead, but the math is unit tested all the same).
 */
export const getTableResizeControlCenter = (edge: number, viewportStart: number, viewportEnd: number,
                                            controlSize: number, controlGap = 0) => {
  const halfSize = controlSize / 2;
  const min = viewportStart + halfSize;
  const max = viewportEnd - halfSize;
  if (min > max) {
    return (viewportStart + viewportEnd) / 2;
  }
  return Math.min(Math.max(edge + controlGap + halfSize, min), max);
};

/** True when the whole control fits inside the viewport at this edge. */
export const isTableResizeControlVisible = (edge: number, viewportEnd: number, controlSize: number, controlGap = 0) => {
  return edge + controlGap + controlSize <= viewportEnd + 1;
};

/**
 * Shrink-protection limits for OUR table model (SiYuan's `getResizeLimits`
 * adapted from grid cells to ParsedTable rows).
 *
 * A body row may only be removed when every cell in it is empty; a column may
 * only be removed when it is empty in the header AND every body row. Returns
 * the hard floors used by `constrainTableResizeCount`. GFM has no merged
 * cells, so there is no invalidCounts here — the floors alone are exact.
 */
export const tableResizeLimits = (
  headerCells: string[],
  bodyRows: string[][],
): { minRows: number; minColumns: number } => {
  let minRows = 0; // an all-empty body may be removed entirely
  let minColumns = 1; // a GFM table always keeps at least one column
  for (let c = 0; c < headerCells.length; c++) {
    if (!isTableCellContentEmpty(headerCells[c], false)) {
      minColumns = Math.max(minColumns, c + 1);
    }
  }
  for (let r = 0; r < bodyRows.length; r++) {
    const row = bodyRows[r] ?? [];
    let rowHasContent = false;
    for (let c = 0; c < row.length; c++) {
      if (!isTableCellContentEmpty(row[c] ?? '', false)) {
        rowHasContent = true;
        minColumns = Math.max(minColumns, c + 1);
      }
    }
    if (rowHasContent) {
      minRows = Math.max(minRows, r + 1);
    }
  }
  return { minRows, minColumns };
};
