/**
 * Block properties as text (Logseq md parity): trailing `key:: value` lines
 * in the editor doc become block properties on commit, structural props
 * (id/collapsed/style) survive every commit untouched.
 */

import { describe, expect, it } from 'vitest';
import {
  applyBlockProps,
  blockEditorDoc,
  editableProps,
  propsShallowEqual,
  splitPropLines,
  type Block,
} from '../src/types';

const block = (text: string, props: Record<string, string> = {}): Block => ({
  text,
  props,
  children: [],
  parent: null,
  kind: 'list',
  marker: null,
});

describe('splitPropLines', () => {
  it('extracts a single trailing prop line', () => {
    const r = splitPropLines('body text\npriority:: high');
    expect(r.text).toBe('body text');
    expect(r.props).toEqual({ priority: 'high' });
  });

  it('extracts a run of trailing prop lines', () => {
    const r = splitPropLines('body\na:: 1\nb:: 2');
    expect(r.text).toBe('body');
    expect(r.props).toEqual({ a: '1', b: '2' });
  });

  it('extracts props from a props-only body (text becomes empty)', () => {
    const r = splitPropLines('type:: book');
    expect(r.text).toBe('');
    expect(r.props).toEqual({ type: 'book' });
  });

  it('returns no props for plain text', () => {
    expect(splitPropLines('just text').props).toEqual({});
    expect(splitPropLines('just text').text).toBe('just text');
  });

  it('does not touch prop-shaped lines in the middle of the text', () => {
    const r = splitPropLines('a:: one\nmore text\nb:: two');
    expect(r.text).toBe('a:: one\nmore text');
    expect(r.props).toEqual({ b: 'two' });
  });

  it('supports empty values and value with :: inside', () => {
    expect(splitPropLines('x\nempty::').props).toEqual({ empty: '' });
    expect(splitPropLines('x\nurl:: http://a::b').props).toEqual({ url: 'http://a::b' });
  });

  it('rejects keys that do not start with a letter (timestamps)', () => {
    expect(splitPropLines('x\n12::30').props).toEqual({});
  });

  it('extracts the trailing prop run even after a blank line', () => {
    // The trailing run starts at the last line; the blank line stays body text.
    const r = splitPropLines('body\n\npriority:: high');
    expect(r.text).toBe('body\n');
    expect(r.props).toEqual({ priority: 'high' });
  });
});

describe('applyBlockProps', () => {
  it('replaces editable props and preserves structural ones', () => {
    const b = block('text', { id: 'abc-1', collapsed: 'true', old: 'x' });
    applyBlockProps(b, { fresh: 'y' });
    expect(b.props).toEqual({ id: 'abc-1', collapsed: 'true', fresh: 'y' });
  });

  it('drops editable props that were deleted from the text', () => {
    const b = block('text', { id: 'abc-1', priority: 'high' });
    applyBlockProps(b, {});
    expect(b.props).toEqual({ id: 'abc-1' });
  });
});

describe('blockEditorDoc', () => {
  it('appends one `key:: value` line per editable prop', () => {
    expect(blockEditorDoc(block('body', { priority: 'high', empty: '' }))).toBe(
      'body\npriority:: high\nempty::',
    );
  });

  it('omits structural props (they have their own UI)', () => {
    expect(blockEditorDoc(block('body', { id: 'abc-1', collapsed: 'true' }))).toBe('body');
  });

  it('returns only prop lines for a props-only block', () => {
    expect(blockEditorDoc(block('', { type: 'book' }))).toBe('type:: book');
  });
});

describe('editableProps / propsShallowEqual', () => {
  it('editableProps filters structural props', () => {
    expect(editableProps(block('t', { id: 'x', a: '1' }))).toEqual({ a: '1' });
  });

  it('propsShallowEqual compares by entries', () => {
    expect(propsShallowEqual({ a: '1' }, { a: '1' })).toBe(true);
    expect(propsShallowEqual({ a: '1' }, { a: '2' })).toBe(false);
    expect(propsShallowEqual({ a: '1' }, { a: '1', b: '2' })).toBe(false);
  });
});
