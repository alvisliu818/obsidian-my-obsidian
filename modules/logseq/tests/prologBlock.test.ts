import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';
import { buildPrologFacts, type PrologFactBlock } from '../src/features/prologFacts';
import { prologSourceOf, prologTemplate, runPrologBlock, wrapInFence } from '../src/features/prologQuery';

const BLOCKS: PrologFactBlock[] = [
  { path: 'books.md', blockId: 'b1', text: 'Dune', marker: null, tags: ['book'], links: [], props: {}, blockProps: { author: 'Herbert' }, parentId: '' },
  { path: 'books.md', blockId: 'b2', text: 'Solaris', marker: null, tags: ['book'], links: [], props: {}, blockProps: { author: 'Lem' }, parentId: '' },
  { path: 'books.md', blockId: 'b3', text: 'Foundation', marker: null, tags: ['book'], links: [], props: {}, blockProps: {}, parentId: '' },
];
const program = buildPrologFacts({ allBlocks: () => BLOCKS, allTags: () => ['book'] }).program;

const fence = (body: string): string => ['```prolog', body, '```'].join('\n');

describe('prologSourceOf', () => {
  it('extracts the body of a prolog fence', () => {
    expect(prologSourceOf(fence('?- tag(B, book).'))).toBe('?- tag(B, book).');
  });

  it('keeps multi-line programs and blank lines', () => {
    const src = fence(['fav(B) :- tag(B, book).', '', '?- fav(B).'].join('\n'));
    expect(prologSourceOf(src)).toBe(['fav(B) :- tag(B, book).', '', '?- fav(B).'].join('\n'));
  });

  it('is case-insensitive about the language tag', () => {
    expect(prologSourceOf('```PROLOG\n?- true.\n```')).toBe('?- true.');
  });

  it('rejects other languages and unfenced text', () => {
    expect(prologSourceOf('```json\n{}\n```')).toBeNull();
    expect(prologSourceOf('just text')).toBeNull();
    expect(prologSourceOf('')).toBeNull();
  });

  it('survives an unterminated fence (uses the rest of the block)', () => {
    expect(prologSourceOf('```prolog\n?- true.')).toBe('?- true.');
  });
});

describe('runPrologBlock', () => {
  it('renders one column per variable and one row per solution', () => {
    const m = runPrologBlock(program, fence('?- tag(B, book), prop(B, author, A).'));
    expect(m.error).toBeNull();
    expect(m.vars).toEqual(['B', 'A']);
    expect(m.rows.map((r) => r.cells)).toEqual([
      ['b1', 'Herbert'],
      ['b2', 'Lem'],
    ]);
  });

  it('reports a goal with no variables as a yes/no answer', () => {
    const m = runPrologBlock(program, fence('?- tag(b1, book).'));
    expect(m.error).toBeNull();
    expect(m.propositional).toBe(true);
    expect(m.rows.length).toBe(1);
  });

  it('shows the syntax error instead of throwing', () => {
    const m = runPrologBlock(program, fence('?- tag(B, book'));
    expect(m.error).toBeTruthy();
    expect(m.rows.length).toBe(0);
  });

  it('asks for a query when the block has no ?-', () => {
    const m = runPrologBlock(program, fence('fav(B) :- tag(B, book).'));
    expect(m.error).toContain('No query');
  });

  it('lets the block define its own rules over the fact base', () => {
    const m = runPrologBlock(program, fence(['fav(B) :- tag(B, book), prop(B, author, A).', '', '?- fav(B).'].join('\n')));
    expect(m.error).toBeNull();
    expect(m.rows.map((r) => r.cells)).toEqual([['b1'], ['b2']]);
  });

  it('refuses a block that is not a prolog fence', () => {
    expect(runPrologBlock(program, 'plain text').error).toBe('Not a prolog block');
  });

  it('caps rows and says so', () => {
    const m = runPrologBlock(program, fence('?- block(B, T).'), 2);
    expect(m.rows.length).toBe(2);
    expect(m.truncated).toBe(true);
  });
});

describe('the query is plain markdown', () => {
  it('survives a save: the fence is preserved byte-for-byte', () => {
    const doc = parseDocument(['- intro', '', '```prolog', '?- tag(B, book).', '```', '', '- after'].join('\n'));
    const fenceBlock = doc.blocks.find((b) => prologSourceOf(b.text) !== null);
    expect(fenceBlock).toBeTruthy();
    expect(fenceBlock?.kind).toBe('raw');

    // The serializer is compact (no blank lines between blocks), so the target
    // is the normalized form — what matters is that the FENCE is untouched and
    // still a working query afterwards.
    const out = serializeDocument(doc);
    expect(out).toContain('```prolog\n?- tag(B, book).\n```');
    const again = parseDocument(out).blocks.find((b) => prologSourceOf(b.text) !== null);
    expect(again).toBeTruthy();
    expect(prologSourceOf(again?.text ?? '')).toBe('?- tag(B, book).');

    const m = runPrologBlock(program, again?.text ?? '');
    expect(m.error).toBeNull();
    expect(m.rows.length).toBe(3);
  });

  it('only a TOP-LEVEL fence is a query', () => {
    // An indented fence is absorbed into its parent bullet by the parser, so
    // it can never be a standalone raw block.
    const doc = parseDocument(['- parent', '  ```prolog', '  ?- tag(B, book).', '  ```'].join('\n'));
    expect(doc.blocks.length).toBe(1);
    expect(prologSourceOf(doc.blocks[0].text)).toBeNull();
  });
});

describe('templates', () => {
  it('wraps a goal in a fence', () => {
    expect(wrapInFence('?- true.')).toBe('```prolog\n?- true.\n```');
  });

  it('the starter template is itself a runnable block', () => {
    const m = runPrologBlock(program, prologTemplate());
    expect(m.error).toBeNull();
  });
});
