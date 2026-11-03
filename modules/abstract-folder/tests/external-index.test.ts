import { describe, expect, it } from 'vitest';

import {
  buildExternalLinkIndex,
  cleanLinkText,
  extractLinkTexts,
  iconFromFrontmatter,
  isMarkdownName,
  parseFrontmatterBlock,
  resolveExternalLink,
} from '../src/utils/externalIndex';

describe('parseFrontmatterBlock', () => {
  it('解析基本 kv 与引号值', () => {
    expect(parseFrontmatterBlock('---\ntitle: "My Note"\nicon: FaFolder\n---\nbody')).toEqual({
      title: 'My Note',
      icon: 'FaFolder',
    });
  });

  it('解析缩进列表', () => {
    const fm = parseFrontmatterBlock('---\nchildren:\n  - "[[a]]"\n  - "[[b]]"\n---\n');
    expect(fm).toEqual({ children: ['[[a]]', '[[b]]'] });
  });

  it('解析流式列表（引号内逗号不切分）', () => {
    const fm = parseFrontmatterBlock('---\nparent: ["a, b", c]\n---\n');
    expect(fm).toEqual({ parent: ['a, b', 'c'] });
  });

  it('解析单引号与星号列表项', () => {
    const fm = parseFrontmatterBlock("---\nparent:\n  * 'hidden'\n---\n");
    expect(fm).toEqual({ parent: ['hidden'] });
  });

  it('容忍 CRLF', () => {
    const fm = parseFrontmatterBlock('---\r\nparent: hidden\r\n---\r\n');
    expect(fm).toEqual({ parent: 'hidden' });
  });

  it('容忍 BOM', () => {
    const fm = parseFrontmatterBlock('\uFEFF---\nicon: eye\n---\n');
    expect(fm).toEqual({ icon: 'eye' });
  });

  it('无 frontmatter 返回 null', () => {
    expect(parseFrontmatterBlock('# just a note\nparent: x\n')).toBeNull();
    expect(parseFrontmatterBlock('')).toBeNull();
  });

  it('未闭合的 frontmatter 返回 null', () => {
    expect(parseFrontmatterBlock('---\nparent: x\n')).toBeNull();
  });

  it('块标量（| / >）给空串占位', () => {
    const fm = parseFrontmatterBlock('---\ntitle: |\n  long text\nparent: x\n---\n');
    expect(fm).toEqual({ title: '', parent: 'x' });
  });

  it('顶层裸列表项丢弃且不污染后续键', () => {
    const fm = parseFrontmatterBlock('---\n- stray\nparent: x\n---\n');
    expect(fm).toEqual({ parent: 'x' });
  });

  it('空值保留为空列表占位', () => {
    const fm = parseFrontmatterBlock('---\nchildren:\nparent: x\n---\n');
    expect(fm).toEqual({ children: [], parent: 'x' });
  });
});

describe('extractLinkTexts', () => {
  it('提取多个 wikilink', () => {
    expect(extractLinkTexts('[[a]] and [[b|alias]]')).toEqual(['a', 'b']);
  });

  it('裸字符串原样作为一个目标', () => {
    expect(extractLinkTexts('Some Note')).toEqual(['Some Note']);
    expect(extractLinkTexts('hidden')).toEqual(['hidden']);
  });

  it('数组逐项展开，空值跳过', () => {
    expect(extractLinkTexts(['[[a]]', '', 'b'])).toEqual(['a', 'b']);
  });

  it('非字符串非数组返回空', () => {
    expect(extractLinkTexts(42)).toEqual([]);
    expect(extractLinkTexts(undefined)).toEqual([]);
  });
});

describe('cleanLinkText', () => {
  it('去括号、别名、小节与引号', () => {
    expect(cleanLinkText('[[a|b]]')).toBe('a');
    expect(cleanLinkText('[[a#heading]]')).toBe('a');
    expect(cleanLinkText('[[a#^blockid]]')).toBe('a');
    expect(cleanLinkText('"[[a]]"')).toBe('a');
    expect(cleanLinkText('  a.md  ')).toBe('a.md');
  });
});

describe('buildExternalLinkIndex + resolveExternalLink', () => {
  const index = buildExternalLinkIndex([
    { rel: 'notes/foo/bar.md', abs: 'D:\\m\\notes\\foo\\bar.md' },
    { rel: 'notes/baz.md', abs: 'D:\\m\\notes\\baz.md' },
    { rel: 'docs/readme.md', abs: 'D:\\m\\docs\\readme.md' },
    { rel: 'alpha/dup.md', abs: 'D:\\m\\alpha\\dup-1.md' },
    { rel: 'beta/dup.md', abs: 'D:\\m\\beta\\dup-2.md' },
  ]);

  it('挂载内相对路径命中（含/不含 .md）', () => {
    expect(resolveExternalLink('notes/foo/bar.md', 'notes/baz.md', index)).toBe('D:\\m\\notes\\foo\\bar.md');
    expect(resolveExternalLink('notes/foo/bar', 'notes/baz.md', index)).toBe('D:\\m\\notes\\foo\\bar.md');
  });

  it('相对源文件所在目录的路径命中', () => {
    expect(resolveExternalLink('foo/bar.md', 'notes/baz.md', index)).toBe('D:\\m\\notes\\foo\\bar.md');
    expect(resolveExternalLink('readme', 'notes/baz.md', index)).toBe('D:\\m\\docs\\readme.md');
  });

  it('按文件名兜底', () => {
    expect(resolveExternalLink('bar', 'notes/baz.md', index)).toBe('D:\\m\\notes\\foo\\bar.md');
  });

  it('大小写不敏感', () => {
    expect(resolveExternalLink('NOTES/FOO/BAR.MD', 'notes/baz.md', index)).toBe('D:\\m\\notes\\foo\\bar.md');
  });

  it('Windows 反斜杠路径', () => {
    expect(resolveExternalLink('notes\\foo\\bar.md', 'notes/baz.md', index)).toBe('D:\\m\\notes\\foo\\bar.md');
  });

  it('同目录命中优先于文件名兜底（重名消歧）', () => {
    // 'dup' 不在 byRel 顶层键里；源目录 beta 命中 beta/dup（而非先插入的 alpha/dup）
    expect(resolveExternalLink('dup.md', 'beta/x.md', index)).toBe('D:\\m\\beta\\dup-2.md');
    expect(resolveExternalLink('dup.md', 'beta\\x.md', index)).toBe('D:\\m\\beta\\dup-2.md');
  });

  it('同目录没命中时文件名兜底取第一个', () => {
    expect(resolveExternalLink('dup.md', 'gamma/x.md', index)).toBe('D:\\m\\alpha\\dup-1.md');
  });

  it('未命中返回 null', () => {
    expect(resolveExternalLink('nope.md', 'notes/baz.md', index)).toBeNull();
    expect(resolveExternalLink('', 'notes/baz.md', index)).toBeNull();
  });
});

describe('杂项', () => {
  it('isMarkdownName 只认 .md', () => {
    expect(isMarkdownName('a.md')).toBe(true);
    expect(isMarkdownName('A.MD')).toBe(true);
    expect(isMarkdownName('a.txt')).toBe(false);
  });

  it('iconFromFrontmatter 取非空字符串', () => {
    expect(iconFromFrontmatter({ icon: ' FaFolder ' })).toBe('FaFolder');
    expect(iconFromFrontmatter({ icon: '  ' })).toBeUndefined();
    expect(iconFromFrontmatter({ icon: 3 })).toBeUndefined();
    expect(iconFromFrontmatter({})).toBeUndefined();
  });
});
