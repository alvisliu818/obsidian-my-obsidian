/**
 * 原文保真：空行（2026-11-25）。
 *
 * 用户报的 diff：md editor 打开并保存后，文件里**块与块之间的空行**整片消失
 * （Gitee diff 一片红全是空行），空列表项本身也被连带挤掉。根因是序列化器
 * 从块树重建文件时只保留「块自己的行」，空行不属于任何块、直接丢弃。
 *
 * 实现：parser 把块前空行记到「下一块」的 `srcGap`、文件末尾空行记到
 * `trailingGap`；序列化时原样拼回。另加整树签名总闸：整篇未编辑 → 原文直出。
 */
import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';

const rt = (md: string): string => serializeDocument(parseDocument(md));

describe('块间空行逐字节保留', () => {
  it('列表块之间的单个空行', () => {
    expect(rt('- a\n\n- b\n')).toBe('- a\n\n- b\n');
  });

  it('连续多个空行', () => {
    expect(rt('- a\n\n\n\n- b\n')).toBe('- a\n\n\n\n- b\n');
  });

  it('只有空格的分隔行', () => {
    expect(rt('- a\n   \n- b\n')).toBe('- a\n   \n- b\n');
  });

  it('嵌套块之间的空行', () => {
    expect(rt('- a\n\t- b\n\n\t- c\n- d\n')).toBe('- a\n\t- b\n\n\t- c\n- d\n');
  });

  it('空列表项与空行混排（用户 diff 的形态）', () => {
    const md = ['- a', '-', '- b', '-', '', '- c', '', '', '- d', ''].join('\n');
    expect(rt(md)).toBe(md);
  });

  it('文件末尾的空行', () => {
    expect(rt('- a\n\n')).toBe('- a\n\n');
    expect(rt('- a')).toBe('- a');
  });

  it('raw 块（标题/fence/引用/数学）之间的空行', () => {
    const md = ['# 标题', '', '```js', 'const a = 1;', '```', '', '> 引用', '', '> 引用2', ''].join('\n');
    expect(rt(md)).toBe(md);
  });

  it('页属性块后的空行', () => {
    expect(rt('title:: My Page\ntags:: a, b\n\n- block')).toBe('title:: My Page\ntags:: a, b\n\n- block');
  });

  it('frontmatter 后的空行', () => {
    expect(rt('---\ntitle: x\n---\n\n- block')).toBe('---\ntitle: x\n---\n\n- block');
  });

  it('CRLF 文件的空行与行尾', () => {
    expect(rt('- a\r\n\r\n- b\r\n')).toBe('- a\r\n\r\n- b\r\n');
  });
});

describe('编辑局部性：只改真实编辑的行', () => {
  const md = [
    '- 2026年11月11日',
    '\t- 总结上一个模块',
    '\t- 7个节点',
    '',
    '- mongo索引得包含第一个字段',
    '- mongo的id是_id',
    '- 4遍',
    '-',
    '- 一周要有一天 补觉',
    '-',
    '- 意图识别',
    '',
    '# 标题',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
  ].join('\n');

  it('编辑一个块，空行/空列表项/代码块全部原样', () => {
    const doc = parseDocument(md);
    const target = doc.blocks.flatMap(function walk(b): typeof b[] {
      return [b, ...b.children.flatMap(walk)];
    }).find((b) => b.text === '4遍');
    expect(target).toBeTruthy();
    target!.text = '4遍【已编辑】';
    const after = serializeDocument(doc).split('\n');
    const before = md.split('\n');
    expect(after.length).toBe(before.length);
    const changed: number[] = [];
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) changed.push(i + 1);
    expect(changed).toEqual([7]);
  });

  it('新增块不引入额外空行', () => {
    const doc = parseDocument(md);
    doc.blocks.push({ kind: 'list', marker: null, text: '新块', props: {}, children: [], parent: null });
    // 文件末尾的空行已经物化成可见空段落块——新块排在它**后面**（原生语义：
    // 光标在文档末尾，新内容写在最后的空行之后）。
    expect(serializeDocument(doc)).toBe(md + '- 新块\n');
  });
});
