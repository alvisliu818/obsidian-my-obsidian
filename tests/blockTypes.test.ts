/**
 * Block types: detection is derived from markdown, conversion rewrites it.
 *
 * The invariants that matter:
 *  - detection never throws and always returns a type (fallback: paragraph);
 *  - converting to the block's own type is idempotent (parameters such as the
 *    heading level or the fence language survive);
 *  - content survives a round trip through another type.
 */

import { describe, expect, it } from 'vitest';
import { createBlock, type Block } from '../src/types';
import {
  BLOCK_TYPES,
  blockTypeMeta,
  calloutKind,
  codeLang,
  detectBlockType,
  headingLevel,
  isVerbatimType,
  type BlockType,
} from '../src/blocks/blockTypes';
import {
  CALLOUT_KINDS,
  CONVERT_TARGETS,
  convertBlock,
  conversionLosesIdentity,
  cycleHeadingLevel,
  setCalloutKind,
  setCodeLang,
  stripToBare,
  type BlockShape,
} from '../src/blocks/blockTypeConvert';

const shape = (text: string, kind: 'list' | 'raw' = 'list'): BlockShape => ({
  kind,
  text,
  marker: null,
});

const block = (text: string, kind: 'list' | 'raw' = 'list'): Block => {
  const b = createBlock(text);
  b.kind = kind;
  return b;
};

describe('block type metadata', () => {
  it('every type has a unique id, label and icon', () => {
    const ids = new Set(BLOCK_TYPES.map((m) => m.id));
    expect(ids.size).toBe(BLOCK_TYPES.length);
    for (const m of BLOCK_TYPES) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.icon.length).toBeGreaterThan(0);
      expect(blockTypeMeta(m.id).id).toBe(m.id);
    }
  });

  it('every type offers a slash-menu template or is converted into', () => {
    for (const m of BLOCK_TYPES) {
      const hasTemplate = !!m.template;
      const isTarget = (CONVERT_TARGETS as readonly BlockType[]).includes(m.id);
      // Media / HTML / props are inserted by dedicated commands, not the menu.
      if (!hasTemplate && !isTarget) {
        expect(['image', 'video', 'audio', 'embed', 'html', 'task', 'props', 'paragraph']).toContain(
          m.id,
        );
      }
    }
  });
});

