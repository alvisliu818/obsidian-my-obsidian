/**
 * Name comparator that matches Obsidian's native file-explorer order.
 *
 * Verified against app.js (1.10.x install, `qL.alphabetical` → `BT`):
 *
 *     new Intl.Collator(void 0, { usage: "sort", sensitivity: "base", numeric: !0 }).compare
 *
 * `numeric: true` is the part plain `localeCompare` misses: digit runs compare
 * as numbers, so `260817` sorts AFTER `99-Attachment` (native behaviour) instead
 * of between `20-Diary` and `30-Reading` (byte order). `sensitivity: "base"` is
 * the case-insensitivity the native explorer uses.
 *
 * One shared Collator instance: constructing one per sort call is measurably
 * slower and these comparators run on every folder render.
 */
const collator = new Intl.Collator(undefined, { usage: 'sort', sensitivity: 'base', numeric: true });

/** Obsidian-native name compare: folders/files alike, case- and digit-run-aware. */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}
