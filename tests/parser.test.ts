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

  it('parses Obsidian frontmatter as the page-properties block', () => {
    const md = '---\ntitle: Test Page\ntags: [a, b]\n---\n- block';
    const doc = parseDocument(md);
    // Carried by the block (the same model as Logseq page props).
    expect(doc.frontmatter).toBe('');
    expect(doc.blocks.length).toBe(2);
    expect(doc.blocks[0].frontmatter).toBe(true);
    expect(doc.blocks[0].kind).toBe('list');
    expect(doc.blocks[0].text).toBe('title: Test Page\ntags: [a, b]');
    expect(doc.blocks[0].props).toEqual({ title: 'Test Page', tags: '[a, b]' });
    expect(doc.blocks[1].text).toBe('block');
    // Round-trips as frontmatter (the Obsidian format is preserved).
    expect(serializeDocument(doc)).toBe('---\ntitle: Test Page\ntags: [a, b]\n---\n- block');
  });

  it('parses Logseq page properties (key:: value) without frontmatter', () => {
    const md = 'title:: My Page\ntags:: a, b\n\n- block';
    const doc = parseDocument(md);
    expect(doc.blocks.length).toBe(2);
    expect(doc.blocks[0].text).toBe('');
    expect(doc.blocks[0].props).toEqual({ title: 'My Page', tags: 'a, b' });
    expect(doc.blocks[0].frontmatter).toBeUndefined();
    expect(doc.blocks[1].text).toBe('block');
    expect(serializeDocument(doc)).toBe('title:: My Page\ntags:: a, b\n- block');
  });

  it('frontmatter and Logseq page props coexist', () => {
    const md = '---\ntitle: x\n---\ntitle:: My Page\ntags:: a, b\n\n- block';
    const doc = parseDocument(md);
    expect(doc.blocks.length).toBe(3);
    expect(doc.blocks[0].frontmatter).toBe(true);
    expect(doc.blocks[0].text).toBe('title: x');
    expect(doc.blocks[1].text).toBe('');
    expect(doc.blocks[1].props).toEqual({ title: 'My Page', tags: 'a, b' });
    expect(doc.blocks[2].text).toBe('block');
    expect(serializeDocument(doc)).toBe('---\ntitle: x\n---\ntitle:: My Page\ntags:: a, b\n- block');
  });

  it('handles empty file', () => {
    const doc = parseDocument('');
    expect(doc.blocks.length).toBe(0);
    expect(serializeDocument(doc)).toBe('');
  });
});

