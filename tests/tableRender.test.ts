import { describe, expect, it } from 'vitest';
import { withTableSeparation, withQuoteRowSeparation } from '../src/blocks/renderTree';

describe('withTableSeparation', () => {
  it('leaves text without pipe rows untouched', () => {
    expect(withTableSeparation('plain text\nsecond line')).toBe('plain text\nsecond line');
  });

  it('leaves a table at block start untouched (already parses)', () => {
    const t = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(withTableSeparation(t)).toBe(t);
  });

  it('leaves a table already preceded by a blank line untouched', () => {
    const t = 'text\n\n| a | b |\n| --- | --- |';
    expect(withTableSeparation(t)).toBe(t);
  });

  it('inserts a blank line when a table hugs the block first line (Logseq md)', () => {
    expect(withTableSeparation('data\n| Name | Age |\n| --- | --- |\n| Alice | 30 |')).toBe(
      'data\n\n| Name | Age |\n| --- | --- |\n| Alice | 30 |',
    );
  });

  it('does not split on a lone pipe row without a delimiter row', () => {
    const t = 'text\n| just one row |';
    expect(withTableSeparation(t)).toBe(t);
  });

  it('does not treat setext underlines after non-pipe text as tables', () => {
    const t = 'Title\n---';
    expect(withTableSeparation(t)).toBe(t);
  });

  it('never inserts inside a code fence', () => {
    const t = '```\n| a | b |\n| --- | --- |\n```\n| x | y |\n| --- | --- |';
    expect(withTableSeparation(t)).toBe('```\n| a | b |\n| --- | --- |\n```\n\n| x | y |\n| --- | --- |');
  });

  it('handles delimiter rows without outer pipes and with alignment colons', () => {
    expect(withTableSeparation('data\n| a | b |\n|:---|---:|')).toBe('data\n\n| a | b |\n|:---|---:|');
  });

  it('handles multiple tables in one block', () => {
    const t = 'one\n| a |\n| - |\ntwo\n| b |\n| - |';
    expect(withTableSeparation(t)).toBe('one\n\n| a |\n| - |\ntwo\n\n| b |\n| - |');
  });
});

describe('withQuoteRowSeparation', () => {
  it('splits a trailing lone ">" into its own visible empty blockquote', () => {
    const src = '> 示例代码：浅拷贝\n>';
    const out = withQuoteRowSeparation(src);
    expect(out).toBe('> 示例代码：浅拷贝\n\n>');
    // The empty blockquote then renders with no element children → CSS min-height.
  });

  it('separates mid-quote empty ">" lines', () => {
    expect(withQuoteRowSeparation('> a\n>\n> b')).toBe('> a\n\n>\n> b');
  });

  it('never touches quote lines with content', () => {
    expect(withQuoteRowSeparation('> a\n> b')).toBe('> a\n> b');
  });

  it('skips empty ">" lines inside fences', () => {
    const src = '```\n>\n```\n>\n';
    expect(withQuoteRowSeparation(src)).toBe(src);
  });
});
