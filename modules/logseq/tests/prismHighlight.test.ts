import { describe, it, expect } from 'vitest';
import Prism from 'prismjs';
import { prismGrammarFor, flattenTokens, enhanceCallNames } from '../src/blocks/prismHighlight';

describe('prismGrammarFor', () => {
  it('resolves core and aliased languages', () => {
    expect(prismGrammarFor('python')).not.toBeNull();
    expect(prismGrammarFor('PY')).not.toBeNull(); // case-insensitive
    expect(prismGrammarFor('py')).not.toBeNull(); // alias
    expect(prismGrammarFor('typescript')).not.toBeNull();
    expect(prismGrammarFor('rs')).not.toBeNull(); // rust alias
    expect(prismGrammarFor('c++')).not.toBeNull(); // cpp alias
    expect(prismGrammarFor('md')).not.toBeNull(); // markdown alias
  });

  it('returns null for unknown languages', () => {
    expect(prismGrammarFor('')).toBeNull();
    expect(prismGrammarFor('not-a-language')).toBeNull();
  });
});

describe('flattenTokens', () => {
  it('produces absolute ranges matching the token classes', () => {
    const text = 'import os\nx = 1  # note';
    const tokens = Prism.tokenize(text, prismGrammarFor('python')!);
    const flat: Array<{ from: number; to: number; type: string }> = [];
    flattenTokens(tokens, 0, flat);
    const byText = new Map(flat.map((f) => [text.slice(f.from, f.to), f.type]));

    expect(byText.get('import')).toBe('keyword');
    expect(byText.get('os')).toBeUndefined(); // plain text in Prism python — reading-view parity
    expect(byText.get('=')).toBe('operator');
    expect(byText.get('1')).toBe('number');
    expect(byText.get('# note')).toBe('comment');
  });

  it('advances past plain strings so nested ranges stay absolute', () => {
    const text = 'a = "hi"';
    const tokens = Prism.tokenize(text, prismGrammarFor('python')!);
    const flat: Array<{ from: number; to: number; type: string }> = [];
    flattenTokens(tokens, 0, flat);
    const str = flat.find((f) => f.type === 'string');
    expect(str).toBeDefined();
    expect(text.slice(str!.from, str!.to)).toBe('"hi"');
  });
});

describe('enhanceCallNames', () => {
  it('marks a plain identifier before a ( punctuation token as function (reading-view parity)', () => {
    const text = 'ds = TensorDataset(x, y)';
    const tokens = Prism.tokenize(text, prismGrammarFor('python')!);
    const flat: Array<{ from: number; to: number; type: string }> = [];
    flattenTokens(tokens, 0, flat);
    const extra = enhanceCallNames(flat, text);
    const fn = extra.find((f) => f.type === 'function');
    expect(fn).toBeDefined();
    expect(text.slice(fn!.from, fn!.to)).toBe('TensorDataset');
  });

  it('does not mark keywords before parentheses', () => {
    const text = 'if (x): pass';
    const tokens = Prism.tokenize(text, prismGrammarFor('python')!);
    const flat: Array<{ from: number; to: number; type: string }> = [];
    flattenTokens(tokens, 0, flat);
    const extra = enhanceCallNames(flat, text);
    expect(extra).toHaveLength(0);
  });
});
