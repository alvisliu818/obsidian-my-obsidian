/**
 * 用户规格的全链路回归：驱动 handleEnter 本体（不是只测 shouldExitListOnEnter），
 * 模拟真实操作序列——有内容的大纲块末尾回车 → 焦点落在新空大纲块 → 再回车。
 *
 * host 桩忠实于真实编辑器的语义：
 * - doc 用真实 parseDocument 解析；
 * - mutate 直跑 fn 并重注册根数组（对应 BlockEditorView.renderInner 每次
 *   render 都 registerRoots(visibleRoots) 的行为）；
 * - focusBlock 同步「CM 文档 = 块文本」（真实编辑器 mount 时同义）。
 */

import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { handleEnter } from '../src/interactions/keymap';
import { linkParents, registerRoots } from '../src/core/treeOps';
import { parseDocument } from '../src/core/parser';
import type { Block } from '../src/types';
import type { BlockEditorView } from '../src/view/BlockEditorView';

function makeEnv(markdown: string) {
  const doc = parseDocument(markdown);
  linkParents(doc.blocks);
  registerRoots(doc.blocks);
  let focused: Block | null = doc.blocks[0] ?? null;
  let cmText = focused?.text ?? '';
  let cmPos = cmText.length;
  const focusTargets: Block[] = [];
  const host = {
    doc,
    get focusedBlock() {
      return focused;
    },
    mutate(fn: () => void) {
      fn();
      registerRoots(doc.blocks);
    },
    focusBlock(b: Block, pos: number | string = 'end') {
      focused = b;
      cmText = b.text;
      cmPos = typeof pos === 'number' ? pos : b.text.length;
      focusTargets.push(b);
    },
    /** 模拟用户点击某块进入编辑（焦点 + CM 文档 = 块文本） */
    focus(b: Block, pos?: number) {
      focused = b;
      cmText = b.text;
      cmPos = pos ?? b.text.length;
      focusTargets.push(b);
    },
  };
  const view = () =>
    ({ state: EditorState.create({ doc: cmText, selection: EditorSelection.cursor(cmPos) }) }) as never;
  return {
    host: host as unknown as BlockEditorView,
    view,
    focusTargets,
    doc,
    focus(b: Block, pos?: number) {
      focused = b;
      cmText = b.text;
      cmPos = pos ?? b.text.length;
      focusTargets.push(b);
    },
  };
}

describe('handleEnter — 块末尾回车新建大纲块,空大纲块回车转文档块', () => {
  it('末位有内容的块回车 → 新空大纲块;空块上再回车 → 转文档块(去圆点)', () => {
    const env = makeEnv('- a\n');

    // 第一刀：'a' 末尾回车 → 分裂出同级空大纲块,焦点落过去
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks).toHaveLength(2);
    const nb = env.focusTargets[env.focusTargets.length - 1];
    expect(nb.text).toBe('');
    expect(nb.kind).toBe('list');
    expect(nb.bare).toBeFalsy();
    expect(env.doc.blocks[1]).toBe(nb);

    // 第二刀：空大纲块上回车 → 退出列表转段落容器(圆点消失),不新增块
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(nb.bare).toBe(true);
    expect(nb.text).toBe('');
    expect(env.doc.blocks).toHaveLength(2);
    expect(env.focusTargets.at(-1)).toBe(nb); // 焦点留在原块(光标回块首)
  });

  it('嵌套层同样成立:子级末位空块回车 → 同层转文档块', () => {
    const env = makeEnv('- a\n  - b\n');
    const a = env.doc.blocks[0];
    const b = a.children[0];
    env.focus(b);

    expect(handleEnter(env.view(), env.host)).toBe(true);
    const nb = env.focusTargets.at(-1)!;
    expect(nb.parent).toBe(a); // 同层新空块
    expect(nb.bare).toBeFalsy();

    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(nb.bare).toBe(true);
    expect(nb.parent).toBe(a); // 层级不变,同层换容器
  });

  it('中间的空块回车 → 分裂出新空块(当前语义:非末位不转,防裸行丢数据)', () => {
    const env = makeEnv('- a\n- c\n');
    const a = env.doc.blocks[0];
    // 在 'a' 的开头回车:空头块留在 blocks[0],'a' 成它的新兄弟
    env.focus(a, 0);
    expect(handleEnter(env.view(), env.host)).toBe(true);
    const mid = env.doc.blocks[0];
    expect(mid.text).toBe('');

    // 中间空块上回车:不转换,分裂出同级空块(非末位,后面还有 'a'、'c')
    env.focus(mid, 0);
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(mid.bare).toBeFalsy();
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['', '', 'a', 'c']);
  });
});
