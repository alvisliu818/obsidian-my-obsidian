/**
 * 引述块 Enter（2026-10-28 用户指令「不要分歧」——对齐思源容器内回车语义）：
 * 引述是容器块，回车 = 容器内拆段落。我们的引述是单个 raw 块（'> ' 内嵌标记），
 * 容器内新段落 = 块内新 '> ' 行：末尾/中间拆行补标记；caret 在标记上/前 →
 * 行上方插空引述行；空引述回车 → 退出引述变空段落（思源同义：容器空末块
 * 回车 getTopEmptyElement 移出容器）。不再拆出新的引述块。
 * （2026-10-26 的 Logseq 同款行为已撤销。）
 */
import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { handleEnter } from '../src/interactions/keymap';
import { linkParents, registerRoots } from '../src/core/treeOps';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';
import { blockEditorDoc, type Block } from '../src/types';
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
    focusBlock(b: Block, pos?: number) {
      focused = b;
      cmText = blockEditorDoc(b);
      cmPos = pos ?? cmText.length;
      focusTargets.push(b);
    },
    /** 逃生舱：直接摆 CM 文档与光标（raw 块文档 = text 原文，位置绝对）。 */
    setCM(text: string, pos: number) {
      cmText = text;
      cmPos = pos;
      focused = doc.blocks[0];
    },
    view: () => ({ state: EditorState.create({ doc: cmText, selection: EditorSelection.cursor(cmPos) }) }) as never,
  };
  return {
    host: host as unknown as BlockEditorView,
    focusTargets,
    doc,
    setCM: host.setCM.bind(host),
    view: host.view.bind(host),
  };
}

describe('引述块 Enter(对齐思源:容器内拆段落,不拆块)', () => {
  it('Q1 非空引述末尾回车 → 同块内新引述行(不新增块)', () => {
    const env = makeEnv('> 引用文字\n');
    env.setCM('> 引用文字', 6); // 末尾
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['> 引用文字\n> ']);
  });

  it('Q2 内容中间回车 → 块内拆行,新行补 > ', () => {
    const env = makeEnv('> hello\n');
    env.setCM('> hello', 4); // '> he|llo'
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['> he\n> llo']);
  });

  it('Q3 空引述回车 → 退出引述变空段落(不新增块)', () => {
    const env = makeEnv('> \n');
    env.setCM('> ', 2);
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['']);
    expect(env.focusTargets.at(-1)).toBe(env.doc.blocks[0]);
  });

  it('Q4 caret 在 > 标记上/前 → 行上方插空引述行(容器内新空段落)', () => {
    const env = makeEnv('> hello\n');
    env.setCM('> hello', 0);
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['> \n> hello']);
  });

  it('Q5 序列化 roundtrip:块内多行引述落盘仍是一个引述块', () => {
    const env = makeEnv('> 引用文字\n');
    env.setCM('> 引用文字', 6);
    handleEnter(env.view(), env.host);
    const rt = parseDocument(serializeDocument(env.doc));
    expect(rt.blocks.map((x) => x.text)).toEqual(['> 引用文字\n> ']);
  });

  it('Q6 多行引述末尾回车 → 仍在本块追加新引述行', () => {
    const env = makeEnv('> a\n> b\n');
    env.setCM('> a\n> b', 7); // 整块末尾
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['> a\n> b\n> ']);
  });

  it('Q7 多行引述第一行末尾回车 → 拆出空引述行作段落分隔', () => {
    const env = makeEnv('> a\n> b\n');
    env.setCM('> a\n> b', 3); // '> a|' 第一行末尾
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['> a\n> \n> b']);
  });

  it('Q8 多行引述第一行行首(caret 在 > 上)→ 该行上方插空引述行', () => {
    const env = makeEnv('> a\n> b\n');
    env.setCM('> a\n> b', 0);
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['> \n> a\n> b']);
  });
});
