import { describe, expect, it } from 'vitest';
import { Program, displayTerm, runProgram } from '../src/features/prolog';
import {
  MAX_FACTS,
  buildPrologFacts,
  pageNameOf,
  valuesForKind,
  type PrologFactBlock,
  type PrologFactSource,
} from '../src/features/prologFacts';
import { buildQuery, newCondition, previewQuery, renderArg } from '../src/features/prologBuild';

function src(blocks: PrologFactBlock[], tags: string[] = []): PrologFactSource {
  return { allBlocks: () => blocks, allTags: () => tags };
}

const FIXTURE: PrologFactBlock[] = [
  {
    path: 'books.md',
    blockId: 'b1',
    text: 'Dune',
    marker: null,
    tags: ['book'],
    links: [],
    props: {},
    blockProps: { author: 'Herbert', year: '1965' },
    parentId: '',
  },
  {
    path: 'books.md',
    blockId: 'b2',
    text: 'Solaris',
    marker: null,
    tags: ['book'],
    links: [],
    props: {},
    blockProps: { author: 'Lem' },
    parentId: '',
  },
  {
    path: 'journal/2026-10-04.md',
    blockId: 'b3',
    text: 'read Dune',
    marker: 'TODO',
    tags: ['reading'],
    links: ['dune'],
    props: {},
    blockProps: {},
    parentId: '',
  },
  {
    path: 'journal/2026-10-04.md',
    blockId: 'b4',
    text: 'chapter notes',
    marker: null,
    tags: [],
    links: [],
    props: {},
    blockProps: {},
    parentId: 'b3',
  },
  // No id: cannot be referenced, so it must produce no facts at all.
  {
    path: 'books.md',
    blockId: '',
    text: 'orphan',
    marker: null,
    tags: ['book'],
    links: [],
    props: {},
    blockProps: {},
    parentId: '',
  },
];

const FIX = src(FIXTURE, ['book', 'reading']);
const { program, stats } = buildPrologFacts(FIX);

function ask(goal: string): string[] {
  const out = runProgram(program, `?- ${goal}.`, { maxSolutions: 50 });
  expect(out.error).toBeNull();
  return out.rows.map((r) => out.vars.map((v) => displayTerm(r[v])).join('/'));
}

/** Solution count for a goal with no variables (a yes/no query). */
function count(goal: string): number {
  const out = runProgram(program, `?- ${goal}.`);
  expect(out.error).toBeNull();
  return out.rows.length;
}

describe('pageNameOf', () => {
  it('takes the lowercased basename without .md', () => {
    expect(pageNameOf('books.md')).toBe('books');
    expect(pageNameOf('journal/2026-10-04.md')).toBe('2026-10-04');
    expect(pageNameOf('a\\b\\Notes.md')).toBe('notes');
  });
});

describe('fact base', () => {
  it('skips blocks without an id', () => {
    expect(stats.blocks).toBe(5);
    // 4 addressable blocks: block + in_file + in_page each, plus their own data.
    expect(ask('block(B, _)')).toEqual(['b1', 'b2', 'b3', 'b4']);
  });

  it('exposes tags, properties, links and markers', () => {
    expect(ask('tag(B, book)')).toEqual(['b1', 'b2']);
    expect(ask('prop(B, author, A)')).toEqual(['b1/Herbert', 'b2/Lem']);
    expect(ask('link(B, dune)')).toEqual(['b3']);
    expect(ask('task(B, todo)')).toEqual(['b3']);
  });

  it('lowercases markers so they are not parsed as variables', () => {
    // `TODO` would parse as a VARIABLE, so `task(B, todo)` only works because
    // the fact base stores markers lowercased.
    expect(ask('task(B, todo)')).toEqual(['b3']);
  });

  it('lowercases property keys', () => {
    const p2 = buildPrologFacts(
      src([
        { path: 'a.md', blockId: 'x1', text: '', marker: null, tags: [], links: [], props: {}, blockProps: { Author: 'Me' } },
      ]),
    ).program;
    const out = runProgram(p2, '?- prop(x1, author, V).');
    expect(out.error).toBeNull();
    expect(out.rows.length).toBe(1);
  });

  it('hides id and collapsed from the data', () => {
    const p2 = buildPrologFacts(
      src([
        {
          path: 'a.md',
          blockId: 'x1',
          text: '',
          marker: null,
          tags: [],
          links: [],
          props: {},
          blockProps: { id: 'x1', collapsed: 'true', note: 'keep' },
        },
      ]),
    ).program;
    const out = runProgram(p2, '?- prop(x1, K, _).');
    expect(out.rows.map((r) => displayTerm(r.K))).toEqual(['note']);
  });

  it('resolves ancestor/2 transitively and has_tag/2 through parents', () => {
    expect(ask('parent(b4, P)')).toEqual(['b3']);
    expect(ask('ancestor(b4, A)')).toEqual(['b3']);
    // b4 has no tag of its own; its parent carries #reading.
    expect(count('has_tag(b4, reading)')).toBe(1);
    expect(count('has_tag(b4, book)')).toBe(0);
  });

  it('records pages', () => {
    expect(ask('page(P, books)')).toEqual(['books.md']);
    expect(ask('in_page(B, books)')).toEqual(['b1', 'b2']);
  });

  it('reports a truncation when the fact ceiling is hit', () => {
    const big = buildPrologFacts(FIX, 5);
    expect(big.stats.truncated).toBe(true);
    expect(big.stats.facts).toBe(5);
    expect(MAX_FACTS).toBeGreaterThan(1000);
  });
});

