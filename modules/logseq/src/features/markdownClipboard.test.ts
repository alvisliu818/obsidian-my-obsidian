// @vitest-environment jsdom
// markdownClipboard 启发式:思源守卫逐条移植 + 渲染等价替代口径
// (HTML 可见文本 == markdown 渲染文本)。jsdom 提供 template/TreeWalker。
import { describe, expect, it } from 'vitest';
import { DOLLAR_PLACEHOLDER, renderedTextOfMarkdown, shouldPasteMarkdownFromHTML } from './markdownClipboard';

describe('renderedTextOfMarkdown(渲染文本近似)', () => {
  it('标题剥 #,列表剥 -,引用剥 >', () => {
    expect(renderedTextOfMarkdown('# Title')).toBe('Title');
    expect(renderedTextOfMarkdown('- a\n- b')).toBe('a\nb');
    expect(renderedTextOfMarkdown('> quoted')).toBe('quoted');
    expect(renderedTextOfMarkdown('> > nested')).toBe('nested');
  });

  it('行内记号剥除:强调/行内代码/链接/图片', () => {
    expect(renderedTextOfMarkdown('some **bold** and *em* text')).toBe('some bold and em text');
    expect(renderedTextOfMarkdown('use `x**y**` here')).toBe('use x**y** here');
    expect(renderedTextOfMarkdown('[click](https://x) and ![alt](y.png)')).toBe('click and alt');
    expect(renderedTextOfMarkdown('<https://x>')).toBe('https://x');
  });

  it('围栏与 $$ 数学体保留原文,围栏行本身不产生文本', () => {
    expect(renderedTextOfMarkdown('```\nconst x = 1;\nreturn x;\n```')).toBe('const x = 1;\nreturn x;');
    expect(renderedTextOfMarkdown('```js\nlet a;\n```')).toBe('let a;');
    expect(renderedTextOfMarkdown('$$\n\\nabla f\n$$')).toBe('\\nabla f');
  });

  it('hr 归空行,表格分隔行整行不产生文本、数据行逐格相连', () => {
    expect(renderedTextOfMarkdown('above\n---\nbelow')).toBe('above\n\nbelow');
    expect(renderedTextOfMarkdown('| a | b |\n| --- | --- |\n| c | d |')).toBe('ab\ncd');
  });
});

describe('shouldPasteMarkdownFromHTML(思源守卫 + 渲染等价)', () => {
  it('空侧直接放弃', () => {
    expect(shouldPasteMarkdownFromHTML('', 'some text')).toBe(false);
    expect(shouldPasteMarkdownFromHTML('<p>text</p>', '')).toBe(false);
    expect(shouldPasteMarkdownFromHTML('<p>text</p>', '   \n  ')).toBe(false);
  });

  it('DOLLAR 占位守卫(思源同款)', () => {
    expect(shouldPasteMarkdownFromHTML('<p>x</p>', `x ${DOLLAR_PLACEHOLDER}`)).toBe(false);
    expect(shouldPasteMarkdownFromHTML(`<p>${DOLLAR_PLACEHOLDER}</p>`, 'x')).toBe(false);
  });

  it('网页划选:HTML 可见文本与纯文本原文相同 → 不是 md 源(有序列表样文本不被拆)', () => {
    expect(shouldPasteMarkdownFromHTML('<p>1. first</p><p>2. second</p>', '1. first\n2. second')).toBe(false);
    expect(shouldPasteMarkdownFromHTML('<div>plain **text** page</div>', 'plain **text** page')).toBe(false);
  });

  it('富样式/富媒体早退:style/class/svg/iframe/video/audio/math', () => {
    expect(shouldPasteMarkdownFromHTML('<p><span style="color:red">**bold**</span></p>', '**bold**')).toBe(false);
    expect(shouldPasteMarkdownFromHTML('<pre><code class="language-js">x</code></pre>', '```js\nx\n```')).toBe(false);
    expect(shouldPasteMarkdownFromHTML('<p>a</p><svg></svg>', 'a')).toBe(false);
    expect(shouldPasteMarkdownFromHTML('<p>a</p><iframe></iframe>', 'a')).toBe(false);
  });

  it('渲染等价 → md 源:Typora 形态(标题+列表)', () => {
    expect(shouldPasteMarkdownFromHTML('<h1>Title</h1><ul><li>a</li><li>b</li></ul>', '# Title\n- a\n- b')).toBe(true);
  });

  it('渲染等价 → md 源:强调/行内代码/链接', () => {
    expect(shouldPasteMarkdownFromHTML('<p>some <strong>bold</strong> text</p>', 'some **bold** text')).toBe(true);
    expect(shouldPasteMarkdownFromHTML('<p>use <code>x**y**</code> here</p>', 'use `x**y**` here')).toBe(true);
    expect(shouldPasteMarkdownFromHTML('<p><a href="https://x">click</a></p>', '[click](https://x)')).toBe(true);
  });

  it('渲染等价 → md 源:代码块/引用/嵌套列表/表格/CRLF', () => {
    expect(
      shouldPasteMarkdownFromHTML(
        '<pre><code>const x = 1;\nreturn x;</code></pre>',
        '```\nconst x = 1;\nreturn x;\n```',
      ),
    ).toBe(true);
    expect(shouldPasteMarkdownFromHTML('<blockquote><p>quoted</p></blockquote>', '> quoted')).toBe(true);
    expect(shouldPasteMarkdownFromHTML('<ul><li>a<ul><li>b</li></ul></li></ul>', '- a\n  - b')).toBe(true);
    expect(
      shouldPasteMarkdownFromHTML(
        '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>',
        '| a | b |\n| --- | --- |\n| c | d |',
      ),
    ).toBe(true);
    expect(shouldPasteMarkdownFromHTML('<h1>T</h1><ul><li>a</li></ul>', '# T\r\n- a')).toBe(true);
  });

  it('带 markdown 记号的网页文本(页面未按 md 渲染)→ 不是 md 源', () => {
    // 网页可见文本是 "Chapter #1 Title"(记号是字面内容),渲染会把 # 剥掉,
    // 两边文本对不上 → 字面粘贴。
    expect(shouldPasteMarkdownFromHTML('<p>Chapter #1 Title</p>', 'Chapter #1 Title')).toBe(false);
  });
});