describe('detectBlockType', () => {
  it('classifies plain outline rows as paragraphs', () => {
    expect(detectBlockType(block('just text'))).toBe('paragraph');
  });

  it('reads headings, including the level', () => {
    expect(detectBlockType(block('# Title'))).toBe('heading');
    expect(headingLevel('### Deep')).toBe(3);
    expect(headingLevel('####### Too deep')).toBe(0);
    expect(headingLevel('nope')).toBe(0);
  });

  it('a task marker outranks text syntax', () => {
    const b = block('# Title');
    b.marker = 'TODO';
    expect(detectBlockType(b)).toBe('task');
  });

  it('separates callouts from plain quotes', () => {
    expect(detectBlockType(block('> [!warning] careful'))).toBe('callout');
    expect(calloutKind('> [!WARNING] careful')).toBe('warning');
    expect(detectBlockType(block('> just a quote'))).toBe('quote');
    expect(calloutKind('> just a quote')).toBe('');
  });

  it('reads the fence language', () => {
    expect(detectBlockType(block('```ts\nconst a = 1\n```'))).toBe('code');
    expect(codeLang('```ts\nconst a = 1\n```')).toBe('ts');
    expect(codeLang('```\nplain\n```')).toBe('');
  });

  it('detects display math only for a delimiter of its own', () => {
    expect(detectBlockType(block('$$\nx^2\n$$'))).toBe('math');
    expect(detectBlockType(shape('$$\nx^2\n$$'))).toBe('math');
    // Inline math is paragraph text, not a math block.
    expect(detectBlockType(block('$x^2$ inline'))).toBe('paragraph');
  });

  it('needs a delimiter row to call something a table', () => {
    expect(detectBlockType(shape('| a | b |\n| --- | --- |\n| 1 | 2 |', 'raw'))).toBe('table');
    expect(detectBlockType(shape('| a | b |', 'raw'))).toBe('paragraph');
  });

  it('detects dividers', () => {
    expect(detectBlockType(shape('---', 'raw'))).toBe('divider');
    expect(detectBlockType(shape('***', 'raw'))).toBe('divider');
    expect(detectBlockType(shape('___', 'raw'))).toBe('divider');
    expect(detectBlockType(shape('--', 'raw'))).toBe('paragraph');
  });

  it('sorts media embeds by extension', () => {
    expect(detectBlockType(block('![[clip.mp4]]'))).toBe('video');
    expect(detectBlockType(block('![[song.mp3]]'))).toBe('audio');
    expect(detectBlockType(block('![[shot.png]]'))).toBe('image');
    expect(detectBlockType(block('![alt](http://x.io/a.png)'))).toBe('image');
    // A page or a PDF embed is an embed, not media.
    expect(detectBlockType(block('![[Some Page]]'))).toBe('embed');
    expect(detectBlockType(block('![[paper.pdf]]'))).toBe('embed');
  });

  it('detects html, iframe and macro embeds', () => {
    expect(detectBlockType(shape('<div class="x">', 'raw'))).toBe('html');
    expect(detectBlockType(shape('<iframe src="x"></iframe>', 'raw'))).toBe('embed');
    expect(detectBlockType(block('{{embed ((abc))}}'))).toBe('embed');
  });

  it('detects markdown lists and footnotes', () => {
    expect(detectBlockType(shape('- a\n- b', 'raw'))).toBe('list');
    expect(detectBlockType(shape('1. a\n2. b', 'raw'))).toBe('ordered');
    expect(detectBlockType(shape('[^1]: note', 'raw'))).toBe('footnote');
  });

  it('recognises the page-properties block', () => {
    const b = createBlock('');
    b.props['title'] = 'Hello';
    expect(detectBlockType(b)).toBe('props');
  });

  it('never throws on a degenerate shape', () => {
    expect(detectBlockType({})).toBe('paragraph');
    expect(detectBlockType({ text: '' })).toBe('paragraph');
  });
});

describe('stripToBare', () => {
  it('unwraps a code fence and keeps the language', () => {
    const bare = stripToBare(shape('```ts\nconst a = 1\nconst b = 2\n```'));
    expect(bare.text).toBe('const a = 1\nconst b = 2');
    expect(bare.lang).toBe('ts');
  });

  it('unwraps display math', () => {
    expect(stripToBare(shape('$$\nx^2\n$$')).text).toBe('x^2');
  });

  it('strips the callout marker but keeps its title text', () => {
    const bare = stripToBare(shape('> [!warning] Careful\n> body'));
    expect(bare.text).toBe('Careful\nbody');
    expect(bare.callout).toBe('warning');
  });

  it('flattens a table into readable lines', () => {
    const bare = stripToBare(shape('| A | B |\n| --- | --- |\n| 1 | 2 |', 'raw'));
    expect(bare.text).toBe('A · B\n1 · 2');
  });

  it('leaves paragraph text untouched', () => {
    expect(stripToBare(shape('plain\ntext')).text).toBe('plain\ntext');
  });
});

