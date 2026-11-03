import { describe, expect, it } from 'vitest';
import { withTableSeparation } from '../src/blocks/renderTree';

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
