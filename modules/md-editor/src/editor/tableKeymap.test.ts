/**
 * cm6-table 移植测试（纯函数：cellRanges/tableAt + 编辑命令经真 EditorView）。
 * jsdom 环境（EditorView 需要 DOM 挂载点），tablePaste.test.ts 同款。
 * @vitest-environment jsdom
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import {
  cellRanges,
  cellSourcePos,
  tableAt,
  tableTabCommand,
  tableInsertCommand,
  tableFormatCommand,
  cm6TableKeymap,
} from './tableKeymap';

beforeAll(() => {
  const proto = Object.getPrototypeOf(document.createRange()) as any;
  if (!proto.getClientRects) {
    proto.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} });
    proto.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) });
  }
});

const TBL = ['| 名 | 值 |', '| --- | :-: |', '| a | 1 |', '| b | 2 |'].join('\n');

function mount(doc: string): EditorView {
  return new EditorView({
    doc,
    extensions: [cm6TableKeymap()],
    parent: document.createElement('div'),
  });
}

describe('cellRanges', () => {
  it('基本分隔与 trim 区间', () => {
    const cells = cellRanges('| a | bb |');
    expect(cells).toHaveLength(2);
    expect(cells![0].text).toBe('a');
    expect(cells![1].text).toBe('bb');
  });

  it('转义管道与行内码不是分隔符', () => {
    const cells = cellRanges('| a\\|b | `x|y` |');
    expect(cells).toHaveLength(2);
    expect(cells![0].text).toBe('a\\|b');
    expect(cells![1].text).toBe('`x|y`');
  });

  it('分隔管道不足两对 → null', () => {
    expect(cellRanges('| 只有一根')).toBeNull();
  });
});

describe('tableAt', () => {
  it('定位顶层表格块（首行 0 缩进）', () => {
    const state = EditorState.create({ doc: 'before\n' + TBL + '\nafter' });
    const tb = tableAt(state, 10);
    expect(tb).not.toBeNull();
    expect(tb!.fromLine).toBe(2);
    expect(tb!.toLine).toBe(5);
  });

  it('缩进表格不接管', () => {
    const indented = TBL.split('\n').map((l) => '  ' + l).join('\n');
    const state = EditorState.create({ doc: indented });
    expect(tableAt(state, 10)).toBeNull();
  });
});

describe('cellSourcePos', () => {
  it('按逻辑行列给出单元格内容起点（跳过分隔行）', () => {
    const state = EditorState.create({ doc: TBL });
    const tb = tableAt(state, 0)!;
    const p = cellSourcePos(state, tb, 1, 0);
    expect(state.doc.sliceString(p, p + 1)).toBe('a');
  });
});

describe('编辑命令（真 EditorView + cm6TableKeymap）', () => {
  it('Tab 在单元格间移动', () => {
    const view = mount(TBL);
    const tb = tableAt(view.state, 0)!;
    const anchor = cellSourcePos(view.state, tb, 0, 0);
    view.dispatch({ selection: EditorSelection.cursor(anchor) });
    expect(tableTabCommand(view)).toBe(true);
    const head2 = cellSourcePos(view.state, tableAt(view.state, 0)!, 0, 1);
    expect(view.state.selection.main.head).toBe(head2);
  });

  it('表格外 Tab 穿透（返回 false）', () => {
    const view = mount('not a table\nsecond');
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(tableTabCommand(view)).toBe(false);
  });

  it('tableInsertCommand 插入骨架', () => {
    const view = mount('abc');
    view.dispatch({ selection: EditorSelection.cursor(3) });
    expect(tableInsertCommand(view)).toBe(true);
    expect(view.state.doc.toString()).toContain('| 列 1 | 列 2 | 列 3 |');
  });

  it('tableFormatCommand 按列宽对齐重排', () => {
    const view = mount('| 名 | 值 |\n| - | - |\n| abc | 1 |');
    view.dispatch({ selection: EditorSelection.cursor(0) });
    expect(tableFormatCommand(view)).toBe(true);
    const out = view.state.doc.toString();
    expect(out).toContain('abc');
    expect(out).toMatch(/| abc/);
  });
});
