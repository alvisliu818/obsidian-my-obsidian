import { describe, expect, it } from 'vitest';
import { blockEmbedSyntax, blockMarkdown, blocksEmbedSyntax, blocksMarkdown } from '../src/features/copyFormats';
import { createBlock } from '../src/types';

describe('blockEmbedSyntax', () => {
  it('assigns an id and wraps it in {{embed ((uuid))}}', () => {
    const b = createBlock('hello');
    const s = blockEmbedSyntax(b);
    expect(b.props['id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(s).toBe(`{{embed ((${b.props['id']}))}}`);
  });

  it('reuses an existing id', () => {
    const b = createBlock('hello');
    b.props['id'] = 'abc';
    expect(blockEmbedSyntax(b)).toBe('{{embed ((abc))}}');
  });
});

describe('blockMarkdown / blocksMarkdown', () => {
  it('serializes a block with its whole sub-tree', () => {
    const child = createBlock('b');
    const parent = createBlock('a');
    parent.children.push(child);
    child.parent = parent;
    expect(blockMarkdown(parent)).toBe('- a\n\t- b');
  });

  it('joins several blocks one per line', () => {
    const a = createBlock('a');
    const b = createBlock('b');
    expect(blocksMarkdown([a, b])).toBe('- a\n- b');
  });
});

describe('blocksEmbedSyntax', () => {
  it('emits one embed per line', () => {
    const a = createBlock('a');
    const b = createBlock('b');
    a.props['id'] = 'id-a';
    b.props['id'] = 'id-b';
    expect(blocksEmbedSyntax([a, b])).toBe('{{embed ((id-a))}}\n{{embed ((id-b))}}');
  });
});
