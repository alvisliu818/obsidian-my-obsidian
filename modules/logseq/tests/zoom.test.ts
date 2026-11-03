import { describe, expect, it } from 'vitest';
import type { Block } from '../src/types';
import { parseDocument } from '../src/core/parser';
import { linkParents } from '../src/core/treeOps';
import { visibleRootsFor } from '../src/interactions/zoom';

function setup(md: string) {
  const doc = parseDocument(md);
  linkParents(doc.blocks);
  return doc;
}

function orphan(): Block {
  return { kind: 'list', marker: null, text: 'gone', props: {}, children: [], parent: null };
}

describe('visibleRootsFor', () => {
  it('shows the children of the focused block', () => {
    const doc = setup('- a\n\t- a1\n\t- a2\n- b\n');
    expect(visibleRootsFor(doc, doc.blocks[0]).map((b) => b.text)).toEqual(['a1', 'a2']);
  });

  it('shows the block itself when it is a leaf (focus never lands on an empty page)', () => {
    const doc = setup('- a\n- b\n');
    expect(visibleRootsFor(doc, doc.blocks[1]).map((b) => b.text)).toEqual(['b']);
  });

  it('falls back to the whole document when the focused block is gone', () => {
    const doc = setup('- a\n- b\n');
    expect(visibleRootsFor(doc, orphan())).toBe(doc.blocks);
    expect(visibleRootsFor(doc, null)).toBe(doc.blocks);
  });
});
