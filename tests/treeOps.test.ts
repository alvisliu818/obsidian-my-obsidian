import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import {
  blockAtPath,
  cloneForest,
  cycleMarker,
  findBlockById,
  flattenVisible,
  indent,
  insertAfter,
  insertBefore,
  isDescendant,
  linkParents,
  mergeWithPrev,
  moveBlock,
  nextVisible,
  outdent,
  prependChild,
  prevVisible,
  registerRoots,
  removeBlock,
  siblingsOf,
  splitBlock,
} from '../src/core/treeOps';

function setup(md: string) {
  const doc = parseDocument(md);
  linkParents(doc.blocks);
  registerRoots(doc.blocks);
  return doc;
}

describe('tree navigation', () => {
  it('flattenVisible skips collapsed subtrees', () => {
    const doc = setup('- a\n\tcollapsed:: true\n\t- a1\n\t\t- a2\n- b');
    const seq = flattenVisible(doc.blocks);
    expect(seq.map((b) => b.text)).toEqual(['a', 'b']);
  });

  it('next/prev visible walk the sequence', () => {
    const doc = setup('- a\n\t- a1\n- b');
    const a1 = doc.blocks[0].children[0];
    expect(nextVisible(doc.blocks, doc.blocks[0])?.text).toBe('a1');
    expect(nextVisible(doc.blocks, a1)?.text).toBe('b');
    expect(prevVisible(doc.blocks, a1)?.text).toBe('a');
    expect(prevVisible(doc.blocks, doc.blocks[0])).toBeNull();
  });

  it('findBlockById and isDescendant', () => {
    const doc = setup('- a\n\tid:: u1\n\t- b\n\t\t- c');
    const a = doc.blocks[0];
    const c = a.children[0].children[0];
    expect(findBlockById(doc.blocks, 'u1')).toBe(a);
    expect(isDescendant(a, c)).toBe(true);
    expect(isDescendant(c, a)).toBe(false);
    expect(siblingsOf(a)).toBe(doc.blocks);
  });
});

describe('structure edits', () => {
  it('indent makes block the child of previous sibling', () => {
    const doc = setup('- a\n- b');
    const b = doc.blocks[1];
    expect(indent(b)).toBe(true);
    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0].children[0]).toBe(b);
    expect(b.parent).toBe(doc.blocks[0]);
  });

  it('indent fails for first sibling', () => {
    const doc = setup('- a\n- b');
    expect(indent(doc.blocks[0])).toBe(false);
  });

  it('outdent promotes block above parent', () => {
    const doc = setup('- a\n\t- b');
    const b = doc.blocks[0].children[0];
    expect(outdent(b)).toBe(true);
    expect(doc.blocks.length).toBe(2);
    expect(doc.blocks[1]).toBe(b);
    expect(b.parent).toBeNull();
  });

  it('outdent fails at top level', () => {
    const doc = setup('- a');
    expect(outdent(doc.blocks[0])).toBe(false);
  });

  it('splitBlock keeps head, moves tail to new sibling', () => {
    const doc = setup('- hello world');
    const b = doc.blocks[0];
    const nb = splitBlock(b, 6);
    expect(b.text).toBe('hello ');
    expect(nb.text).toBe('world');
    expect(nb.parent).toBeNull();
    expect(doc.blocks[1]).toBe(nb);
  });

  it('mergeWithPrev joins text and reparents children', () => {
    const doc = setup('- first\n- second\n\t- kid1\n\t- kid2');
    const second = doc.blocks[1];
    const prev = mergeWithPrev(doc.blocks, second);
    expect(prev?.text).toBe('firstsecond');
    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0].children.length).toBe(2);
    expect(doc.blocks[0].children[0].text).toBe('kid1');
    expect(doc.blocks[0].children[0].parent).toBe(doc.blocks[0]);
  });

  it('mergeWithPrev returns null for the first block', () => {
    const doc = setup('- only');
    expect(mergeWithPrev(doc.blocks, doc.blocks[0])).toBeNull();
  });

  it('mergeWithPrev merges into last VISIBLE block (skips collapsed parents)', () => {
    const doc = setup('- parent\n\tcollapsed:: true\n\t- hidden\n- tail');
    const tail = doc.blocks[1];
    const prev = mergeWithPrev(doc.blocks, tail);
    expect(prev?.text).toBe('parenttail');
  });
});

