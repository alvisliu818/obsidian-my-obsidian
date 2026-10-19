/**
 * 块内标题渲染:`- ## 标题` 里的 `##` 必须交给 Obsidian 渲染成 <h2>,
 * 而续行里的 `#` 和代码注释行不能被 heading 化。
 */
import { describe, expect, it } from 'vitest';
import { escapeInBlockHeadings } from '../src/blocks/renderTree';
import { toOutlineDocText, unescapeNoteLine, NOTE_ZWSP } from '../src/features/codeDoc';

describe('escapeInBlockHeadings', () => {
  it('leaves a heading on the first line alone (it IS the block heading)', () => {
    expect(escapeInBlockHeadings('## 幻灯片 1：深度学习概述')).toBe('## 幻灯片 1：深度学习概述');
    expect(escapeInBlockHeadings('# 第 1 章')).toBe('# 第 1 章');
    expect(escapeInBlockHeadings('###### 六级标题')).toBe('###### 六级标题');
  });

  it('escapes a heading-looking line in the body (continuation text)', () => {
    expect(escapeInBlockHeadings('正文说明\n# 这是注释不是标题')).toBe('正文说明\n\\# 这是注释不是标题');
  });

  it('leaves fenced content verbatim on every line', () => {
    const src = '说明\n```bash\n# 装依赖\necho hi\n```';
    expect(escapeInBlockHeadings(src)).toBe(src);
  });

  it('ignores a hash that is not a heading (no space after the run)', () => {
    const src = '正文\n#tag 不是标题';
    expect(escapeInBlockHeadings(src)).toBe(src);
  });

  it('leaves plain text untouched', () => {
    expect(escapeInBlockHeadings('普通文本\n第二行')).toBe('普通文本\n第二行');
  });
});

describe('comment lines never reach the renderer as headings', () => {
  it('prefixes a python comment with the zero-width-space escape', () => {
    const outline = toOutlineDocText([{ kind: 'text', text: '# 这是注释', startLine: 1 }]);
    expect(outline).toBe(`- ${NOTE_ZWSP}# 这是注释`);
    // 取回时剥掉,文件里不多一个字节
    expect(unescapeNoteLine(`${NOTE_ZWSP}# 这是注释`)).toBe('# 这是注释');
  });

  it('still escapes fences and task markers', () => {
    expect(toOutlineDocText([{ kind: 'text', text: '```py', startLine: 1 }])).toBe(`- ${NOTE_ZWSP}\`\`\`py`);
    expect(toOutlineDocText([{ kind: 'text', text: 'TODO 买牛奶', startLine: 1 }])).toBe(`- ${NOTE_ZWSP}TODO 买牛奶`);
  });

  it('leaves an ordinary comment line untouched (e.g. // in JS)', () => {
    expect(toOutlineDocText([{ kind: 'text', text: '// 普通注释', startLine: 1 }])).toBe('- // 普通注释');
  });
});
