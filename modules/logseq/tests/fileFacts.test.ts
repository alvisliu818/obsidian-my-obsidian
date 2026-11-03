/**
 * The shared markdown -> facts extractor. Both the in-memory BlockIndex and
 * the SQLite index are derived from this, so its output IS the definition of
 * "what a file means".
 */

import { describe, expect, it } from 'vitest';
import { SYNTHETIC_PREFIX, bkeyOf, extractFile, indentLines } from '../src/index/fileFacts';

describe('extractFile — block identity and shape', () => {
  it('emits blocks in document order with depth and parent keys', () => {
    const f = extractFile('a.md', '- one\n\t- two\n\t\t- three\n- four\n');
    expect(f.blocks.map((b) => [b.ord, b.depth, b.text])).toEqual([
      [0, 0, 'one'],
      [1, 1, 'two'],
      [2, 2, 'three'],
      [3, 0, 'four'],
    ]);
    expect(f.blocks[1].parentKey).toBe(f.blocks[0].bkey);
    expect(f.blocks[2].parentKey).toBe(f.blocks[1].bkey);
    expect(f.blocks[3].parentKey).toBe('');
  });

  it('uses the real id:: as the key and keeps a synthetic one otherwise', () => {
    const id = '11111111-1111-4111-8111-111111111111';
    const f = extractFile('a.md', `- parent\nid:: ${id}\n\t- child\n`);
    expect(f.blocks[0].bkey).toBe(id);
    expect(f.blocks[0].id).toBe(id);
    expect(f.blocks[1].id).toBe('');
    expect(f.blocks[1].bkey).toBe(`${SYNTHETIC_PREFIX}a.md#1`);
    // parent_id is the parent's real id ('' when the parent has none) — that
    // is what the Prolog `parent/2` facts are built from.
    expect(f.blocks[1].parentId).toBe(id);
  });

  it('synthetic keys can never collide with a uuid', () => {
    expect(bkeyOf('a.md', 0, '')).toBe('~a.md#0');
    expect(bkeyOf('a.md', 0, 'abc')).toBe('abc');
  });

  it('normalizes the owning page name', () => {
    expect(extractFile('folder/My Page.md', '- x\n').page).toBe('my page');
  });
});

describe('extractFile — refs out of the text', () => {
  it('collects tags, links and ((block refs))', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    const other = '33333333-3333-4333-8333-333333333333';
    const f = extractFile('a.md', `- see [[Projects/X]] and #Work/Todo ((${other}))\nid:: ${id}\n`);
    const b = f.blocks[0];
    expect(b.tags).toEqual(['work/todo']);
    expect(b.links).toEqual(['x']);
    expect(b.refs).toEqual([other]);
  });

  it('drops self-references', () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const f = extractFile('a.md', `- self ((${id}))\nid:: ${id}\n`);
    expect(f.blocks[0].refs).toEqual([]);
  });

  it('does not count tags written inside [[...]]', () => {
    expect(extractFile('a.md', '- [[note#heading]]\n').blocks[0].tags).toEqual([]);
  });
});

describe('extractFile — properties', () => {
  it('keeps `props` narrow and `blockProps` complete', () => {
    const f = extractFile('a.md', '- task\npriority:: A\ncustom:: yes\n');
    expect(f.blocks[0].props).toEqual({ priority: 'A' });
    expect(f.blocks[0].blockProps).toEqual({ priority: 'A', custom: 'yes' });
  });

  it('reads Logseq page properties off the first block', () => {
    const f = extractFile('Person.md', 'lastname:: Smith\nextends:: #Contact\n\n- a person\n');
    expect(f.pageProps).toEqual({ lastname: 'Smith', extends: '#Contact' });
  });
});

describe('extractFile — flashcards', () => {
  it('a #card block carries its children as the answer side', () => {
    const f = extractFile('a.md', '- capital of France? #card\n\t- Paris\n\t\t- since 508\n- plain\n');
    expect(f.blocks[0].isCard).toBe(true);
    expect(f.blocks[1].isCard).toBe(false);
    // Children are serialized at depth 1 — identical to the old
    // `serializeBlock(child, 1)` output the in-memory index produced.
    expect(f.blocks[0].answer).toBe('\t- Paris\n\t\t- since 508');
  });

  it('a non-card carries no answer', () => {
    expect(extractFile('a.md', '- x\n\t- y\n').blocks[0].answer).toBe('');
  });
});

describe('indentLines', () => {
  it('prefixes every line and is a no-op at depth 0', () => {
    expect(indentLines('a\nb', 1)).toBe('\ta\n\tb');
    expect(indentLines('a\nb', 0)).toBe('a\nb');
  });
});
