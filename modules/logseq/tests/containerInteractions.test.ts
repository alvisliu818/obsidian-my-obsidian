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
import { handleBackspace, handleEnter, handlePaste, handleSpace } from '../src/interactions/keymap';
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

describe('思源输入转换 — `#`+空格 转标题', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // handleSpace 的转换在 setTimeout 里重读 view.state——真实编辑器的
  // state 是活的;测试桩用带 getter 的持久 view 模拟。
  function liveView(ref: { doc: string; head: number }): never {
    return {
      state: {
        get doc() {
          return { toString: () => ref.doc, length: ref.doc.length };
        },
        get selection() {
          return { main: { head: ref.head, empty: true, from: ref.head, to: ref.head } };
        },
      },
    } as never;
  }

  it('bare 段落行首 `# `+空格 → kind=raw 标题,光标落前缀后', async () => {
    const env = makeEnv('hello\n');
    const a = env.doc.blocks[0];
    env.focus(a, 0);
    const ref = { doc: '#', head: 1 };
    expect(handleSpace(liveView(ref), env.host)).toBe(false);
    ref.doc = '# '; // 空格落盘
    ref.head = 2;
    await sleep(20);
    expect(a.kind).toBe('raw');
    expect(a.text).toBe('# ');
    expect(a.bare).toBe(false);
    expect(env.focusTargets.at(-1)).toBe(a);
  });

  it('`## ` 转二级标题;列表项里敲 # 不转换', async () => {
    const env = makeEnv('hello\n');
    const a = env.doc.blocks[0];
    env.focus(a, 0);
    const ref = { doc: '##', head: 2 };
    handleSpace(liveView(ref), env.host);
    ref.doc = '## body';
    ref.head = 7;
    await sleep(20);
    expect(a.kind).toBe('raw');
    expect(a.text).toBe('## body');

    const env2 = makeEnv('- item\n');
    const it0 = env2.doc.blocks[0];
    env2.focus(it0);
    // 列表项非 bare:handleSpace 直接 return false,不转换
    const ref2 = { doc: '- # ', head: 4 };
    expect(handleSpace(liveView(ref2), env2.host)).toBe(false);
    await sleep(20);
    expect(it0.kind).toBe('list');
  });
});

describe('思源粘贴决策树 — 多行 markdown 拆块插入', () => {
  function pasteEnv(markdown: string) {
    const env = makeEnv(markdown);
    const ref = { doc: '', head: 0 };
    const view = () =>
      ({
        state: {
          get doc() {
            return { toString: () => ref.doc, length: ref.doc.length, lineAt: (p: number) => ({ text: ref.doc.split('\n')[ref.doc.slice(0, p).split('\n').length - 1] ?? '', from: 0, to: ref.doc.length, number: 1 }) };
          },
          get selection() {
            return { main: { head: ref.head, empty: true, from: ref.head, to: ref.head } };
          },
        },
      }) as never;
    return { env, ref, view };
  }

  it('段落里粘贴多行列表 → 拆块插入中间,光标落末尾', async () => {
    const ev = { stopPropagation: () => {} } as unknown as ClipboardEvent;
    const { env, ref, view } = pasteEnv('para\n');
    const a = env.doc.blocks[0];
    env.focus(a, 5); // 末尾
    ref.doc = 'para';
    ref.head = 4;
    expect(handlePaste(view(), env.host, ev, '- x\n- y\n')).toBe(true);
    expect(env.doc.blocks.map((b) => b.text)).toEqual(['para', 'x', 'y']);
    expect(env.doc.blocks[1].bare).toBeFalsy(); // 列表项
    expect(env.focusTargets.at(-1)?.text).toBe('y');
  });

  it('光标在文本中间粘贴 → 头留在原块,尾成延续块(段落 bare 语义)', () => {
    const ev = { stopPropagation: () => {} } as unknown as ClipboardEvent;
    const { env, ref, view } = pasteEnv('abcdef\n');
    const a = env.doc.blocks[0];
    env.focus(a, 3);
    ref.doc = 'abcdef';
    ref.head = 3;
    handlePaste(view(), env.host, ev, '- x\n');
    expect(a.text).toBe('abc');
    expect(env.doc.blocks.map((b) => b.text)).toEqual(['abc', 'x', 'def']);
    expect(env.doc.blocks[2].bare).toBe(true); // bare 段落延续
  });

  it('列表项里粘贴 → 粘贴块成同级项,尾部列表语义延续', () => {
    const ev = { stopPropagation: () => {} } as unknown as ClipboardEvent;
    const { env, ref, view } = pasteEnv('- one\n- two\n');
    const one = env.doc.blocks[0];
    env.focus(one, 3); // 'one' 末尾
    ref.doc = '- one'; // 编辑文档带符号
    ref.head = 5;
    handlePaste(view(), env.host, ev, '- x\n');
    expect(env.doc.blocks.map((b) => b.text)).toEqual(['one', 'x', 'two']);
    expect(env.doc.blocks[1].bare).toBeFalsy();
    expect(env.doc.blocks[2].bare).toBeFalsy(); // 列表延续(非 bare)
  });
});
