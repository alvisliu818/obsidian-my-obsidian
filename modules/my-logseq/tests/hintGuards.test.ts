/**
 * 补全提示守卫回归（2026-10-26 第五批）：思源 blockHintRange.test.ts 用例
 * 逐条移植 + CM 适配守卫（行内代码/标题前缀/tag/未收口块提示）用例。
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import {
  BLOCK_HINT_KEYS,
  getBlockHintTriggerOffset,
  hintSuppressedAt,
  isBlockHintQueryAtCaret,
  isCaretInHeadingPrefix,
  isCaretInInlineCode,
  isCaretInTag,
  shouldIgnoreHintTrigger,
  unfinishedBlockHintAt,
} from '../src/features/hintGuards';

// --- 思源 blockHintRange.test.ts 移植 ---

describe('getBlockHintTriggerOffset（思源移植）', () => {
  it('uses the latest overlapping trigger inside existing closing markers', () => {
    expect(getBlockHintTriggerOffset('[[[', ']]', '[[', ']]')).toBe(1);
    expect(getBlockHintTriggerOffset('【【【query', '】】', '【【', '】】')).toBe(1);
  });

  it('replaces exactly the latest trigger in the reported scenario', () => {
    const text = '[[[]]';
    const caretOffset = 3;
    const triggerOffset = getBlockHintTriggerOffset(text.substring(0, caretOffset), text.substring(caretOffset), '[[', ']]');
    expect(text.substring(0, triggerOffset) + 'reference' + text.substring(caretOffset)).toBe('[reference]]');
  });

  it('keeps the first trigger when the query starts with an opening marker', () => {
    const text = '[[[电影自习室] 全集';
    const triggerOffset = getBlockHintTriggerOffset(text, '', '[[', ']]');
    expect(triggerOffset).toBe(0);
    expect(text.substring(triggerOffset + 2)).toBe('[电影自习室] 全集');
    expect(getBlockHintTriggerOffset('[[[', ']', '[[', ']]')).toBe(0);
    expect(getBlockHintTriggerOffset('【【【', '】', '【【', '】】')).toBe(0);
  });

  it('extracts the query after the latest overlapping trigger', () => {
    const text = '[[[query';
    const triggerOffset = getBlockHintTriggerOffset(text, ']]', '[[', ']]');
    expect(text.substring(triggerOffset + 2)).toBe('query');
  });

  it('includes manually entered closing markers in the query', () => {
    const text = '[[foo]]';
    const triggerOffset = getBlockHintTriggerOffset(text, '', '[[', ']]');
    expect(text.substring(triggerOffset + 2)).toBe('foo]]');
  });
});

describe('isBlockHintQueryAtCaret（思源移植）', () => {
  it('recognizes an unfinished query around the caret', () => {
    expect(isBlockHintQueryAtCaret('prefix [[que', 'ry', '[[', ']]', 512)).toBe(true);
    expect(isBlockHintQueryAtCaret('prefix ((query', '', '((', '))', 512)).toBe(true);
  });

  it('keeps a query editable before its closing marker', () => {
    expect(isBlockHintQueryAtCaret('[[que', 'ry]]', '[[', ']]', 512)).toBe(true);
  });

  it('rejects text outside a valid query', () => {
    expect(isBlockHintQueryAtCaret('plain text', '', '[[', ']]', 512)).toBe(false);
    expect(isBlockHintQueryAtCaret('[[ query', '', '[[', ']]', 512)).toBe(false);
    expect(isBlockHintQueryAtCaret('[[12345', '', '[[', ']]', 5)).toBe(false);
  });
});

describe('shouldIgnoreHintTrigger（思源移植）', () => {
  const blockHintKeys = ['((', '[[', '（（', '【【'];

  it('keeps block reference queries intact when slash hints appear inside them', () => {
    expect(shouldIgnoreHintTrigger('[[', '、', blockHintKeys)).toBe(true);
    expect(shouldIgnoreHintTrigger('((', '/', blockHintKeys)).toBe(true);
    expect(shouldIgnoreHintTrigger('[[', '#', blockHintKeys)).toBe(true);
    expect(shouldIgnoreHintTrigger('[[', ':', blockHintKeys)).toBe(true);
  });

  it('does not block unrelated hint contexts', () => {
    expect(shouldIgnoreHintTrigger('', '、', blockHintKeys)).toBe(false);
    expect(shouldIgnoreHintTrigger('#', '、', blockHintKeys)).toBe(true);
    expect(shouldIgnoreHintTrigger('、', '[[', blockHintKeys)).toBe(false);
  });
});

// --- CM 适配守卫 ---

const stateOf = (text: string, pos?: number): { state: EditorState; pos: number } => {
  const state = EditorState.create({ doc: text });
  return { state, pos: pos ?? text.length };
};

describe('isCaretInInlineCode', () => {
  it('suppresses inside a closed span including markers, not outside', () => {
    const doc = 'before `code` after';
    // '`code`' 占 7..13
    expect(isCaretInInlineCode(stateOf(doc, 7).state, 7)).toBe(true); // 开标记上
    expect(isCaretInInlineCode(stateOf(doc, 10).state, 10)).toBe(true); // 内容中
    expect(isCaretInInlineCode(stateOf(doc, 13).state, 13)).toBe(true); // 闭标记上
    expect(isCaretInInlineCode(stateOf(doc, 6).state, 6)).toBe(false); // 开标记前
    expect(isCaretInInlineCode(stateOf(doc, 14).state, 14)).toBe(false); // 闭标记后
  });

  it('ignores an unclosed backtick', () => {
    expect(isCaretInInlineCode(stateOf('a `bcd', 5).state, 5)).toBe(false);
  });
});

describe('isCaretInHeadingPrefix（issue 7933）', () => {
  it('suppresses while the caret sits inside the # run of a heading line', () => {
    const doc = '## foo\n- b';
    expect(isCaretInHeadingPrefix(stateOf(doc, 1).state, 1)).toBe(true);
    expect(isCaretInHeadingPrefix(stateOf(doc, 2).state, 2)).toBe(true);
    // 空格后（正在敲标题文本）放行
    expect(isCaretInHeadingPrefix(stateOf(doc, 3).state, 3)).toBe(false);
    expect(isCaretInHeadingPrefix(stateOf(doc, 5).state, 5)).toBe(false);
  });

  it('does not apply to non-heading lines', () => {
    expect(isCaretInHeadingPrefix(stateOf('##', 2).state, 2)).toBe(false); // 没有空格,还不是标题行
    expect(isCaretInHeadingPrefix(stateOf('- ## x', 3).state, 3)).toBe(false);
  });
});

describe('isCaretInTag', () => {
  it('fires inside a tag token but not on plain # words', () => {
    const doc = 'a #tag/子 x';
    // 列：0=a,1=' ',2=#,3=t,4=a,5=g,6=/,7=子,8=' ',9=x
    expect(isCaretInTag(stateOf(doc, 3).state, 3)).toBe(true);
    expect(isCaretInTag(stateOf(doc, 7).state, 7)).toBe(true);
    expect(isCaretInTag(stateOf(doc, 2).state, 2)).toBe(false); // '#' 上（记号起点）
    expect(isCaretInTag(stateOf(doc, 9).state, 9)).toBe(false); // 空白后
  });
});

describe('unfinishedBlockHintAt / hintSuppressedAt（规则 3）', () => {
  it('detects unfinished (( and [[ queries at the caret', () => {
    expect(unfinishedBlockHintAt(stateOf('see ((que', 9).state, 9)).toBe('((');
    expect(unfinishedBlockHintAt(stateOf('see [[que', 9).state, 9)).toBe('[[');
    expect(unfinishedBlockHintAt(stateOf('see ((que)) x', 13).state, 13)).toBeNull(); // 已收口
    expect(unfinishedBlockHintAt(stateOf('(( que', 6).state, 6)).toBeNull(); // 查询以空白开头,非法
  });

  it('slash/tag sources yield to an open block hint; block hints themselves do not', () => {
    const { state, pos } = stateOf('see [[que', 9);
    expect(hintSuppressedAt(state, pos, false)).toBe(true); // slash/tag 让位
    expect(hintSuppressedAt(state, pos, true)).toBe(false); // [[ 源自身照常
  });

  it('inline code suppresses every source', () => {
    const doc = 'x `a((b` y';
    expect(hintSuppressedAt(stateOf(doc, 8).state, 8, true)).toBe(true);
    expect(hintSuppressedAt(stateOf(doc, 8).state, 8, false)).toBe(true);
  });

  it('exposes the block hint keys used by the stateless rule', () => {
    expect(BLOCK_HINT_KEYS.map((k) => k.split)).toEqual(['((', '[[']);
  });
});
