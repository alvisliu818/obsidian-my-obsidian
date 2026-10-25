/**
 * 思源容器块交互回归(用户指令 2026-10-25,protyle enter.ts/listEnter +
 * remove.ts removeLi 的行为移植):
 *
 * - E6 有子块的项末尾回车 → 新空项成为第一个子项
 * - E7 有子块的项中间回车 → 尾部成新项,子块跟尾部
 * - E5 bare 空子块回车 → 删空块,父项之后建新的列表项
 * - E8 段首回车 → 上面插空块,光标留在原块
 * - B1 唯一列表项块首退格 → 拆壳变段落(bare,文本保留)
 * - B4 顶级列表首项(有兄弟)块首退格 → no-op
 *
 * host 桩与 blockEnterFlow.test.ts 同义(mutate 直跑 + registerRoots)。
 */

import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { handleBackspace, handleEnter } from '../src/interactions/keymap';
import { linkParents, registerRoots } from '../src/core/treeOps';
import { parseDocument } from '../src/core/parser';
import { blockEditorDoc, editorMarkerLen, type Block } from '../src/types';
import type { BlockEditorView } from '../src/view/BlockEditorView';

function makeEnv(markdown: string) {
  const doc = parseDocument(markdown);
  linkParents(doc.blocks);
  registerRoots(doc.blocks);
  let focused: Block | null = doc.blocks[0] ?? null;
  let cmText = focused ? blockEditorDoc(focused) : '';
  let cmPos = cmText.length;
  const focusTargets: Block[] = [];
  const host = {
    doc,
    get focusedBlock() {
      return focused;
    },
    get visibleRoots() {
      return doc.blocks;
    },
    mutate(fn: () => void) {
      fn();
      registerRoots(doc.blocks);
    },
    focusBlock(b: Block, pos: number | string = 'end') {
      focused = b;
      cmText = blockEditorDoc(b);
      const mlen = editorMarkerLen(b);
      cmPos = typeof pos === 'number' ? (pos > 0 ? pos + mlen : mlen) : cmText.length;
      focusTargets.push(b);
    },
  };
  return {
    host: host as unknown as BlockEditorView,
    focusTargets,
    doc,
    focus(b: Block, pos?: number) {
      focused = b;
      cmText = blockEditorDoc(b);
      const mlen = editorMarkerLen(b);
      cmPos = pos === undefined ? cmText.length : pos > 0 ? pos + mlen : mlen;
      focusTargets.push(b);
    },
    /** 逃生舱:直接摆 CM 文档与光标(模拟 focusEditor 的删符号等前置状态) */
    setCM(text: string, pos: number) {
      cmText = text;
      cmPos = pos;
    },
    view: () => ({ state: EditorState.create({ doc: cmText, selection: EditorSelection.cursor(cmPos) }) }) as never,
  };
}

describe('思源容器块交互 — Enter', () => {
  it('E6: 有子块的项末尾回车 → 新空项成为第一个子项', () => {
    const env = makeEnv('- ab\n  - a1\n');
    const a = env.doc.blocks[0];
    env.focus(a); // 末尾
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(a.children).toHaveLength(2);
    expect(a.children[0].text).toBe('');
    expect(a.children[0].bare).toBeFalsy();
    expect(a.children[1].text).toBe('a1');
    expect(env.focusTargets.at(-1)).toBe(a.children[0]);
  });

  it('E7: 有子块的项中间回车 → 尾部成新项,子块跟尾部', () => {
    const env = makeEnv('- ab\n  - a1\n');
    const a = env.doc.blocks[0];
    env.focus(a, 1); // 'a|b'
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(a.text).toBe('a');
    expect(a.children).toHaveLength(0);
    const nb = env.focusTargets.at(-1)!;
    expect(nb.text).toBe('b');
    expect(nb.parent).toBeNull();
    expect(nb.children.map((c) => c.text)).toEqual(['a1']);
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['a', 'b']);
  });

  it('E5: bare 空子块回车 → 删空块,父项之后建新的列表项', () => {
    const env = makeEnv('- a\n  - b\n');
    const a = env.doc.blocks[0];
    const b = a.children[0];
    // 有内容的子块末尾回车 → 同级空子块(E1);空子块回车 → bare 化(退出路径)
    env.focus(b);
    expect(handleEnter(env.view(), env.host)).toBe(true);
    const empty = env.focusTargets.at(-1)!;
    expect(empty.parent).toBe(a);
    env.focus(empty);
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(empty.bare).toBe(true);
    // 再回车 → 删掉空子块,父项之后新建列表项(思源:空子块再次回车仍创建后续列表项)
    env.focus(empty);
    expect(handleEnter(env.view(), env.host)).toBe(true);
    const nb = env.focusTargets.at(-1)!;
    expect(nb).not.toBe(empty);
    expect(nb.parent).toBeNull();
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['a', '']);
    expect(a.children.map((c) => c.text)).toEqual(['b']);
  });

  it('E8: 段首回车 → 上面插空块,光标留在原块', () => {
    const env = makeEnv('- hello\n');
    const a = env.doc.blocks[0];
    env.focus(a, 0);
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['', 'hello']);
    expect(a.text).toBe('hello');
    expect(env.focusTargets.at(-1)).toBe(a); // 光标留在原块
  });

  it('E8 段落容器同规: bare 块段首回车插入的空块同为 bare', () => {
    const env = makeEnv('hello\n');
    const a = env.doc.blocks[0];
    env.focus(a, 0);
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks[0].bare).toBe(true);
    expect(env.doc.blocks[1].text).toBe('hello');
  });
});

describe('思源容器块交互 — Backspace 块首', () => {
  it('B1: 唯一列表项退格 → 拆壳变段落(文本保留,不合进列表外上一块)', () => {
    const env = makeEnv('prev\n\n- only\n');
    const only = env.doc.blocks.find((b) => b.text === 'only')!;
    env.focus(only);
    // 模拟 focusEditor 删符号后的状态:doc 无符号,光标在块首
    env.setCM('only', 0);
    expect(handleBackspace(env.view(), env.host)).toBe(true);
    expect(only.bare).toBe(true);
    expect(only.text).toBe('only');
    expect(only.marker).toBeNull();
    expect(env.doc.blocks.filter((b) => b.text === 'prev')).toHaveLength(1);
  });

  it('B1: 符号还在文档里时块首退格同样剥符号拆壳', () => {
    const env = makeEnv('- only\n');
    const only = env.doc.blocks[0];
    env.focus(only);
    env.setCM('- only', 0); // 光标在 `- ` 之前(符号区现形态)
    expect(handleBackspace(env.view(), env.host)).toBe(true);
    expect(only.bare).toBe(true);
    expect(only.text).toBe('only');
  });

  it('B4: 顶级列表首项(有兄弟)块首退格 → no-op', () => {
    const env = makeEnv('- a\n- c\n');
    const a = env.doc.blocks[0];
    env.focus(a);
    env.setCM('- a', 0);
    expect(handleBackspace(env.view(), env.host)).toBe(true);
    expect(a.bare).toBeFalsy();
    expect(a.text).toBe('a');
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['a', 'c']);
  });

  it('嵌套首项(有兄弟)退格 → 合并进父项(思源:合进上一块)', () => {
    const env = makeEnv('- p\n  - a\n  - c\n');
    const p = env.doc.blocks[0];
    const a = p.children[0];
    env.focus(a);
    env.setCM('a', 0); // 符号已删,块首
    expect(handleBackspace(env.view(), env.host)).toBe(true);
    expect(p.text).toBe('pa');
    expect(p.children.map((c) => c.text)).toEqual(['c']);
  });
});
