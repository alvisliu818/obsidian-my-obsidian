/**
 * Supertags (Tana "Supertags" + Logseq DB "New Tags" parity).
 *
 * Both references share one idea: **a tag can carry a template of fields**, so
 * applying it to a node materializes that structure instead of being a bare
 * label. Logseq DB calls them "new tags" (also classes/types) and stores the
 * template as properties on the tag's own page; Tana calls them supertags and
 * inherits through "Extend from". We follow Logseq DB, because this plugin
 * stores everything as plain markdown and already round-trips `key:: value`
 * both at page level and block level:
 *
 *   Person.md                     <- the tag's page IS the definition
 *   lastname::
 *   birthday::
 *   extends:: #Contact            <- optional parents (Logseq DB's `extends`)
 *
 *   - Marisha #Person             <- applying #Person materializes the fields
 *     lastname:: rv
 *     birthday:: 1988-04-12
 *
 * Design notes, all of them load-bearing:
 *
 * - **Field names are Logseq property keys**, so they follow the file format's
 *   `key:: value` rule: `[A-Za-z][A-Za-z0-9_-]*`, i.e. `lastname::` is a field
 *   but `last name::` is NOT — the space makes the parser treat the line as
 *   block text, and the field silently never appears in the template. Use
 *   `lastname` / `last_name` / `last-name`.
 * - **A field with an empty value declares the field without a default**
 *   (`lastname::`); a non-empty value IS the default and is materialized onto
 *   the node when the tag is applied (Tana's "default fields").
 * - **Inheritance is transitive and cycle-safe.** A definition may extend
 *   several parents; a diamond yields each field ONCE, and a cycle
 *   (`#a extends #b`, `#b extends #a`) resolves to whatever is reachable
 *   instead of hanging.
 * - **Nearest definition wins**, and parents contribute before children, so a
 *   child can override a parent's default (Logseq DB: "Tags inherit properties
 *   from all parent tags").
 * - **Fields are only ADDED, never overwritten.** Applying a tag must never
 *   clobber a value the user already typed — that is data loss, and it is the
 *   one thing a template feature must not do.
 * - Applying a tag is **idempotent**; removing it retracts only the fields it
 *   actually contributed and that the user has not since filled in.
 *
 * Pure logic: no obsidian / DOM imports, unit-tested under plain vitest.
 */

import { normalizeLinkTarget } from './query';

/** One field of a supertag template. */
export interface SupertagField {
  key: string;
  /** Materialized onto the node on apply; '' = declare the field, no value. */
  defaultValue: string;
}

/** A tag's definition: its field template plus its parent tags. */
export interface SupertagDef {
  /** Normalized tag name (lowercased). */
  name: string;
  fields: SupertagField[];
  /** Normalized parent tag names from `extends::`. */
  parents: string[];
}

/** The property naming a supertag's parents (Logseq DB's key). */
export const EXTENDS_PROP = 'extends';

/** Props owned by the editor's own UI; never treated as template fields. */
const NON_FIELD_PROPS = new Set(['id', 'collapsed', 'style', EXTENDS_PROP]);

/**
 * Normalize a tag / page name so supertag lookups agree with the block index.
 *
 * This MUST stay in step with `normalizeLinkTarget` (query.ts), which is what
 * the index uses for both `#tag` occurrences and `[[link]]` targets — a name
 * that normalizes differently here would silently never match a block tag.
 * On top of it we strip the `#` prefix and `[[ ]]` wrapping, since a supertag
 * may be written as `#Person`, `Person` or `#[[Person]]`.
 */
export function normalizeTag(raw: string): string {
  let s = raw.trim().replace(/^#+/, '').trim(); // `#Person` is the same tag
  // Unwrap BEFORE cutting the alias: `[[Page|alias]]` must not lose its
  // closing brackets to the `|` split.
  const wiki = /^\[\[(.*)\]\]$/.exec(s);
  if (wiki) s = wiki[1];
  return normalizeLinkTarget(s);
}

/** Split a `extends::` value into parent tag names (comma / space separated). */
function parseExtends(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => normalizeTag(s))
    .filter(Boolean);
}

/**
 * Build a definition from a tag's page properties. Returns null when the page
 * declares no fields and no parents — an ordinary `#tag` page is NOT a
 * supertag, and must keep behaving like a plain tag.
 */
export function supertagDefFrom(name: string, props: Record<string, string>): SupertagDef | null {
  const fields: SupertagField[] = [];
  for (const [key, value] of Object.entries(props)) {
    if (NON_FIELD_PROPS.has(key)) continue;
    if (key === '') continue;
    fields.push({ key, defaultValue: value ?? '' });
  }
  const parents = parseExtends(props[EXTENDS_PROP] ?? '');
  if (fields.length === 0 && parents.length === 0) return null;
  return { name: normalizeTag(name), fields, parents };
}

