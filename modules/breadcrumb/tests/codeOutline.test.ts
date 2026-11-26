/**
 * 代码文件面包屑的缩进大纲：纯函数单测。
 *
 * 行为契约（与 md 标题面包屑对齐）：
 * - 块头 = 以 `:` 或 `{` 结尾的非空行；只有块头进面包屑；
 * - 缩进决定父子；同级/更浅的行把更深的块弹出；
 * - 每一行的链 = 该行处的「块头栈」（块头行含自身）；
 * - 空行沿用上一行的链，不会把路径断掉；
 * - 多行函数调用（`(` 结尾）不算块头——不为普通调用画一层。
 */

import { describe, expect, it } from 'vitest';
import { buildCodeOutline, indentWidth, isCodeBlockHeader } from '../src/codeOutline';

describe('indentWidth', () => {
  it('counts spaces as one column and tabs as four', () => {
    expect(indentWidth('')).toBe(0);
    expect(indentWidth('    x')).toBe(4);
    expect(indentWidth('\tx')).toBe(4);
    expect(indentWidth('\t  x')).toBe(6);
    expect(indentWidth('  \t\tx')).toBe(10);
  });

  it('stops at the first non-whitespace character', () => {
    expect(indentWidth('  x    y')).toBe(2);
  });
});

describe('isCodeBlockHeader', () => {
  it('accepts Python / YAML / Ruby block headers', () => {
    expect(isCodeBlockHeader('def foo():')).toBe(true);
    expect(isCodeBlockHeader('for i in range(3):')).toBe(true);
    expect(isCodeBlockHeader('key:')).toBe(true);
    expect(isCodeBlockHeader('  if x:  ')).toBe(true);
  });

  it('accepts JS / TS / Java / C block headers', () => {
    expect(isCodeBlockHeader('function foo() {')).toBe(true);
    expect(isCodeBlockHeader('  if (x) {')).toBe(true);
    expect(isCodeBlockHeader('class A {')).toBe(true);
  });

  it('rejects statements and multi-line call openings', () => {
    expect(isCodeBlockHeader('x = 1')).toBe(false);
    expect(isCodeBlockHeader('result = fn(')).toBe(false);
    expect(isCodeBlockHeader('items = [')).toBe(false);
    expect(isCodeBlockHeader('   ')).toBe(false);
  });
});

describe('buildCodeOutline — Python', () => {
  const lines = [
    'def foo():',
    '    x = 1',
    '    for i in range(3):',
    '        if x:',
    '            print(i)',
    'y = 2',
  ];

  it('chains the enclosing headers for a nested line', () => {
    const outline = buildCodeOutline(lines);
    const chain = outline.chainAt.get(5) ?? [];
    expect(chain.map((n) => n.line)).toEqual([1, 3, 4]);
    expect(chain.map((n) => n.text)).toEqual(['def foo():', 'for i in range(3):', 'if x:']);
  });

  it('includes a header line itself, and stops at the same indent', () => {
    const outline = buildCodeOutline(lines);
    expect((outline.chainAt.get(1) ?? []).map((n) => n.line)).toEqual([1]);
    expect((outline.chainAt.get(2) ?? []).map((n) => n.line)).toEqual([1]);
    expect((outline.chainAt.get(3) ?? []).map((n) => n.line)).toEqual([1, 3]);
    // 顶层语句：前面的 def 已经出栈
    expect(outline.chainAt.get(6) ?? []).toEqual([]);
  });

  it('builds child links for the next-level menu', () => {
    const outline = buildCodeOutline(lines);
    expect(outline.roots.map((n) => n.line)).toEqual([1]);
    expect(outline.roots[0].children.map((n) => n.line)).toEqual([3]);
    expect(outline.roots[0].children[0].children.map((n) => n.line)).toEqual([4]);
    expect(outline.roots[0].children[0].children[0].children).toEqual([]);
  });

  it('keeps the chain across blank lines', () => {
    const outline = buildCodeOutline(['def foo():', '    x = 1', '', '    print(x)']);
    expect((outline.chainAt.get(3) ?? []).map((n) => n.line)).toEqual([1]);
    expect((outline.chainAt.get(4) ?? []).map((n) => n.line)).toEqual([1]);
  });

  it('does not draw a level for multi-line call arguments', () => {
    const outline = buildCodeOutline(['result = fn(', '    a,', '    b,', ')', 'next_line = 1']);
    expect(outline.roots).toEqual([]);
    expect(outline.chainAt.get(2) ?? []).toEqual([]);
    expect(outline.chainAt.get(5) ?? []).toEqual([]);
  });

  it('handles tabs as four columns', () => {
    const outline = buildCodeOutline(['def foo():', '\tif x:', '\t\tprint(1)']);
    expect((outline.chainAt.get(3) ?? []).map((n) => n.line)).toEqual([1, 2]);
  });
});

describe('buildCodeOutline — JS braces', () => {
  const lines = ['function outer() {', '  if (a) {', '    inner();', '  }', '}'];

  it('chains braces blocks and pops on closing braces', () => {
    const outline = buildCodeOutline(lines);
    expect((outline.chainAt.get(3) ?? []).map((n) => n.line)).toEqual([1, 2]);
    // 闭合括号不是块头；它属于外层块（内层已按缩进弹出）
    expect((outline.chainAt.get(4) ?? []).map((n) => n.line)).toEqual([1]);
    expect(outline.chainAt.get(5) ?? []).toEqual([]);
  });
});
