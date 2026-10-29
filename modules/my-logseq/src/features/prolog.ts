/**
 * A small Prolog interpreter: terms, parser, unification, SLD resolution with
 * backtracking, cut, and a practical set of built-ins.
 *
 * Why it exists: `{{query ...}}` is a fixed vocabulary (marker/tag/page/text/
 * date). Anything relational — "blocks tagged #book whose author also wrote a
 * block tagged #film", "everything under a heading that has a deadline" — needs
 * variables, joins and recursion, which is exactly what a logic query gives.
 *
 * Pure logic: no obsidian / DOM imports, unit-tested under plain vitest.
 *
 * Deliberate limits (safety, and this runs on every render):
 * - No `assert`/`retract`: the fact base is rebuilt from the block index, so a
 *   query can never mutate the vault or carry state across renders.
 * - No file, shell or network built-ins.
 * - Every run is bounded by inference steps, recursion depth and result count.
 *
 * Syntax: facts, rules (`h :- b.`), queries (`?- goal.`), comments (`%` and
 * C-style), lists, quoted atoms, strings, operators up to `:-`.
 */

// ---------------------------------------------------------------------------
// Terms
// ---------------------------------------------------------------------------

export interface Var {
  readonly k: 'var';
  readonly name: string;
  /** Identity stamp: two activations' `X` must not collide, so each gets one. */
  readonly stamp: number;
}
export interface Atom {
  readonly k: 'atom';
  readonly name: string;
}
export interface Num {
  readonly k: 'num';
  readonly value: number;
}
export interface Str {
  readonly k: 'str';
  readonly value: string;
}
export interface Comp {
  readonly k: 'comp';
  readonly name: string;
  readonly args: Term[];
}
export type Term = Var | Atom | Num | Str | Comp;

let stampSeq = 0;
export function freshVar(name: string): Var {
  return { k: 'var', name, stamp: stampSeq++ };
}
export function atom(name: string): Atom {
  return { k: 'atom', name };
}
export function num(value: number): Num {
  return { k: 'num', value };
}
export function str(value: string): Str {
  return { k: 'str', value };
}
export function comp(name: string, args: Term[]): Comp {
  return { k: 'comp', name, args };
}

export const TRUE: Atom = atom('true');
export const NIL: Atom = atom('[]');
/** `[a,b|T]` — the standard `'[|]'/2` spine. */
export function cons(head: Term, tail: Term): Comp {
  return comp('[|]', [head, tail]);
}
export function listTerm(items: Term[], tail: Term = NIL): Term {
  let out = tail;
  for (let i = items.length - 1; i >= 0; i--) out = cons(items[i], out);
  return out;
}

/** Predicate indicator, e.g. `tag/2`. */
export function functorKey(t: Term): string {
  if (t.k === 'comp') return `${t.name}/${t.args.length}`;
  return `${t.k === 'atom' ? t.name : '?'}/0`;
}

export class PrologError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrologError';
  }
}

// ---------------------------------------------------------------------------
// Binder: mutable bindings + trail, so backtracking is a pop to a mark
// ---------------------------------------------------------------------------

class Binder {
  private binds = new Map<number, Term>();
  private trail: Var[] = [];

  mark(): number {
    return this.trail.length;
  }

  /** Undo every binding made after `m`. Idempotent. */
  undo(m: number): void {
    while (this.trail.length > m) {
      const v = this.trail.pop();
      if (v) this.binds.delete(v.stamp);
    }
  }

  bind(v: Var, t: Term): void {
    this.binds.set(v.stamp, t);
    this.trail.push(v);
  }

  deref(t: Term): Term {
    let cur = t;
    let guard = 0;
    while (cur.k === 'var') {
      const b = this.binds.get(cur.stamp);
      if (!b) return cur;
      cur = b;
      if (++guard > 1e6) throw new PrologError('variable binding chain too long');
    }
    return cur;
  }
}

/** Does `v` occur inside `t`? Without this, `X = f(X)` builds a cyclic term. */
function occurs(v: Var, t: Term, bd: Binder): boolean {
  const x = bd.deref(t);
  if (x.k === 'var') return x.stamp === v.stamp;
  if (x.k === 'comp') return x.args.some((a) => occurs(v, a, bd));
  return false;
}

export function unify(a: Term, b: Term, bd: Binder): boolean {
  const x = bd.deref(a);
  const y = bd.deref(b);
  if (x === y) return true;
  if (x.k === 'var' && y.k === 'var') {
    bd.bind(x, y);
    return true;
  }
  if (x.k === 'var') {
    if (occurs(x, y, bd)) return false;
    bd.bind(x, y);
    return true;
  }
  if (y.k === 'var') {
    if (occurs(y, x, bd)) return false;
    bd.bind(y, x);
    return true;
  }
  if (x.k === 'num' && y.k === 'num') return x.value === y.value;
  if (x.k === 'atom' && y.k === 'atom') return x.name === y.name;
  if (x.k === 'str' && y.k === 'str') return x.value === y.value;
  if (x.k === 'comp' && y.k === 'comp') {
    if (x.name !== y.name || x.args.length !== y.args.length) return false;
    for (let i = 0; i < x.args.length; i++) {
      if (!unify(x.args[i], y.args[i], bd)) return false;
    }
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

const NEEDS_QUOTES = /^[^a-z]|[^A-Za-z0-9_]/;

/** Canonical Prolog text (quoted where required) — for errors and code preview. */
export function formatTerm(t: Term, bd?: Binder): string {
  const x = bd ? bd.deref(t) : t;
  switch (x.k) {
    case 'var':
      return x.name === '_' ? `_G${x.stamp}` : x.name;
    case 'num':
      return String(x.value);
    case 'str':
      return `"${x.value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
    case 'atom':
      return NEEDS_QUOTES.test(x.name) ? `'${x.name.replace(/'/g, "''")}'` : x.name;
    case 'comp':
      return `${x.name}(${x.args.map((a) => formatTerm(a, bd)).join(', ')})`;
  }
}

/**
 * UI text: like `formatTerm` but unquoted, so page names and block text read
 * naturally in a results table. Lists print as `[a, b]`.
 */
