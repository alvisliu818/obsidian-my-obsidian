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

/**
 * 是否以 ASCII 字母/数字开头（CJK 等非拉丁名称的分组判据）。
 *
 * 用户实测（2026-11-18）：Windows 资源管理器（中文区域）把纯 CJK 名排在所有
 * ASCII 名之后（`day01…kb_0817 < 掌柜智库资料`），而 Obsidian 的 collator 在
 * 中文 locale 下把 CJK 排在前面——挂载树与资源管理器顺序不一致被报为排序
 * bug。这里补一层分组：ASCII 领头的名字整体排在非 ASCII 领头之前，组内再走
 * collator。纯 CJK 对纯 CJK、纯 ASCII 对纯 ASCII 的相对顺序不变。
 */
function latinLead(name: string): boolean {
  return /^[A-Za-z0-9]/.test(name);
}

/** Obsidian-native name compare: folders/files alike, case- and digit-run-aware.
 *  外加一层：ASCII 领头的名字排在 CJK 等非 ASCII 领头之前（Windows 资源管理器
 *  中文区域同款顺序，2026-11-18 用户报告排序不一致）。 */
export function compareNames(a: string, b: string): number {
  const la = latinLead(a) ? 0 : 1;
  const lb = latinLead(b) ? 0 : 1;
  if (la !== lb) return la - lb;
  return collator.compare(a, b);
}
