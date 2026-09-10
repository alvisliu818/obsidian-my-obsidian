import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeDocument, serializeBlock } from '../src/core/serializer';
import { linkParents } from '../src/core/treeOps';
import type { Block, ParsedDocument } from '../src/types';

/** Normalizing round-trip: parse ∘ serialize ∘ parse is idempotent. */
function roundTrip(md: string): ParsedDocument {
  return parseDocument(serializeDocument(parseDocument(md)));
}

function normalize(doc: ParsedDocument): ParsedDocument {
  const strip = (b: Block): any => ({
    kind: b.kind,
    marker: b.marker,
    text: b.text,
    props: b.props,
    children: b.children.map(strip),
  });
  return {
    frontmatter: doc.frontmatter,
    pageProps: doc.pageProps,
    blocks: doc.blocks.map(strip),
  } as ParsedDocument;
}

describe('parser: basic Logseq structure', () => {
  it('parses flat list into top-level blocks', () => {
    const doc = parseDocument('- a\n- b\n- c');
    expect(doc.blocks.length).toBe(3);
    expect(doc.blocks[0].text).toBe('a');
    expect(doc.blocks[2].text).toBe('c');
  });

  it('parses markers', () => {
    const doc = parseDocument('- TODO task\n- DOING wip\n- DONE done\n- plain');
    expect(doc.blocks.map((b) => b.marker)).toEqual(['TODO', 'DOING', 'DONE', null]);
    expect(doc.blocks[0].text).toBe('task');
  });

  it('parses nesting via tabs', () => {
    const doc = parseDocument('- parent\n\t- child1\n\t\t- grandchild\n\t- child2\n- next');
    const parent = doc.blocks[0];
    expect(parent.children.length).toBe(2);
    expect(parent.children[0].children.length).toBe(1);
    expect(parent.children[1].text).toBe('child2');
    expect(doc.blocks[1].text).toBe('next');
    linkParents(doc.blocks);
    expect(doc.blocks[0].children[0].children[0].parent?.text).toBe('child1');
  });

  it('parses block properties (id::, collapsed::)', () => {
    const doc = parseDocument('- block with props\n\tid:: 6612a3b0-1234\n\tcollapsed:: true');
    const b = doc.blocks[0];
    expect(b.props['id']).toBe('6612a3b0-1234');
    expect(b.props['collapsed']).toBe('true');
  });

  it('parses page properties and frontmatter', () => {
    const md = '---\ntitle: x\n---\ntitle:: My Page\ntags:: a, b\n\n- block';
    const doc = parseDocument(md);
    expect(doc.frontmatter).toBe('---\ntitle: x\n---');
    expect(doc.pageProps).toBe('title:: My Page\ntags:: a, b');
    expect(doc.blocks.length).toBe(1);
  });

  it('handles empty file', () => {
    const doc = parseDocument('');
    expect(doc.blocks.length).toBe(0);
    expect(serializeDocument(doc)).toBe('');
  });
});

describe('parser: raw content preservation', () => {
  it('keeps headings/paragraphs as raw top-level blocks', () => {
    const doc = parseDocument('# Title\n\nSome paragraph text.\n- item');
    expect(doc.blocks.length).toBe(2);
    expect(doc.blocks[0].kind).toBe('raw');
    expect(doc.blocks[0].text).toBe('# Title\n\nSome paragraph text.');
    expect(doc.blocks[1].kind).toBe('list');
    expect(doc.blocks[1].text).toBe('item');
  });

  it('does not parse list lines inside top-level code fences', () => {
    const md = '# Heading\n```js\n- not a block\n  const x = 1;\n```\n- real block';
    const doc = parseDocument(md);
    expect(doc.blocks.length).toBe(2);
    expect(doc.blocks[0].kind).toBe('raw');
    expect(doc.blocks[0].text).toContain('- not a block');
    expect(doc.blocks[1].text).toBe('real block');
  });

  it('keeps in-block code fences as block text', () => {
    const md = '- code block\n\t```js\n\tconst x = 1;\n\t  deep();\n\t```\n- next';
    const doc = parseDocument(md);
    expect(doc.blocks.length).toBe(2);
    expect(doc.blocks[0].text).toBe('code block\n```js\nconst x = 1;\n  deep();\n```');
  });

  it('attaches deep non-list lines as soft lines of the block', () => {
    const doc = parseDocument('- first line\n\tsecond line\n\tthird line');
    expect(doc.blocks[0].text).toBe('first line\nsecond line\nthird line');
  });

  it('supports 2-space indent files', () => {
    const doc = parseDocument('- a\n  - b\n    - c');
    expect(doc.blocks[0].children[0].text).toBe('b');
    expect(doc.blocks[0].children[0].children[0].text).toBe('c');
  });

  it('supports 4-space indent files (skipped levels attach correctly)', () => {
    const doc = parseDocument('- a\n    - b');
    expect(doc.blocks[0].children.length).toBe(1);
    expect(doc.blocks[0].children[0].text).toBe('b');
  });
});