describe('visual builder', () => {
  it('defaults each argument to a variable named by its kind', () => {
    const c = newCondition('tag/2');
    expect(c.args.map((a) => a.text)).toEqual(['B', 'T']);
    expect(c.args.every((a) => a.isVar)).toBe(true);
  });

  it('joins conditions that share a variable name', () => {
    const tag = newCondition('tag/2');
    tag.args[1] = { text: 'book', isVar: false };
    const prop = newCondition('prop/3');
    const { goal } = buildQuery([tag, prop]);
    expect(goal).toBe('tag(B, book), prop(B, K, V)');
  });

  it('quotes literals that would otherwise parse as variables', () => {
    expect(renderArg({ text: 'Open', isVar: false })).toBe("'Open'");
    expect(renderArg({ text: 'open', isVar: false })).toBe('open');
    expect(renderArg({ text: 'two words', isVar: false })).toBe("'two words'");
    expect(renderArg({ text: "it's", isVar: false })).toBe("'it''s'");
  });

  it('treats an empty argument as "anything"', () => {
    expect(renderArg({ text: '', isVar: false })).toBe('_');
  });

  it('negates a condition', () => {
    const c = newCondition('tag/2');
    c.args[1] = { text: 'draft', isVar: false };
    c.negate = true;
    expect(buildQuery([c]).goal).toBe('\\+ tag(B, draft)');
  });

  it('refuses to build an empty query', () => {
    expect(buildQuery([]).error).toBeTruthy();
  });

  it('generates a source that parses back to the same goal', () => {
    const tag = newCondition('tag/2');
    tag.args[1] = { text: 'book', isVar: false };
    const built = buildQuery([tag]);
    expect(built.error).toBeNull();
    expect(built.source.startsWith('```prolog')).toBe(true);
    expect(built.source).toContain('?- tag(B, book).');
  });

  it('previews results against the fact base', () => {
    const tag = newCondition('tag/2');
    tag.args[1] = { text: 'book', isVar: false };
    const out = previewQuery(program, buildQuery([tag]).goal);
    expect(out.error).toBeNull();
    expect(out.rows).toEqual([['b1'], ['b2']]);
  });

  it('suggests real values per argument kind', () => {
    expect(valuesForKind(FIX, 'tag')).toEqual(['book', 'reading']);
    expect(valuesForKind(FIX, 'propKey')).toEqual(['author', 'year']);
    expect(valuesForKind(FIX, 'marker')).toContain('todo');
  });
});

describe('empty fact base', () => {
  it('answers nothing rather than erroring', () => {
    const p: Program = buildPrologFacts(src([])).program;
    const out = runProgram(p, '?- tag(B, book).');
    // `tag/2` exists as a built-in rule (has_tag), so this is an empty result…
    expect(out.rows.length).toBe(0);
    expect(out.error).toBeNull();
  });
});
