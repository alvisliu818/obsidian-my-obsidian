/**
 * Compiles the block index into a Prolog fact base, plus the schema metadata
 * the visual query builder needs.
 *
 * Pure logic: no obsidian / DOM imports. The index is reached through the
 * structural `PrologFactSource` interface so this file stays loadable (and
 * testable) under plain node.
 *
 * ## The fact schema
 *
 *   block(Id, Text)      — every block that carries an `id::`
 *   in_page(Id, Page)    — page name (lowercased basename) the block lives on
 *   in_file(Id, Path)    — vault path, e.g. `journal/2026-10-04.md`
 *   tag(Id, Tag)         — `#tag` occurrences in the block
 *   prop(Id, Key, Value) — `key:: value` properties
 *   link(Id, Target)     — `[[page]]` references
 *   ref(Id, ToId)        — `((uuid))` block references
 *   parent(Child, Parent)
 *   task(Id, Marker)     — marker, lowercased (`todo`, `doing`, `done`)
 *   page(Path, Name)
 *
 *   ancestor(X, Y)  — transitive parent
 *   has_tag(Id, T)  — the tag, or one inherited from an ancestor block
 *
 * ## Case rule (this bites people, so it is deliberate)
 *
 * In Prolog an uppercase token is a VARIABLE. Tags, page names, property KEYS
 * and markers are therefore stored lowercased, so `tag(B, book)` and
 * `task(B, todo)` just work. Property VALUES and block text are verbatim —
 * write them quoted when they start uppercase: `prop(B, status, 'Open')`.
 */

import {
  Program,
  atom,
  comp,
  freshVar,
  parseProgram,
  type Clause,
  type Term,
} from './prolog';

export interface PrologFactBlock {
  path: string;
  blockId: string;
  text: string;
  marker: string | null;
  tags: string[];
  links: string[];
  /** Query-relevant subset; `blockProps` carries everything. */
  props: Record<string, string>;
  blockProps?: Record<string, string>;
  parentId?: string;
}

export interface PrologFactSource {
  allBlocks(): PrologFactBlock[];
  allTags(): string[];
}

/** Blocks without an `id::` cannot be addressed, so they get no facts. */
const SKIP_PROPS = new Set(['id', 'collapsed']);

