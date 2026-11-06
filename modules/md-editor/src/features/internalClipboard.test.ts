// 内部剪贴板格式夹带:编解码 roundtrip / 注释提取与剥除 / Excel 守卫 /
// mime 优先 / 消毒(坏 base64)。纯字符串,无 DOM。
import { describe, expect, it } from 'vitest';
import {
  INTERNAL_MIME,
  buildWebClipboardHTML,
  decodeBase64Utf8,
  encodeBase64Utf8,
  getInternalFromClipboardData,
  getInternalFromTextHTML,
  internalCarrierHTML,
} from './internalClipboard';

describe('base64 编解码', () => {
  it('roundtrip(含中文/换行/emoji)', () => {
    const md = '# 标题\n- 中文项目 **粗体**\n```code\n```\n\ttab → ✓';
    expect(decodeBase64Utf8(encodeBase64Utf8(md))).toBe(md);
  });

  it('坏 base64 消毒为空串', () => {
    expect(decodeBase64Utf8('!!!!')).toBe('');
    expect(decodeBase64Utf8('')).toBe('');
  });
});

describe('buildWebClipboardHTML(夹带包装)', () => {
  it('internal 为空原样返回', () => {
    expect(buildWebClipboardHTML('<p>x</p>', '')).toBe('<p>x</p>');
  });

  it('非空前置 base64 注释,提取后还原', () => {
    const md = '# T\n- a';
    const wrapped = buildWebClipboardHTML('<div>x</div>', md);
    expect(wrapped.startsWith(`<!--data-obsidian-logseq='${encodeBase64Utf8(md)}'-->`)).toBe(true);
    expect(wrapped.endsWith('<div>x</div>')).toBe(true);
  });
});

describe('getInternalFromTextHTML(提取与剥除)', () => {
  it('提取内部数据并把注释从 html 里剥掉', () => {
    const md = '- a\n- b';
    const { internal, html } = getInternalFromTextHTML(
      `<!--data-obsidian-logseq='${encodeBase64Utf8(md)}'--><div>body</div>`,
    );
    expect(internal).toBe(md);
    expect(html).toBe('<div>body</div>');
  });

  it('无注释原样返回', () => {
    const r = getInternalFromTextHTML('<div>plain</div>');
    expect(r.internal).toBe('');
    expect(r.html).toBe('<div>plain</div>');
  });

  it('正文里出现的多个同形注释全部剥除,只取第一个为内部数据', () => {
    const md = 'first';
    const source = `<!--data-obsidian-logseq='${encodeBase64Utf8(md)}'--><!--data-obsidian-logseq='egg'-->x`;
    const { internal, html } = getInternalFromTextHTML(source);
    expect(internal).toBe(md);
    expect(html).toBe('x');
  });

  it('Excel 剪贴板守卫:xmlns:x office 命名空间时判无内部数据并剥注释', () => {
    const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><!--data-obsidian-logseq='${encodeBase64Utf8('evil')}'--><table><td>1</td></table>`;
    const r = getInternalFromTextHTML(html);
    expect(r.internal).toBe('');
    expect(r.html).not.toContain('data-obsidian-logseq');
    expect(r.html).toContain('<table>');
  });
});

describe('getInternalFromClipboardData(粘贴侧入口)', () => {
  it('自定义 mime 优先', () => {
    const d = {
      getData: (type: string) => (type === INTERNAL_MIME ? 'from-mime' : `<!--data-obsidian-logseq='${encodeBase64Utf8('from-html')}'-->h`),
    };
    expect(getInternalFromClipboardData(d)).toBe('from-mime');
  });

  it('mime 为空回落 text/html 夹带', () => {
    const md = 'fallback-md';
    const d = {
      getData: (type: string) => (type === 'text/html' ? `<!--data-obsidian-logseq='${encodeBase64Utf8(md)}'-->h` : ''),
    };
    expect(getInternalFromClipboardData(d)).toBe(md);
  });
});

describe('internalCarrierHTML(写侧载体)', () => {
  it('pre-wrap div + HTML 转义', () => {
    expect(internalCarrierHTML('<b>&x</b>')).toBe('<div style="white-space:pre-wrap">&lt;b&gt;&amp;x&lt;/b&gt;</div>');
  });

  it('换行原样保留在载体里(白名单 mime 下唯一保行途径)', () => {
    expect(internalCarrierHTML('a\nb')).toContain('a\nb');
  });
});
