/**
 * 原文保真回归测试(2026-11-25)。
 *
 * 用户诉求：md editor 保存时「不要自动去 -、不要自动删空格，真实修改了什么
 * 就修改什么」。此前保存按块模型重写全文，把 `\t  collapsed::` 规范成
 * `\t\t`、把空列表项 `-` 补成 `- `——用户没碰的行被改写。
 *
 * 实现：parser 给每个块记录原文行(srcLines)+语义快照(srcSig)；未编辑块
 * 序列化时直接吐原文行，编辑过的块才走规范化。
 */
import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';

describe('原文保真：未编辑块逐字节保留', () => {
  it('混合缩进的 props 行与空列表项往返字节一致', () => {
    // \t + 2 空格的 props 缩进、无尾空格的空列表项 -、行尾空格，
    // 都是用户写下的原文，往返必须原样保留。
    const md = [
      '- 节点',
      '\t  collapsed:: true',
      '\t  id:: 1234',
      '\t- 子项',
      '-',                       // 空列表项（无尾空格）
      '-  带额外空格的文本',      // 标记后多空格属内容
      '- 尾部有空格  ',
      '',
    ].join('\n');
    expect(serializeDocument(parseDocument(md))).toBe(md);
  });

  it('CRLF 文件往返保留行尾与 CRLF', () => {
    const md = '- A\r\n\t  collapsed:: true\r\n- B\r\n';
    expect(serializeDocument(parseDocument(md))).toBe(md);
  });

  it('deep fence 的空格缩进原样保留，不规范化', () => {
    const md = [
      '- title',
      '  - chapter',
      '    - section',
      '      - training',
      '        - init weights',
      '        ```python',
      '        def train(): pass',
      '        ```',
    ].join('\n');
    expect(serializeDocument(parseDocument(md))).toBe(md);
  });

  it('只编辑一个块，其他块原文逐字节不变', () => {
    const md = [
      '- 节点',
      '\t  collapsed:: true',
      '\t- 子项 A',
      '- 子项 B',
      '\t  id:: keep-me',
      '-',
    ].join('\n');
    const doc = parseDocument(md);
    const target = doc.blocks[0].children[0]; // 子项 A
    target.text = target.text + '【已编辑】';
    const out = serializeDocument(doc);
    const before = md.split('\n');
    const after = out.split('\n');
    const changed: number[] = [];
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      if (before[i] !== after[i]) changed.push(i + 1);
    }
    // 只有子项 A 那一行变，props/id/空列表项等原文都不动
    expect(changed).toEqual([3]);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]); // \t  + 2 空格的 props 保留
    expect(after[4]).toBe(before[4]); // id props 保留
    expect(after[5]).toBe(before[5]); // 空列表项 - 保留
  });

  it('未编辑原文直出；编辑过语义决策的块才规范化（保真不能破坏语义）', () => {
    // 整篇未编辑 → 原文直出（打开即保存零 diff）。
    expect(serializeDocument(parseDocument('TODO buy milk\n'))).toBe('TODO buy milk\n');
    expect(serializeDocument(parseDocument('- []todo\n'))).toBe('- []todo\n');
    // 编辑了该块 → parser 的语义归一化必须写回，否则重解析丢语义。
    const a = parseDocument('TODO buy milk\n');
    a.blocks[0].text = 'buy milk!';
    expect(serializeDocument(a)).toBe('- TODO buy milk!\n');
    const b = parseDocument('- []todo\n');
    b.blocks[0].text = 'todo!';
    expect(serializeDocument(b)).toBe('- [ ] todo!\n');
  });
});
