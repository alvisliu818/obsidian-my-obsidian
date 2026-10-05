/**
 * Block views: a `view::` property on a PARENT block decides how its CHILDREN
 * are presented — as a table, as cards, or as tabs.
 *
 *   - Books            <- the parent: a plain block whose children are the data
 *     view:: table
 *     - Dune
 *       author:: Herbert
 *     - Solaris
 *       author:: Lem
 *
 * Rationale: an outline forces every child to be a bullet, which makes a list
 * of same-shaped records unreadable (you cannot scan a column, and the fields
 * you want to compare are scattered at different indents). A view property
 * turns that same outline data into a shape you can actually read. The data
 * stays plain indented markdown — a view is a RENDERING of the children, never
 * a different storage format, so a block keeps working when the view is removed.
 *
 * Design notes:
 * - **Views apply to the block's own children, not the block itself.** The
 *   parent still renders as a normal bullet so it stays focusable/zoomable.
 * - **A child with children of its own contributes ONE row/card/tab** (its own
 *   text and props), not a nested expansion — a view is one flat level. Its
 *   subtree is still reachable by zooming into that row.
 * - **Columns come from the children**, in first-seen order (not sorted), so the
 *   order matches how the outline reads. `view-columns::` overrides that when
 *   the user wants an explicit order or a subset.
 * - **Empty children render an explicit empty state** rather than nothing, so a
 *   mistyped `view::` never looks like a broken block.
 * - Unknown view names fall back to `table` (the most useful default) rather
 *   than silently rendering nothing.
 *
 * Pure logic: no obsidian / DOM imports, unit-tested under plain vitest.
 */

/** The property that selects a view. */
export const VIEW_PROP = 'view';
/** Optional explicit column order / subset. */
export const VIEW_COLUMNS_PROP = 'view-columns';

export type BlockViewKind = 'table' | 'cards' | 'tabs';

/** Aliases accepted in `view::`, so `view:: card` and `view:: Cards` work. */
const VIEW_ALIASES: Record<string, BlockViewKind> = {
  table: 'table',
  list: 'table',
  grid: 'table',
  card: 'cards',
  cards: 'cards',
  gallery: 'cards',
  board: 'cards',
  tab: 'tabs',
  tabs: 'tabs',
  accordion: 'tabs',
};

/**
 * Props owned by the editor / view machinery — never shown as data.
 *
 * Compared LOWERCASE, and the dash is dropped too, so `view-columns`,
 * `viewColumns` and `View-Columns` are all recognized as the same config key.
 * Property keys reach us exactly as typed, so without this a stray `View::`
 * would leak a column into the table.
 */
const NON_DATA_PROPS = new Set(
  ['id', 'collapsed', 'style', VIEW_PROP, VIEW_COLUMNS_PROP].map(normPropKey),
);

/** Lowercase + strip dashes, so config keys compare case/punctuation-insensitively. */
function normPropKey(k: string): string {
  return k.toLowerCase().replace(/-/g, '');
}

/** A child block, reduced to what a view needs (no DOM, no parent pointers). */
export interface ViewChild {
  /** Block text, first line (the record's title). */
  text: string;
  /** Block marker (TODO / DOING / DONE) when it has one. */
  marker: 'TODO' | 'DOING' | 'DONE' | null;
  props: Record<string, string>;
  /** True when the child has children of its own (a record with sub-records). */
  hasChildren: boolean;
}

/** The requested view for a block, or null when it has no `view::` property. */
export function viewKindOf(props: Record<string, string>): BlockViewKind | null {
  const raw = readProp(props, VIEW_PROP).trim().toLowerCase();
  if (!raw) return null;
  return VIEW_ALIASES[raw] ?? 'table';
}

/**
 * Read a config property case- and dash-insensitively, so `view::`,
 * `View::` and `VIEW::` all work. Data props are read exactly (no case
 * folding) so a column named `Author` keeps its spelling.
 */
function readProp(props: Record<string, string>, key: string): string {
  const want = normPropKey(key);
  for (const [k, v] of Object.entries(props)) {
    if (normPropKey(k) === want) return v ?? '';
  }
  return '';
}

/**
 * The data columns for a table: `view-columns::` when present (explicit order,
 * blanks and unknown names dropped), otherwise every prop occurring on any
 * child, in first-seen order.
 */
export function viewColumns(
  children: readonly ViewChild[],
  props: Record<string, string> = {},
): string[] {
  const explicit = readProp(props, VIEW_COLUMNS_PROP)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length > 0) return [...new Set(explicit)];

  const seen: string[] = [];
  for (const c of children) {
    for (const k of Object.keys(c.props)) {
      if (NON_DATA_PROPS.has(normPropKey(k))) continue;
      if (!seen.includes(k)) seen.push(k);
    }
  }
  return seen;
}

/** One row/card/tab: the child plus its resolved column values. */
export interface ViewRecord {
  child: ViewChild;
  /**
   * Index of this child in the PARENT's `children` array. Carried explicitly so
   * a click always opens the block the record was built from — a parallel
   * positional lookup in the renderer would silently drift the moment records
   * get filtered, sorted or capped differently from the children array.
   */
  childIndex: number;
  /** Column values keyed by column name ('' when unset). */
  values: Record<string, string>;
  /** Row label = the block's own first line. */
  title: string;
}

export interface BlockViewModel {
  kind: BlockViewKind;
  columns: string[];
  records: ViewRecord[];
}

/** Build the full model for a block's children under `view::`. */
export function buildBlockView(
  props: Record<string, string>,
  children: readonly ViewChild[],
  limit = Number.POSITIVE_INFINITY,
): BlockViewModel | null {
  const kind = viewKindOf(props);
  if (kind === null) return null;
  // Columns are derived from ALL children (not just the shown ones) so the cap
  // never silently drops a column that later rows would have used.
  const columns = viewColumns(children, props);
  const records = children.slice(0, Math.max(0, limit)).map((child, i) => {
    const values: Record<string, string> = {};
    for (const c of columns) values[c] = child.props[c] ?? '';
    return { child, childIndex: i, values, title: child.text };
  });
  return { kind, columns, records };
}

/** True when a block asks for a view (any recognized or unrecognized value). */
export function isViewBlock(props: Record<string, string>): boolean {
  return (props[VIEW_PROP] ?? '').trim().length > 0;
}