export function displayTerm(t: Term, bd?: Binder): string {
  const x = bd ? bd.deref(t) : t;
  if (x.k === 'comp' && x.name === '[|]') {
    const items: string[] = [];
    let cur: Term = x;
    let guard = 0;
    while (cur.k === 'comp' && cur.name === '[|]' && guard++ < 1000) {
      items.push(displayTerm(cur.args[0], bd));
      cur = bd ? bd.deref(cur.args[1]) : cur.args[1];
    }
    if (cur.k === 'atom' && cur.name === '[]') return `[${items.join(', ')}]`;
    return `[${items.join(', ')}|${displayTerm(cur, bd)}]`;
  }
  switch (x.k) {
    case 'var':
      return x.name;
    case 'num':
      return String(x.value);
    case 'str':
      return x.value;
    case 'atom':
      return x.name;
    case 'comp':
      return `${x.name}(${x.args.map((a) => displayTerm(a, bd)).join(', ')})`;
  }
}

/** Deep copy with fresh variables for unbound ones (what `findall` needs). */
function copyTerm(t: Term, bd: Binder, map: Map<number, Var>): Term {
  const x = bd.deref(t);
  if (x.k === 'var') {
    let n = map.get(x.stamp);
    if (!n) {
      n = freshVar(x.name);
      map.set(x.stamp, n);
    }
    return n;
  }
  if (x.k === 'comp') return comp(x.name, x.args.map((a) => copyTerm(a, bd, map)));
  return x;
}

