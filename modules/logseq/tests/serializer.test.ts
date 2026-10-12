import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeBlockContent } from '../src/core/serializer';
import { linkParents } from '../src/core/treeOps';

function block(md: string, index = 0) {
  const doc = parseDocument(md);
  linkParents(doc.blocks);
  return doc.blocks[index];
}

describe('serializeBlockContent', () => {
  it('renders children as a top-level list under the block text', () => {
    const b = block('- parent\n\t- child\n\t\t- grandchild\n');
    expect(serializeBlockContent(b)).toBe('parent\n\n- child\n\t- grandchild');
  });

  it('keeps a single-line block as plain text', () => {
    expect(serializeBlockContent(block('- only me\n'))).toBe('only me');
  });

  it('hides id/collapsed bookkeeping props of the subtree', () => {
    const b = block('- parent\n\t- child\n\t\tid:: 1234\n\t\tcollapsed:: true\n\t\tdue:: monday\n');
    expect(serializeBlockContent(b)).toBe('parent\n\n- child\n\tdue:: monday');
  });
});
