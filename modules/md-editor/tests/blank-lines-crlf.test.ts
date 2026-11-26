/**
 * CRLF 笔记回归（合成夹具：CRLF + 大量空行 + 空列表项 + 嵌套 + 引用）。
 *
 * 用户报的现象：主库里打开笔记，空行完全没有渲染（块挨着块、看不到空行）；
 * 保存后 Gitee diff 里整片红色（空行被吃）。
 *
 * 本用例锁定三件事：
 *  1. 打开→保存逐字节不变（CRLF、空行、行尾空格全部原样）；
 *  2. 空行物化成可见的空段落块（编辑器里一行可点击的空白）；
 *  3. 编辑一个块只改它自己那一行，其余行（含空行）一个字节都不动。
 *
 * 夹具是**合成**的（个人真实笔记不入公开仓），结构与用户报的文件一致。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';
import type { Block } from '../src/types';

const FILE = new URL('./fixtures/blank-lines-crlf.md', import.meta.url);
const MD = readFileSync(FILE, 'utf8');

function flatten(blocks: Block[], out: Block[] = []): Block[] {
  for (const b of blocks) {
    out.push(b);
    flatten(b.children, out);
  }
  return out;
}

describe('CRLF 笔记：空行渲染 + 原文保真', () => {
  it('打开→保存逐字节不变', () => {
    expect(serializeDocument(parseDocument(MD))).toBe(MD);
  });

  it('空行物化成可见的空段落块（每一行都能看到/点到）', () => {
    const doc = parseDocument(MD);
    const blanks = flatten(doc.blocks).filter((b) => b.bare && b.text === '');
    const blankLines = MD.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim() === '').length;
    // 物化块数 = 空行数 − 代码围栏内部的那条空行（是 fence 内容，不是分隔行）
    // − 文件末尾换行（不是一行，与 parser 的 trailingGap 口径一致）。
    expect(blanks.length).toBe(blankLines - 2);
    expect(blanks.every((b) => b.kind === 'list')).toBe(true);
  });

  it('编辑一个块只改它自己那一行', () => {
    const doc = parseDocument(MD);
    const target = flatten(doc.blocks).find((b) => b.text === '独立行甲');
    expect(target).toBeTruthy();
    target!.text = '独立行甲【已编辑】';
    const out = serializeDocument(doc);
    const before = MD.replace(/\r\n/g, '\n').split('\n');
    const after = out.replace(/\r\n/g, '\n').split('\n');
    expect(after.length).toBe(before.length);
    const changed: number[] = [];
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed.push(i + 1);
    expect(changed).toEqual([before.indexOf('独立行甲') + 1]);
  });

  it('CRLF 行尾仍然保留', () => {
    const out = serializeDocument(parseDocument(MD));
    expect(out.includes('\r\n')).toBe(true);
    expect(/(?<!\r)\n/.test(out)).toBe(false);
  });
});
