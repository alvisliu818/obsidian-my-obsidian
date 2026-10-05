/**
 * Folding state round-trips through markdown as a property line below the
 * block — the same shape a list block already uses.
 *
 * The constraint this covers (measured, not assumed): `serializeBlock` used to
 * answer a verbatim block with `return b.text`, so a raw block's props were
 * dropped on every save, and a `collapsed:: true` line INSIDE a fence comes
 * back as code. So the flag has to live outside the text.
 *
 * Both levels share one key: `collapsed:: true` (one-line summary) and
 * `collapsed:: full` (terse marker).
 */
import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeDocument, serializeBlock } from '../src/core/serializer';
import { createBlock, type Block } from '../src/types';
import { foldLevelOf, foldSummary, isFoldableBody, isMediaOnlyBlock, nextFoldLevel } from '../src/core/fold';

function roundTrip(md: string): string {
  return serializeDocument(parseDocument(md)).trim();
}

describe('fold state as a property below the block', () => {
  it('reads a fold flag written under a fenced code block', () => {
    const md = ['```python', 'x = 1', '```', 'collapsed:: true'].join('\n');
    const doc = parseDocument(md);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe('raw');
    expect(foldLevelOf(doc.blocks[0].props)).toBe('summary');
  });

  it('reads the full level too', () => {
    const doc = parseDocument(['```python', 'x = 1', '```', 'collapsed:: full'].join('\n'));
    expect(foldLevelOf(doc.blocks[0].props)).toBe('full');
  });

  it('round-trips both levels unchanged', () => {
    for (const level of ['true', 'full']) {
      const md = ['```python', 'x = 1', '```', `collapsed:: ${level}`].join('\n');
      expect(roundTrip(md)).toBe(md);
    }
  });

  it('round-trips a folded heading, a folded table and a folded quote', () => {
    const cases = [
      ['# Heading', 'collapsed:: true'].join('\n'),
      ['| a | b |', '| --- | --- |', '| 1 | 2 |', 'collapsed:: true'].join('\n'),
      ['> quoted', '> more', 'collapsed:: true'].join('\n'),
    ];
    for (const md of cases) {
      expect(roundTrip(md)).toBe(md);
      expect(foldLevelOf(parseDocument(md).blocks[0].props)).toBe('summary');
    }
  });

  it('round-trips a folded math fence', () => {
    const md = ['$$', 'x^2', '$$', 'collapsed:: true'].join('\n');
    expect(roundTrip(md)).toBe(md);
    expect(foldLevelOf(parseDocument(md).blocks[0].props)).toBe('summary');
  });

  it('a fold flag only binds to a CLOSED region', () => {
    // An unterminated fence can still gain lines, so a property inside it is
    // content — this is what keeps `key:: value` inside a code block as code.
    const md = ['```', 'collapsed:: true', 'x = 1', '```'].join('\n');
    const doc = parseDocument(md);
    expect(doc.blocks[0].props).toEqual({});
    expect(doc.blocks[0].text).toContain('collapsed:: true');
  });

  it('leaves an unrelated key under a raw block as content', () => {
    // Only the fold flag is re-attached; other keys must not silently migrate.
    const md = ['```', 'x = 1', '```', 'author:: me'].join('\n');
    const doc = parseDocument(md);
    expect(doc.blocks[0].props).toEqual({});
    expect(doc.blocks[0].text).toContain('author:: me');
  });

  it('two folded fences in a row each keep their own flag', () => {
    // A blank line separates them: two adjacent verbatim blocks are written
    // back with one, since two fences written back to back would merge into
    // a single construct in CommonMark.
    const md = [
      '```',
      'a = 1',
      '```',
      'collapsed:: true',
      '',
      '```',
      'b = 2',
      '```',
      'collapsed:: full',
    ].join('\n');
    const doc = parseDocument(md);
    expect(doc.blocks).toHaveLength(2);
    expect(foldLevelOf(doc.blocks[0].props)).toBe('summary');
    expect(foldLevelOf(doc.blocks[1].props)).toBe('full');
    expect(roundTrip(md)).toBe(md);
  });

  it('an unfolded raw block still serializes to exactly its text', () => {
    const b: Block = { ...createBlock('```\nx = 1\n```'), kind: 'raw' };
    expect(serializeBlock(b, 0)).toBe('```\nx = 1\n```');
  });

  it('skips fold props in embeds / drag previews', () => {
    const b: Block = { ...createBlock('```\nx = 1\n```'), kind: 'raw', props: { collapsed: 'true' } };
    const out = serializeBlock(b, 0, ['id', 'collapsed']);
    expect(out).toBe('```\nx = 1\n```');
  });

  it('a list block with children is unaffected', () => {
    const md = ['- item', '\tcollapsed:: true', '\t- child'].join('\n');
    const doc = parseDocument(md);
    expect(doc.blocks[0].props['collapsed']).toBe('true');
    expect(roundTrip(md)).toBe(md);
  });
});

