/**
 * The visual query builder's model → Prolog source.
 *
 * Pure logic: no obsidian / DOM imports, so the generated code is unit-tested
 * without a vault.
 */

import { parseProgram, runProgram, type Term } from './prolog';
import { PREDICATES, type ArgKind, type PredicateSpec } from './prologFacts';
import { wrapInFence } from './prologQuery';

/** One argument slot: either a variable name or a literal value. */
export interface ArgValue {
  text: string;
  isVar: boolean;
}

export interface Condition {
  /** Predicate indicator, e.g. `tag/2`. */
  pi: string;
  negate: boolean;
  args: ArgValue[];
}

/**
 * Default variable name per argument kind. Two rows of the same kind then share
 * a variable by default — which is exactly the join people want
 * (`tag(B, T), prop(B, K, V)` rather than four unrelated variables).
 */
const DEFAULT_VAR: Record<ArgKind, string> = {
  block: 'B',
  page: 'P',
  tag: 'T',
  propKey: 'K',
  propValue: 'V',
  marker: 'M',
  text: 'Text',
};

export function specOf(pi: string): PredicateSpec | undefined {
  return PREDICATES.find((p) => p.pi === pi);
}

/** A fresh condition for a predicate, with sensible variable defaults. */
export function newCondition(pi: string): Condition {
  const spec = specOf(pi);
  return {
    pi,
    negate: false,
    args: (spec?.args ?? []).map((a) => ({ text: DEFAULT_VAR[a.kind], isVar: true })),
  };
}

const NEEDS_QUOTES = /^[^a-z]|[^A-Za-z0-9_]/;

/** Render one argument as Prolog text. Empty means "anything" (`_`). */
export function renderArg(a: ArgValue): string {
  const t = a.text.trim();
  if (!t) return '_';
  if (a.isVar) return t;
  return NEEDS_QUOTES.test(t) ? `'${t.replace(/'/g, "''")}'` : t;
}

/** One condition as a goal term. */
export function conditionToGoal(c: Condition): string {
  const spec = specOf(c.pi);
  if (!spec) return '';
  const args = c.args.slice(0, spec.args.length).map(renderArg);
  while (args.length < spec.args.length) args.push('_');
  const body = `${spec.name}(${args.join(', ')})`;
  return c.negate ? `\\+ ${body}` : body;
}

/** The conjunction of every condition; '' when nothing usable is set. */
export function buildGoal(conds: readonly Condition[]): string {
  return conds.map(conditionToGoal).filter(Boolean).join(', ');
}

export interface BuiltQuery {
  goal: string;
  /** The full fenced block to insert into a note. */
  source: string;
  /** Syntax check of the generated source (null when it parses). */
  error: string | null;
}

/** Header comments explaining the schema (keeps generated blocks self-documenting). */
const HEADER = [
  '% Facts: block(Id, Text) in_page(Id, Page) tag(Id, Tag) prop(Id, Key, Value)',
  '%        link(Id, Page) ref(Id, ToId) parent(Child, Parent) task(Id, Marker)',
  '% Rules: ancestor(X, Y)  has_tag(Id, Tag)',
];

export function buildQuery(conds: readonly Condition[], withHeader = true): BuiltQuery {
  const goal = buildGoal(conds);
  if (!goal) {
    return { goal: '', source: '', error: 'Add at least one condition' };
  }
  const body = withHeader ? [...HEADER, '', `?- ${goal}.`] : [`?- ${goal}.`];
  const source = wrapInFence(body.join('\n'));
  let error: string | null = null;
  try {
    const parsed = parseProgram(body.slice(withHeader ? 3 : 0).join('\n'));
    if (parsed.queries.length === 0) error = 'Could not parse the generated goal';
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return { goal, source, error };
}

/** Dry-run the generated goal against a fact base (for the live preview). */
export function previewQuery(
  program: Parameters<typeof runProgram>[0],
  goal: string,
  maxSolutions = 12,
): { vars: string[]; rows: string[][]; error: string | null; count: number } {
  if (!goal) return { vars: [], rows: [], error: null, count: 0 };
  const out = runProgram(program, `?- ${goal}.`, { maxSolutions, maxSteps: 100_000 });
  const rows = out.rows.map((r) => out.vars.map((v) => textOf(r[v])));
  return { vars: out.vars, rows, error: out.error, count: out.rows.length };
}

function textOf(t: Term): string {
  switch (t.k) {
    case 'atom':
      return t.name;
    case 'num':
      return String(t.value);
    case 'str':
      return t.value;
    case 'var':
      return '_';
    case 'comp':
      return `${t.name}(${t.args.map(textOf).join(', ')})`;
  }
}
