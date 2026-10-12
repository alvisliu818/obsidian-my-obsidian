/**
 * Embedded query engine: parse + execute Logseq-style {{query ...}} blocks.
 * Pure logic (no obsidian / DOM deps) — unit-testable under plain vitest.
 *
 * Supported syntax (a practical subset of Logseq queries):
 *   (TODO) (DOING) (DONE)          — task marker
 *   (all)                           — every block
 *   [[page]]                        — blocks linking to a page (or embedding it)
 *   #tag                            — blocks carrying a tag (sub-tags included)
 *   "text"                          — full-text contains (case-insensitive)
 *   (priority A)                    — blocks with priority:: A/B/C (bare: any)
 *   (scheduled before "2026-01-01") — date comparison; ops: before/after/<=/>=/between
 *   (deadline ...)                  — same ops
 *   (and A B ...) (or A B ...) (not A) — combinators
 *   {{query A B}}                   — bare sequence = implicit and
 */

export interface QueryBlock {
  path: string;
  /** Owning block id ('' when the block has no id). */
  blockId: string;
  text: string;
  marker: string | null;
  tags: string[];
  /** Normalized link targets (lowercased page basenames). */
  links: string[];
  /** Block properties relevant to queries: priority / scheduled / deadline. */
  props: Record<string, string>;
}

export type QueryAST =
  | { t: 'marker'; marker: string }
  | { t: 'all' }
  | { t: 'page'; page: string }
  | { t: 'tag'; tag: string }
  | { t: 'text'; text: string }
  | { t: 'priority'; level: string | null }
  | { t: 'date'; kind: 'scheduled' | 'deadline'; op: DateOp; a: string; b?: string }
  | { t: 'and'; children: QueryAST[] }
  | { t: 'or'; children: QueryAST[] }
  | { t: 'not'; child: QueryAST };

type DateOp = 'before' | 'after' | 'between' | '<=' | '>=' | '<' | '>';

const DATE_KINDS = new Set(['scheduled', 'deadline']);
const DATE_OPS = new Set(['before', 'after', 'between', '<=', '>=', '<', '>']);

const QUERY_RE = /^\{\{query\s+([\s\S]+?)\}\}$/;
const QUERY_TABLE_RE = /^\{\{query-table\s+([\s\S]+?)\}\}$/;

const MARKER_WORDS = new Set(['TODO', 'DOING', 'DONE']);
const HEAD_WORDS = new Set(['and', 'or', 'not']);

/** Extract the query body from raw block text; null when the block is not a query. */
export function queryStringOf(text: string): string | null {
  const m = text.trim().match(QUERY_RE);
  return m ? m[1] : null;
}

/** Extract the body of a `{{query-table ...}}` block; null when not one. */
export function queryTableStringOf(text: string): string | null {
  const m = text.trim().match(QUERY_TABLE_RE);
  return m ? m[1] : null;
}

