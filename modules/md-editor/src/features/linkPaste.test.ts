// 链接粘贴决策:纯函数直测(URL 判定 / 包链接方向 / URL↔URL 放行)。
// og handler/paste.cljs 与 SilverBullet pasteLinkExtension 的并集语义。
import { describe, expect, it } from 'vitest';
import { isBareUrl, linkPasteDecision } from './linkPaste';

describe('isBareUrl', () => {
  it('http/https 整段 URL 为真', () => {
    expect(isBareUrl('https://obsidian.md')).toBe(true);
    expect(isBareUrl('http://localhost:8080/a/b?x=1#frag')).toBe(true);
  });
  it('含空白/协议不符/非 URL 文本为假', () => {
    expect(isBareUrl('ftp://example.com')).toBe(false);
    expect(isBareUrl('https://a.com foo')).toBe(false);
    expect(isBareUrl('看这个 https://a.com')).toBe(false);
    expect(isBareUrl('plain text')).toBe(false);
    expect(isBareUrl('')).toBe(false);
  });
});

describe('linkPasteDecision', () => {
  it('URL 粘贴到文字选区 → [选区](url)', () => {
    expect(linkPasteDecision('https://a.com', '文档')).toEqual({ insert: '[文档](https://a.com)' });
  });
  it('文本粘贴到 URL 选区 → [文本](选区url)', () => {
    expect(linkPasteDecision('标题', 'https://a.com')).toEqual({ insert: '[标题](https://a.com)' });
  });
  it('多行文本粘贴到 URL 选区不接管(不作 label)', () => {
    expect(linkPasteDecision('一行\n二行', 'https://a.com')).toBeNull();
  });
  it('URL↔URL 不接管(默认替换,og replace-text-f 同果)', () => {
    expect(linkPasteDecision('https://b.com', 'https://a.com')).toBeNull();
  });
  it('空选区/空粘贴/双方非 URL → null 落默认粘贴', () => {
    expect(linkPasteDecision('https://a.com', '')).toBeNull();
    expect(linkPasteDecision('', '选区')).toBeNull();
    expect(linkPasteDecision('文本', '选区')).toBeNull();
  });
});
