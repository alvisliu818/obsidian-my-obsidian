/**
 * compareNames — Windows 资源管理器「按名称」排序契约的回归锚。
 *
 * 对齐 StrCmpLogicalW（Windows 11 / zh-CN 实测）：
 *  - 数字串按数值比较，前导零多的排前面（01 < 1）；
 *  - `-` 与 `'` 忽略；标点 < 数字 < 字母；
 *  - 任意位置 ASCII 先于 CJK（旧实现只分组首字符，05_尚硅谷 会排到
 *    05_FastAPIProject 前，2026-11-27 用户再次报告）；
 *  - 全角/带音标字符折算到 ASCII 原型之后。
 *
 * 挂载面板（sortChildren/orderedLevel）、挂载选择器、挂载筛选和虚拟浏览器
 * 都经由这一个比较器排序；文件夹优先由调用方负责。
 */

import { describe, expect, it } from 'vitest';
import { compareNames } from '../src/nameCompare';

const sorted = (names: string[]): string[] => [...names].sort(compareNames);

describe('compareNames', () => {
  it('sorts digit runs numerically: 260817 after 99-Attachment', () => {
    expect(sorted(['00-Tips', '10-Help', '20-Diary', '260817', '30-Reading', '99-Attachment'])).toEqual([
      '00-Tips',
      '10-Help',
      '20-Diary',
      '30-Reading',
      '99-Attachment',
      '260817',
    ]);
  });

  it('puts more leading zeros first, like Explorer: a001 < a01 < a1', () => {
    expect(sorted(['a1', 'a001', 'a01'])).toEqual(['a001', 'a01', 'a1']);
  });

  it('is case-insensitive like the native explorer', () => {
    // 'abc' 在 'B' 之前(按 a<b 比较),而不是字节序里大写 B(0x42)永远在前。
    expect(compareNames('abc', 'B')).toBeLessThan(0);
    expect(compareNames('abc', 'b')).toBeLessThan(0);
  });

  it('keeps ASCII ahead of CJK at ANY position, not just the first char', () => {
    // 2026-11-27 实报: 260817 里 05_尚硅谷… 被 locale collator 排在 05_FastAPIProject 前。
    expect(sorted(['05_尚硅谷大模型技术之FastAPI', '05_FastAPIProject'])).toEqual([
      '05_FastAPIProject',
      '05_尚硅谷大模型技术之FastAPI',
    ]);
    // 首字符分组仍然有效: 英文文件排在纯 CJK 文件前。
    expect(sorted(['大模型基础.xmind', 'project0817.bmpr', 'resume.db'])).toEqual([
      'project0817.bmpr',
      'resume.db',
      '大模型基础.xmind',
    ]);
  });

  it('ignores hyphens when comparing (01_project before 01-python)', () => {
    expect(sorted(['01-python基础', '01_project260817'])).toEqual(['01_project260817', '01-python基础']);
    expect(compareNames('-a', '_a')).toBeGreaterThan(0);
  });

  it('orders punctuation before digits before letters', () => {
    expect(sorted(['a', '00', '.env', '-a', '!a'])).toEqual(['!a', '.env', '00', 'a', '-a']);
  });

  it('puts full-width and accented forms right after their ASCII base', () => {
    expect(sorted(['（1）', '(1)', '.env'])).toEqual(['(1)', '（1）', '.env']);
    expect(sorted(['b', 'á', 'a'])).toEqual(['a', 'á', 'b']);
  });

  it('keeps emoji after Latin and before Han', () => {
    expect(sorted(['尚', '😀', 'Z'])).toEqual(['Z', '😀', '尚']);
  });

  it('still breaks ties deterministically for equal-under-collation names', () => {
    // 大小写不同、其余全等: 比较器返回 0，Array#sort 稳定保持原序。
    expect(compareNames('Note.md', 'NOTE.MD')).toBe(0);
  });
});