describe('serializer', () => {
  it('emits Logseq format', () => {
    const doc = parseDocument('- TODO x\n\tid:: u1\n\t- child');
    expect(serializeDocument(doc)).toBe('- TODO x\n\tid:: u1\n\t- child');
  });

  it('emits soft lines indented one level deeper', () => {
    const doc = parseDocument('- a\n\tb');
    expect(serializeDocument(doc)).toBe('- a\n\tb');
  });
});

describe('round-trip invariants', () => {
  const samples: Array<[string, string]> = [
    ['flat', '- a\n- b'],
    ['nested', '- a\n\t- b\n\t\t- c\n- d'],
    ['markers', '- TODO a\n- DOING b\n- DONE c'],
    ['props', '- a\n\tid:: u-1\n\tcollapsed:: true\n- b'],
    ['soft lines', '- first\n\tsecond\n- other'],
    ['frontmatter+pageprops', '---\nkey: v\n---\ntitle:: p\n\n- a'],
    ['raw heading', '# H1\npara\n\n- a'],
    ['top-level fence', '```js\n- fake\n```\n- real'],
    ['in-block fence', '- code\n\t```js\n\tconst x;\n\t```\n- next'],
    ['empty block', '- \n- after'],
    ['deep nesting', '- l0\n\t- l1\n\t\t- l2\n\t\t\t- l3\n\t- back to l1'],
    ['mixed', '---\nf: 1\n---\ntype:: note\n\n# Head\n\n- TODO main\n\tid:: uuid-main\n\t- child A\n\t\t- grand\n\t- child B\n\nFooter paragraph.\n```py\nprint(1)\n```'],
  ];

  for (const [name, md] of samples) {
    it(`parse∘serialize∘parse is stable: ${name}`, () => {
      const once = parseDocument(md);
      const twice = roundTrip(md);
      expect(normalize(twice)).toEqual(normalize(once));
    });

    it(`serialize∘parse is stable after first pass: ${name}`, () => {
      const once = serializeDocument(parseDocument(md));
      const twice = serializeDocument(parseDocument(once));
      expect(twice).toBe(once);
    });
  }

  it('round-trips real-world logseq journal export', () => {
    const md = [
      '- TODO Fix the build [[project/alpha]] #urgent',
      '\tid:: 6612f100-1111-4aaa-bbbb-ccccdddd0001',
      '\t- Context: it broke in ((6612f100-1111-4aaa-bbbb-ccccdddd0002))',
      '\t- Steps',
      '\t\t- run `make`',
      '\t\t\tlog-line:: 1',
      '\t\t- check output',
      '- DONE Write docs',
      '\tid:: 6612f100-1111-4aaa-bbbb-ccccdddd0002',
      '\tcollapsed:: true',
    ].join('\n');
    const doc = parseDocument(md);
    expect(doc.blocks.length).toBe(2);
    expect(doc.blocks[0].children.length).toBe(2);
    expect(doc.blocks[0].children[1].children.length).toBe(2);
    expect(serializeDocument(doc)).toBe(md);
    expect(normalize(roundTrip(md))).toEqual(normalize(doc));
  });
});

describe('serializeBlock', () => {
  it('serializes a subtree for block references', () => {
    const doc = parseDocument('- parent\n\t- c1\n\t\t- g1\n\t- c2');
    const out = serializeBlock(doc.blocks[0], 0);
    expect(out).toBe('- parent\n\t- c1\n\t\t- g1\n\t- c2');
  });
});
