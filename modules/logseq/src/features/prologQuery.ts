/**
 * The ```prolog query block: pull the source out of a fenced block, run it
 * against the fact base, and shape the solutions into a table model.
 *
 * Pure logic (no obsidian / DOM), so the whole path is unit-testable.
 *
 * Only TOP-LEVEL fences are treated as queries: an indented fence is absorbed
 * into its parent bullet's text by the parser, so treating those as queries
 * would hijack ordinary outline blocks.
 */

import { displayTerm, runProgram, type Term } from './prolog';

export const PROLOG_LANG = 'prolog';
export const MAX_ROWS = 200;

const FENCE_OPEN_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*prolog[ \t]*$/i;
const FENCE_CLOSE_RE = /^[ \t]*(`{3,}|~{3,})[ \t]*$/;

/**
 * Extract the Prolog source from a fenced block's text; null when the block is
 * not a ```prolog block.
 */
export function prologSourceOf(text: string): string | null {
  const lines = text.split('\n');
  if (!FENCE_OPEN_RE.test(lines[0] ?? '')) return null;
  let end = lines.length;
  for (let i = lines.length - 1; i >= 1; i--) {
    if (FENCE_CLOSE_RE.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(1, end).join('\n');
}

export interface PrologRow {
  /** One rendered cell per column. */
  cells: string[];
  /** The bound term per column, so the UI can link a block id to its source. */
  terms: Term[];
}

export interface PrologTableModel {
  /** Column names: the goal's variables, in order of first appearance. */
  vars: string[];
  rows: PrologRow[];
  truncated: boolean;
  /** Syntax / runtime / "no query" error; null when the query ran. */
  error: string | null;
  /** True when the goal has no variables (`?- tag(b1, book).` — yes or no). */
  propositional: boolean;
  steps: number;
  ms: number;
  /** The source that was run, for display next to the results. */
  source: string;
}

/** Run a ```prolog block's source against a fact base. */
export function runPrologBlock(
  program: Parameters<typeof runProgram>[0],
  blockText: string,
  maxRows: number = MAX_ROWS,
): PrologTableModel {
  const source = prologSourceOf(blockText);
  if (source === null) {
    return emptyModel('', 'Not a prolog block');
  }
  const started = Date.now();
  const out = runProgram(program, source, { maxSolutions: maxRows });
  const ms = Date.now() - started;
  const rows: PrologRow[] = out.rows.map((r) => ({
    cells: out.vars.map((v) => displayTerm(r[v])),
    terms: out.vars.map((v) => r[v]),
  }));
  return {
    vars: out.vars,
    rows,
    truncated: out.truncated,
    error: out.error,
    propositional: out.vars.length === 0,
    steps: out.steps,
    ms,
    source: source.trim(),
  };
}

function emptyModel(source: string, error: string): PrologTableModel {
  return {
    vars: [],
    rows: [],
    truncated: false,
    error,
    propositional: false,
    steps: 0,
    ms: 0,
    source,
  };
}

/** Starter source inserted by the command / slash menu. */
export function prologTemplate(): string {
  return [
    '```prolog',
    '% Facts: block(Id, Text) in_page(Id, Page) tag(Id, Tag) prop(Id, Key, Value)',
    '%        link(Id, Page) ref(Id, ToId) parent(Child, Parent) task(Id, Marker)',
    '% Rules: ancestor(X, Y)  has_tag(Id, Tag)',
    '% Uppercase = variable. Tags, pages, property keys and markers are lowercase.',
    '',
    '?- tag(B, book), prop(B, author, A).',
    '```',
  ].join('\n');
}

/** Render a goal's clauses + goal as a fenced block (used by the builder). */
export function wrapInFence(src: string): string {
  return ['```' + PROLOG_LANG, src.replace(/\s+$/, ''), '```'].join('\n');
}
