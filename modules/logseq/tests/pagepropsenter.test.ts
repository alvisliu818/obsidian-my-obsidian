/**
 * 页面属性块 Enter（2026-10-26 修复，库内库外同链）：Logseq 属性块的编辑
 * 文档是 `- editor:: x\nstatus:: y`（符号即文本），通用回车路径会把首行
 * 属性掉进 text、剩余属性行被 splitBlock 拦腰拆成普通列表块。正确语义 =
 * 属性行整体提交进模型 + 下方新建块。frontmatter 块同理（单冒号行不匹配
 * splitPropLines，中途回车会把 frontmatter 文本拆出块外）。
 */
import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { handleEnter } from '../src/interactions/keymap';
import { linkParents, registerRoots } from '../src/core/treeOps';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';
import { blockEditorDoc, isPagePropsBlock, splitEditorDocForCommit, type Block } from '../src/types';
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

describe('页面属性块 Enter（2026-10-26 修复）', () => {
  it('P1 属性行整体提交进模型 + 下方新建块(库内库外同链)', () => {
    const env = makeEnv('editor:: logseq\nstatus:: active\n\n- 内容块\n');
    // 编辑文档带 `- ` 弹符号(符号即文本),光标在末尾
    expect(blockEditorDoc(env.doc.blocks[0])).toBe('- editor:: logseq\nstatus:: active');
    expect(handleEnter(env.view(), env.host)).toBe(true);
    const [props, blank, content] = env.doc.blocks;
    expect(props.text).toBe('');
    expect(props.kind).toBe('list');
    expect(props.bare).toBe(false);
    expect(props.props).toEqual({ editor: 'logseq', status: 'active' });
    expect(blank.text).toBe('');
    expect(content.text).toBe('内容块');
    expect(env.focusTargets.at(-1)).toBe(blank);
  });

  it('P2 属性行中间回车:两行属性都保住,不拆散', () => {
    const env = makeEnv('editor:: logseq\nstatus:: active\n\n- 内容块\n');
    env.setCM('- editor:: logseq\nstatus:: active', 18); // 首行行尾
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks[0].text).toBe('');
    expect(env.doc.blocks[0].props).toEqual({ editor: 'logseq', status: 'active' });
    expect(env.doc.blocks[1].text).toBe('');
  });

  it('P3 frontmatter 块中途回车:文本原样提交 + 下方新建块,不拆出块外', () => {
    const env = makeEnv('---\ntitle: t\nstatus: x\n---\n- a\n');
    expect(env.doc.blocks[0].frontmatter).toBe(true);
    env.setCM('title: t\nstatus: x', 5); // title:| t
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks[0].frontmatter).toBe(true);
    expect(env.doc.blocks[0].text).toBe('title: t\nstatus: x');
    expect(env.doc.blocks[1].text).toBe('');
  });

  it('P4 序列化 roundtrip:属性块完整 + 新块就位', () => {
    const env = makeEnv('editor:: logseq\nstatus:: active\n\n- 内容块\n');
    handleEnter(env.view(), env.host);
    const rt = parseDocument(serializeDocument(env.doc));
    expect(isPagePropsBlock(rt.blocks[0])).toBe(true);
    expect(rt.blocks[0].props).toEqual({ editor: 'logseq', status: 'active' });
    expect(rt.blocks[1].text).toBe('');
    expect(rt.blocks[2].text).toBe('内容块');
  });

  it('P5 空首块(无属性)回车:与原 splitBlock 路径产出一致(新空块在下方)', () => {
    const env = makeEnv('- \n');
    expect(handleEnter(env.view(), env.host)).toBe(true);
    expect(env.doc.blocks.map((x) => x.text)).toEqual(['', '']);
    expect(env.doc.blocks[0].bare).toBe(false);
  });
});

describe('splitEditorDocForCommit(提交口径统一入口,属性块 Enter 链修复)', () => {
  it('属性块形态:带符号首行不拒收,属性行全进 props、text 归空', () => {
    const b = { kind: 'list', marker: null, text: '', props: {}, children: [], parent: null } as Block;
    const r = splitEditorDocForCommit(b, '- editor:: logseq\nstatus:: active');
    expect(r.text).toBe('');
    expect(r.props).toEqual({ editor: 'logseq', status: 'active' });
    expect(b.bare).toBe(false);
  });

  it('键序翻转后的重挂文档同样收敛(尾随段完整)', () => {
    const b = { kind: 'list', marker: null, text: '', props: {}, children: [], parent: null } as Block;
    // applyBlockProps 键序翻转后重挂的文档形态(实测触发再提交退化的输入)
    const r = splitEditorDocForCommit(b, '- status:: active\neditor:: logseq');
    expect(r.text).toBe('');
    expect(r.props).toEqual({ status: 'active', editor: 'logseq' });
  });

  it('三连提交收敛(mutate 预提交 → fn → focusBlock 再提交)与单次一致', () => {
    const b = { kind: 'list', marker: null, text: '', props: {}, children: [], parent: null } as Block;
    b.props = { editor: 'logseq', status: 'active' };
    // 提交①:mutate 预提交(挂载文档)
    const r1 = splitEditorDocForCommit(b, '- editor:: logseq\nstatus:: active');
    b.text = r1.text;
    Object.assign(b.props, r1.props);
    // 提交②:fn(同一 live 文本)
    const r2 = splitEditorDocForCommit(b, '- editor:: logseq\nstatus:: active');
    b.text = r2.text;
    Object.assign(b.props, r2.props);
    // 提交③:focusBlock 再提交(applyBlockProps 键序翻转后的重挂文档)
    const doc3 = blockEditorDoc(b);
    const r3 = splitEditorDocForCommit(b, doc3);
    b.text = r3.text;
    Object.assign(b.props, r3.props);
    expect(b.text).toBe('');
    expect(b.props['editor']).toBe('logseq');
    expect(b.props['status']).toBe('active');
  });

  it('普通块维持原口径:先切尾随属性段再剥符号', () => {
    const b = { kind: 'list', marker: null, text: 'hello', props: {}, children: [], parent: null } as Block;
    const r = splitEditorDocForCommit(b, '- hello\nprop:: v');
    expect(r.text).toBe('hello');
    expect(r.props).toEqual({ prop: 'v' });
  });

  it('段落敲出符号:submit 路径同步 bare/marker(符号即文本)', () => {
    const b = { kind: 'list', marker: null, text: '', props: {}, children: [], parent: null } as Block;
    b.bare = true;
    const r = splitEditorDocForCommit(b, '- x');
    expect(r.text).toBe('x');
    expect(b.bare).toBe(false);
  });
});
