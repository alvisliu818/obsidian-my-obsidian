/**
 * Supertag text helpers: the boundary rules that decide WHICH `#tag` occurrence
 * gets removed. A wrong answer here silently eats a different tag's text, so
 * these cases are pinned deliberately.
 */

import { describe, expect, it } from 'vitest';
import { collectBlockTags, removeTagFromText } from '../src/features/supertagText';

describe('collectBlockTags', () => {
  it('finds tags, lowercased, deduped, in order', () => {
    expect(collectBlockTags('hello #World and #more #WORLD')).toEqual(['world', 'more']);
  });

  it('ignores tags inside [[...]] — those are page links', () => {
    expect(collectBlockTags('see [[NotATag]] plus #real')).toEqual(['real']);
  });

  it('handles hierarchical and hyphenated names', () => {
    expect(collectBlockTags('#project/alpha #book-club')).toEqual(['project/alpha', 'book-club']);
  });

  it('needs a name character IMMEDIATELY after the sigil', () => {
    // '# 12' is a markdown heading, not a tag: the name may not be separated.
    expect(collectBlockTags('# alone # 12')).toEqual([]);
    expect(collectBlockTags('#12 #3d')).toEqual(['12', '3d']);
  });

  it('returns nothing for plain text', () => {
    expect(collectBlockTags('no tags here')).toEqual([]);
  });
});

describe('removeTagFromText', () => {
  it('removes a trailing tag and its leading space', () => {
    expect(removeTagFromText('Marisha #person', 'person')).toBe('Marisha');
  });

  it('removes a tag in the middle without gluing words together', () => {
    expect(removeTagFromText('a #x b', 'x')).toBe('a b');
  });

  it('leaves a longer tag ALONE (#book vs #books)', () => {
    expect(removeTagFromText('read #books', 'book')).toBe('read #books');
    expect(removeTagFromText('join #book-club', 'book')).toBe('join #book-club');
  });

  it('removes the exact name when both it and a longer one are present', () => {
    expect(removeTagFromText('#book and #books', 'book')).toBe('and #books');
  });

  it('never touches a tag inside a page link', () => {
    expect(removeTagFromText('see [[#Person]] here', 'person')).toBe('see [[#Person]] here');
  });

  it('removes a real tag while leaving a link of the same name intact', () => {
    expect(removeTagFromText('#person met [[person]]', 'person')).toBe('met [[person]]');
  });

  it('is case-insensitive and accepts a #prefixed argument', () => {
    expect(removeTagFromText('hi #Person', '#PERSON')).toBe('hi');
  });

  it('removes only the FIRST occurrence', () => {
    expect(removeTagFromText('#x and #x', 'x')).toBe('and #x');
  });

  it('returns the text unchanged when the tag is absent', () => {
    expect(removeTagFromText('nothing here', 'person')).toBe('nothing here');
  });

  it('is stable across add/remove cycles (no whitespace drift)', () => {
    let t = 'Marisha Silva';
    t = `${t} #person`;
    expect(t).toBe('Marisha Silva #person');
    expect(removeTagFromText(t, 'person')).toBe('Marisha Silva');
    // Re-adding after a removal reproduces the identical string.
    expect(`${removeTagFromText(t, 'person')} #person`).toBe(t);
  });

  it('preserves multi-line block text', () => {
    expect(removeTagFromText('line one #x\nline two', 'x')).toBe('line one\nline two');
  });

  it('leaves an empty tag argument alone', () => {
    expect(removeTagFromText('text', '')).toBe('text');
  });
});
