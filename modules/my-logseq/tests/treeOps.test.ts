import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';
import type { Block } from '../src/types';
import { createBlock } from '../src/types';
import {
  blockAtPath,
  cloneForest,
  containsBlock,
  cycleMarker,
  findBlockById,
  flattenVisible,
  indent,
  insertAfter,
  insertBefore,
  isDescendant,
  linkParents,
  mergeWithNext,
  mergeWithPrev,
  moveBlock,
  moveBlockGroup,
  nextVisible,
  outdent,
  prependChild,
  prevVisible,
  rangeAnchor,
  registerRoots,
  removeBlock,
  siblingsOf,
  shouldExitListOnEnter,
  splitBlock,
  toBareParagraph,
  visibleRange,
} from '../src/core/treeOps';

function setup(md: string) {
  const doc = parseDocument(md);
  linkParents(doc.blocks);
  registerRoots(doc.blocks);
  return doc;
}

/** Block texts in document order — the readable form for most assertions. */
const texts = (bs: Block[]): string[] => bs.map((b) => b.text);

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

  it('mergeWithNext joins text and reparents children (document order)', () => {
    const doc = setup('- first\n\t- kid1\n\t- kid2\n- second');
    const first = doc.blocks[0];
    // Document order: the next visible block after `first` is its first child
    // (same walker Backspace uses backward).
    const merged = mergeWithNext(doc.blocks, first);
    expect(merged?.text).toBe('firstkid1');
    expect(doc.blocks.length).toBe(2);
    expect(doc.blocks[0].children.length).toBe(1);
    expect(doc.blocks[0].children[0].text).toBe('kid2');
    expect(doc.blocks[1].text).toBe('second');
  });

  it('mergeWithNext on an empty block deletes the empty row', () => {
    // The table-preceding-empty-line case: Del on the empty block pulls the
    // next block's content in and the row disappears.
    const doc = setup('- para\n- \n- | a | b |');
    const empty = doc.blocks[1];
    const merged = mergeWithNext(doc.blocks, empty);
    expect(merged?.text).toBe('| a | b |');
    expect(doc.blocks.length).toBe(2);
    expect(doc.blocks[1].text).toBe('| a | b |');
  });

  it('mergeWithNext returns null for the last block', () => {
    const doc = setup('- only');
    expect(mergeWithNext(doc.blocks, doc.blocks[0])).toBeNull();
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

describe('moveBlockGroup', () => {
  it('preserves order when dropping a group after a target', () => {
    const doc = setup('- a\n- b\n- c');
    const [a, b, c] = doc.blocks;
    // Looping moveBlock would give [c, b, a] — every member is inserted
    // directly adjacent to the target, so each one pushes the last further out.
    expect(texts(moveBlockGroup([a, b], c, 'after'))).toEqual(['a', 'b']);
    expect(texts(doc.blocks)).toEqual(['c', 'a', 'b']);
  });

  it('preserves order when dropping before a target', () => {
    const doc = setup('- a\n- b\n- c');
    const [a, b, c] = doc.blocks;
    moveBlockGroup([a, b], c, 'before');
    expect(texts(doc.blocks)).toEqual(['a', 'b', 'c']);
  });

  it('preserves order when dropping into a target', () => {
    const doc = setup('- a\n- b\n- c');
    const [a, b, c] = doc.blocks;
    moveBlockGroup([a, b], c, 'child');
    expect(texts(doc.blocks)).toEqual(['c']);
    expect(texts(c.children)).toEqual(['a', 'b']);
    expect(c.children[0].parent).toBe(c);
  });

  it('keeps a non-contiguous group in order', () => {
    const doc = setup('- a\n- x\n- b\n- y\n- c');
    const [a, , b, , c] = doc.blocks;
    moveBlockGroup([a, b], c, 'after');
    expect(texts(doc.blocks)).toEqual(['x', 'y', 'c', 'a', 'b']);
  });

  it('re-parents the whole group', () => {
    const doc = setup('- a\n- b\n- host');
    const [a, b, host] = doc.blocks;
    moveBlockGroup([a, b], host, 'child');
    for (const b2 of host.children) expect(b2.parent).toBe(host);
    expect(host.parent).toBeNull();
  });

  it('carries descendants along instead of detaching them', () => {
    // `q` must be a ROOT bullet — an indented `- q` would be p's child.
    const doc = setup('- p\n\t- p1\n- q\n- target');
    const [p, , target] = doc.blocks;
    const p1 = p.children[0];
    // p1 is inside p: moving it separately would tear the subtree apart, so it
    // travels as part of p instead of being listed as moved.
    const moved = moveBlockGroup([p, p1], target, 'after');
    expect(texts(moved)).toEqual(['p']);
    expect(texts(p.children)).toEqual(['p1']);
    expect(texts(doc.blocks)).toEqual(['q', 'target', 'p']);
    expect(p1.parent).toBe(p);
  });

  it('refuses a group that would land on itself or its own descendant', () => {
    const doc = setup('- a\n\t- a1\n- b');
    const [a, b] = doc.blocks;
    const a1 = a.children[0];
    expect(moveBlockGroup([a, b], a, 'before')).toEqual([]);
    expect(moveBlockGroup([a, b], a1, 'after')).toEqual([]);
    expect(texts(doc.blocks)).toEqual(['a', 'b']);
  });

  it('moves a verbatim group at root level unchanged', () => {
    const doc = setup('- a\n- b\n- c');
    const table = { kind: 'raw' as const, marker: null, text: '| A |', props: {}, children: [], parent: null } as Block;
    doc.blocks.splice(1, 0, table);
    linkParents(doc.blocks);
    moveBlockGroup([table], doc.blocks[0], 'after');
    expect(texts(doc.blocks)).toEqual(['a', '| A |', 'b', 'c']);
    expect(doc.blocks[1]).toBe(table);
  });
});

describe('sibling cache stays correct after a move', () => {
  it('follows a block within its own document', () => {
    const doc = setup('- a\n- b\n- c');
    const [a, b] = doc.blocks;
    moveBlock(a, b, 'after');
    expect(siblingsOf(a)).toBe(doc.blocks);
    expect(texts(doc.blocks)).toEqual(['b', 'a', 'c']);
  });

  it('follows a block moved into ANOTHER document (cross-file drop)', () => {
    const docA = setup('- a1\n- a2');
    const docB = setup('- b1\n- b2');
    const a1 = docA.blocks[0];
    const b1 = docB.blocks[0];
    moveBlock(a1, b1, 'after');
    // The block now lives in docB: the cache must not hand back docA's array,
    // or the next removeBlock/indent edits a list it is no longer in.
    expect(siblingsOf(a1)).toBe(docB.blocks);
    expect(texts(docA.blocks)).toEqual(['a2']);
    expect(texts(docB.blocks)).toEqual(['b1', 'a1', 'b2']);
    // And the stale entry must not make it survive a delete.
    removeBlock(a1);
    expect(texts(docB.blocks)).toEqual(['b1', 'b2']);
  });

  it('follows a whole group moved into another document', () => {
    const docA = setup('- a1\n- a2');
    const docB = setup('- b1');
    moveBlockGroup(docA.blocks, docB.blocks[0], 'after');
    expect(texts(docA.blocks)).toEqual([]);
    expect(texts(docB.blocks)).toEqual(['b1', 'a1', 'a2']);
    for (const b of docB.blocks) expect(siblingsOf(b)).toBe(docB.blocks);
  });

  it('a block that gained a parent no longer resolves as top-level', () => {
    const doc = setup('- a\n- b');
    const [a, b] = doc.blocks;
    moveBlock(a, b, 'child');
    expect(a.parent).toBe(b);
    // Its container is now b.children — not the root list.
    expect(siblingsOf(a)).toBe(b.children);
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

describe('containsBlock', () => {
  it('sees a block at ANY depth, not just at the root', () => {
    const doc = setup('- root\n\t- mid\n\t\t- deep\n- other');
    const [root, other] = doc.blocks;
    const mid = root.children[0];
    const deep = mid.children[0];
    // Identity against the root array alone only finds `root` and `other`;
    // a caller filtering candidates that way silently drops every nested
    // block, which is how extracting a sub-block did nothing at all.
    expect([root, other].includes(mid)).toBe(false);
    expect(containsBlock(doc.blocks, root)).toBe(true);
    expect(containsBlock(doc.blocks, mid)).toBe(true);
    expect(containsBlock(doc.blocks, deep)).toBe(true);
  });

  it('rejects a block that is not in the forest', () => {
    const doc = setup('- a');
    expect(containsBlock(doc.blocks, createBlock('stranger'))).toBe(false);
    expect(containsBlock([], createBlock('a'))).toBe(false);
    expect(containsBlock(doc.blocks, null as unknown as Block)).toBe(false);
  });
});

describe('shift-click range anchor', () => {
  const MD = `- alpha
\t- alpha-1
\t- alpha-2
- bravo
\t- bravo-1
- charlie
\t- charlie-1
`;

  /** Visible order as plain strings — easier to assert on than identities. */
  function seq(roots: Block[]): string[] {
    return flattenVisible(roots).map((b) => b.text);
  }

  function rangeTexts(roots: Block[], anchor: Block, target: Block): string[] | null {
    return visibleRange(roots, anchor, target)?.map((b) => b.text) ?? null;
  }

  it('falls back to the focused block when nothing was clicked yet', () => {
    // The reported bug: editing `alpha`, then Shift+clicking `bravo-1`.
    // lastClicked is null because editing never goes through selectFromClick.
    const doc = setup(MD);
    const [alpha, alpha1, alpha2, bravo, bravo1] = flattenVisible(doc.blocks);
    expect(rangeAnchor(doc.blocks, null, alpha)).toBe(alpha);
    expect(rangeTexts(doc.blocks, alpha, bravo1)).toEqual([
      'alpha',
      'alpha-1',
      'alpha-2',
      'bravo',
      'bravo-1',
    ]);
    // Sanity: the block being edited is genuinely part of the range.
    expect(rangeTexts(doc.blocks, alpha, bravo1)).toContain(alpha.text);
    expect(alpha1.text).toBe('alpha-1');
    expect(alpha2.text).toBe('alpha-2');
    expect(bravo.text).toBe('bravo');
  });

  it('prefers lastClicked over the focused block', () => {
    // Editing charlie but shift+clicking from bravo: the click anchor wins,
    // otherwise the range would jump back to the block being edited.
    const doc = setup(MD);
    const seq2 = flattenVisible(doc.blocks);
    const bravo = seq2[3];
    const charlie = seq2[5];
    expect(rangeAnchor(doc.blocks, bravo, charlie)).toBe(bravo);
    expect(rangeTexts(doc.blocks, bravo, charlie)).toEqual(['bravo', 'bravo-1', 'charlie']);
  });

  it('returns null when neither anchor is visible', () => {
    const doc = setup(MD);
    expect(rangeAnchor(doc.blocks, null, null)).toBeNull();
    expect(rangeAnchor(doc.blocks, createBlock('stranger'), null)).toBeNull();
  });

  it('ignores a lastClicked that left the visible sequence', () => {
    // A stale anchor must not shadow a perfectly good focused block.
    const doc = setup(MD);
    const focused = flattenVisible(doc.blocks)[0];
    expect(rangeAnchor(doc.blocks, createBlock('stranger'), focused)).toBe(focused);
  });

  it('is direction-agnostic', () => {
    const doc = setup(MD);
    const [alpha, , , , bravo1] = flattenVisible(doc.blocks);
    expect(rangeTexts(doc.blocks, bravo1, alpha)).toEqual(
      rangeTexts(doc.blocks, alpha, bravo1),
    );
  });

  it('visibleRange returns null when an end is not visible', () => {
    const doc = setup(MD);
    const alpha = flattenVisible(doc.blocks)[0];
    expect(visibleRange(doc.blocks, alpha, createBlock('stranger'))).toBeNull();
    expect(visibleRange(doc.blocks, createBlock('stranger'), alpha)).toBeNull();
  });

  it('skips blocks hidden inside a collapsed sub-tree', () => {
    const doc = setup(MD);
    flattenVisible(doc.blocks)[0].props['collapsed'] = 'true';
    const after = flattenVisible(doc.blocks);
    expect(seq(doc.blocks)).toEqual(['alpha', 'bravo', 'bravo-1', 'charlie', 'charlie-1']);
    // `alpha-1` is hidden, so the range must not contain it.
    expect(rangeTexts(doc.blocks, after[0], after[1])).toEqual(['alpha', 'bravo']);
  });

  it('a single-block range (anchor === target) is just that block', () => {
    const doc = setup(MD);
    const bravo = flattenVisible(doc.blocks)[3];
    expect(rangeTexts(doc.blocks, bravo, bravo)).toEqual(['bravo']);
  });
});

describe('paragraph container propagation', () => {
  it('splitBlock inherits the bare flag (Enter in a paragraph stays a paragraph)', () => {
    const doc = setup('a paragraph\n');
    const b = doc.blocks[0];
    expect(b.bare).toBe(true);
    const nb = splitBlock(b, 5);
    expect(nb.bare).toBe(true);
    expect(serializeDocument(doc)).toBe('a par\nagraph\n');
  });

  it('splitBlock does not mark list items as bare', () => {
    const doc = setup('- a list item\n');
    const nb = splitBlock(doc.blocks[0], 2);
    expect(nb.bare).toBeFalsy();
  });

  it('cycleMarker promotes a paragraph to a task list item (bare cleared)', () => {
    const doc = setup('buy milk\n');
    const b = doc.blocks[0];
    expect(b.bare).toBe(true);
    cycleMarker(b);
    expect(b.marker).toBe('TODO');
    expect(b.bare).toBeFalsy();
    expect(serializeDocument(doc)).toBe('- TODO buy milk\n');
  });
});

describe('empty list block leaves the list on Enter (SiYuan parity)', () => {
  it('the LAST empty list block exits the list and becomes a paragraph', () => {
    const doc = setup('- a\n- ');
    const empty = doc.blocks[1];
    expect(empty.text).toBe('');
    expect(shouldExitListOnEnter(empty, '')).toBe(true);
    toBareParagraph(empty);
    expect(empty.bare).toBe(true);
    // 段落容器:顶层不带 `- ` 前缀,保存不会把段落改写回列表项。
    // 空段落落在文件末尾时磁盘上只留下一个换行(没有载体),开始打字后才落盘。
    expect(serializeDocument(doc)).toBe('- a\n');
  });

  it('an empty list block in the MIDDLE keeps splitting into siblings', () => {
    const doc = setup('- a\n- \n- c\n');
    const empty = doc.blocks[1];
    expect(shouldExitListOnEnter(empty, '')).toBe(false);
  });

  it('a block with content, a TODO marker, children or bare already is not one', () => {
    const doc = setup('- a\n- b\n');
    expect(shouldExitListOnEnter(doc.blocks[1], 'b')).toBe(false);
    doc.blocks[1].marker = 'TODO';
    expect(shouldExitListOnEnter(doc.blocks[1], '')).toBe(false);
    doc.blocks[1].marker = null;
    doc.blocks[1].children.push(createBlock('child'));
    expect(shouldExitListOnEnter(doc.blocks[1], '')).toBe(false);
    // 已经是段落的空块:回车照常分裂出新的空段落,不参与退出列表。
    const para = setup('a paragraph\n').blocks[0];
    expect(para.bare).toBe(true);
    expect(shouldExitListOnEnter(para, '')).toBe(false);
  });

  it('a nested empty block exits too — same level, and the disk keeps `- `', () => {
    const doc = setup('- a\n  - b\n  - ');
    const nested = doc.blocks[0].children[1];
    expect(nested.text).toBe('');
    expect(shouldExitListOnEnter(nested, '')).toBe(true);
    toBareParagraph(nested);
    // 层级不变(思源的 breakList 也是同层换容器);depth>0 的段落序列化回落
    // 成 `- ` 形式,否则重解析会把裸行并成上一块的软行。
    expect(nested.parent).toBe(doc.blocks[0]);
    expect(serializeDocument(doc)).toBe('- a\n  - b\n  - ');
  });
});
