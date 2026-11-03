import { describe, expect, it } from 'vitest';
import {
  Program,
  atom,
  displayTerm,
  num,
  parseProgram,
  parseTerm,
  runProgram,
  runQuery,
  type QueryOutcome,
} from '../src/features/prolog';

function run(src: string, opts?: Parameters<typeof runProgram>[2]): QueryOutcome {
  return runProgram(new Program(), src, opts);
}

/** One solution per row, rendered as `Name=Value` joined by ', '. */
function rows(out: QueryOutcome): string[] {
  return out.rows.map((r) =>
    out.vars.map((v) => `${v}=${displayTerm(r[v])}`).join(', '),
  );
}

/** Value of one variable in the first row — a query's other variables are
 *  usually unbound scratch, so asserting the whole row would be noise. */
function val(src: string, name: string): string | null {
  const out = run(src);
  expect(out.error).toBeNull();
  const r = out.rows[0];
  return r ? displayTerm(r[name]) : null;
}

describe('parser', () => {
  it('reads facts, rules and queries', () => {
    const p = parseProgram(`
      parent(a, b).
      ancestor(X, Y) :- parent(X, Y).
      ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
      ?- ancestor(a, W).
    `);
    expect(p.clauses.length).toBe(3);
    expect(p.queries.length).toBe(1);
  });

  it('keeps comments and strings out of the terms', () => {
    const p = parseProgram('% lead\nf("a, b"). % trail\n');
    expect(p.clauses.length).toBe(1);
    expect(displayTerm(p.clauses[0].head)).toBe('f(a, b)');
  });

  it('supports C-style comments', () => {
    expect(parseProgram('/* skip\nme */ f(1).').clauses.length).toBe(1);
  });

  it('parses lists, partial lists and the empty list', () => {
    expect(displayTerm(parseTerm('[a, b, c]'))).toBe('[a, b, c]');
    expect(displayTerm(parseTerm('[a|T]'))).toBe('[a|T]');
    expect(displayTerm(parseTerm('[]'))).toBe('[]');
  });

  it('parses quoted atoms with spaces and escaped quotes', () => {
    expect(displayTerm(parseTerm("'Dune: part one'"))).toBe('Dune: part one');
    expect(displayTerm(parseTerm("'it''s'"))).toBe("it's");
  });

  it('respects operator precedence: * binds tighter than +', () => {
    expect(val('?- X is 2 + 3 * 4.', 'X')).toBe('14');
  });

  it('treats a sign on a number literal as part of the number', () => {
    expect(val('?- X is -3 + 1.', 'X')).toBe('-2');
    // ...but `5 - 1` stays subtraction
    expect(val('?- X is 5 - 1.', 'X')).toBe('4');
  });

  it('reads conjunction, disjunction and negation', () => {
    expect(parseTerm('a, b')).toMatchObject({ name: ',' });
    expect(parseTerm('a ; b')).toMatchObject({ name: ';' });
    expect(parseTerm('\\+ a')).toMatchObject({ name: '\\+' });
  });

  it('reports a syntax error rather than throwing raw', () => {
    const out = run('f(a.');
    expect(out.error).toBeTruthy();
    expect(out.rows.length).toBe(0);
  });
});

describe('unification', () => {
  it('binds variables in both directions', () => {
    expect(rows(run('?- f(X, b) = f(a, Y).'))).toEqual(['X=a, Y=b']);
  });

  it('shares one variable across occurrences', () => {
    expect(rows(run('?- g(X, X) = g(a, Y).'))).toEqual(['X=a, Y=a']);
  });

  it('fails on mismatched values', () => {
    expect(rows(run('?- f(X) = f(a), X = b.'))).toEqual([]);
  });

  it('refuses a cyclic term (occurs check)', () => {
    expect(rows(run('?- X = f(X).'))).toEqual([]);
  });

  it('unifies list spines and their tails', () => {
    expect(rows(run('?- [a, b] = [H | T].'))).toEqual(['H=a, T=[b]']);
  });
});