describe('parser: raw content preservation', () => {
  it('keeps headings raw; plain lines become first-level list items', () => {
    const doc = parseDocument('# Title\n\nSome paragraph text.\n- item');
    expect(doc.blocks.length).toBe(3);
    expect(doc.blocks[0].kind).toBe('raw');
    expect(doc.blocks[0].text).toBe('# Title');
    expect(doc.blocks[1].kind).toBe('list');
    expect(doc.blocks[1].text).toBe('Some paragraph text.');
    expect(doc.blocks[2].kind).toBe('list');
    expect(doc.blocks[2].text).toBe('item');
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

  it('a list item can open a fence whose body is not indented', () => {
    const md = '- ```sql\ncreate database test;\n```\n- 删除库\n- ```sql\ndrop database test;\n```';
    const doc = parseDocument(md);
    expect(doc.blocks.map((b) => b.kind)).toEqual(['list', 'list', 'list']);
    expect(doc.blocks[0].text).toBe('```sql\ncreate database test;\n```');
    expect(doc.blocks[1].text).toBe('删除库');
    expect(doc.blocks[2].text).toBe('```sql\ndrop database test;\n```');
  });

  it('dedents a nested fence body to the content column (Logseq parity)', () => {
    // Logseq format: body lines sit one unit deeper than the block marker —
    // that column is stripped so the code renders flush.
    const md = '- parent\n\t- ```python\n\t\tds = TensorDataset(x, y)\n\t\tdl = DataLoader(ds)\n\t\t```\n- next';
    const doc = parseDocument(md);
    const fence = doc.blocks[0].children[0];
    expect(fence.text).toBe('```python\nds = TensorDataset(x, y)\ndl = DataLoader(ds)\n```');
  });

  it('keeps indentation beyond the content column as code indent', () => {
    // 深度学习.md shape: block at depth 2, body lines at 9 tabs — the column
    // (depth+1 = 3 units) is stripped, the remaining 6 tabs are code indent.
    const md =
      '- parent\n\t- 1. 构造数据\n\t\t- ```python\n\t\t\t\t\t\t\t\t\tx = torch.randn(100, 1)\n\t\t\t```';
    const doc = parseDocument(md);
    const fence = doc.blocks[0].children[0].children[0];
    expect(fence.text).toBe('```python\n\t\t\t\t\t\tx = torch.randn(100, 1)\n```');
  });

  it('does not treat inline triple backticks on a list item as a fence', () => {
    const doc = parseDocument('- 用 ```code``` 表示\n- next');
    expect(doc.blocks.map((b) => b.text)).toEqual(['用 ```code``` 表示', 'next']);
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

  it('bare top-level lines become first-level list items (Logseq parity)', () => {
    const doc = parseDocument('just a plain line\n- item\nanother plain line');
    expect(doc.blocks.map((b) => [b.kind, b.text])).toEqual([
      ['list', 'just a plain line'],
      ['list', 'item'],
      ['list', 'another plain line'],
    ]);
  });

  it('consecutive bare lines (no blank between) merge into ONE first-level block', () => {
    const doc = parseDocument('para one\npara two\npara three\n- item');
    expect(doc.blocks.map((b) => [b.kind, b.text])).toEqual([
      ['list', 'para one\npara two\npara three'],
      ['list', 'item'],
    ]);
    // Round-trips as `- ` item + indented soft lines.
    expect(serializeDocument(doc)).toBe('- para one\n\tpara two\n\tpara three\n- item');
  });

  it('a blank line separates bare-line groups into distinct blocks', () => {
    const doc = parseDocument('para A line 1\npara A line 2\n\npara B\n- item');
    expect(doc.blocks.map((b) => [b.kind, b.text])).toEqual([
      ['list', 'para A line 1\npara A line 2'],
      ['list', 'para B'],
      ['list', 'item'],
    ]);
  });

  it('bare lines keep marker detection and take indented props / children', () => {
    const doc = parseDocument('TODO buy milk\n\tpriority:: high\n\t- check price');
    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0].marker).toBe('TODO');
    expect(doc.blocks[0].text).toBe('buy milk');
    expect(doc.blocks[0].props['priority']).toBe('high');
    expect(doc.blocks[0].children[0].text).toBe('check price');
  });

  it('structural raw lines stay raw (ordered list, quote, table, hr, html)', () => {
    const doc = parseDocument('1. first\n- item\n> quoted\n- item2\n| a | b |');
    expect(doc.blocks.map((b) => [b.kind, b.text])).toEqual([
      ['raw', '1. first'],
      ['list', 'item'],
      ['raw', '> quoted'],
      ['list', 'item2'],
      ['raw', '| a | b |'],
    ]);
    // Consecutive structural lines form one raw block (quote/table runs);
    // none of them is promoted to a list item.
    const run = parseDocument('====\n<div>html</div>');
    expect(run.blocks.map((b) => b.kind)).toEqual(['raw']);
    expect(run.blocks[0].text).toBe('====\n<div>html</div>');
  });

  it('indented bare lines remain soft lines (not promoted to items)', () => {
    const doc = parseDocument('- parent\n\tcontinued without dash');
    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0].text).toBe('parent\ncontinued without dash');
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
    ['nested fence column body', '- parent\n\t- ```python\n\t\tx = 1\n\t\t```\n- next'],
    ['nested fence deep code indent', '- parent\n\t- 1. 构造\n\t\t- ```python\n\t\t\t\t\t\t\t\t\tx = torch.randn(100, 1)\n\t\t\t```'],
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
