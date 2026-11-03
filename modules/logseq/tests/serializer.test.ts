import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeBlockContent, serializeDocument } from '../src/core/serializer';
import { linkParents } from '../src/core/treeOps';

function block(md: string, index = 0) {
  const doc = parseDocument(md);
  linkParents(doc.blocks);
  return doc.blocks[index];
}

describe('serializeBlockContent', () => {
  it('renders children as a top-level list under the block text', () => {
    const b = block('- parent\n\t- child\n\t\t- grandchild\n');
    expect(serializeBlockContent(b)).toBe('parent\n\n- child\n\t- grandchild');
  });

  it('keeps a single-line block as plain text', () => {
    expect(serializeBlockContent(block('- only me\n'))).toBe('only me');
  });

  it('hides id/collapsed bookkeeping props of the subtree', () => {
    const b = block('- parent\n\t- child\n\t\tid:: 1234\n\t\tcollapsed:: true\n\t\tdue:: monday\n');
    expect(serializeBlockContent(b)).toBe('parent\n\n- child\n\tdue:: monday');
  });
});

describe('paragraph container (bare blocks)', () => {
  it('serializes without the `- ` prefix and round-trips as a paragraph', () => {
    const doc = parseDocument('plain paragraph\nsecond line\n');
    expect(serializeDocument(doc)).toBe('plain paragraph\nsecond line\n');
    const again = parseDocument(serializeDocument(doc));
    expect(again.blocks.length).toBe(1);
    expect(again.blocks[0].bare).toBe(true);
    expect(again.blocks[0].text).toBe('plain paragraph\nsecond line');
  });

  it('keeps children (list items) under the paragraph at depth+1', () => {
    const doc = parseDocument('intro paragraph\n\t- child item\n');
    expect(serializeDocument(doc)).toBe('intro paragraph\n\t- child item\n');
    const again = parseDocument(serializeDocument(doc));
    expect(again.blocks[0].bare).toBe(true);
    expect(again.blocks[0].children.map((c) => c.text)).toEqual(['child item']);
  });

  it('keeps properties indented one level so they re-attach as props', () => {
    const doc = parseDocument('foldable paragraph\n\tcollapsed:: true\n');
    expect(serializeDocument(doc)).toBe('foldable paragraph\n\tcollapsed:: true\n');
    const again = parseDocument(serializeDocument(doc));
    expect(again.blocks[0].bare).toBe(true);
    expect(again.blocks[0].props['collapsed']).toBe('true');
  });

  it('falls back to the `- ` form for a nested paragraph (structure safety)', () => {
    const doc = parseDocument('- parent\n\t- child\n');
    // 手工把 child 降级成段落容器并留在 depth 1:磁盘上嵌套段必须带标记,
    // 否则重解析会把裸行并成父块的软行(结构拍平)。
    doc.blocks[0].children[0].bare = true;
    expect(serializeDocument(doc)).toBe('- parent\n\t- child\n');
    const again = parseDocument(serializeDocument(doc));
    expect(again.blocks[0].children[0].text).toBe('child');
  });

  it('a marker-bearing bare line stays a task list item (bullet shown)', () => {
    const doc = parseDocument('TODO buy milk\n');
    expect(doc.blocks[0].bare).toBeFalsy();
    expect(serializeDocument(doc)).toBe('- TODO buy milk\n');
  });
});
