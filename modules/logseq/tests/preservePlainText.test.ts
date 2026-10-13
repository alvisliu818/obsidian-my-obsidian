import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';

/**
 * 保真模式（`preservePlainText`）：普通 Markdown 打开后不应被转成大纲列表——
 * 逐字块路径要求 serialize(parse(x)) 字节不变。
 */
const P = { preservePlainText: true };

const roundTrip = (md: string): string => serializeDocument(parseDocument(md, P));

describe('保真模式：普通 Markdown 不转大纲', () => {
  it('纯段落文件打开再保存字节不变', () => {
    const md = ['第一段第一行', '第一段第二行', '', '第二段', ''].join('\n');
    expect(roundTrip(md)).toBe(md);
    // 不得出现任何 `- ` 列表标记
    expect(roundTrip(md)).not.toMatch(/^- /m);
  });

  it('段落 + 标题 + 代码围栏混合文件字节不变', () => {
    const md = [
      '## 12.1 深拷贝和浅拷贝',
      '',
      '这是普通段落，不应该被加上项目符号。',
      '第二行继续。',
      '## 12.3 命名空间和作用域',
      '',
      '```python',
      'a = [1, 2]',
      'b = a',
      '```',
      '',
    ].join('\n');
    expect(roundTrip(md)).toBe(md);
  });

  it('段落里不产生 list 块（逐字块，无 bullet）', () => {
    const doc = parseDocument('普通一行\n接着一行\n', P);
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe('raw');
    expect(doc.blocks[0].text).toBe('普通一行\n接着一行');
  });

  it('已是 Logseq 大纲的文件照旧解析为 list 块', () => {
    const doc = parseDocument('- 一级\n\t- 二级\n', P);
    expect(doc.blocks[0].kind).toBe('list');
    expect(doc.blocks[0].children).toHaveLength(1);
    expect(serializeDocument(doc)).toBe('- 一级\n\t- 二级\n');
  });

  it('裸行 + 大纲混合：大纲部分保持可嵌套', () => {
    const md = ['前言段落', '', '- 项目一', '- 项目二', ''].join('\n');
    expect(roundTrip(md)).toBe(md);
  });

  it('表格 / 引用 / 内联 HTML 混合文件字节不变', () => {
    const md = [
      '说明段落。',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '> 引用一行',
      '',
      '<img src="x.png"',
      '  style="width: 10px">',
      '',
    ].join('\n');
    expect(roundTrip(md)).toBe(md);
  });

  it('连续空行与文首空行不产生多余空行', () => {
    const md = ['# 标题', '', '', '正文', ''].join('\n');
    expect(roundTrip(md)).toBe(md);
  });

  it('空行分隔的段落各自成块（可单独多选/折叠/转换）', () => {
    const doc = parseDocument('第一段。\n\n第二段。\n\n第三段。\n', P);
    expect(doc.blocks).toHaveLength(3);
    expect(doc.blocks.every((b) => b.kind === 'raw')).toBe(true);
    expect(doc.blocks.map((b) => b.text)).toEqual(['第一段。', '第二段。', '第三段。']);
    // 块间空行以 blankBefore 计数保留，字节仍然不变
    expect(doc.blocks[1].blankBefore).toBe(1);
    expect(serializeDocument(doc)).toBe('第一段。\n\n第二段。\n\n第三段。\n');
  });

  it('连续空行原样保留（不收敛成一个）', () => {
    const md = ['# 标题', '', '', '正文', ''].join('\n');
    expect(roundTrip(md)).toBe(md);
  });

  it('关闭开关时维持 Logseq 原生语义（裸行收编为 - 项）', () => {
    const doc = parseDocument('裸行\n', {});
    expect(doc.blocks[0].kind).toBe('list');
    expect(serializeDocument(doc)).toBe('- 裸行\n');
  });
});
