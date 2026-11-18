// @vitest-environment jsdom
// 粘贴转表格:TSV 纯字符串断言 + HTML 分支需要 DOMParser(jsdom 提供)。
import { describe, expect, it } from 'vitest';
import { pipeTableFromHtml, pipeTableFromTsv, tableMarkdownFromClipboard } from './tablePaste';

describe('pipeTableFromTsv', () => {
  it('Excel 两列复制转管道表', () => {
    const tsv = 'Name\tAge\nAlice\t30\nBob\t25';
    expect(pipeTableFromTsv(tsv)).toBe(
      ['| Name | Age |', '| --- | --- |', '| Alice | 30 |', '| Bob | 25 |'].join('\n'),
    );
  });

  it('无 tab 不接管(单列没有分隔符)', () => {
    expect(pipeTableFromTsv('plain text\nsecond line')).toBeNull();
  });

  it('管道转义与换行压空格', () => {
    const tsv = 'a|b\tc\nd\te';
    const md = pipeTableFromTsv(tsv)!;
    expect(md).toContain('a\\|b');
    expect(md.split('\n').length).toBe(3);
  });

  it('行内换行压成空格(CRLF 输入)', () => {
    const md = pipeTableFromTsv('a\tb\r\nc\td')!;
    expect(md.split('\n')[0]).toBe('| a | b |');
  });
});

describe('pipeTableFromHtml', () => {
  it('HTML table 转管道表', () => {
    const html = '<table><tr><th>h1</th><th>h2</th></tr><tr><td>a</td><td>b</td></tr></table>';
    expect(pipeTableFromHtml(html)).toBe(['| h1 | h2 |', '| --- | --- |', '| a | b |'].join('\n'));
  });

  it('非 table HTML 返回 null', () => {
    expect(pipeTableFromHtml('<p>hello</p>')).toBeNull();
  });

  it('单列表格不接管', () => {
    expect(pipeTableFromHtml('<table><tr><td>only</td></tr></table>')).toBeNull();
  });
});

describe('tableMarkdownFromClipboard', () => {
  it('HTML 优先于 TSV', () => {
    const md = tableMarkdownFromClipboard('<table><tr><td>x</td><td>y</td></tr></table>', 'x\ty');
    expect(md).toBe(['| x | y |', '| --- | --- |'].join('\n'));
  });

  it('光标在表格块内不接管', () => {
    const focused = '| a | b |\n| --- | --- |';
    const tsv = 'x\ty\n1\t2';
    expect(tableMarkdownFromClipboard('', tsv, { focusedBlockText: focused })).toBeNull();
    expect(tableMarkdownFromClipboard('', tsv, { focusedBlockText: '' })).not.toBeNull();
  });

  it('单行文本不接管', () => {
    expect(tableMarkdownFromClipboard('', 'no tabs here')).toBeNull();
  });
});