/** A definition source: the set of pages that look like tag definitions. */
export type SupertagRegistry = Map<string, SupertagDef>;

/** Look up a definition by tag name (case/`#`-insensitive). */
export function lookupSupertag(reg: SupertagRegistry, name: string): SupertagDef | null {
  return reg.get(normalizeTag(name)) ?? null;
}

/**
 * Resolve a tag's FULL field template, following `extends` transitively.
 * Parents come before children (so a child overrides), each field appears
 * once, and cycles terminate.
 */
export function resolveSupertagFields(
  reg: SupertagRegistry,
  name: string,
  seen: Set<string> = new Set(),
): SupertagField[] {
  const key = normalizeTag(name);
  if (seen.has(key)) return []; // cycle guard
  const def = reg.get(key);
  if (!def) return [];
  seen.add(key);
  // Parents first, then own fields. A key declared by THIS definition
  // overrides the inherited one IN PLACE (keeping the parent's position), so a
  // child can change a parent's default without reordering the template.
  // Across several parents the FIRST one to claim a key wins (diamond).
  const out: SupertagField[] = [];
  const at = new Map<string, number>();
  const put = (f: SupertagField, override: boolean): void => {
    const i = at.get(f.key);
    if (i === undefined) {
      at.set(f.key, out.length);
      out.push(f);
    } else if (override) {
      out[i] = f;
    }
  };
  for (const parent of def.parents) {
    for (const f of resolveSupertagFields(reg, parent, seen)) put(f, false);
  }
  for (const f of def.fields) put(f, true);
  return out;
}

/**
 * The merged template for a SET of tags (a node may carry several). Earlier
 * tags win over later ones, mirroring the order they appear in the block.
 */
export function resolveFieldsForTags(reg: SupertagRegistry, tags: readonly string[]): SupertagField[] {
  const out: SupertagField[] = [];
  const claimed = new Set<string>();
  for (const tag of tags) {
    for (const f of resolveSupertagFields(reg, tag)) {
      if (claimed.has(f.key)) continue;
      claimed.add(f.key);
      out.push(f);
    }
  }
  return out;
}

/** Normalized names of the tags among `tags` that actually define a supertag. */
export function supertagsIn(reg: SupertagRegistry, tags: readonly string[]): string[] {
  return tags.map((t) => normalizeTag(t)).filter((t) => reg.has(t));
}

/**
 * Apply supertags to a node's properties: materialize the inherited template.
 *
 * NEVER overwrites an existing key — a value the user typed (or one already
 * materialized) is left exactly as it is.
 *
 * Returns null when nothing changed, so callers can skip a re-render / write.
 */
export function applySupertags(
  props: Record<string, string>,
  reg: SupertagRegistry,
  tags: readonly string[],
): Record<string, string> | null {
  const fields = resolveFieldsForTags(reg, tags);
  if (fields.length === 0) return null;
  let changed = false;
  const out = { ...props };
  for (const f of fields) {
    if (f.key in out) continue; // never clobber
    out[f.key] = f.defaultValue;
    changed = true;
  }
  return changed ? out : null;
}

/**
 * Retract a removed supertag's fields.
 *
 * Only fields that (a) come from the templates of the tags being removed and
 * (b) are still empty or still hold the template default are dropped — a value
 * the user has since typed is real data and survives. Fields still required by
 * another tag on the node are kept.
 *
 * Returns null when nothing changed.
 */
export function removeSupertags(
  props: Record<string, string>,
  reg: SupertagRegistry,
  removedTags: readonly string[],
  remainingTags: readonly string[],
): Record<string, string> | null {
  const removed = resolveFieldsForTags(reg, removedTags);
  if (removed.length === 0) return null;
  // Defaults in force BEFORE the removal, so we can tell "untouched template
  // value" from "user data".
  const owned = new Map(removed.map((f) => [f.key, f.defaultValue]));
  const stillNeeded = new Set(resolveFieldsForTags(reg, remainingTags).map((f) => f.key));
  let changed = false;
  const out = { ...props };
  for (const [key, defValue] of owned) {
    if (stillNeeded.has(key)) continue;
    const v = out[key];
    if (v === undefined) continue;
    if (v !== '' && v !== defValue) continue; // user filled it in — real data
    delete out[key];
    changed = true;
  }
  return changed ? out : null;
}

/** True when any tag on the node is a supertag. */
export function hasSupertags(reg: SupertagRegistry, tags: readonly string[]): boolean {
  return supertagsIn(reg, tags).length > 0;
}
