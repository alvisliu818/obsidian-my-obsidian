// 虚拟链接扫描核心:纯函数直测(fakelink PrefixTree 语义的接受矩阵/词界/
// CJK 子串/最长优先/重叠消解)。
import { describe, expect, it } from 'vitest';
import { emptyTrie, resolveOverlaps, scanVirtualLinks, trieInsert } from './virtualLinkScan';

const WHOLE = { matchBeginningOfWords: false, matchEndOfWords: false, matchAnyPartsOfWords: false };

function scan(text: string, keys: string[], opts: Partial<typeof WHOLE> = {}): Array<{ from: number; to: number; key: string }> {
  const trie = emptyTrie();
  for (const k of keys) trieInsert(trie, k.toLowerCase());
  return scanVirtualLinks(text, trie, { ...WHOLE, ...opts });
}

describe('scanVirtualLinks 整词基线', () => {
  it('整词命中(词界起+词界尾)', () => {
    expect(scan('看这个 Obsidian 就好', ['obsidian'])).toEqual([{ from: 4, to: 12, key: 'obsidian' }]);
  });
  it('词中子串默认不收(前缀/后缀/中段全关)', () => {
    expect(scan('Ants in pants', ['ant'])).toEqual([]);
  });
  it('前缀开关:词首部分命中', () => {
    expect(scan('Ants here', ['ant'], { matchBeginningOfWords: true })).toEqual([{ from: 0, to: 3, key: 'ant' }]);
  });
  it('后缀开关:词尾部分命中', () => {
    expect(scan('xxant yy', ['ant'], { matchEndOfWords: true })).toEqual([{ from: 2, to: 5, key: 'ant' }]);
  });
  it('任意片段:词中子串', () => {
    expect(scan('xxantyy', ['ant'], { matchAnyPartsOfWords: true })).toEqual([{ from: 2, to: 5, key: 'ant' }]);
  });
  it('大小写不敏(命中 key 归一为小写)', () => {
    expect(scan('OBSIDIAN ok', ['obsidian'])).toEqual([{ from: 0, to: 8, key: 'obsidian' }]);
  });
  it('数字算词内(科目二冲刺带背3 整词)', () => {
    expect(scan('科目二冲刺带背3 完结', ['科目二冲刺带背3'])).toEqual([{ from: 0, to: 8, key: '科目二冲刺带背3' }]);
  });
});

describe('scanVirtualLinks CJK 子串', () => {
  it('非空隔文字恒子串(「牙痛」在「我牙痛了」中间命中)', () => {
    expect(scan('我牙痛了', ['牙痛'])).toEqual([{ from: 1, to: 3, key: '牙痛' }]);
  });
  it('同位多候选最长优先(欧拉方程 > 欧拉)', () => {
    expect(scan('欧拉方程是变量', ['欧拉', '欧拉方程'])).toEqual([{ from: 0, to: 4, key: '欧拉方程' }]);
  });
  it('CJK 与拉丁混排词界(abc王鸽 后缀吸收)', () => {
    // 「王鸽」在「abc王鸽」中是 CJK 子串,恒接受
    expect(scan('abc王鸽尾', ['王鸽'])).toEqual([{ from: 3, to: 5, key: '王鸽' }]);
  });
});

describe('scanVirtualLinks 多命中与重叠消解', () => {
  it('多处命中逐个产出(升序)', () => {
    expect(scan('a obsidian b obsidian c', ['obsidian'])).toEqual([
      { from: 2, to: 10, key: 'obsidian' },
      { from: 13, to: 21, key: 'obsidian' },
    ]);
  });
  it('重叠消解:长候选优先占位', () => {
    expect(resolveOverlaps([
      { from: 0, to: 3, key: 'ant' },
      { from: 0, to: 7, key: 'ants in' },
    ])).toEqual([{ from: 0, to: 7, key: 'ants in' }]);
  });
  it('两字符最短词命中,单字不入扫描(trie 本身允许,索引侧裁剪)', () => {
    expect(scan('AI 来了', ['ai'])).toEqual([{ from: 0, to: 2, key: 'ai' }]);
  });
  it('空词库/空文本零命中', () => {
    expect(scan('', ['x'])).toEqual([]);
    expect(scan('文本', [], { matchAnyPartsOfWords: true })).toEqual([]);
  });
});