describe('convertBlock', () => {
  it('paragraph → heading and back', () => {
    const h = convertBlock(shape('hello'), 'heading');
    expect(h.text).toBe('# hello');
    expect(headingLevel(h.text)).toBe(1);
    expect(convertBlock(h, 'paragraph').text).toBe('hello');
  });

  it('converting a heading to heading keeps its level', () => {
    const h = convertBlock(shape('### deep'), 'heading');
    expect(h.text).toBe('### deep');
    // …and the same for a code block's language.
    const c = convertBlock(shape('```ts\ncode\n```'), 'code');
    expect(c.text).toBe('```ts\ncode\n```');
    // …and for a callout's kind.
    const k = convertBlock(shape('> [!tip] hi'), 'callout');
    expect(k.text).toBe('> [!tip] hi');
  });

  it('task conversion sets and clears the marker', () => {
    const t = convertBlock(shape('call back'), 'task');
    expect(t.marker).toBe('TODO');
    expect(detectBlockType(t)).toBe('task');
    const p = convertBlock(t, 'paragraph');
    expect(p.marker).toBe(null);
    expect(p.text).toBe('call back');
  });

  it('quote prefixes every soft line', () => {
    expect(convertBlock(shape('a\nb'), 'quote').text).toBe('> a\n> b');
    expect(convertBlock(shape('> a\n> b'), 'paragraph').text).toBe('a\nb');
  });

  it('callout conversion keeps the kind and the body', () => {
    const c = convertBlock(shape('head\nbody'), 'callout', { callout: 'danger' });
    expect(c.text).toBe('> [!danger] head\n> body');
    expect(setCalloutKind(c, 'success')?.text).toBe('> [!success] head\n> body');
    expect(setCalloutKind(shape('plain'), 'success')).toBe(null);
  });

  it('code conversion keeps the body and swaps the language', () => {
    const c = convertBlock(shape('let a = 1'), 'code', { lang: 'js' });
    expect(c.text).toBe('```js\nlet a = 1\n```');
    expect(setCodeLang(c, 'ts')?.text).toBe('```ts\nlet a = 1\n```');
    expect(setCodeLang(shape('plain'), 'ts')).toBe(null);
  });

  it('math wraps the formula', () => {
    expect(convertBlock(shape('x^2'), 'math').text).toBe('$$\nx^2\n$$');
    expect(convertBlock(shape('$$\nx^2\n$$'), 'paragraph').text).toBe('x^2');
  });

  it('table conversion is lossless in both directions', () => {
    const t = convertBlock(shape('a\nb'), 'table');
    expect(t.kind).toBe('raw');
    expect(t.text).toBe('| Content |\n| --- |\n| a |\n| b |');
    // The generated header row is content too — dropping it would lose text.
    expect(convertBlock(t, 'paragraph').text).toBe('Content\na\nb');
  });

  it('list and ordered conversions number their lines', () => {
    expect(convertBlock(shape('a\nb'), 'list').text).toBe('- a\n- b');
    expect(convertBlock(shape('a\nb'), 'ordered').text).toBe('1. a\n2. b');
    expect(convertBlock(shape('- a\n- b', 'raw') as BlockShape, 'paragraph').text).toBe('a\nb');
  });

  it('divider and footnote are verbatim blocks', () => {
    expect(convertBlock(shape('anything'), 'divider').text).toBe('---');
    expect(convertBlock(shape('a note'), 'footnote').text).toBe('[^1]: a note');
    expect(convertBlock(shape('[^1]: a note', 'raw'), 'paragraph').text).toBe('a note');
  });

  it('media / html targets are not conversion targets', () => {
    const s = shape('text');
    expect(convertBlock(s, 'image').text).toBe('text');
    expect(convertBlock(s, 'video').kind).toBe('list');
    expect(convertBlock(s, 'html').text).toBe('text');
  });

  it('verbatim targets drop the block identity (the UI warns)', () => {
    expect(conversionLosesIdentity(shape('x'), 'table')).toBe(true);
    expect(conversionLosesIdentity(shape('x'), 'divider')).toBe(true);
    expect(conversionLosesIdentity(shape('x'), 'heading')).toBe(false);
    expect(isVerbatimType('footnote')).toBe(true);
    expect(isVerbatimType('callout')).toBe(false);
  });
});

describe('cycleHeadingLevel', () => {
  it('wraps around between 1 and 6', () => {
    expect(cycleHeadingLevel(shape('## T'), 1)?.text).toBe('### T');
    expect(cycleHeadingLevel(shape('# T'), -1)?.text).toBe('###### T');
    expect(cycleHeadingLevel(shape('###### T'), 1)?.text).toBe('# T');
  });

  it('returns null when the block is not a heading', () => {
    expect(cycleHeadingLevel(shape('plain'), 1)).toBe(null);
  });
});

describe('CALLOUT_KINDS', () => {
  it('covers the Obsidian callout set', () => {
    expect(CALLOUT_KINDS).toContain('note');
    expect(CALLOUT_KINDS).toContain('warning');
    expect(CALLOUT_KINDS).toContain('quote');
    expect(new Set(CALLOUT_KINDS).size).toBe(CALLOUT_KINDS.length);
  });
});
