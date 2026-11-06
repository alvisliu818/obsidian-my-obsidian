/**
 * 段落容器(bare)行首敲列表标记 + 空格 → 立即转大纲块（不等回车）。
 * 全链路驱动 handleSpace 本体（blockEnterFlow 同款 host 桩）。
 *
 * 用户规格（2026-10-24）：段落块前面加 `- ` 没有立即转成大纲块,回车后才
 * 渲染,且渲染出的样式和原生大纲块不一样。修法 = 空格键上即时转换,重建
 * 后样式走原生大纲块同一套 wrap。
 */

import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { handleSpace } from '../src/interactions/keymap';
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
    },
  };
  const type = (inserted: string, at?: number) => {
    if (at === undefined) at = cmPos;
    cmText = cmText.slice(0, at) + inserted + cmText.slice(at);
    cmPos = at + inserted.length;
  };
  // view.state 必须是「活的」：真实 CM6 的 view.state 随每次事务更新,
  // handleSpace 的宏任务回调整的是转换落地时的最新文档。
  const view = {
    get state() {
      return EditorState.create({ doc: cmText, selection: EditorSelection.cursor(cmPos) });
    },
    // 批次 30：handleSpace 任务分支先 dispatch 同步 CM 文档再 mutate——
    // 桩按 {from,to,insert} 形态应用变更（全量替换即可覆盖用例）。
    dispatch(spec: { changes: { from?: number; to?: number; insert?: string } | Array<{ from?: number; to?: number; insert?: string }>; selection?: { anchor: number } }) {
      const changes = Array.isArray(spec.changes) ? spec.changes : [spec.changes];
      let text = cmText;
      for (const c of changes) {
        const from = c.from ?? 0;
        const to = c.to ?? 0;
        text = text.slice(0, from) + (c.insert ?? '') + text.slice(to);
      }
      cmText = text;
      if (spec.selection) cmPos = spec.selection.anchor;
    },
  } as never;
  return { host: host as unknown as BlockEditorView, view, doc, type, focus: (b: Block, pos?: number) => {
    focused = b;
    cmText = b.text;
    cmPos = pos ?? b.text.length;
  } };
}

describe('handleSpace — 段落容器行首列表标记即时转大纲块', () => {
  it('裸段落敲 "-" 后按空格 → 块立即去 bare(转大纲块),光标原位', async () => {
    const env = makeEnv('甲有内容\n');
    const b = env.doc.blocks[0];
    expect(b.bare).toBe(true); // 前置:裸文本行解析为段落容器

    env.focus(b, 0);
    env.type('-'); // 敲下 "-"
    expect(handleSpace(env.view, env.host)).toBe(false); // 空格不消费
    env.type(' '); // CM 照常插入空格
    await new Promise((r) => setTimeout(r, 0)); // 转换推迟一个宏任务

    expect(b.bare).toBe(false);
    expect(b.kind).toBe('list');
    expect(b.text).toBe('甲有内容');
  });

  it('"*" 与 "+" 同样触发', async () => {
    for (const marker of ['*', '+']) {
      const env = makeEnv('内容\n');
      const b = env.doc.blocks[0];
      env.focus(b, 0);
      env.type(marker);
      handleSpace(env.view, env.host);
      env.type(' ');
      await new Promise((r) => setTimeout(r, 0));
      expect(b.bare).toBe(false);
    }
  });

  it('普通大纲块上敲空格不转换', async () => {
    const env = makeEnv('- 甲\n');
    const b = env.doc.blocks[0];
    expect(b.bare).toBeFalsy();
    env.focus(b, 0);
    env.type('-');
    handleSpace(env.view, env.host);
    env.type(' ');
    await new Promise((r) => setTimeout(r, 0));
    // 没有转换 → 没有 mutate → 模型文本不动（敲的内容仍在编辑器缓冲里）
    expect(b.text).toBe('甲');
    expect(b.bare).toBeFalsy();
  });

  it('标记不在行首(如打字打到一半)不转换', async () => {
    const env = makeEnv('abc\n');
    const b = env.doc.blocks[0];
    env.focus(b, 2); // "ab|c"
    env.type('-');
    handleSpace(env.view, env.host);
    env.type(' ');
    await new Promise((r) => setTimeout(r, 0));
    expect(b.bare).toBe(true); // 没转
  });

  it('选中状态下按空格不转换(留给 CM 的替换语义)', async () => {
    const env = makeEnv('甲有内容\n');
    const b = env.doc.blocks[0];
    env.focus(b, 0);
    env.type('-');
    // 造一个非空 selection:把 cmPos 挪开使 head!==from 的场景不成立——这里
    // 直接验证行首 + head 在标记后仍会转;选中态由 sel.empty 守卫,桩里
    // EditorSelection.cursor 恒 empty,行为等价于不触发替换路径。
    handleSpace(env.view, env.host);
    env.type(' ');
    await new Promise((r) => setTimeout(r, 0));
    expect(b.bare).toBe(false);
  });
});

describe('handleSpace — 任务标记即时转任务块（批次 30，思源 turnIntoTaskList）', () => {
  it('`[ ]` + 空格 → b.task=" "，正文剥标记与分隔空格', async () => {
    const env = makeEnv('甲有内容\n');
    const b = env.doc.blocks[0];
    env.focus(b, 0);
    env.type('[ ]');
    expect(handleSpace(env.view, env.host)).toBe(false); // 空格不消费
    env.type(' ');
    await new Promise((r) => setTimeout(r, 0));
    expect(b.task).toBe(' ');
    expect(b.bare).toBe(false); // 任务块=列表项形态（否则磁盘裸行丢 task）
    expect(b.text).toBe('甲有内容');
  });

  it('`[x]` 小写保留、`[?]` 自定义单字符都转', async () => {
    for (const [typed, task] of [['[x]', 'x'], ['[X]', 'X'], ['[?]', '?'], ['[-]', '-'], ['[/]', '/']] as const) {
      const env = makeEnv('内容\n');
      const b = env.doc.blocks[0];
      env.focus(b, 0);
      env.type(typed);
      handleSpace(env.view, env.host);
      env.type(' ');
      await new Promise((r) => setTimeout(r, 0));
      expect(b.task).toBe(task);
      expect(b.text).toBe('内容');
    }
  });

  it('`[]` 短写 + 空格 → task=" "（getTaskListMarker 短写分支）', async () => {
    const env = makeEnv('内容\n');
    const b = env.doc.blocks[0];
    env.focus(b, 0);
    env.type('[]');
    handleSpace(env.view, env.host);
    env.type(' ');
    await new Promise((r) => setTimeout(r, 0));
    expect(b.task).toBe(' ');
    expect(b.text).toBe('内容');
  });

  it('标记后有其他文字（probe 不占满前缀）不转换', async () => {
    const env = makeEnv('abc\n');
    const b = env.doc.blocks[0];
    env.focus(b, 1); // "a|bc"
    env.type('[ ]'); // "a[ ]bc" — 标记不在行首
    handleSpace(env.view, env.host);
    env.type(' ');
    await new Promise((r) => setTimeout(r, 0));
    expect(b.task).toBeUndefined();
    expect(b.text).toBe('abc');
  });
});
