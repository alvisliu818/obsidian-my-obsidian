/**
 * Inline memo predicates (batch 27): `((text))` with a non-UUID payload is a
 * memo; the UUID form belongs to block refs. Pure judgement — the CM dispatch
 * layer (textSelectionMenu.memoToggleSelection) and the static render pass
 * (features/links.enhanceInlineMemos) both branch on these.
 */

import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { isBlockRefForm, isMemoPayload, isMemoSpanAt } from '../src/interactions/inlineMemo';

const docOf = (s: string) => EditorState.create({ doc: s }).doc;

describe('isBlockRefForm', () => {
  it('accepts canonical UUID forms (both cases)', () => {
    expect(isBlockRefForm('0e6343ea-31f3-4b3a-a3f5-c2b9ea0a5d1e')).toBe(true);
    expect(isBlockRefForm('0E6343EA-31F3-4B3A-A3F5-C2B9EA0A5D1E')).toBe(true);
  });
  it('rejects near-UUID shapes', () => {
    expect(isBlockRefForm('0e6343ea-31f3-4b3a-a3f5-c2b9ea0a5d1')).toBe(false);
    expect(isBlockRefForm('0e6343ea31f34b3aa3f5c2b9ea0a5d1e')).toBe(false);
    expect(isBlockRefForm('note')).toBe(false);
    expect(isBlockRefForm('')).toBe(false);
  });
});

describe('isMemoPayload', () => {
  it('accepts free text (including CJK and spaces)', () => {
    expect(isMemoPayload('memo here')).toBe(true);
    expect(isMemoPayload('中文备注')).toBe(true);
    expect(isMemoPayload('a')).toBe(true);
  });
  it('rejects empty, newline, parens and UUID payloads', () => {
    expect(isMemoPayload('')).toBe(false);
    expect(isMemoPayload('two\nlines')).toBe(false);
    expect(isMemoPayload('nested (parens)')).toBe(false);
    expect(isMemoPayload('0e6343ea-31f3-4b3a-a3f5-c2b9ea0a5d1e')).toBe(false);
  });
});

describe('isMemoSpanAt', () => {
  const TEXT = 'aa ((memo here)) bb';
  const start = TEXT.indexOf('((') + 2;
  const end = start + 'memo here'.length;

  it('true for an exact selection inside a pair', () => {
    expect(isMemoSpanAt(docOf(TEXT), start, end)).toBe(true);
  });
  it('false for a UUID pair', () => {
    const T2 = 'x ((0e6343ea-31f3-4b3a-a3f5-c2b9ea0a5d1e)) y';
    const s2 = T2.indexOf('((') + 2;
    expect(isMemoSpanAt(docOf(T2), s2, s2 + 36)).toBe(false);
  });
  it('false for partial selections', () => {
    expect(isMemoSpanAt(docOf(TEXT), start, start + 4)).toBe(false);
    expect(isMemoSpanAt(docOf(TEXT), start + 1, end)).toBe(false);
  });
  it('false without a wrapping pair', () => {
    expect(isMemoSpanAt(docOf('plain memo text'), 6, 10)).toBe(false);
  });
  it('false when the payload itself is invalid', () => {
    const T3 = 'aa ((a(b)c)) bb';
    const s3 = T3.indexOf('((') + 2;
    expect(isMemoSpanAt(docOf(T3), s3, s3 + 'a(b)c'.length)).toBe(false);
  });
});
