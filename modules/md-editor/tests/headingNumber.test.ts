/**
 * 标题编号测试（批次 24）：思源 kernel/model/heading_number.go 算法用例转译
 * （计数/格式化/超界回落）+ 我们侧收集语义（list 首行/raw 顶层/嵌套参与/
 * quote·fence·marker 不参与）。
 */
import { describe, expect, it } from 'vitest';
import {
  buildHeadingNumbers,
  collectHeadings,
  formatHeadingCounter,
  formatHeadingNumber,
  headingNumberNeedsSpacing,
  headingNumberPresetByID,
} from '../src/core/headingNumber';
import { createBlock, type Block } from '../src/types';

const b = (text: string, ...children: Block[]): Block => {
  const blk = createBlock(text);
  blk.children = children;
  return blk;
};
const heading = (level: number, ...children: Block[]): Block =>
  b('#'.repeat(level) + ' h', ...children);

describe('formatHeadingCounter (Go formatHeadingCounter 1:1)', () => {
  it('decimal', () => {
    expect(formatHeadingCounter(7, 'decimal')).toBe('7');
  });
  it('alphabetic is bijective base-N (1=A 26=Z 27=AA)', () => {
    expect(formatHeadingCounter(1, 'upper-alpha')).toBe('A');
    expect(formatHeadingCounter(26, 'upper-alpha')).toBe('Z');
    expect(formatHeadingCounter(27, 'upper-alpha')).toBe('AA');
    expect(formatHeadingCounter(52, 'upper-alpha')).toBe('AZ');
    expect(formatHeadingCounter(1, 'lower-alpha')).toBe('a');
  });
  it('roman within 3999, out of range falls back to decimal', () => {
    expect(formatHeadingCounter(1, 'upper-roman')).toBe('I');
    expect(formatHeadingCounter(4, 'upper-roman')).toBe('IV');
    expect(formatHeadingCounter(9, 'upper-roman')).toBe('IX');
    expect(formatHeadingCounter(14, 'upper-roman')).toBe('XIV');
    expect(formatHeadingCounter(40, 'upper-roman')).toBe('XL');
    expect(formatHeadingCounter(90, 'upper-roman')).toBe('XC');
    expect(formatHeadingCounter(400, 'upper-roman')).toBe('CD');
    expect(formatHeadingCounter(1994, 'upper-roman')).toBe('MCMXCIV');
    expect(formatHeadingCounter(3999, 'upper-roman')).toBe('MMMCMXCIX');
    expect(formatHeadingCounter(4000, 'upper-roman')).toBe('4000');
    expect(formatHeadingCounter(0, 'upper-roman')).toBe('0');
    expect(formatHeadingCounter(14, 'lower-roman')).toBe('xiv');
  });
  it('greek alphabets', () => {
    expect(formatHeadingCounter(1, 'upper-greek')).toBe('Α');
    expect(formatHeadingCounter(24, 'upper-greek')).toBe('Ω');
    expect(formatHeadingCounter(25, 'upper-greek')).toBe('ΑΑ');
    expect(formatHeadingCounter(27, 'upper-greek')).toBe('ΑΓ');
    expect(formatHeadingCounter(1, 'lower-greek')).toBe('α');
  });
  it('chinese numbers (Go chineseNumber)', () => {
    expect(formatHeadingCounter(1, 'chinese')).toBe('一');
    expect(formatHeadingCounter(9, 'chinese')).toBe('九');
    expect(formatHeadingCounter(10, 'chinese')).toBe('十');
    expect(formatHeadingCounter(11, 'chinese')).toBe('十一');
    expect(formatHeadingCounter(20, 'chinese')).toBe('二十');
    expect(formatHeadingCounter(21, 'chinese')).toBe('二十一');
    expect(formatHeadingCounter(100, 'chinese')).toBe('一百');
    expect(formatHeadingCounter(110, 'chinese')).toBe('一百一十');
    expect(formatHeadingCounter(200, 'chinese')).toBe('二百');
    expect(formatHeadingCounter(1000, 'chinese')).toBe('一千');
    expect(formatHeadingCounter(1100, 'chinese')).toBe('一千一百');
    expect(formatHeadingCounter(10000, 'chinese')).toBe('一万');
    expect(formatHeadingCounter(10001, 'chinese')).toBe('一万零一');
    expect(formatHeadingCounter(10010, 'chinese')).toBe('一万零一十');
    expect(formatHeadingCounter(11000, 'chinese')).toBe('一万一千');
    expect(formatHeadingCounter(12345, 'chinese')).toBe('一万二千三百四十五');
    expect(formatHeadingCounter(100000, 'chinese')).toBe('十万');
    expect(formatHeadingCounter(123456, 'chinese')).toBe('十二万三千四百五十六');
    expect(formatHeadingCounter(0, 'chinese')).toBe('0');
  });
  it('circled 1..20, out of range falls back to decimal', () => {
    expect(formatHeadingCounter(1, 'circled')).toBe('①');
    expect(formatHeadingCounter(20, 'circled')).toBe('⑳');
    expect(formatHeadingCounter(21, 'circled')).toBe('21');
    expect(formatHeadingCounter(0, 'circled')).toBe('0');
  });
});