const BLOCK_REF_RE =
  /\(\(([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)\)/g;

/** Hard ceiling so one pathological vault cannot stall a render. */
export const MAX_FACTS = 400_000;

export interface FactBaseStats {
  facts: number;
  blocks: number;
  pages: number;
  /** True when `MAX_FACTS` stopped fact generation early. */
  truncated: boolean;
}

/**
 * Built-in rules layered over the facts. `ancestor/2` and `has_tag/2` are the
 * two things a relational query adds over `{{query ...}}`, so they ship with
 * the fact base rather than having to be re-typed in every query block.
 */
export const BUILTIN_RULES_SRC = `
ancestor(X, Y) :- parent(X, Y).
ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
has_tag(Id, T) :- tag(Id, T).
has_tag(Id, T) :- parent(Id, P), has_tag(P, T).
`;

function builtinRuleClauses(): Clause[] {
  try {
    return parseProgram(BUILTIN_RULES_SRC).clauses;
  } catch {
    return [];
  }
}

/** Page name for a vault path: basename without `.md`, lowercased. */
export function pageNameOf(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() ?? path;
  const name = base.toLowerCase().endsWith('.md') ? base.slice(0, -3) : base;
  return name.toLowerCase();
}

export function buildPrologFacts(
  src: PrologFactSource,
  maxFacts: number = MAX_FACTS,
): { program: Program; stats: FactBaseStats } {
  const program = new Program();
  let facts = 0;
  let truncated = false;
  const add = (t: Term): void => {
    if (truncated) return;
    if (facts >= maxFacts) {
      truncated = true;
      return;
    }
    facts++;
    program.fact(t);
  };

  const blocks = src.allBlocks();
  const paths = new Set<string>();
  for (const b of blocks) {
    const id = b.blockId;
    if (!id) continue; // no id :: no way to refer to it
    if (b.path) paths.add(b.path);
    add(comp('block', [atom(id), atom(b.text ?? '')]));
    add(comp('in_file', [atom(id), atom(b.path)]));
    add(comp('in_page', [atom(id), atom(pageNameOf(b.path))]));
    if (b.marker) add(comp('task', [atom(id), atom(b.marker.toLowerCase())]));
    if (b.parentId) add(comp('parent', [atom(id), atom(b.parentId)]));
    for (const t of b.tags ?? []) add(comp('tag', [atom(id), atom(t.toLowerCase())]));
    for (const l of b.links ?? []) add(comp('link', [atom(id), atom(l.toLowerCase())]));
    const props = b.blockProps ?? b.props ?? {};
    for (const [k, v] of Object.entries(props)) {
      if (SKIP_PROPS.has(k.toLowerCase())) continue;
      add(comp('prop', [atom(id), atom(k.toLowerCase()), atom(v)]));
    }
    for (const m of (b.text ?? '').matchAll(BLOCK_REF_RE)) {
      if (m[1] === id) continue;
      add(comp('ref', [atom(id), atom(m[1])]));
    }
  }
  for (const p of [...paths].sort()) {
    add(comp('page', [atom(p), atom(pageNameOf(p))]));
  }

  for (const c of builtinRuleClauses()) program.assert(c.head, c.body);

  // Every schema predicate must EXIST even when the vault has no facts for it:
  // an undefined predicate is a hard error, but "no blocks have a deadline yet"
  // is an empty result. A clause with a `fail` body gives exactly that, and
  // keeps `\\+ prop(B, x, _)` meaning what it should.
  for (const spec of PREDICATES) {
    if (program.has(spec.pi)) continue;
    const [name, arity] = spec.pi.split('/');
    const vars = Array.from({ length: Number(arity) }, () => freshVar('_'));
    program.assert(comp(name, vars), atom('fail'));
  }

  return {
    program,
    stats: { facts, blocks: blocks.length, pages: paths.size, truncated },
  };
}

// ---------------------------------------------------------------------------
// Caching: the fact base is expensive and only changes when the index does
// ---------------------------------------------------------------------------

interface CacheEntry {
  version: number;
  result: { program: Program; stats: FactBaseStats };
}

const cache = new WeakMap<object, CacheEntry>();

/** Fact base for an index, rebuilt only when `version` changes. */
export function prologFacts(src: PrologFactSource, version: number): {
  program: Program;
  stats: FactBaseStats;
} {
  const key = src as unknown as object;
  const hit = cache.get(key);
  if (hit && hit.version === version) return hit.result;
  const result = buildPrologFacts(src);
  cache.set(key, { version, result });
  return result;
}

// ---------------------------------------------------------------------------
// Schema metadata for the visual builder
// ---------------------------------------------------------------------------

/** What kind of value an argument expects — drives autocompletion. */
export type ArgKind = 'block' | 'page' | 'tag' | 'propKey' | 'propValue' | 'marker' | 'text';

export interface ArgSpec {
  label: string;
  kind: ArgKind;
}

export interface PredicateSpec {
  /** `tag/2` */
  pi: string;
  name: string;
  args: ArgSpec[];
  doc: string;
}

export const PREDICATES: PredicateSpec[] = [
  { pi: 'block/2', name: 'block', args: [{ label: 'Block', kind: 'block' }, { label: 'Text', kind: 'text' }], doc: 'A block and its text' },
  { pi: 'in_page/2', name: 'in_page', args: [{ label: 'Block', kind: 'block' }, { label: 'Page', kind: 'page' }], doc: 'The page a block lives on' },
  { pi: 'tag/2', name: 'tag', args: [{ label: 'Block', kind: 'block' }, { label: 'Tag', kind: 'tag' }], doc: 'A #tag on the block itself' },
  { pi: 'has_tag/2', name: 'has_tag', args: [{ label: 'Block', kind: 'block' }, { label: 'Tag', kind: 'tag' }], doc: 'Tag on the block or any ancestor' },
  { pi: 'prop/3', name: 'prop', args: [{ label: 'Block', kind: 'block' }, { label: 'Key', kind: 'propKey' }, { label: 'Value', kind: 'propValue' }], doc: 'A key:: value property' },
  { pi: 'link/2', name: 'link', args: [{ label: 'Block', kind: 'block' }, { label: 'Page', kind: 'page' }], doc: 'A [[page]] reference' },
  { pi: 'ref/2', name: 'ref', args: [{ label: 'Block', kind: 'block' }, { label: 'Target', kind: 'block' }], doc: 'A ((block-id)) reference' },
  { pi: 'parent/2', name: 'parent', args: [{ label: 'Child', kind: 'block' }, { label: 'Parent', kind: 'block' }], doc: 'Immediate parent block' },
  { pi: 'ancestor/2', name: 'ancestor', args: [{ label: 'Block', kind: 'block' }, { label: 'Ancestor', kind: 'block' }], doc: 'Any ancestor block' },
  { pi: 'task/2', name: 'task', args: [{ label: 'Block', kind: 'block' }, { label: 'Marker', kind: 'marker' }], doc: 'Task marker (todo/doing/done)' },
  { pi: 'page/2', name: 'page', args: [{ label: 'Path', kind: 'text' }, { label: 'Name', kind: 'page' }], doc: 'Every page in the vault' },
];

export const MARKERS = ['todo', 'doing', 'done', 'now', 'later', 'waiting', 'canceled'];

/** Candidate values for an argument kind, for the builder's datalist. */
export function valuesForKind(src: PrologFactSource, kind: ArgKind, limit = 60): string[] {
  const take = (xs: string[]): string[] => [...new Set(xs)].sort().slice(0, limit);
  switch (kind) {
    case 'tag':
      return take(src.allTags().map((t) => t.toLowerCase()));
    case 'page':
      return take(src.allBlocks().map((b) => pageNameOf(b.path)));
    case 'propKey': {
      const keys: string[] = [];
      for (const b of src.allBlocks()) {
        for (const k of Object.keys(b.blockProps ?? b.props ?? {})) {
          if (!SKIP_PROPS.has(k.toLowerCase())) keys.push(k.toLowerCase());
        }
      }
      return take(keys);
    }
    case 'propValue': {
      const vals: string[] = [];
      for (const b of src.allBlocks()) {
        for (const [k, v] of Object.entries(b.blockProps ?? b.props ?? {})) {
          if (SKIP_PROPS.has(k.toLowerCase()) || !v) continue;
          vals.push(v);
        }
      }
      return take(vals);
    }
    case 'marker':
      return MARKERS;
    default:
      return [];
  }
}