describe('moveBlock', () => {
  it('moves before/after/child', () => {
    const doc = setup('- a\n- b\n- c');
    const c = doc.blocks[2];
    expect(moveBlock(c, doc.blocks[0], 'before')).toBe(true);
    expect(doc.blocks.map((b) => b.text)).toEqual(['c', 'a', 'b']);

    const a = doc.blocks[1];
    expect(moveBlock(a, doc.blocks[0], 'child')).toBe(true);
    expect(doc.blocks.length).toBe(2);
    expect(doc.blocks[0].children[0].text).toBe('a');
  });

  it('rejects moving a block into its own descendant', () => {
    const doc = setup('- a\n\t- b\n\t\t- c');
    const a = doc.blocks[0];
    const c = a.children[0].children[0];
    expect(moveBlock(a, c, 'before')).toBe(false);
    expect(moveBlock(a, c, 'child')).toBe(false);
  });

  it('rejects moving onto itself', () => {
    const doc = setup('- a\n- b');
    expect(moveBlock(doc.blocks[0], doc.blocks[0], 'after')).toBe(false);
  });
});

describe('marker cycling', () => {
  it('cycles null→TODO→DOING→DONE→null', () => {
    const doc = setup('- plain');
    const b = doc.blocks[0];
    expect(cycleMarker(b)).toBe('TODO');
    expect(cycleMarker(b)).toBe('DOING');
    expect(cycleMarker(b)).toBe('DONE');
    expect(cycleMarker(b)).toBeNull();
  });
});

describe('insert/remove/clone', () => {
  it('insertAfter/insertBefore/prependChild/appendChild keep parents consistent', () => {
    const doc = setup('- a\n- b');
    const a = doc.blocks[0];
    const b = doc.blocks[1];
    insertAfter(a, { ...a, text: 'x', children: [], props: {}, parent: null, kind: 'list', marker: null } as any);
    expect(doc.blocks[1].text).toBe('x');
    insertBefore(b, { ...a, text: 'y', children: [], props: {}, parent: null, kind: 'list', marker: null } as any);
    expect(doc.blocks[2].text).toBe('y');
    prependChild(a, { ...a, text: 'k', children: [], props: {}, parent: null, kind: 'list', marker: null } as any);
    expect(a.children[0].text).toBe('k');
    expect(a.children[0].parent).toBe(a);
  });

  it('removeBlock detaches from siblings', () => {
    const doc = setup('- a\n- b\n- c');
    removeBlock(doc.blocks[1]);
    expect(doc.blocks.map((b) => b.text)).toEqual(['a', 'c']);
  });

  it('blockAtPath resolves a child-index path (embed sub-tree addressing)', () => {
    const doc = setup('- a\n\t- a1\n\t\t- a1x\n\t- a2\n');
    const a = doc.blocks[0];
    expect(blockAtPath(a, [])).toBe(a);
    expect(blockAtPath(a, [1])?.text).toBe('a2');
    expect(blockAtPath(a, [0, 0])?.text).toBe('a1x');
    expect(blockAtPath(a, [5])).toBeNull();
    expect(blockAtPath(a, [0, 0, 0])).toBeNull();
  });

  it('cloneForest deep-copies with ids and parents', () => {
    const doc = setup('- a\n\tid:: u1\n\t- b');
    const copy = cloneForest(doc.blocks);
    expect(copy[0].props['id']).toBe('u1');
    expect(copy[0].children[0].parent).toBe(copy[0]);
    expect(copy[0].children[0]).not.toBe(doc.blocks[0].children[0]);
  });
});