describe('formatHeadingNumber (Go formatHeadingNumber 1:1)', () => {
  it('hierarchical decimal template by depth', () => {
    const preset = headingNumberPresetByID('decimal-hierarchical');
    expect(formatHeadingNumber([1], preset)).toBe('1');
    expect(formatHeadingNumber([1, 2, 3], preset)).toBe('1.2.3');
  });
  it('chinese-document preset mixes styles per level', () => {
    const preset = headingNumberPresetByID('chinese-document');
    expect(formatHeadingNumber([1], preset)).toBe('一、');
    expect(formatHeadingNumber([1, 2], preset)).toBe('（二）');
    expect(formatHeadingNumber([1, 1, 1], preset)).toBe('1.');
    // Go 语义：按层深取**单个**模板（depth=5 → '{6}.'，只含 {6}）——中文档每层
    // 只显示当层编号（一、→（一）→ 1.），不累积前几层；hierarchical 模板才累积。
    expect(formatHeadingNumber([2, 1, 3, 1, 5, 2], preset)).toBe('B.');
  });
  it('decimal-parenthesized', () => {
    const preset = headingNumberPresetByID('decimal-parenthesized');
    expect(formatHeadingNumber([2], preset)).toBe('2）');
  });
  it('deeper than templates falls back to joined decimals', () => {
    const preset = headingNumberPresetByID('decimal-hierarchical');
    expect(formatHeadingNumber([1, 1, 1, 1, 1, 1, 1], preset)).toBe('1.1.1.1.1.1.1');
  });
  it('empty path is empty', () => {
    expect(formatHeadingNumber([], headingNumberPresetByID('decimal-hierarchical'))).toBe('');
  });
});

describe('collectHeadings (我们侧收集语义)', () => {
  it('list first-line headings and raw top-level headings both count', () => {
    // 块 text 是 parser 剥掉 `- ` 前缀后的内容；marker 参数是 Logseq marker。
    const todo = createBlock('marker task', 'TODO');
    const roots = [b('# one'), b('plain text'), b('# raw heading'), b('> quote'), b('```\ncode\n```'), todo];
    const got = collectHeadings(roots);
    expect(got.map((h) => h.level)).toEqual([1, 1]);
  });
  it('nested list children participate (SiYuan ListItem not excluded)', () => {
    const roots = [b('top text', heading(1), heading(2))];
    expect(collectHeadings(roots).map((h) => h.level)).toEqual([1, 2]);
  });
  it('continuation lines and markers are not headings', () => {
    const roots = [b('- text\n## not a heading (continuation)'), b('- TODO # tagged')];
    expect(collectHeadings(roots)).toEqual([]);
  });
});

describe('buildHeadingNumbers (Go buildHeadingNumberEntries 1:1)', () => {
  it('stack counters: deeper resets, shallower truncates', () => {
    const roots = [heading(1), heading(2), heading(2), heading(1), heading(2), heading(3)];
    const m = buildHeadingNumbers(roots, 'decimal-hierarchical');
    expect([...m.values()]).toEqual(['1', '1.1', '1.2', '2', '2.1', '2.1.1']);
  });
  it('popping to shallower level truncates counters', () => {
    const roots = [heading(1), heading(2), heading(3), heading(2), heading(1)];
    const m = buildHeadingNumbers(roots, 'decimal-hierarchical');
    expect([...m.values()]).toEqual(['1', '1.1', '1.1.1', '1.2', '2']);
  });
  it('mixed kinds in document order', () => {
    const roots = [heading(1), b('paragraph'), b('# raw'), heading(2)];
    const m = buildHeadingNumbers(roots, 'chinese-document');
    expect([...m.values()]).toEqual(['一、', '二、', '（一）']);
  });
  it('no headings → empty map', () => {
    expect(buildHeadingNumbers([b('text'), b('- item')], 'decimal-hierarchical').size).toBe(0);
  });
});

describe('headingNumberNeedsSpacing (思源 headingNumberNeedsSpacing 1:1)', () => {
  it('full-width punctuation endings carry their own spacing', () => {
    expect(headingNumberNeedsSpacing('一、')).toBe(false);
    expect(headingNumberNeedsSpacing('（一）')).toBe(false);
    expect(headingNumberNeedsSpacing('1）')).toBe(false);
    expect(headingNumberNeedsSpacing('1.2.3')).toBe(true);
    expect(headingNumberNeedsSpacing('1.')).toBe(true);
    expect(headingNumberNeedsSpacing('①')).toBe(true);
  });
});