/** Convenience: raw block text → AST for a query-table block (null when invalid). */
export function parseQueryTableText(text: string): QueryAST | null {
  const src = queryTableStringOf(text);
  return src === null ? null : parseQuery(src);
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TokKind = '(' | ')' | 'page' | 'tag' | 'text' | 'word';
interface Tok {
  k: TokKind;
  v: string;
}

class Lexer {
  private i = 0;
  private pushed: Tok | null = null;

  constructor(private s: string) {}

  next(): Tok | null {
    if (this.pushed) {
      const t = this.pushed;
      this.pushed = null;
      return t;
    }
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i++;
    if (this.i >= this.s.length) return null;
    const rest = this.s.slice(this.i);
    const c = rest[0];
    if (c === '(') {
      this.i++;
      return { k: '(', v: '' };
    }
    if (c === ')') {
      this.i++;
      return { k: ')', v: '' };
    }
    let m: RegExpMatchArray | null;
    if (c === '[') {
      m = rest.match(/^\[\[([^\]]+)\]\]/);
      if (m) {
        this.i += m[0].length;
        return { k: 'page', v: m[1].trim() };
      }
    }
    if (c === '#') {
      m = rest.match(/^#([\p{L}\d_/-]+)/u);
      if (m) {
        this.i += m[0].length;
        return { k: 'tag', v: m[1] };
      }
    }
    if (c === '"' || c === "'") {
      const end = this.s.indexOf(c, this.i + 1);
      if (end !== -1) {
        const v = this.s.slice(this.i + 1, end);
        this.i = end + 1;
        return { k: 'text', v };
      }
    }
    m = rest.match(/^[^\s()[\]#"']+/);
    if (!m) throw new Error(`unexpected char at ${this.i}`);
    this.i += m[0].length;
    return { k: 'word', v: m[0] };
  }

  peek(): Tok | null {
    if (!this.pushed) {
      const t = this.next();
      if (t) this.pushed = t;
    }
    return this.pushed;
  }
}

// ---------------------------------------------------------------------------
// Parser (recursive descent)
// ---------------------------------------------------------------------------

function atomFromTok(t: Tok): QueryAST {
  switch (t.k) {
    case 'page':
      return { t: 'page', page: t.v };
    case 'tag':
      return { t: 'tag', tag: t.v };
    case 'text':
      return { t: 'text', text: t.v };
    case 'word':
      if (MARKER_WORDS.has(t.v.toUpperCase())) return { t: 'marker', marker: t.v.toUpperCase() };
      if (t.v.toLowerCase() === 'all') return { t: 'all' };
      throw new Error(`unknown word: ${t.v}`);
    default:
      throw new Error('unexpected token');
  }
}

/** Parse one term; `)` is consumed by the enclosing group loop, never here. */
function parseTerm(lx: Lexer): QueryAST {
  const t = lx.next();
  if (!t) throw new Error('unexpected end of query');
  if (t.k === ')') throw new Error('unexpected )');
  if (t.k !== '(') return atomFromTok(t);

  // group: ( head? term... )
  const head = lx.next();
  if (!head) throw new Error('unclosed (');
  if (head.k === ')') throw new Error('empty ()');

  // Special heads: (priority A) (scheduled before "d") (deadline <= "d")
  const special = specialGroup(head, lx);
  if (special) return special;

  let h: 'and' | 'or' | 'not' | null = null;
  let first: Tok | null = null;
  if (head.k === 'word' && HEAD_WORDS.has(head.v.toLowerCase())) {
    h = head.v.toLowerCase() as 'and' | 'or' | 'not';
  } else {
    first = head;
  }

  const args: QueryAST[] = [];
  if (first) args.push(atomFromTok(first));
  for (;;) {
    const p = lx.peek();
    if (!p) throw new Error('unclosed (');
    if (p.k === ')') {
      lx.next();
      break;
    }
    args.push(parseTerm(lx));
  }

  if (h === 'and') return { t: 'and', children: args };
  if (h === 'or') return { t: 'or', children: args };
  if (h === 'not') return { t: 'not', child: args[0] ?? { t: 'all' } };
  // (TODO), (TODO "x") — plain group: single term passes through, several = and
  if (args.length === 1) return args[0];
  return { t: 'and', children: args };
}

/**
 * Parse special group heads: priority / scheduled / deadline.
 * Returns null when the head word is not one of them (throws on malformed).
 * Grammar:
 *   (priority) | (priority A)
 *   (scheduled before "d") | (scheduled after "d") | (scheduled between "a" "b")
 *   (scheduled <= "d") | (scheduled >= "d") | (scheduled < "d") | (scheduled > "d")
 */
function specialGroup(head: Tok, lx: Lexer): QueryAST | null {
  if (head.k !== 'word') return null;
  const w = head.v.toLowerCase();

  if (w === 'priority') {
    const lvl = lx.peek();
    if (lvl && lvl.k !== ')') {
      lx.next(); // consume the level token
      if (lvl.k !== 'word' || !/^[ABC]$/i.test(lvl.v)) throw new Error('priority level must be A/B/C');
      expectClose(lx);
      return { t: 'priority', level: lvl.v.toUpperCase() };
    }
    expectClose(lx);
    return { t: 'priority', level: null };
  }

  if (DATE_KINDS.has(w)) {
    const kind = w as 'scheduled' | 'deadline';
    const opTok = lx.next();
    if (!opTok || opTok.k !== 'word' || !DATE_OPS.has(opTok.v.toLowerCase())) {
      throw new Error('expected date operator');
    }
    const op = opTok.v.toLowerCase() as DateOp;
    const a = dateString(lx);
    let b: string | undefined;
    if (op === 'between') b = dateString(lx);
    expectClose(lx);
    return { t: 'date', kind, op, a, b };
  }

  return null;
}

/** Read a "quoted" date string token. */
function dateString(lx: Lexer): string {
  const t = lx.next();
  if (!t || t.k !== 'text') throw new Error('expected "date"');
  return t.v;
}

function expectClose(lx: Lexer): void {
  const t = lx.next();
  if (!t || t.k !== ')') throw new Error('expected )');
}

/** Parse a `{{query ...}}` body; returns null on syntax errors. */
export function parseQuery(src: string): QueryAST | null {
  try {
    const lx = new Lexer(src);
    const terms: QueryAST[] = [];
    for (;;) {
      const t = lx.peek();
      if (!t) break;
      if (t.k === ')') throw new Error('unexpected )');
      terms.push(parseTerm(lx));
    }
    if (terms.length === 0) return null;
    if (terms.length === 1) return terms[0];
    return { t: 'and', children: terms };
  } catch {
    return null;
  }
}

/** Convenience: raw block text → AST (null when not a query / invalid). */
export function parseQueryText(text: string): QueryAST | null {
  const src = queryStringOf(text);
  return src === null ? null : parseQuery(src);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Normalize a wikilink target: strip alias / subpath / extension → lowercase basename. */
export function normalizeLinkTarget(raw: string): string {
  let s = raw.split('|')[0].trim();
  const hash = s.indexOf('#');
  if (hash > 0) s = s.slice(0, hash); // `>0`: keep #tag-like names, only strip subpaths
  s = s.trim();
  if (s.toLowerCase().endsWith('.md')) s = s.slice(0, -3);
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (slash !== -1) s = s.slice(slash + 1);
  return s.toLowerCase();
}

function match(ast: QueryAST, b: QueryBlock, now: Date): boolean {
  switch (ast.t) {
    case 'all':
      return true;
    case 'marker':
      return (b.marker ?? '').toUpperCase() === ast.marker;
    case 'page': {
      const target = normalizeLinkTarget(ast.page);
      return b.links.some((l) => l === target);
    }
    case 'tag':
      return b.tags.some((t) => t === ast.tag.toLowerCase() || t.startsWith(ast.tag.toLowerCase() + '/'));
    case 'text':
      return b.text.toLowerCase().includes(ast.text.toLowerCase());
    case 'priority': {
      const pr = b.props['priority'];
      if (!pr) return false;
      return ast.level === null || pr.toUpperCase() === ast.level;
    }
    case 'date': {
      const raw = b.props[ast.kind];
      if (!raw) return false;
      const v = toDays(raw, now);
      if (v === null) return false;
      const a = toDays(ast.a, now);
      if (a === null) return false;
      switch (ast.op) {
        case 'before':
        case '<':
          return v < a;
        case 'after':
        case '>':
          return v > a;
        case '<=':
          return v <= a;
        case '>=':
          return v >= a;
        case 'between': {
          const bDays = ast.b !== undefined ? toDays(ast.b, now) : null;
          return bDays !== null && v >= a && v <= bDays;
        }
      }
      return false;
    }
    case 'and':
      return ast.children.every((c) => match(c, b, now));
    case 'or':
      return ast.children.some((c) => match(c, b, now));
    case 'not':
      return !match(ast.child, b, now);
  }
}

/** Parse a date-ish string to a day number (epoch days, UTC); null when invalid. */
export function toDays(s: string, now: Date): number | null {
  const t = s.trim().toLowerCase();
  const day = 24 * 60 * 60 * 1000;
  const localDay = (d: Date): number =>
    Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / day);
  if (t === 'today') return localDay(now);
  if (t === 'yesterday') return localDay(now) - 1;
  if (t === 'tomorrow') return localDay(now) + 1;
  const m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isFinite(d) ? Math.floor(d / day) : null;
}

/** Execute a query against a pool of indexed blocks (stable order preserved). */
export function execQuery<T extends QueryBlock>(ast: QueryAST, blocks: T[], now: Date = new Date()): T[] {
  return blocks.filter((b) => match(ast, b, now));
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Strip common markdown noise for one-line previews. */
export function plainText(s: string): string {
  return s
    .replace(/\[\[([^\]|]+)(\|[^\]]+)?\]\]/g, (_m, inner: string, alias?: string) =>
      (alias ? alias.slice(1) : inner).trim(),
    )
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/__([^_]*)__/g, '$1')
    .replace(/==([^=]*)==/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .trim();
}

// ---------------------------------------------------------------------------
// Query-table model ({{query-table ...}})
// ---------------------------------------------------------------------------

export interface QueryTableRow {
  path: string;
  blockId: string;
  text: string;
  marker: string | null;
  props: Record<string, string>;
}

export interface QueryTableModel {
  /** Property keys present across the result rows (sorted; UI-only props excluded). */
  columns: string[];
  rows: QueryTableRow[];
}

/** Props that are engine-internal and never shown as table columns. */
const TABLE_HIDDEN_PROPS = new Set(['id', 'collapsed']);

/**
 * Build the table view model for query results: fixed Block column plus one
 * dynamic column per property that occurs in any result block.
 */
export function buildQueryTableModel<T extends QueryBlock>(results: T[]): QueryTableModel {
  const keys = new Set<string>();
  for (const r of results) {
    for (const k of Object.keys(r.props)) {
      if (!TABLE_HIDDEN_PROPS.has(k)) keys.add(k);
    }
  }
  return {
    columns: Array.from(keys).sort(),
    rows: results.map((r) => ({
      path: r.path,
      blockId: r.blockId,
      text: r.text,
      marker: r.marker,
      props: r.props,
    })),
  };
}
