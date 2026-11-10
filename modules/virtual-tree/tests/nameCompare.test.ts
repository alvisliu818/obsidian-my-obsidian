/**
 * compareNames — Obsidian 原生同名排序契约的回归锚。
 *
 * 对齐 app.js 的 `new Intl.Collator(void 0,{usage:"sort",sensitivity:"base",numeric:!0})`:
 * 数字串按数值比较、大小写不敏感。挂载面板(sortChildren/orderedLevel)、
 * 挂载选择器和虚拟浏览器都经由这一个比较器排序。
 */

import { describe, expect, it } from 'vitest';
import { compareNames } from '../src/nameCompare';

describe('compareNames', () => {
  it('sorts digit runs numerically: 260817 after 99-Attachment', () => {
    const names = ['00-Tips', '10-Help', '20-Diary', '260817', '30-Reading', '99-Attachment'];
    expect([...names].sort(compareNames)).toEqual([
      '00-Tips',
      '10-Help',
      '20-Diary',
      '30-Reading',
      '99-Attachment',
      '260817',
    ]);
  });

  it('is case-insensitive like the native explorer', () => {
    // 'abc' 在 'B' 之前(按 a<b 比较),而不是字节序里大写 B(0x42)永远在前。
    expect(compareNames('abc', 'B')).toBeLessThan(0);
    expect(compareNames('abc', 'b')).toBeLessThan(0);
  });

  it('still breaks ties deterministically for equal-under-collation names', () => {
    // Collator base 敏感度视大小写为相等;Array#sort 是稳定排序,
    // 相等键保持原相对顺序——这里只验证比较器本身返回 0。
    expect(compareNames('Note.md', 'NOTE.MD')).toBe(0);
  });
});
