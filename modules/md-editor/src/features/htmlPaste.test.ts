// @vitest-environment jsdom
// HTML 粘贴转 markdown:DOMParser(jsdom 提供)+ turndown(PnP 解析)。
// 表格分支复用 tablePaste 的 pipeTableFromHtml,断言与纯表格粘贴同语义。
import { describe, expect, it } from 'vitest';
import { htmlToMarkdown } from './htmlPaste';

describe('htmlToMarkdown', () => {
  it('粗体/斜体/行内码', () => {
    expect(htmlToMarkdown('<div><b>粗</b> and <i>斜</i> <code>码</code></div>')).toBe('**粗** and *斜* `码`');
  });
  it('链接与图片', () => {
    expect(htmlToMarkdown('<a href="https://a.com">链接</a>')).toBe('[链接](https://a.com)');
    expect(htmlToMarkdown('<img src="pic.png" alt="图">')).toBe('![图](pic.png)');
  });
  it('列表与标题', () => {
    const md = htmlToMarkdown('<h2>标题</h2><ul><li>一</li><li>二</li></ul>');
    expect(md).toBe('## 标题\n\n- 一\n- 二');
  });
  it('HTML 表格转管道表(与纯表格粘贴同管线)', () => {
    const md = htmlToMarkdown('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>');
    expect(md).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |');
  });
  it('HTML 注释剥离', () => {
    expect(htmlToMarkdown('<div>前<!-- hidden -->后<b>粗</b></div>')).toBe('前后**粗**');
  });
  it('围栏代码内的列表标记不被规范化(逐行围栏感知)', () => {
    const md = htmlToMarkdown('<ul><li>外</li></ul><pre><code>-   keep\n  *   also</code></pre>');
    expect(md).toBe('- 外\n\n```\n-   keep\n  *   also\n```');
  });
  it('纯文本壳(无结构标记)返回 null → 调用方字面粘贴', () => {
    expect(htmlToMarkdown('<div>纯文本</div>')).toBeNull();
    expect(htmlToMarkdown('plain')).toBeNull();
    expect(htmlToMarkdown('')).toBeNull();
  });
});