describe('resolution', () => {
  it('enumerates every solution by backtracking', () => {
    expect(rows(run('?- member(X, [a, b, c]).'))).toEqual(['X=a', 'X=b', 'X=c']);
  });

  it('joins two goals on a shared variable', () => {
    const out = run(`
      tag(b1, book).
      tag(b2, film).
      prop(b1, author, herbert).
      ?- tag(B, book), prop(B, author, A).
    `);
    expect(rows(out)).toEqual(['B=b1, A=herbert']);
  });

  it('uses the first-argument index: bound arg is a lookup, not a scan', () => {
    const out = run(`
      prop(b1, status, open).
      prop(b2, status, done).
      ?- prop(b2, K, V).
    `);
    expect(rows(out)).toEqual(['K=status, V=done']);
    // ...and an unbound first arg still finds everything
    expect(rows(run('prop(b1, a, x). prop(b2, a, y).\n?- prop(B, a, y).'))).toEqual(['B=b2']);
  });

  it('resolves recursive rules transitively', () => {
    const out = run(`
      parent(a, b).
      parent(b, c).
      parent(c, d).
      ancestor(X, Y) :- parent(X, Y).
      ancestor(X, Y) :- parent(X, Z), ancestor(Z, Y).
      ?- ancestor(a, W).
    `);
    expect(rows(out)).toEqual(['W=b', 'W=c', 'W=d']);
  });

  it('renames variables apart per activation', () => {
    // Both `p` calls use X; they must not collide.
    const out = run('p(1). p(2).\n?- p(X), p(Y).');
    expect(rows(out)).toEqual(['X=1, Y=1', 'X=1, Y=2', 'X=2, Y=1', 'X=2, Y=2']);
  });

  it('treats negation as failure', () => {
    expect(rows(run('?- \\+ member(4, [1, 2, 3]).'))).toHaveLength(1);
    expect(rows(run('?- \\+ member(2, [1, 2, 3]).'))).toHaveLength(0);
  });
});

describe('control constructs', () => {
  it('supports disjunction', () => {
    expect(rows(run('?- (X = 1 ; X = 2).'))).toEqual(['X=1', 'X=2']);
  });

  it('if-then-else commits to the condition\'s first solution', () => {
    // Without `->` this would enumerate every member.
    expect(rows(run('?- (member(X, [1, 2, 3]) -> Y = first ; Y = none).'))).toEqual([
      'X=1, Y=first',
    ]);
  });

  it('if-then-else falls through when the condition fails', () => {
    expect(rows(run('?- (member(X, []) -> Y = first ; Y = none).'))).toEqual(['X=X, Y=none']);
  });

  it('a cut inside a negated goal does not escape', () => {
    // If the `!` leaked out of the `\\+`, q/1 would stop after the first p/1.
    expect(rows(run('p(1). p(2).\nq(X) :- p(X), \\+ (X = 3, !).\n?- q(X).'))).toEqual([
      'X=1',
      'X=2',
    ]);
  });
});

describe('cut', () => {
  it('stops after the first solution of the clause', () => {
    const out = run('p(1). p(2). p(3).\nq(X) :- p(X), !.\n?- q(X).');
    expect(rows(out)).toEqual(['X=1']);
  });

  it('does not retry goals to its left', () => {
    const out = run('p(1). p(2).\nr(X, Y) :- p(X), !, p(Y).\n?- r(X, Y).');
    // Without the cut this would be 4 rows; with it, X stays 1.
    expect(rows(out)).toEqual(['X=1, Y=1', 'X=1, Y=2']);
  });

  it('is scoped to its own predicate', () => {
    const out = run('p(1). p(2).\nq(X) :- p(X), !.\ns(X) :- p(X).\n?- q(_), s(Y).');
    // The cut inside q/1 must NOT stop p/2 from being re-tried by s/1.
    expect(rows(out)).toEqual(['Y=1', 'Y=2']);
  });
});