describe('foldable bodies', () => {
  const block = (text: string, children = 0): Block => ({
    ...createBlock(text),
    children: Array.from({ length: children }, () => createBlock('c')),
  });

  it('a single-line block with no children has nothing to fold', () => {
    expect(isFoldableBody(block('a short line'))).toBe(false);
  });

  it('multi-line text is foldable', () => {
    expect(isFoldableBody(block('line one\nline two'))).toBe(true);
  });

  it('a block with children is foldable', () => {
    expect(isFoldableBody(block('parent', 2))).toBe(true);
  });

  it('media-only blocks are foldable even on one line', () => {
    expect(isFoldableBody(block('![](a.png)'))).toBe(true);
    expect(isFoldableBody(block('![[diagram.png]]'))).toBe(true);
    expect(isFoldableBody(block('![](clip.mp4)'))).toBe(true);
  });

  it('prose that merely contains an image is not media-only', () => {
    expect(isMediaOnlyBlock('see ![](a.png) here')).toBe(false);
    expect(isFoldableBody(block('see ![](a.png) here'))).toBe(false);
  });

  it('a plain link is not media', () => {
    expect(isMediaOnlyBlock('[link](x.md)')).toBe(false);
  });

  it('several images in one block are still media-only', () => {
    expect(isMediaOnlyBlock('![](a.png) ![[b.png]]')).toBe(true);
  });
});

describe('fold levels cycle', () => {
  it('plain click is a two-state toggle: fold, then expand', () => {
    // Three states on the common path meant expanding took two clicks, which
    // reads as "the first click didn't register" — the caret is a small target
    // in the margin, so a user has no way to tell which click was wasted.
    expect(nextFoldLevel('none', false)).toBe('summary');
    expect(nextFoldLevel('summary', false)).toBe('none');
  });

  it('a plain click also expands from the full level', () => {
    expect(nextFoldLevel('full', false)).toBe('none');
  });

  it('alt click goes straight to full, and unfolds from full', () => {
    expect(nextFoldLevel('none', true)).toBe('full');
    expect(nextFoldLevel('summary', true)).toBe('full');
    expect(nextFoldLevel('full', true)).toBe('none');
  });
});

describe('fold summaries', () => {
  it('a code fence summarises to its first line', () => {
    const doc = parseDocument(['```python', 'def hello():', '    pass', '```'].join('\n'));
    expect(foldSummary(doc.blocks[0])).toBe('```python');
  });

  it('an image summarises to a labelled file name', () => {
    expect(foldSummary(parseDocument('![](assets/shot.png)').blocks[0])).toBe('图片 · assets/shot.png');
  });

  it('a video embed is labelled as such', () => {
    expect(foldSummary(parseDocument('![](clip.mp4)').blocks[0])).toBe('视频 · clip.mp4');
  });

  it('an empty block gets a placeholder', () => {
    expect(foldSummary(createBlock(''))).toBe('空块');
  });
});
