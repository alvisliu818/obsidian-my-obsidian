/**
 * 块选择模式纯函数回归(思源 blockSelection.test.ts 用例移植,2026-10-26):
 * toggle 祖先/后代互斥、可见序列连续性、删除后光标候选(含环检测)。
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import type { EditorView } from '@codemirror/view';
import { linkParents } from '../src/core/treeOps';
import { parseDocument } from '../src/core/parser';
import { handleEscape } from '../src/interactions/keymap';
import type { BlockRenderHost } from '../src/blocks/renderHost';
import {
  blockContains,
  deleteCandidate,
  isContinuousSelection,
  toggleBlockSelection,
} from '../src/interactions/blockSelection';
import type { Block } from '../src/types';

function makeTree(markdown: string): Block[] {
  const doc = parseDocument(markdown);
  linkParents(doc.blocks);
  return doc.blocks;
}

/** 可见序列的 next(测试桩:线性 flatten,等价 treeOps.nextVisible 的邻接语义)。 */
function makeNext(seq: Block[]): (b: Block) => Block | null {
  return (b) => {
    const i = seq.indexOf(b);
    return i >= 0 && i < seq.length - 1 ? seq[i + 1] : null;
  };
}

describe('blockContains', () => {
  it('walks the parent chain', () => {
    const blocks = makeTree('- a\n  - b\n- c');
    const [a, c] = blocks;
    const b = a.children[0];
    expect(blockContains(a, b)).toBe(true);
    expect(blockContains(b, a)).toBe(false);
    expect(blockContains(a, c)).toBe(false);
  });
});

describe('toggleBlockSelection', () => {
  it('adds and removes the target without changing unrelated marks', () => {
    const blocks = makeTree('- first\n- second');
    const [first, second] = blocks;
    expect(toggleBlockSelection([first], second)).toEqual([first, second]);
    expect(toggleBlockSelection([first, second], second)).toEqual([first]);
  });

  it('keeps parent and child marks mutually exclusive', () => {
    const blocks = makeTree('- parent\n  - child\n- sibling');
    const [parent, sibling] = blocks;
    const child = parent.children[0];
    expect(toggleBlockSelection([parent, sibling], child)).toEqual([sibling, child]);
    expect(toggleBlockSelection([child, sibling], parent)).toEqual([sibling, parent]);
  });
});

describe('isContinuousSelection', () => {
  it('accepts one block and adjacent blocks', () => {
    const seq = makeTree('- a\n- b\n- c');
    const next = makeNext(seq);
    expect(isContinuousSelection([seq[0]], next)).toBe(true);
    expect(isContinuousSelection([seq[0], seq[1]], next)).toBe(true);
  });

  it('rejects empty, non-contiguous, and out-of-sequence selections', () => {
    const seq = makeTree('- a\n- b\n- c\n- d');
    const next = makeNext(seq);
    expect(isContinuousSelection([], next)).toBe(false);
    expect(isContinuousSelection([seq[0], seq[2]], next)).toBe(false);
    expect(isContinuousSelection([seq[1], seq[0]], next)).toBe(false);
  });
});

describe('deleteCandidate', () => {
  const makeLine = (): Block[] => makeTree('- A\n- B\n- C\n- D\n- E');

  it('uses the next block for Delete and the previous block for Backspace', () => {
    const blocks = makeLine();
    const [a, b, c, d] = blocks;
    expect(deleteCandidate([b, c], 'Delete', prevOf(blocks), makeNext(blocks)))
      .toEqual({ block: d, side: 'after' });
    expect(deleteCandidate([b, c], 'Backspace', prevOf(blocks), makeNext(blocks)))
      .toEqual({ block: a, side: 'before' });
  });

  it('uses the outside edges for non-contiguous marks', () => {
    const blocks = makeLine();
    const [a, b, d, e] = [blocks[0], blocks[1], blocks[3], blocks[4]];
    expect(deleteCandidate([b, d], 'Delete', prevOf(blocks), makeNext(blocks)))
      .toEqual({ block: e, side: 'after' });
    expect(deleteCandidate([b, d], 'Backspace', prevOf(blocks), makeNext(blocks)))
      .toEqual({ block: a, side: 'before' });
  });

  it('falls back to the opposite side and returns nothing when everything is deleted', () => {
    const blocks = makeLine();
    expect(deleteCandidate(blocks.slice(3), 'Delete', prevOf(blocks), makeNext(blocks)))
      .toEqual({ block: blocks[2], side: 'before' });
    expect(deleteCandidate(blocks.slice(0, 2), 'Backspace', prevOf(blocks), makeNext(blocks)))
      .toEqual({ block: blocks[2], side: 'after' });
    expect(deleteCandidate(blocks, 'Delete', prevOf(blocks), makeNext(blocks))).toBeUndefined();
  });

  it('skips candidates that are also being deleted (cycle guard)', () => {
    const blocks = makeLine();
    const targets = [blocks[1], blocks[3]];
    const nextWithCycle = (b: Block): Block | null => {
      if (b === blocks[3]) return blocks[1]; // deleted → 跳过
      if (b === blocks[1]) return blocks[4];
      return makeNext(blocks)(b);
    };
    expect(deleteCandidate(targets, 'Delete', prevOf(blocks), nextWithCycle))
      .toEqual({ block: blocks[4], side: 'after' });
  });
});

/** 可见序列的 prev 测试桩。 */
function prevOf(seq: Block[]): (b: Block) => Block | null {
  return (b) => {
    const i = seq.indexOf(b);
    return i > 0 ? seq[i - 1] : null;
  };
}

describe('handleEscape 升级链（思源兕底块选中）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('提交后下一帧把锚点挂到刚提交的块上', () => {
    const b = makeTree('- a\n- b')[0];
    const blurs: number[] = [];
    let anchored: Block | null = null;
    const host = {
      focusedBlock: b,
      enterBlockSelection(x: Block) {
        anchored = x;
      },
    } as unknown as BlockRenderHost;
    const view = {
      composing: false,
      contentDOM: { blur: () => void blurs.push(1) },
    } as unknown as EditorView;
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
      fn();
      return 0;
    });
    expect(handleEscape(view, host)).toBe(true);
    expect(blurs).toEqual([1]); // 提交路径走了
    expect(anchored).toBe(b); // 锚点=刚提交的块
  });

  it('组合期间吞掉 Esc：不提交也不进模式（思源同规）', () => {
    const host = {
      focusedBlock: makeTree('- a')[0],
      enterBlockSelection: () => {
        throw new Error('must not enter selection during composition');
      },
    } as unknown as BlockRenderHost;
    const view = {
      composing: true,
      contentDOM: {
        blur: () => {
          throw new Error('must not commit during composition');
        },
      },
    } as unknown as EditorView;
    expect(handleEscape(view, host)).toBe(true);
  });

  it('宿主没有 enterBlockSelection（片段场景）时只提交不锚住', () => {
    const b = makeTree('- a')[0];
    let blurs = 0;
    const host = { focusedBlock: b } as unknown as BlockRenderHost;
    const view = {
      composing: false,
      contentDOM: { blur: () => void blurs++ },
    } as unknown as EditorView;
    vi.stubGlobal('requestAnimationFrame', (fn: () => void) => {
      fn();
      return 0;
    });
    expect(handleEscape(view, host)).toBe(true);
    expect(blurs).toBe(1);
  });
});