describe('built-ins', () => {
  it('findall collects every solution into a list', () => {
    expect(val('?- findall(X, member(X, [a, b, c]), L).', 'L')).toBe('[a, b, c]');
  });

  it('findall yields the empty list when the goal has no solutions', () => {
    expect(val('?- findall(X, member(X, []), L).', 'L')).toBe('[]');
  });

  it('copies terms out of the bag (no shared variables)', () => {
    const out = run('p(f(_)). p(g(_)).\n?- findall(T, p(T), L), L = [A, B].');
    expect(rows(out)).toHaveLength(1);
  });

  it('evaluates arithmetic with is/2', () => {
    expect(val('?- X is 7 // 2.', 'X')).toBe('3');
    expect(val('?- X is 7 mod 2.', 'X')).toBe('1');
    expect(val('?- X is 2 ** 10.', 'X')).toBe('1024');
  });

  it('compares numbers', () => {
    expect(rows(run('?- 3 < 5.'))).toHaveLength(1);
    expect(rows(run('?- 5 =< 5.'))).toHaveLength(1);
    expect(rows(run('?- 5 =:= 5.'))).toHaveLength(1);
    expect(rows(run('?- 5 =\\= 6.'))).toHaveLength(1);
  });

  it('enumerates between/3', () => {
    expect(rows(run('?- between(1, 3, X).'))).toEqual(['X=1', 'X=2', 'X=3']);
  });

  it('sorts and de-duplicates', () => {
    expect(val('?- sort([c, a, b, a], L).', 'L')).toBe('[a, b, c]');
    expect(val('?- msort([c, a, b, a], L).', 'L')).toBe('[a, a, b, c]');
  });

  it('checks types', () => {
    expect(rows(run('?- atom(hello).'))).toHaveLength(1);
    expect(rows(run('?- atom(1).'))).toHaveLength(0);
    expect(rows(run('?- var(X).'))).toHaveLength(1);
    expect(rows(run('?- nonvar(X).'))).toHaveLength(0);
  });

  it('measures and concatenates text', () => {
    expect(val('?- atom_length(dune, N).', 'N')).toBe('4');
    // An uppercase token is a variable, so a literal word must be quoted.
    expect(val("?- string_concat(a, b, C).", 'C')).toBe('ab');
    expect(val("?- downcase_atom('DUNE', L).", 'L')).toBe('dune');
  });

  it('reports an unknown predicate instead of silently failing', () => {
    const out = run('?- nosuchpredicate(X).');
    expect(out.error).toContain('nosuchpredicate/1');
  });
});

describe('safety limits', () => {
  it('stops a left-recursive program at the depth limit', () => {
    const out = run('p :- p.\n?- p.', { maxDepth: 50 });
    expect(out.error).toContain('depth');
  });

  it('stops a runaway program at the step limit', () => {
    const out = run('n(0).\nn(N) :- n(M), N is M + 1.\n?- n(X).', { maxSteps: 2000 });
    expect(out.error).toContain('step limit');
  });

  it('caps the number of rows returned', () => {
    const out = run('?- between(1, 500, X).', { maxSolutions: 10 });
    expect(out.rows.length).toBe(10);
    expect(out.truncated).toBe(true);
  });
});

describe('runProgram', () => {
  it('requires a query', () => {
    const out = run('f(1).');
    expect(out.error).toContain('No query');
  });

  it('uses the last ?- as the query', () => {
    const out = run('?- X = 1.\n?- X = 2.');
    expect(rows(out)).toEqual(['X=2']);
  });

  it('lets the block define helper rules over the fact base', () => {
    const base = new Program();
    base.fact(atom('base_fact'));
    const out = runProgram(base, 'derived :- base_fact.\n?- derived.');
    expect(out.rows.length).toBe(1);
  });

  it('names duplicate variable occurrences distinctly', () => {
    expect(runQuery(new Program(), parseTerm('f(X, X) = f(a, a)')).vars).toEqual(['X']);
    // Two separate `X` variables can only come from two clauses; within one
    // query the same name is the same variable.
    expect(run('p(X, Y).\n?- p(A, B).').vars).toEqual(['A', 'B']);
  });

  it('keeps numeric terms numeric', () => {
    const out = run('?- X = 42.');
    expect(out.rows[0].X).toEqual(num(42));
  });
});
