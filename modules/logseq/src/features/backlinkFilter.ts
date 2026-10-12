/**
 * Linked-references filtering (Logseq parity, `logseq.db.common.reference`).
 *
 * Logseq puts a funnel button next to a page's "Linked references"; clicking it
 * opens a dialog listing every page reference that occurs inside those
 * references (brackets AND hashtags — both are page refs there), each with its
 * occurrence count. Clicking a value INCLUDES it, Shift-clicking EXCLUDES it,
 * and the choice is remembered per page.
 *
 * Matching semantics, taken verbatim from Logseq's `matches-filters?`:
 *   include: AND  — a reference survives only if it carries ALL included values
 *   exclude: NONE — a reference is dropped if it carries ANY excluded value
 *
 * "Carries" means the reference's EFFECTIVE refs: its own `[[links]]` / `#tags`
 * plus everything inherited from its ancestors (a child of a linked block is
 * linked too), plus the page it lives on (so you can filter by source page).
 * Values are normalized page names (lowercased basenames), which is what the
 * block index hands us — display casing comes from `refLabel()`.
 *
 * Pure logic: no obsidian / DOM imports, unit-tested under plain vitest.
 */

import type { RefFilter } from '../types';

/** One reference block (or any object carrying its effective refs). */
export interface RefCarrier {
  /** Normalized page-ref names carried by this reference. */
  refs: string[];
}

export type { RefFilter };

export const EMPTY_REF_FILTER: RefFilter = { includes: [], excludes: [] };

/** What the funnel button should look like (Logseq colors it by state). */
export type RefFilterState = 'none' | 'include' | 'exclude' | 'both';

export function emptyRefFilter(): RefFilter {
  return { includes: [], excludes: [] };
}

export function isRefFilterActive(f: RefFilter | undefined | null): boolean {
  return !!f && (f.includes.length > 0 || f.excludes.length > 0);
}

/** Logseq's four-way funnel state (green / red / amber / neutral). */
export function refFilterState(f: RefFilter | undefined | null): RefFilterState {
  const inc = f?.includes.length ?? 0;
  const exc = f?.excludes.length ?? 0;
  if (inc > 0 && exc > 0) return 'both';
  if (inc > 0) return 'include';
  if (exc > 0) return 'exclude';
  return 'none';
}

/**
 * Dedupe + sort helper. Values are lowercased because matching is
 * case-insensitive (the index hands out lowercased page names) — a stored
 * `Alpha` must behave exactly like the `alpha` the index produces.
 */
function norm(values: readonly string[] | undefined | null): string[] {
  return [
    ...new Set(
      (values ?? [])
        .filter((v) => typeof v === 'string')
        .map((v) => v.trim().toLowerCase())
        .filter((v) => v.length > 0),
    ),
  ].sort();
}

/**
 * Sanitize a filter read from disk (settings JSON). Anything not an array of
 * non-empty strings is dropped, so a hand-edited/corrupt data.json can't break
 * rendering.
 */
export function refFilterFrom(raw: unknown): RefFilter {
  const o = (raw ?? {}) as Partial<RefFilter>;
  return {
    includes: norm(Array.isArray(o.includes) ? o.includes : []),
    excludes: norm(Array.isArray(o.excludes) ? o.excludes : []),
  };
}

/**
 * Does this reference survive the filter? Include = AND, exclude = NONE
 * (Logseq `matches-filters?`).
 */
export function matchesRefFilter(refs: readonly string[], f: RefFilter | undefined | null): boolean {
  if (!isRefFilterActive(f)) return true;
  const filter = f as RefFilter;
  const set = new Set(refs);
  for (const inc of filter.includes) if (!set.has(inc)) return false;
  for (const exc of filter.excludes) if (set.has(exc)) return false;
  return true;
}

/** Keep only the references passing the filter (order preserved). */
export function filterRefs<T extends RefCarrier>(entries: readonly T[], f: RefFilter | undefined | null): T[] {
  if (!isRefFilterActive(f)) return entries as T[];
  return entries.filter((e) => matchesRefFilter(e.refs, f));
}

/**
 * Click a value in the filter dialog.
 *
 * Logseq (`ref-button`): a value already present in EITHER list is removed;
 * a fresh value is added to includes (plain click) or excludes (Shift-click).
 */
export function toggleRefFilter(f: RefFilter, value: string, exclude = false): RefFilter {
  const v = value.toLowerCase();
  const includes = norm(f.includes);
  const excludes = norm(f.excludes);
  if (includes.includes(v) || excludes.includes(v)) {
    return {
      includes: includes.filter((x) => x !== v),
      excludes: excludes.filter((x) => x !== v),
    };
  }
  if (exclude) excludes.push(v);
  else includes.push(v);
  return { includes: includes.sort(), excludes: excludes.sort() };
}

/** Drop every filter value. */
export function clearRefFilter(): RefFilter {
  return emptyRefFilter();
}

/** A candidate value in the dialog, with how many references carry it. */
export interface RefFilterValue {
  /** Normalized name (what matching uses). */
  key: string;
  /** How many references carry it. */
  count: number;
}

export interface RefValueOptions {
  /** Values never offered as candidates (e.g. the page being viewed). */
  exclude?: readonly string[];
  /** Max candidates returned; the most frequent ones win. */
  limit?: number;
}

/**
 * Collect the dialog's candidate values from a set of references: every page
 * ref they carry, most frequent first, ties broken alphabetically. Values
 * already pinned in the filter are still counted (the dialog shows them under
 * Includes / Excludes) — `filterRefValues` drops them for the "all values" list.
 */
export function countRefValues(
  entries: readonly RefCarrier[],
  opts: RefValueOptions = {},
): RefFilterValue[] {
  const skip = new Set((opts.exclude ?? []).map((v) => v.toLowerCase()));
  const counts = new Map<string, number>();
  for (const e of entries) {
    // A reference contributes each value at most once.
    for (const r of new Set(e.refs)) {
      const key = r.toLowerCase();
      if (key.length === 0 || skip.has(key)) continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const all = [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key));
  return opts.limit !== undefined && opts.limit >= 0 ? all.slice(0, opts.limit) : all;
}

/** Case-insensitive subsequence match (what the dialog's search box uses). */
export function fuzzyMatchRef(query: string, text: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const t = text.toLowerCase();
  let from = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i === -1) return false;
    from = i + 1;
  }
  return true;
}

/**
 * The dialog's "all values" list: candidates minus the pinned ones, narrowed by
 * the search box. Sorted by frequency (as in the dialog), not by relevance.
 */
export function filterRefValues(
  values: readonly RefFilterValue[],
  f: RefFilter | undefined | null,
  query = '',
): RefFilterValue[] {
  const pinned = new Set([...(f?.includes ?? []), ...(f?.excludes ?? [])].map((v) => v.toLowerCase()));
  return values.filter((v) => !pinned.has(v.key) && fuzzyMatchRef(query, v.key));
}