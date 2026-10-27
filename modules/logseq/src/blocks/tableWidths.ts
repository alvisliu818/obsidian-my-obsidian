/**
 * Per-column table widths, persisted as a block property.
 *
 * PURE LOGIC + DOM APPLICATION — no `obsidian` import — unit tested under
 * plain node (project rule: anything under test must stay importable).
 *
 * ## Provenance (siyuan batch 20)
 *
 * Self-designed: SiYuan's markdown tables have NO per-column width drag (they
 * distribute `<col style='min-width:60px'>` evenly; only its database views
 * have real column widths — batch 19 recon, coverage doc §二.1 corrected).
 * What SiYuan DOES provide and we reuse: the 60px default column width
 * (`TABLE_DEFAULT_COLUMN_WIDTH` in tableResizeCore.ts) as the drag floor, and
 * the general idea that widths live in the block model, not the DOM.
 *
 * ## Why a block prop, not inline HTML
 *
 * The widths must survive round-trips through the file. The block model owns
 * `props: Record<string, string>` and the serializer emits them as trailing
 * `key:: value` lines that the parser re-attaches (verified by probe:
 * a list-form table block followed by `table-widths:: 120, 80` parses back
 * with the text untouched and the prop attached). Raw-form tables are
 * excluded from the drag affordance in tableEditor — a raw block's tail
 * `key:: value` line would stay CONTENT (parser rule: only fold flags
 * re-attach to raw), so persisting widths there is impossible by design.
 *
 * ## Why per-cell width+max-width, not a colgroup
 *
 * A `<colgroup>` under `table-layout: auto` is only a SUGGESTION — long cell
 * content still widens the column, so a dragged width would silently not
 * hold. Switching the table to `table-layout: fixed` would change the layout
 * of never-dragged columns too (they would equalize). Setting `width` AND
 * `max-width` on each cell of the column keeps auto layout for everything
 * else while making dragged widths authoritative: short content keeps the
 * dragged width, long content wraps instead of pushing the column wider.
 */

/** The block prop storing per-column widths. */
export const TABLE_WIDTHS_PROP = 'table-widths';

/** Drag floor — SiYuan's default column width; narrower is unreadable. */
export const MIN_COLUMN_WIDTH = 60;
/** Drag ceiling — mirrors the image-resize cap (renderTree.enhanceImages). */
export const MAX_COLUMN_WIDTH = 2000;

/** Clamp a dragged width into the legal range, rounded to whole px. */
export const clampColumnWidth = (w: number): number =>
  Math.max(MIN_COLUMN_WIDTH, Math.min(MAX_COLUMN_WIDTH, Math.round(w)));

/**
 * Parse a stored `table-widths` value.
 *
 * POSITIONAL: entries map to columns by index, so an unparsable entry becomes
 * 0 ("unset") rather than being dropped — dropping would shift every later
 * column's width onto the wrong column after the user clears a middle one.
 * Returns null when absent or when no entry is set at all.
 */
export const parseTableWidths = (v: string | undefined | null): number[] | null => {
  if (!v) return null;
  const widths = v.split(',').map((part) => {
    const n = Number(part.trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  });
  return widths.some((w) => w > 0) ? widths : null;
};

/**
 * Serialize widths for the block prop (`120, 80, 240`); unset columns emit an
 * empty segment (`120, , 240`) so the positions survive the round-trip.
 */
export const serializeTableWidths = (widths: number[]): string =>
  widths.map((w) => (w > 0 ? String(Math.round(w)) : '')).join(', ');

/**
 * Apply stored widths to a rendered table: column i gets the width on every
 * cell of that column (header AND body — the header alone would not pin the
 * column under auto layout). Columns beyond the stored list are untouched,
 * so a table that grew after the widths were saved keeps its new column
 * natural and its old columns pinned.
 */
export const applyColumnWidths = (table: HTMLTableElement, widths: number[] | null): void => {
  if (!widths || widths.length === 0) return;
  const rows = [
    ...(table.tHead?.rows ?? []),
    ...(table.tBodies[0]?.rows ?? []),
  ];
  for (const row of rows) {
    for (let c = 0; c < row.cells.length && c < widths.length; c++) {
      const w = widths[c];
      if (!w || w <= 0) continue; // 0 = unset: leave the column natural
      const px = `${clampColumnWidth(w)}px`;
      const cell = row.cells[c] as HTMLElement;
      cell.style.width = px;
      cell.style.maxWidth = px;
    }
  }
};

/** Remove width styles from one column (the dblclick reset path). */
export const clearColumnWidth = (table: HTMLTableElement, col: number): void => {
  const rows = [
    ...(table.tHead?.rows ?? []),
    ...(table.tBodies[0]?.rows ?? []),
  ];
  for (const row of rows) {
    const cell = row.cells[col] as HTMLElement | undefined;
    if (!cell) continue;
    cell.style.removeProperty('width');
    cell.style.removeProperty('max-width');
  }
};

/**
 * Merge a new width for one column into a stored widths list (missing
 * entries read as "unset" and are materialized as 0), returning the list to
 * serialize.
 */
export const withColumnWidth = (widths: number[] | null, col: number, w: number): number[] => {
  const next = widths ? [...widths] : [];
  while (next.length < col) next.push(0);
  next[col] = clampColumnWidth(w);
  return next;
};

/** True when every entry is unset/invalid — the prop key should be dropped. */
export const isEmptyWidths = (widths: number[] | null | undefined): boolean =>
  !widths || widths.every((w) => !w || w <= 0);
