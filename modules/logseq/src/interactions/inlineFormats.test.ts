// @vitest-environment jsdom
// 批次 28：语法树选区判定（思源 toolbar/inlineFormat.ts 交集正解的 Lezer
// 转译）。核心病例：`**x**` 双亮根治 / 嵌套交集 / 跨边界 / 树解包。
import { describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { EditorState, type Extension } from '@codemirror/state';
import { mathSyntax } from '../editor/mathSyntax';
import { obsidianInlineSyntax } from '../editor/obsidianInlineSyntax';
import {
  formatNodeAt,
  inlineFormatsAcross,
  inlineFormatsIn,
  normalizeMark,
} from './inlineFormats';
import {
  activeMarksAt,
  clearFormatting,
  isWrapped,
  toggleMarkerPairFor,
} from './textSelectionMenu';

const lang: Extension = markdown({
  base: markdownLanguage,
  addKeymap: false,
  extensions: [mathSyntax(), obsidianInlineSyntax()],
});

const mkView = (doc: string): EditorView =>
  new EditorView({ doc, parent: document.body, extensions: [lang] });
const mkState = (doc: string): EditorState => EditorState.create({ doc, extensions: [lang] });
const select = (v: EditorView, from: number, to: number) =>
  v.dispatch({ selection: { anchor: from, head: to } });

describe('inlineFormatsIn 交集判定（思源 getRangeInlineFormats 对应）', () => {
  it('**x** 选 x 只判 bold——hug 双亮根治', () => {
    const st = mkState('**x**');
    expect(inlineFormatsIn(st, 2, 3)).toEqual(['**']);
  });

  it('嵌套：inner 同得 bold 与 italic，tail 只得 bold', () => {
    const st = mkState('**bold *inner* tail**');
    expect(inlineFormatsIn(st, 8, 13)).toEqual(['**', '*']); // inner
    expect(inlineFormatsIn(st, 2, 6)).toEqual(['**']); // bold
    expect(inlineFormatsIn(st, 15, 19)).toEqual(['**']); // tail
  });

  it('跨边界选区（内容 + 普通文本）交集为空', () => {
    const st = mkState('*a* plain');
    // 'a* pl'：段 ' pl' 无格式覆盖 → 空交集
    expect(inlineFormatsIn(st, 1, 7)).toEqual([]);
  });

  it('选中含标记字符的区域仍按覆盖类型判（源码模式选 * 标记）', () => {
    const st = mkState('**x**');
    // 含开标记：段被 StrongEmphasis 覆盖
    expect(inlineFormatsIn(st, 0, 4)).toEqual(['**']);
    // 仅左标记 + 内容：同上
    expect(inlineFormatsIn(st, 1, 3)).toEqual(['**']);
  });

  it('六种语法各自的树节点映射', () => {
    const st = mkState('~~s~~ x `c` x ==h== x %%m%% x $f$');
    expect(inlineFormatsIn(st, 2, 3)).toEqual(['~~']);
    expect(inlineFormatsIn(st, 9, 10)).toEqual(['`']);
    expect(inlineFormatsIn(st, 16, 17)).toEqual(['==']);
    expect(inlineFormatsIn(st, 24, 25)).toEqual(['%%']);
    expect(inlineFormatsIn(st, 31, 32)).toEqual(['$']);
  });

  it('普通文本无任何格式 → 空交集；空段 → undefined', () => {
    const st = mkState('plain **b**');
    expect(inlineFormatsIn(st, 0, 5)).toEqual([]);
    expect(inlineFormatsIn(st, 9, 9)).toBeUndefined();
  });

  it('inlineFormatsAcross 多段交集再交（思源 getRangesInlineFormats）', () => {
    const st = mkState('**a** *b*');
    expect(inlineFormatsAcross(st, [{ from: 2, to: 3 }, { from: 6, to: 7 }])).toEqual([]);
    expect(inlineFormatsAcross(st, [{ from: 2, to: 3 }, { from: 10, to: 11 }])).toEqual(['**']);
  });
});

describe('formatNodeAt 覆盖节点定位（解包用）', () => {
  it('选区在节点内 → 返回覆盖节点；越界选区不命中', () => {
    const st = mkState('**bold *inner* tail**');
    expect(formatNodeAt(st, 8, 13, '**')?.from).toBe(0);
    expect(formatNodeAt(st, 8, 13, '**')?.to).toBe(21);
    expect(formatNodeAt(st, 8, 13, '*')?.from).toBe(7);
    expect(formatNodeAt(st, 8, 13, '*')?.to).toBe(14);
    // 选区越出 Emphasis：italic 不命中（部分覆盖不算）
    expect(formatNodeAt(st, 5, 10, '*')).toBeNull();
  });

  it('空选区：光标在内容/标记内都命中（resolveInner 偏左向上）', () => {
    const st = mkState('**bold** x');
    expect(formatNodeAt(st, 3, 3, '**')?.name).toBe('StrongEmphasis'); // 内容中间
    expect(formatNodeAt(st, 1, 1, '**')?.name).toBe('StrongEmphasis'); // 开标记内
    expect(formatNodeAt(st, 8, 8, '**')?.name).toBe('StrongEmphasis'); // 闭标记内
    expect(formatNodeAt(st, 9, 9, '**')).toBeNull(); // 节点外空格
  });

  it('alt 拼写归一：__ 命中 StrongEmphasis', () => {
    const st = mkState('__u__');
    expect(formatNodeAt(st, 2, 3, '__')?.name).toBe('StrongEmphasis');
    expect(formatNodeAt(st, 2, 3, '**')?.name).toBe('StrongEmphasis');
    expect(normalizeMark('__')).toBe('**');
    expect(normalizeMark('_')).toBe('*');
  });
});

describe('activeMarksAt / isWrapped（树口径统一）', () => {
  it('**x** 选 x：只亮 bold', () => {
    const v = mkView('**x**');
    select(v, 2, 3);
    expect(activeMarksAt(v)).toEqual(['**']);
    expect(isWrapped(v, '**')).toBe(true);
    expect(isWrapped(v, '*')).toBe(false);
  });

  it('嵌套选 inner：bold 与 italic 同亮', () => {
    const v = mkView('**bold *inner* tail**');
    select(v, 8, 13);
    expect(activeMarksAt(v)).toEqual(['**', '*']);
  });

  it('空选区 word 探测：光标在格式词内照样亮', () => {
    const v = mkView('**bold** x');
    select(v, 5, 5); // bold 中间
    expect(activeMarksAt(v)).toEqual(['**']);
    select(v, 9, 9); // 空格处无词
    expect(activeMarksAt(v)).toEqual([]);
  });

  it('空选区无词但光标在格式标记内：光标点判定命中', () => {
    const v = mkView('**x**');
    select(v, 2, 2); // ** 与 x 之间
    expect(activeMarksAt(v)).toEqual(['**']);
  });

  it('六语法按钮态全绿', () => {
    const v = mkView('~~s~~ `c` ==h== %%m%% $f$');
    select(v, 2, 3);
    expect(activeMarksAt(v)).toEqual(['~~']);
    select(v, 6, 7);
    expect(activeMarksAt(v)).toEqual(['`']);
    select(v, 12, 13);
    expect(activeMarksAt(v)).toEqual(['==']);
    select(v, 18, 19);
    expect(activeMarksAt(v)).toEqual(['%%']);
    select(v, 24, 25);
    expect(activeMarksAt(v)).toEqual(['$']);
  });
});

describe('toggleMarkerPairFor 树解包', () => {
  it('嵌套选 inner 点 bold：解包整个 StrongEmphasis（原生语义）', () => {
    const v = mkView('**bold *inner* tail**');
    select(v, 8, 13); // inner
    toggleMarkerPairFor(v, '**');
    expect(v.state.doc.toString()).toBe('bold *inner* tail');
    // 选区随 changes 自动映射回 inner 内容
    expect(v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to)).toBe('inner');
  });

  it('嵌套选 inner 点 italic：解包 Emphasis 保留 bold', () => {
    const v = mkView('**bold *inner* tail**');
    select(v, 8, 13);
    toggleMarkerPairFor(v, '*', '_');
    expect(v.state.doc.toString()).toBe('**bold inner tail**');
  });

  it('光标在格式词内（无选区）点 bold：解包整个格式', () => {
    const v = mkView('pre **bold** post');
    select(v, 8, 8); // bold 中间
    toggleMarkerPairFor(v, '**');
    expect(v.state.doc.toString()).toBe('pre bold post');
  });

  it('__ 包裹经 alt 解包', () => {
    const v = mkView('__u__');
    select(v, 2, 3);
    toggleMarkerPairFor(v, '**', '__');
    expect(v.state.doc.toString()).toBe('u');
  });

  it('无格式选区照常包裹（wrap 分支行为不变）', () => {
    const v = mkView('hello world');
    select(v, 6, 11);
    toggleMarkerPairFor(v, '**');
    expect(v.state.doc.toString()).toBe('hello **world**');
  });

  it('选区越出节点不误解包（交集空走包裹分支，原格式保留）', () => {
    const v = mkView('**b** plain');
    select(v, 4, 9); // '* pla' —— 越出 StrongEmphasis[0,4]
    toggleMarkerPairFor(v, '**');
    expect(v.state.doc.toString().startsWith('**b**')).toBe(true); // 原 bold 未被解包
  });

  it('Math $ 解包', () => {
    const v = mkView('$f$ tail');
    select(v, 1, 2);
    toggleMarkerPairFor(v, '$');
    expect(v.state.doc.toString()).toBe('f tail');
  });
});

describe('clearFormatting 树清理', () => {
  it('选区内嵌套格式全部剥净', () => {
    const v = mkView('**bold *inner* tail**');
    select(v, 8, 13); // inner
    clearFormatting(v);
    expect(v.state.doc.toString()).toBe('bold inner tail');
  });

  it('紧贴选区的格式也剥净（原 hug 循环场景）', () => {
    const v = mkView('**whole**');
    select(v, 2, 7);
    clearFormatting(v);
    expect(v.state.doc.toString()).toBe('whole');
  });

  it('无格式选区原样保留', () => {
    const v = mkView('plain text');
    select(v, 0, 5);
    clearFormatting(v);
    expect(v.state.doc.toString()).toBe('plain text');
  });
});
