/**
 * 引述块 Enter（用户指定 2026-10-26）：非空引述末尾回车 → 新建同级引述块；
 * 内容中间回车 → 拆成两个引述块；空引述回车 → 退出引述；caret 在标记上 →
 * 上方插空段落。此前 raw 分支走 splitRawToOutline 把引述拆成大纲块。
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
    focusBlock(b: Block) {
      focused = b;
      cmText = blockEditorDoc(b);
      cmPos = cmText.length;
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

describe('引述块 Enter（用户指定 2026-10-26）', () => {
  it('Q1 非空引述末尾回车 → 新建同级空引述块', () => {
    const env = makeEnv('> 引用文字\n');
    env.setCM('> 引用文字', 6); // 末尾
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['> 引用文字', '> ']);
    const nb = env.focusTargets.at(-1)!;
    expect(nb.kind).toBe('raw');
    expect(nb.parent).toBeNull();
  });

  it('Q2 内容中间回车 → 拆成两个引述块,尾部补 > ', () => {
    const env = makeEnv('> hello\n');
    env.setCM('> hello', 4); // '> he|llo'
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['> he', '> llo']);
  });

  it('Q3 空引述回车 → 退出引述变空段落(不新增块)', () => {
    const env = makeEnv('> \n');
    env.setCM('> ', 2);
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['']);
    expect(env.focusTargets.at(-1)).toBe(env.doc.blocks[0]);
  });

  it('Q4 caret 在 > 上 → 上方插空段落,引述保持原样', () => {
    const env = makeEnv('> hello\n');
    env.setCM('> hello', 0);
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['', '> hello']);
  });

  it('Q5 序列化 roundtrip:新同级引述落盘仍是一个引述块', () => {
    const env = makeEnv('> 引用文字\n');
    env.setCM('> 引用文字', 6);
    handleEnter(env.view(), env.host);
    const rt = parseDocument(serializeDocument(env.doc));
    expect(rt.blocks.map((x) => x.text)).toEqual(['> 引用文字', '> ']);
  });

  it('Q6 库外同链:非列表 raw 的多行引述末尾回车同样拆同级', () => {
    const env = makeEnv('> a\n> b\n');
    env.setCM('> a\n> b', 7); // 整块末尾
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['> a\n> b', '> ']);
  });
});