function hasVars(t: Term): boolean {
  if (t.k === 'var') return true;
  if (t.k === 'comp') return t.args.some(hasVars);
  return false;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

const SYMBOL_CHARS = new Set(Array.from('+#&*+-./:<=>?@^~\\'));

type TokKind = 'var' | 'atom' | 'num' | 'str' | 'punc' | 'sym' | 'end';
interface Tok {
  kind: TokKind;
  v: string;
  n?: number;
}

class Lexer {
  private toks: Tok[] = [];
  private i = 0;

  constructor(s: string) {
    this.run(s);
  }

  list(): Tok[] {
    return this.toks;
  }

  private run(s: string): void {
    while (this.i < s.length) {
      const c = s[this.i];
      if (/\s/.test(c)) {
        this.i++;
        continue;
      }
      if (c === '%') {
        while (this.i < s.length && s[this.i] !== '\n') this.i++;
        continue;
      }
      if (c === '/' && s[this.i + 1] === '*') {
        this.i += 2;
        while (this.i < s.length && !(s[this.i] === '*' && s[this.i + 1] === '/')) this.i++;
        this.i += 2;
        continue;
      }
      // '.' is the end token only when followed by whitespace / EOF / comment.
      if (c === '.') {
        const n = s[this.i + 1];
        if (n === undefined || /\s/.test(n) || n === '%') {
          this.i++;
          this.toks.push({ kind: 'end', v: '.' });
          continue;
        }
      }
      if (/[0-9]/.test(c)) {
        const m = /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(s.slice(this.i));
        if (!m) throw new PrologError('bad number');
        this.toks.push({ kind: 'num', v: m[0], n: Number(m[0]) });
        this.i += m[0].length;
        continue;
      }
      if (c === '"' || c === "'") {
        this.quoted(s, c);
        continue;
      }
      if (/[a-z]/.test(c)) {
        this.word(s, 'atom');
        continue;
      }
      if (/[A-Z_]/.test(c)) {
        this.word(s, 'var');
        continue;
      }
      // `;` and `!` are ISO "solo" characters: not part of a symbol-atom run,
      // but they still have to reach the operator table.
      if (c === ';' || c === '!') {
        this.i++;
        this.toks.push({ kind: 'sym', v: c });
        continue;
      }
      if ('()[]{}|,'.includes(c)) {
        this.i++;
        this.toks.push({ kind: 'punc', v: c });
        continue;
      }
      if (SYMBOL_CHARS.has(c)) {
        let j = this.i;
        while (j < s.length && SYMBOL_CHARS.has(s[j])) j++;
        this.toks.push({ kind: 'sym', v: s.slice(this.i, j) });
        this.i = j;
        continue;
      }
      throw new PrologError(`unexpected character '${c}'`);
    }
  }

  private word(s: string, kind: 'atom' | 'var'): void {
    let j = this.i;
    while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j++;
    this.toks.push({ kind, v: s.slice(this.i, j) });
    this.i = j;
  }

  private quoted(s: string, q: string): void {
    this.i++;
    let out = '';
    while (this.i < s.length) {
      const c = s[this.i];
      if (c === '\\') {
        const e = s[this.i + 1];
        if (e === undefined) break;
        out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
        this.i += 2;
        continue;
      }
      if (c === q) {
        if (q === "'" && s[this.i + 1] === "'") {
          out += "'";
          this.i += 2;
          continue;
        }
        this.i++;
        this.toks.push({ kind: q === '"' ? 'str' : 'atom', v: out });
        return;
      }
      out += c;
      this.i++;
    }
    throw new PrologError('unterminated quoted item');
  }
}

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

type InfixType = 'xfx' | 'xfy' | 'yfx';
type PrefixType = 'fy' | 'fx';

/** [precedence, associativity]; lower precedence binds tighter. */
const INFIX: Record<string, [number, InfixType]> = {
  ':-': [1200, 'xfx'],
  '-->': [1200, 'xfx'],
  ';': [1100, 'xfy'],
  '|': [1100, 'xfy'],
  '->': [1050, 'xfy'],
  ',': [1000, 'xfy'],
  '=': [700, 'xfx'],
  '\\=': [700, 'xfx'],
  '==': [700, 'xfx'],
  '\\==': [700, 'xfx'],
  '@<': [700, 'xfx'],
  '@>': [700, 'xfx'],
  '@=<': [700, 'xfx'],
  '@>=': [700, 'xfx'],
  is: [700, 'xfx'],
  '=:=': [700, 'xfx'],
  '=\\=': [700, 'xfx'],
  '<': [700, 'xfx'],
  '>': [700, 'xfx'],
  '=<': [700, 'xfx'],
  '>=': [700, 'xfx'],
  '+': [500, 'yfx'],
  '-': [500, 'yfx'],
  '/\\': [500, 'yfx'],
  '\\/': [500, 'yfx'],
  '*': [400, 'yfx'],
  '/': [400, 'yfx'],
  '//': [400, 'yfx'],
  mod: [400, 'yfx'],
  rem: [400, 'yfx'],
  '<<': [400, 'yfx'],
  '>>': [400, 'yfx'],
  '**': [200, 'xfx'],
  '^': [200, 'xfy'],
};

const PREFIX: Record<string, [number, PrefixType]> = {
  ':-': [1200, 'fx'],
  '?-': [1200, 'fx'],
  '\\+': [900, 'fy'],
  '-': [200, 'fy'],
  '+': [200, 'fy'],
  '\\': [200, 'fy'],
};

const MAX_PREC = 1200;
/** Argument precedence: `,` (1000) and `;`/`|` separate instead of joining. */
const ARG_PREC = 999;

/**
 * Operators that are ALWAYS prefix, even when followed by `(`.
 *
 * `\+(a, b)` is how everyone writes a negated conjunction, but the usual
 * "name immediately followed by `(` is a functor" rule would read it as a
 * two-argument functor `\+/2`. These three are never meant as functors.
 */
const ALWAYS_PREFIX = new Set(['\\+', '?-', ':-']);

/**
 * `,` and `|` lex as punctuation (list and argument syntax needs that) but are
 * also infix operators, so the operator loop has to accept them too.
 */
function isOperatorToken(t: Tok): boolean {
  return t.kind === 'sym' || t.kind === 'atom' || (t.kind === 'punc' && (t.v === ',' || t.v === '|'));
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

export interface Clause {
  head: Term;
  body: Term;
}

export interface ParsedProgram {
  clauses: Clause[];
  /** Every `?- goal` directive, in source order. The last one is the query. */
  queries: Term[];
}

class Parser {
  private pos = 0;
  /**
   * Variables of the clause being parsed. Every occurrence of `X` in ONE clause
   * must be the same variable — without this, `f(X, X)` would be two unrelated
   * variables and every join in a query would silently fail. Anonymous `_` is
   * always fresh.
   */
  private vars = new Map<string, Var>();

  constructor(private toks: Tok[]) {}

  private varOf(name: string): Var {
    if (name === '_') return freshVar('_');
    let v = this.vars.get(name);
    if (!v) {
      v = freshVar(name);
      this.vars.set(name, v);
    }
    return v;
  }

  private peek(n = 0): Tok | null {
    return this.toks[this.pos + n] ?? null;
  }

  private take(): Tok {
    const t = this.toks[this.pos++];
    if (!t) throw new PrologError('unexpected end of input');
    return t;
  }

  private expectPunc(v: string): void {
    const t = this.take();
    if (t.kind !== 'punc' || t.v !== v) throw new PrologError(`expected '${v}' but found '${t.v}'`);
  }

  /** One clause (or directive); null at end of input. */
  clause(): Clause | null {
    const head = this.peek();
    if (!head || head.kind === 'end') return null;
    this.vars = new Map(); // each clause has its own variables
    const term = this.readTerm(MAX_PREC);
    const end = this.peek();
    if (end && end.kind === 'end') this.pos++;
    else if (end !== null) throw new PrologError(`expected '.' but found '${end.v}'`);
    if (term.k === 'comp' && term.name === ':-' && term.args.length === 2) {
      return { head: term.args[0], body: term.args[1] };
    }
    if (term.k === 'comp' && term.name === '?-' && term.args.length === 1) {
      return { head: atom('?-'), body: term.args[0] };
    }
    return { head: term, body: TRUE };
  }

  private readTerm(maxPrec: number): Term {
    let left = this.readPrimary();
    for (;;) {
      const t = this.peek();
      if (!t || !isOperatorToken(t)) break;
      const op = INFIX[t.v];
      if (!op || op[0] > maxPrec) break;
      const after = this.peek(1);
      // `foo(is)` / `[a, b]`: an operator name used as a bare argument.
      if (
        after &&
        ((after.kind === 'punc' && ')]}|,'.includes(after.v)) || after.kind === 'end')
      ) {
        break;
      }
      const [prec, type] = op;
      this.pos++;
      const right = this.readTerm(type === 'yfx' ? prec : prec - 1);
      left = comp(t.v, [left, right]);
    }
    return left;
  }

  private readPrimary(): Term {
    const t = this.take();
    switch (t.kind) {
      case 'num':
        return num(t.n ?? Number(t.v));
      case 'str':
        return str(t.v);
      case 'var':
        return this.varOf(t.v);
      case 'atom':
        return this.peek()?.kind === 'punc' && this.peek()?.v === '('
          ? comp(t.v, this.argList())
          : atom(t.v);
      case 'sym': {
        // `?- goal` is always the directive form, never a functor call.
        if (t.v === '?-') return comp('?-', [this.readTerm(MAX_PREC)]);
        const pre = PREFIX[t.v];
        if (pre && (ALWAYS_PREFIX.has(t.v) || !this.isCall())) {
          const [prec, type] = pre;
          return comp(t.v, [this.readTerm(type === 'fy' ? prec : prec - 1)]);
        }
        // `-1`: a sign directly on a number literal (`5 - 1` stays subtraction,
        // because there `-` is consumed by the infix loop instead).
        if ((t.v === '-' || t.v === '+') && this.peek()?.kind === 'num') {
          const n = this.take();
          return num(t.v === '-' ? -(n.n ?? 0) : (n.n ?? 0));
        }
        if (this.isCall()) return comp(t.v, this.argList());
        return atom(t.v);
      }
      case 'punc': {
        if (t.v === '(') {
          const inner = this.readTerm(MAX_PREC);
          this.expectPunc(')');
          return inner;
        }
        if (t.v === '[') return this.listBody();
        if (t.v === '{') {
          if (this.peek()?.kind === 'punc' && this.peek()?.v === '}') {
            this.pos++;
            return atom('{}');
          }
          const inner = this.readTerm(MAX_PREC);
          this.expectPunc('}');
          return comp('{}', [inner]);
        }
        throw new PrologError(`unexpected '${t.v}'`);
      }
      default:
        throw new PrologError(`unexpected '${t.v}'`);
    }
  }

  private isCall(): boolean {
    const p = this.peek();
    return p !== null && p.kind === 'punc' && p.v === '(';
  }

  private argList(): Term[] {
    this.expectPunc('(');
    const args: Term[] = [];
    if (this.peek()?.kind === 'punc' && this.peek()?.v === ')') {
      this.pos++;
      return args;
    }
    for (;;) {
      args.push(this.readTerm(ARG_PREC));
      if (this.peek()?.kind === 'punc' && this.peek()?.v === ',') {
        this.pos++;
        continue;
      }
      break;
    }
    this.expectPunc(')');
    return args;
  }

  private listBody(): Term {
    if (this.peek()?.kind === 'punc' && this.peek()?.v === ']') {
      this.pos++;
      return NIL;
    }
    const items: Term[] = [];
    for (;;) {
      items.push(this.readTerm(ARG_PREC));
      if (this.peek()?.kind === 'punc' && this.peek()?.v === ',') {
        this.pos++;
        continue;
      }
      break;
    }
    let tail: Term = NIL;
    if (this.peek()?.kind === 'punc' && this.peek()?.v === '|') {
      this.pos++;
      tail = this.readTerm(ARG_PREC);
    }
    this.expectPunc(']');
    return listTerm(items, tail);
  }
}

/** Parse a whole source. Throws `PrologError` with a readable message. */
export function parseProgram(src: string): ParsedProgram {
  const p = new Parser(new Lexer(src).list());
  const clauses: Clause[] = [];
  const queries: Term[] = [];
  for (;;) {
    const c = p.clause();
    if (!c) break;
    const h = c.head;
    // `:- directive` has no side effects we support; drop it.
    if (h.k === 'atom' && h.name === '?-') queries.push(c.body);
    else if (!(h.k === 'atom' && h.name === ':-')) clauses.push(c);
  }
  return { clauses, queries };
}

/** Parse a single term such as `tag(X, book)`; throws on bad syntax. */
export function parseTerm(src: string): Term {
  const parsed = parseProgram(`${src}.`);
  if (parsed.clauses.length === 0) throw new PrologError('not a term');
  return parsed.clauses[0].head;
}

// ---------------------------------------------------------------------------
// Clause database
// ---------------------------------------------------------------------------

export interface ClauseSource {
  candidates(goal: Term, bd: Binder): Clause[];
  /** Whether the predicate exists at all — distinct from "no matching clause". */
  has(pi: string): boolean;
}

/** Unambiguous key for a first-argument value (JSON escapes any delimiter). */
function valueKey(t: Term): string | null {
  if (t.k === 'atom') return JSON.stringify(['a', t.name]);
  if (t.k === 'num') return JSON.stringify(['n', t.value]);
  if (t.k === 'str') return JSON.stringify(['s', t.value]);
  return null;
}

export class Program implements ClauseSource {
  private byName = new Map<string, Clause[]>();
  /**
   * `pi` → first-arg value key → clauses. Turns `prop(Id, k, v)` into a lookup
   * instead of a scan, which is what makes joins over a big fact base feasible.
   */
  private byFirstArg = new Map<string, Map<string, Clause[]>>();
  private names: string[] = [];
  /**
   * Predicates with at least one clause whose first argument is NOT a literal
   * (a rule like `ancestor(X, Y) :- ...`): a concrete value cannot be looked up
   * in the index for those, so they must fall back to the full clause list.
   */
  private notIndexable = new Set<string>();

  assert(head: Term, body: Term = TRUE): void {
    if (head.k === 'var' || head.k === 'num' || head.k === 'str') {
      throw new PrologError(`cannot assert ${formatTerm(head)}`);
    }
    const key = functorKey(head);
    let list = this.byName.get(key);
    if (!list) {
      list = [];
      this.byName.set(key, list);
      this.names.push(key);
    }
    list.push({ head, body });
    if (head.k === 'comp' && head.args.length > 0) {
      const vk = valueKey(head.args[0]);
      if (!vk) {
        this.notIndexable.add(key);
        return;
      }
      let m = this.byFirstArg.get(key);
      if (!m) {
        m = new Map();
        this.byFirstArg.set(key, m);
      }
      let l2 = m.get(vk);
      if (!l2) {
        l2 = [];
        m.set(vk, l2);
      }
      l2.push({ head, body });
    }
  }

  /** Assert a fact (a clause whose body is `true`). */
  fact(t: Term): void {
    this.assert(t, TRUE);
  }

  has(pi: string): boolean {
    return this.byName.has(pi);
  }

  /** Sorted predicate indicators — drives the visual builder's dropdown. */
  predicates(): string[] {
    return [...new Set(this.names)].sort();
  }

  candidates(goal: Term, bd: Binder): Clause[] {
    const key = functorKey(goal);
    if (!this.notIndexable.has(key) && goal.k === 'comp' && goal.args.length > 0) {
      const vk = valueKey(bd.deref(goal.args[0]));
      if (vk) return this.byFirstArg.get(key)?.get(vk) ?? [];
    }
    return this.byName.get(key) ?? [];
  }
}

/**
 * Block-local clauses on top of the shared fact base. The fact base is large
 * and rebuilt on every index change, so layering beats copying it per query.
 */
export class LayeredProgram implements ClauseSource {
  constructor(
    private local: Clause[],
    private base: Program,
  ) {}

  candidates(goal: Term, bd: Binder): Clause[] {
    const key = functorKey(goal);
    if (this.local.length > 0) {
      const mine = this.local.filter((c) => functorKey(c.head) === key);
      if (mine.length > 0) {
        const rest = this.base.candidates(goal, bd);
        return rest.length === 0 ? mine : [...mine, ...rest];
      }
    }
    return this.base.candidates(goal, bd);
  }

  has(pi: string): boolean {
    return this.local.some((c) => functorKey(c.head) === pi) || this.base.has(pi);
  }
}

// ---------------------------------------------------------------------------
// Solver
// ---------------------------------------------------------------------------

type Goal = Generator<void, void, void>;

interface Ctx {
  src: ClauseSource;
  steps: number;
  maxSteps: number;
  maxDepth: number;
}

/** Thrown by `!` to unwind to the clause that owns it. */
class CutSignal {
  constructor(public barrier: object) {}
}

const DEFAULT_MAX_STEPS = 300_000;
const DEFAULT_MAX_DEPTH = 250;
/** Cap on a `findall` bag, so one goal cannot exhaust memory. */
const MAX_BAG = 10_000;

function isCut(t: Term): boolean {
  return t.k === 'atom' && t.name === '!';
}

/**
 * Solve one goal. `barrier` is the clause body a cut `!` belongs to, or null at
 * the top level. It is threaded explicitly rather than read off a stack: while
 * an inner predicate is suspended mid-solution, its own barrier is still the
 * top of the stack, and a cut in the OUTER clause body would steal it.
 */
function* solveGoal(
  goal: Term,
  bd: Binder,
  ctx: Ctx,
  depth: number,
  barrier: object | null,
): Goal {
  if (depth > ctx.maxDepth) {
    throw new PrologError(`recursion depth limit reached (${ctx.maxDepth})`);
  }
  if (++ctx.steps > ctx.maxSteps) {
    throw new PrologError(`step limit reached (${ctx.maxSteps} inferences)`);
  }
  const g = bd.deref(goal);

  if (g.k === 'var') throw new PrologError('goal is an unbound variable');
  if (g.k === 'num' || g.k === 'str') throw new PrologError(`${formatTerm(g, bd)} is not callable`);

  if (g.k === 'atom') {
    if (g.name === 'true') {
      yield;
      return;
    }
    if (g.name === 'fail' || g.name === 'false') return;
    if (g.name === '!') {
      yield;
      if (barrier) throw new CutSignal(barrier);
      return;
    }
    const bi = BUILTINS[`${g.name}/0`];
    if (bi) {
      yield* callBuiltin(bi, [], bd, ctx, depth + 1);
      return;
    }
    yield* solveUser(g, bd, ctx, depth);
    return;
  }

  const { name, args } = g;
  const arity = args.length;

  // --- control constructs: intercepted before built-ins and user clauses ---
  if (arity === 2 && name === ',') {
    if (isCut(bd.deref(args[0]))) {
      yield* solveGoal(args[1], bd, ctx, depth + 1, barrier);
      if (barrier) throw new CutSignal(barrier);
      return;
    }
    for (const _ of solveGoal(args[0], bd, ctx, depth + 1, barrier)) {
      yield* solveGoal(args[1], bd, ctx, depth + 1, barrier);
    }
    return;
  }
  // `;` and `->` are transparent to cut: a `!` in either branch still cuts the
  // enclosing clause.
  if (arity === 2 && name === ';') {
    // `( If -> Then ; Else )` is one construct: when If succeeds it COMMITS,
    // so Else must not run — otherwise `member(X,[1,2,3]) -> T ; E` would also
    // give you E. Equivalent to `(If, !, Then ; Else)` with a local cut.
    const left = bd.deref(args[0]);
    if (left.k === 'comp' && left.name === '->' && left.args.length === 2) {
      const bar = {};
      let taken = false;
      try {
        for (const _ of solveGoal(left.args[0], bd, ctx, depth + 1, bar)) {
          taken = true;
          // Then keeps its own backtracking; only the condition is committed.
          yield* solveGoal(left.args[1], bd, ctx, depth + 1, barrier);
          throw new CutSignal(bar);
        }
      } catch (e) {
        if (e instanceof CutSignal && e.barrier === bar) return;
        throw e;
      }
      if (!taken) yield* solveGoal(args[1], bd, ctx, depth + 1, barrier);
      return;
    }
    yield* solveGoal(args[0], bd, ctx, depth + 1, barrier);
    yield* solveGoal(args[1], bd, ctx, depth + 1, barrier);
    return;
  }
  if (arity === 2 && name === '->') {
    const mark = bd.mark();
    for (const _ of solveGoal(args[0], bd, ctx, depth + 1, barrier)) {
      yield* solveGoal(args[1], bd, ctx, depth + 1, barrier);
      bd.undo(mark);
      break; // if-then commits to the condition's first solution
    }
    bd.undo(mark);
    return;
  }
  if (arity === 1 && name === '\\+') return yield* negate(args[0], bd, ctx, depth + 1);

  const bi = BUILTINS[`${name}/${arity}`];
  if (bi) {
    yield* callBuiltin(bi, args, bd, ctx, depth + 1);
    return;
  }
  yield* solveUser(g, bd, ctx, depth);
}

/**
 * Run a built-in. Built-ins are written without trail bookkeeping (they just
 * unify and yield), so the undo has to happen here — otherwise `X = 1 ; X = 2`
 * would leave X bound to 1 and the second branch could never succeed.
 */
function* callBuiltin(
  bi: BuiltinFn,
  args: Term[],
  bd: Binder,
  ctx: Ctx,
  depth: number,
): Goal {
  const mark = bd.mark();
  try {
    yield* bi(args, bd, ctx, depth);
  } finally {
    bd.undo(mark);
  }
}

function* negate(goal: Term, bd: Binder, ctx: Ctx, depth: number): Goal {
  const mark = bd.mark();
  let any = false;
  try {
    // Cut is opaque inside a negated goal: a `!` there is local to it.
    for (const _ of solveGoal(goal, bd, ctx, depth, {})) {
      any = true;
      break;
    }
  } catch (e) {
    if (!(e instanceof CutSignal)) throw e;
  }
  bd.undo(mark);
  if (!any) yield;
}

/**
 * Run a goal under its own cut barrier — what `call/1`, `findall/3` and
 * `forall/2` need, since a cut inside them must not escape.
 */
function* callOpaque(goal: Term, bd: Binder, ctx: Ctx, depth: number): Goal {
  const barrier = {};
  try {
    yield* solveGoal(goal, bd, ctx, depth, barrier);
  } catch (e) {
    if (!(e instanceof CutSignal && e.barrier === barrier)) throw e;
  }
}

function* solveUser(goal: Term, bd: Binder, ctx: Ctx, depth: number): Goal {
  const clauses = ctx.src.candidates(goal, bd);
  if (clauses.length === 0) {
    // "No clause matches" and "no such predicate" are different things: the
    // first-argument index returns nothing for a value that simply has no
    // clauses (a leaf block has no `parent` row), which must FAIL, not error.
    if (!ctx.src.has(functorKey(goal))) throw new PrologError(`unknown predicate: ${functorKey(goal)}`);
    return;
  }
  const barrier = {};
  for (const cl of clauses) {
      // Ground clauses carry no variables, so they can be reused as-is;
      // renaming 100k facts per query would cost more than the query itself.
      const inst = hasVars(cl.head) || hasVars(cl.body) ? renameClause(cl) : cl;
      const mark = bd.mark();
      if (unify(goal, inst.head, bd)) {
        try {
          yield* solveGoal(inst.body, bd, ctx, depth + 1, barrier);
        } catch (e) {
          if (e instanceof CutSignal && e.barrier === barrier) {
            bd.undo(mark);
            return;
          }
          bd.undo(mark);
          throw e;
        }
      bd.undo(mark);
    } else {
      bd.undo(mark);
    }
  }
}

/** Rename a clause's variables apart so two activations never share them. */
function renameClause(cl: Clause): Clause {
  const map = new Map<number, Var>();
  const walk = (t: Term): Term => {
    if (t.k === 'var') {
      let n = map.get(t.stamp);
      if (!n) {
        n = freshVar(t.name);
        map.set(t.stamp, n);
      }
      return n;
    }
    if (t.k === 'comp') return comp(t.name, t.args.map(walk));
    return t;
  };
  return { head: walk(cl.head), body: walk(cl.body) };
}

// ---------------------------------------------------------------------------
// Standard order and arithmetic
// ---------------------------------------------------------------------------

function typeRank(t: Term): number {
  switch (t.k) {
    case 'var':
      return 0;
    case 'num':
      return 1;
    case 'atom':
      return 2;
    case 'str':
      return 3;
    case 'comp':
      return 4;
  }
}

export function compareStd(a: Term, b: Term): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (a.k === 'var' && b.k === 'var') return a.stamp === b.stamp ? 0 : a.stamp < b.stamp ? -1 : 1;
  if (a.k === 'num' && b.k === 'num') return a.value === b.value ? 0 : a.value < b.value ? -1 : 1;
  if (a.k === 'atom' && b.k === 'atom') return a.name === b.name ? 0 : a.name < b.name ? -1 : 1;
  if (a.k === 'str' && b.k === 'str') return a.value === b.value ? 0 : a.value < b.value ? -1 : 1;
  if (a.k === 'comp' && b.k === 'comp') {
    if (a.args.length !== b.args.length) return a.args.length < b.args.length ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    for (let i = 0; i < a.args.length; i++) {
      const c = compareStd(a.args[i], b.args[i]);
      if (c !== 0) return c;
    }
    return 0;
  }
  return 0;
}

function evalArith(t: Term, bd: Binder): number {
  const x = bd.deref(t);
  if (x.k === 'num') return x.value;
  if (x.k === 'atom') {
    if (x.name === 'pi') return Math.PI;
    if (x.name === 'e') return Math.E;
    if (x.name === 'inf') return Infinity;
    if (x.name === 'max_tagged_integer') return Number.MAX_SAFE_INTEGER;
    throw new PrologError(`arithmetic: unknown constant '${x.name}'`);
  }
  if (x.k === 'comp') {
    if (x.args.length === 1) {
      const a = evalArith(x.args[0], bd);
      switch (x.name) {
        case '-':
          return -a;
        case '+':
          return a;
        case 'abs':
          return Math.abs(a);
        case 'sign':
          return Math.sign(a);
        case 'sqrt':
          return Math.sqrt(a);
        case 'truncate':
        case 'integer':
          return Math.trunc(a);
        case 'round':
          return Math.round(a);
        case 'floor':
          return Math.floor(a);
        case 'ceiling':
        case 'ceil':
          return Math.ceil(a);
        case '\\':
          return ~a;
        default:
          throw new PrologError(`arithmetic: unknown function ${x.name}/1`);
      }
    }
    if (x.args.length === 2) {
      const a = evalArith(x.args[0], bd);
      const b = evalArith(x.args[1], bd);
      switch (x.name) {
        case '+':
          return a + b;
        case '-':
          return a - b;
        case '*':
          return a * b;
        case '/':
          if (b === 0) throw new PrologError('arithmetic: division by zero');
          return a / b;
        case '//':
          if (b === 0) throw new PrologError('arithmetic: division by zero');
          return Math.trunc(a / b);
        case 'mod':
          if (b === 0) throw new PrologError('arithmetic: division by zero');
          return a - b * Math.floor(a / b);
        case 'rem':
          if (b === 0) throw new PrologError('arithmetic: division by zero');
          return a - b * Math.trunc(a / b);
        case 'min':
          return Math.min(a, b);
        case 'max':
          return Math.max(a, b);
        case '**':
        case '^':
          return Math.pow(a, b);
        case '>>':
          return a >> b;
        case '<<':
          return a << b;
        case '/\\':
          return a & b;
        case '\\/':
          return a | b;
        case 'gcd':
          return gcd(a, b);
        default:
          throw new PrologError(`arithmetic: unknown function ${x.name}/2`);
      }
    }
  }
  throw new PrologError(`arithmetic: ${formatTerm(x, bd)} is not a number`);
}

function gcd(a: number, b: number): number {
  let x = Math.abs(Math.trunc(a));
  let y = Math.abs(Math.trunc(b));
  while (y) {
    const t = y;
    y = x % y;
    x = t;
  }
  return x;
}

// ---------------------------------------------------------------------------
// Built-ins
// ---------------------------------------------------------------------------

type BuiltinFn = (args: Term[], bd: Binder, ctx: Ctx, depth: number) => Goal;

/** Walk a list spine; `null` when it is not a (possibly partial) list. */
function listItems(l: Term, bd: Binder): { items: Term[]; tail: Term } | null {
  const items: Term[] = [];
  let cur = bd.deref(l);
  let guard = 0;
  while (guard++ < 1e6) {
    if (cur.k === 'atom' && cur.name === '[]') return { items, tail: cur };
    if (cur.k === 'comp' && cur.name === '[|]' && cur.args.length === 2) {
      items.push(cur.args[0]);
      cur = bd.deref(cur.args[1]);
      continue;
    }
    return null;
  }
  return null;
}

function cmp(pred: (c: number) => boolean): BuiltinFn {
  return function* (args, bd) {
    if (pred(compareStd(bd.deref(args[0]), bd.deref(args[1])))) yield;
  };
}

function arithCmp(pred: (a: number, b: number) => boolean): BuiltinFn {
  return function* (args, bd) {
    if (pred(evalArith(args[0], bd), evalArith(args[1], bd))) yield;
  };
}

function typeCheck1(fn: (t: Term) => boolean): BuiltinFn {
  return function* (args, bd) {
    if (fn(bd.deref(args[0]))) yield;
  };
}

function isGround(t: Term, bd: Binder): boolean {
  const x = bd.deref(t);
  if (x.k === 'var') return false;
  if (x.k === 'comp') return x.args.every((a) => isGround(a, bd));
  return true;
}

function sortBuiltin(dedup: boolean): BuiltinFn {
  return function* (args, bd) {
    const l = listItems(bd.deref(args[0]), bd);
    if (!l || !(l.tail.k === 'atom' && l.tail.name === '[]')) {
      throw new PrologError('sort/2: not a proper list');
    }
    const items = l.items.map((t) => bd.deref(t));
    items.sort(compareStd);
    const out: Term[] = [];
    for (const t of items) {
      if (dedup && out.length > 0 && compareStd(out[out.length - 1], t) === 0) continue;
      out.push(t);
    }
    if (unify(args[1], listTerm(out), bd)) yield;
  };
}

function caseBuiltin(fn: (s: string) => string): BuiltinFn {
  return function* (args, bd) {
    const a = bd.deref(args[0]);
    const text = a.k === 'atom' ? a.name : a.k === 'str' ? a.value : null;
    if (text === null) throw new PrologError('case conversion: not an atom');
    if (unify(args[1], atom(fn(text)), bd)) yield;
  };
}

const BUILTINS: Record<string, BuiltinFn> = {
  'true/0': function* () {
    yield;
  },
  'fail/0': function* () {},
  'false/0': function* () {},

  '=/2': function* (args, bd) {
    if (unify(args[0], args[1], bd)) yield;
  },
  '\\=/2': function* (args, bd) {
    const mark = bd.mark();
    const ok = unify(args[0], args[1], bd);
    bd.undo(mark);
    if (!ok) yield;
  },
  '==/2': function* (args, bd) {
    if (compareStd(bd.deref(args[0]), bd.deref(args[1])) === 0) yield;
  },
  '\\==/2': function* (args, bd) {
    if (compareStd(bd.deref(args[0]), bd.deref(args[1])) !== 0) yield;
  },
  '@</2': cmp((c) => c < 0),
  '@=</2': cmp((c) => c <= 0),
  '@>/2': cmp((c) => c > 0),
  '@>=/2': cmp((c) => c >= 0),
  'compare/3': function* (args, bd) {
    const c = compareStd(bd.deref(args[1]), bd.deref(args[2]));
    if (unify(args[0], atom(c < 0 ? '<' : c > 0 ? '>' : '='), bd)) yield;
  },

  'is/2': function* (args, bd) {
    if (unify(args[0], num(evalArith(args[1], bd)), bd)) yield;
  },
  '</2': arithCmp((a, b) => a < b),
  '>/2': arithCmp((a, b) => a > b),
  '=</2': arithCmp((a, b) => a <= b),
  '>=/2': arithCmp((a, b) => a >= b),
  '=:=/2': arithCmp((a, b) => a === b),
  '=\\=/2': arithCmp((a, b) => a !== b),

  'var/1': function* (args, bd) {
    if (bd.deref(args[0]).k === 'var') yield;
  },
  'nonvar/1': function* (args, bd) {
    if (bd.deref(args[0]).k !== 'var') yield;
  },
  'atom/1': typeCheck1((t) => t.k === 'atom'),
  'number/1': typeCheck1((t) => t.k === 'num'),
  'string/1': typeCheck1((t) => t.k === 'str'),
  'atomic/1': typeCheck1((t) => t.k === 'atom' || t.k === 'num' || t.k === 'str'),
  'compound/1': typeCheck1((t) => t.k === 'comp'),
  'callable/1': typeCheck1((t) => t.k === 'atom' || t.k === 'comp'),
  'ground/1': function* (args, bd) {
    if (isGround(args[0], bd)) yield;
  },
  'is_list/1': function* (args, bd) {
    const t = bd.deref(args[0]);
    if (t.k === 'atom' && t.name === '[]') yield;
    else if (t.k === 'comp' && t.name === '[|]' && t.args.length === 2) {
      const l = listItems(t, bd);
      if (l && l.tail.k === 'atom' && l.tail.name === '[]') yield;
    }
  },

  'findall/3': function* (args, bd, ctx, depth) {
    const [tpl, goal, bag] = args;
    const items: Term[] = [];
    const mark = bd.mark();
    try {
      for (const _ of callOpaque(goal, bd, ctx, depth)) {
        items.push(copyTerm(tpl, bd, new Map()));
        bd.undo(mark);
        if (items.length >= MAX_BAG) break;
      }
    } finally {
      bd.undo(mark);
    }
    if (unify(bag, listTerm(items), bd)) yield;
  },
  'forall/2': function* (args, bd, ctx, depth) {
    const mark = bd.mark();
    let all = true;
    for (const _ of callOpaque(args[0], bd, ctx, depth)) {
      const m2 = bd.mark();
      let ok = false;
      for (const __ of callOpaque(args[1], bd, ctx, depth)) {
        ok = true;
        break;
      }
      bd.undo(m2);
      if (!ok) {
        all = false;
        break;
      }
    }
    bd.undo(mark);
    if (all) yield;
  },
  'copy_term/2': function* (args, bd) {
    if (unify(args[1], copyTerm(args[0], bd, new Map()), bd)) yield;
  },

  'member/2': function* (args, bd) {
    const [x, l] = args;
    let cur = bd.deref(l);
    let guard = 0;
    while (guard++ < 1e6) {
      const c = bd.deref(cur);
      if (c.k === 'atom' && c.name === '[]') return;
      if (c.k === 'comp' && c.name === '[|]' && c.args.length === 2) {
        const mark = bd.mark();
        if (unify(x, c.args[0], bd)) yield;
        bd.undo(mark);
        cur = c.args[1];
        continue;
      }
      if (c.k === 'var') {
        // Partial list: one solution. `member(X, L)` is otherwise infinite,
        // which is never what a note query wants.
        const mark = bd.mark();
        if (unify(c, listTerm([x], freshVar('_')), bd)) yield;
        bd.undo(mark);
        return;
      }
      throw new PrologError(`member/2: ${formatTerm(c, bd)} is not a list`);
    }
  },
  'length/2': function* (args, bd) {
    const [l, n] = args;
    const t = bd.deref(l);
    if (t.k === 'str') {
      if (unify(n, num(t.value.length), bd)) yield;
      return;
    }
    const parsed = listItems(t, bd);
    if (parsed && parsed.tail.k === 'atom' && parsed.tail.name === '[]') {
      if (unify(n, num(parsed.items.length), bd)) yield;
      return;
    }
    const nv = bd.deref(n);
    if (nv.k === 'num') {
      const want = Math.trunc(nv.value);
      if (want < 0) return;
      if (parsed) {
        const extra = want - parsed.items.length;
        if (extra < 0) return;
        if (unify(parsed.tail, listTerm(Array.from({ length: extra }, () => freshVar('_'))), bd)) {
          yield;
        }
        return;
      }
      if (unify(t, listTerm(Array.from({ length: want }, () => freshVar('_'))), bd)) yield;
      return;
    }
    throw new PrologError('length/2: need a proper list or a length');
  },
  'append/3': function* (args, bd) {
    const [a, b, c] = args;
    const av = bd.deref(a);
    if (av.k === 'atom' && av.name === '[]') {
      if (unify(b, c, bd)) yield;
      return;
    }
    const al = listItems(av, bd);
    if (al) {
      const mark = bd.mark();
      if (unify(c, listTerm(al.items, b), bd)) yield;
      bd.undo(mark);
      return;
    }
    const cl = listItems(bd.deref(c), bd);
    if (cl) {
      for (let i = 0; i <= cl.items.length; i++) {
        const mark = bd.mark();
        const ok =
          unify(a, listTerm(cl.items.slice(0, i), freshVar('_')), bd) &&
          unify(b, listTerm(cl.items.slice(i), cl.tail), bd);
        if (ok) yield;
        bd.undo(mark);
      }
      return;
    }
    throw new PrologError('append/3: insufficiently instantiated');
  },
  'between/3': function* (args, bd) {
    const lo = evalArith(args[0], bd);
    const hi = evalArith(args[1], bd);
    const x = bd.deref(args[2]);
    if (x.k === 'num') {
      if (x.value >= lo && x.value <= hi) yield;
      return;
    }
    if (x.k !== 'var') throw new PrologError('between/3: third argument is not a variable');
    for (let i = Math.ceil(lo); i <= Math.floor(hi); i++) {
      const mark = bd.mark();
      if (unify(args[2], num(i), bd)) yield;
      bd.undo(mark);
    }
  },
  'call/1': function* (args, bd, ctx, depth) {
    yield* callOpaque(args[0], bd, ctx, depth);
  },
  'sort/2': sortBuiltin(true),
  'msort/2': sortBuiltin(false),

  'atom_string/2': function* (args, bd) {
    const av = bd.deref(args[0]);
    const sv = bd.deref(args[1]);
    if (av.k === 'atom') {
      if (unify(args[1], str(av.name), bd)) yield;
      return;
    }
    if (sv.k === 'str') {
      if (unify(args[0], atom(sv.value), bd)) yield;
      return;
    }
    throw new PrologError('atom_string/2: one argument must be bound');
  },
  'number_string/2': function* (args, bd) {
    const nv = bd.deref(args[0]);
    const sv = bd.deref(args[1]);
    if (nv.k === 'num') {
      if (unify(args[1], str(String(nv.value)), bd)) yield;
      return;
    }
    if (sv.k === 'str') {
      const v = Number(sv.value);
      if (!Number.isNaN(v) && unify(args[0], num(v), bd)) yield;
      return;
    }
    throw new PrologError('number_string/2: one argument must be bound');
  },
  'atom_length/2': function* (args, bd) {
    const a = bd.deref(args[0]);
    const text = a.k === 'atom' ? a.name : a.k === 'str' ? a.value : null;
    if (text === null) throw new PrologError('atom_length/2: not an atom');
    if (unify(args[1], num(text.length), bd)) yield;
  },
  'string_concat/3': function* (args, bd) {
    const text = (t: Term): string | null =>
      t.k === 'atom' ? t.name : t.k === 'str' ? t.value : t.k === 'num' ? String(t.value) : null;
    const ta = text(bd.deref(args[0]));
    const tb = text(bd.deref(args[1]));
    const tc = text(bd.deref(args[2]));
    if (ta !== null && tb !== null) {
      if (unify(args[2], str(ta + tb), bd)) yield;
      return;
    }
    if (tc !== null && ta !== null && tc.startsWith(ta)) {
      if (unify(args[1], str(tc.slice(ta.length)), bd)) yield;
      return;
    }
    if (tc !== null && tb !== null && tc.endsWith(tb)) {
      if (unify(args[0], str(tc.slice(0, tc.length - tb.length)), bd)) yield;
      return;
    }
    throw new PrologError('string_concat/3: insufficiently instantiated');
  },
  'downcase_atom/2': caseBuiltin((s) => s.toLowerCase()),
  'upcase_atom/2': caseBuiltin((s) => s.toUpperCase()),
};

// ---------------------------------------------------------------------------
// Query API
// ---------------------------------------------------------------------------

export interface QueryOptions {
  /** Inference budget: a runaway program stops here instead of hanging the UI. */
  maxSteps?: number;
  maxSolutions?: number;
  maxDepth?: number;
}

export interface QueryOutcome {
  /** Column names: the goal's variables, in order of first appearance. */
  vars: string[];
  rows: Array<Record<string, Term>>;
  /** True when `maxSolutions` cut the result short. */
  truncated: boolean;
  /** Syntax or runtime error text; `rows` is empty when set. */
  error: string | null;
  steps: number;
}

/** The goal's variables in first-appearance order (anonymous ones excluded). */
export function goalVars(goal: Term): Var[] {
  const out: Var[] = [];
  const seen = new Set<number>();
  const walk = (t: Term): void => {
    if (t.k === 'var') {
      if (seen.has(t.stamp)) return;
      seen.add(t.stamp);
      if (t.name !== '_' && !t.name.startsWith('_')) out.push(t);
      return;
    }
    if (t.k === 'comp') t.args.forEach(walk);
  };
  walk(goal);
  return out;
}

/** Distinct display names for the goal's variables (`X`, `X_2`, ...). */
export function columnNames(goal: Term): string[] {
  const seen = new Map<string, number>();
  return goalVars(goal).map((v) => {
    const n = seen.get(v.name) ?? 0;
    seen.set(v.name, n + 1);
    return n === 0 ? v.name : `${v.name}_${n + 1}`;
  });
}

/** Run a goal. Never throws: problems come back as `error`. */
export function runQuery(
  src: ClauseSource,
  goal: Term,
  opts: QueryOptions = {},
): QueryOutcome {
  const vars = goalVars(goal);
  const names = columnNames(goal);
  const bd = new Binder();
  const ctx: Ctx = {
    src,
    steps: 0,
    maxSteps: opts.maxSteps ?? DEFAULT_MAX_STEPS,
    maxDepth: opts.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
  const rows: Array<Record<string, Term>> = [];
  const maxSolutions = opts.maxSolutions ?? 200;
  let truncated = false;
  try {
    for (const _ of solveGoal(goal, bd, ctx, 0, null)) {
      const row: Record<string, Term> = {};
      for (let i = 0; i < vars.length; i++) {
        row[names[i]] = copyTerm(vars[i], bd, new Map());
      }
      rows.push(row);
      if (rows.length >= maxSolutions) {
        truncated = true;
        break;
      }
    }
  } catch (e) {
    return {
      vars: names,
      rows: [],
      truncated: false,
      error: e instanceof Error ? e.message : String(e),
      steps: ctx.steps,
    };
  }
  return { vars: names, rows, truncated, error: null, steps: ctx.steps };
}

/**
 * Parse and run a full source (rules then `?- goal`), the shape a ```prolog
 * block uses. The block's own clauses are layered over the shared fact base.
 */
export function runProgram(
  base: Program,
  src: string,
  opts: QueryOptions = {},
): QueryOutcome & { goal: Term | null } {
  let parsed: ParsedProgram;
  try {
    parsed = parseProgram(src);
  } catch (e) {
    return {
      vars: [],
      rows: [],
      truncated: false,
      error: e instanceof Error ? e.message : String(e),
      steps: 0,
      goal: null,
    };
  }
  const goal = parsed.queries[parsed.queries.length - 1] ?? null;
  if (!goal) {
    return {
      vars: [],
      rows: [],
      truncated: false,
      error: 'No query. Add a goal such as:  ?- block(B, Text).',
      steps: 0,
      goal: null,
    };
  }
  const srcLayers =
    parsed.clauses.length > 0 ? new LayeredProgram(parsed.clauses, base) : base;
  return { ...runQuery(srcLayers, goal, opts), goal };
}
