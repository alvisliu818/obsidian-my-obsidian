// @vitest-environment jsdom
// 格式刷:取色(按钮态同口径)/once 应用即退/continuous 连续/Esc 退出/
// 清除后重放(目标多余格式被刷掉)。
import { describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import {
  activatePainter,
  applyPainter,
  deactivatePainter,
  isFormatPainterActive,
  showFormatToolbar,
  takePainterSnapshot,
} from './formatToolbar';

function mkView(doc: string): EditorView {
  return new EditorView({ doc, parent: document.body });
}
const select = (v: EditorView, from: number, to: number) =>
  v.dispatch({ selection: { anchor: from, head: to } });

describe('格式刷(formatToolbar 格式刷流程)', () => {
  it('取色:选区上的标记集(hug 口径,与按钮态一致)', () => {
    const v = mkView('~~s~~ t');
    select(v, 2, 3); // 's'
    expect(takePainterSnapshot(v)).toEqual(['~~']);
  });

  it('once 应用即退:目标拿到快照格式', () => {
    const v = mkView('~~s~~ t');
    select(v, 2, 3); // 取色 's'
    activatePainter(v, false);
    expect(isFormatPainterActive()).toBe(true);
    select(v, 6, 7); // 目标 't'
    showFormatToolbar(v, false); // mouseup 触发入口
    expect(v.state.doc.toString()).toBe('~~s~~ ~~t~~');
    expect(isFormatPainterActive()).toBe(false); // once 应用即退
  });

  it('清除后重放:目标的多余格式被刷掉', () => {
    const v = mkView('~~s~~ **t**');
    select(v, 2, 3); // 取色 's'(快照 ~~)
    activatePainter(v, false);
    select(v, 8, 9); // 目标 't'(带 ** 包裹)
    showFormatToolbar(v, false);
    expect(v.state.doc.toString()).toBe('~~s~~ ~~t~~');
  });

  it('continuous 连续:应用后仍激活,可再次应用,显式退出', () => {
    const v = mkView('~~s~~ t u');
    select(v, 2, 3);
    activatePainter(v, true);
    select(v, 6, 7); // 't'
    showFormatToolbar(v, false);
    expect(v.state.doc.toString()).toBe('~~s~~ ~~t~~ u');
    expect(isFormatPainterActive()).toBe(true);
    select(v, 12, 13); // 'u'(首轮应用后偏移后移)
    showFormatToolbar(v, false);
    expect(v.state.doc.toString()).toBe('~~s~~ ~~t~~ ~~u~~');
    expect(isFormatPainterActive()).toBe(true);
    deactivatePainter();
    expect(isFormatPainterActive()).toBe(false);
  });

  it('Esc 退出连续模式', () => {
    const v = mkView('~~s~~ t');
    select(v, 2, 3);
    activatePainter(v, true);
    expect(isFormatPainterActive()).toBe(true);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(isFormatPainterActive()).toBe(false);
  });

  it('空快照也激活(思源语义:无格式 = 刷「清除」)', () => {
    const v = mkView('plain t');
    select(v, 0, 5); // 'plain' 无任何包裹
    activatePainter(v, false);
    expect(isFormatPainterActive()).toBe(true);
    select(v, 6, 7); // 't'
    showFormatToolbar(v, false);
    expect(v.state.doc.toString()).toBe('plain t'); // 清除后无类型重放 = 原样
    expect(isFormatPainterActive()).toBe(false);
  });

  it('applyPainter 直接调用:指定类型集重放', () => {
    const v = mkView('**b** t');
    select(v, 6, 7);
    applyPainter(v, ['**']);
    expect(v.state.doc.toString()).toBe('**b** **t**');
  });
});
