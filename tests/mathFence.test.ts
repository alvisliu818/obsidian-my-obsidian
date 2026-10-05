/**
 * Display math fences (`$$` on its own line) must survive as ONE block.
 *
 * Regression: `$$` matches STRUCTURAL_RAW_RE, but the LaTeX body between the
 * delimiters usually does not — a bare `\nabla f(x1,x2)=…` line parses as an
 * ordinary top-level line. The parser therefore emitted THREE sibling blocks
 * (raw `$$`, bare formula, raw `$$`), so the renderer saw a lone delimiter and
 * a naked formula string instead of one math block. Real-world case: the
 * 尚硅谷大模型技术之深度学习2.2.0 note, where every formula rendered as raw
 * `$$` / `\frac{…}` / `$$` text.
 */
import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';

describe('display math fences', () => {
  it('keeps a top-level $$…$$ region as one raw block', () => {
    const doc = parseDocument(
      [
        '梯度为：',
        '',
        '$$',
        '\\nabla f(x1,x2)=[  \\frac{\\partial f}{\\partial{x}_{1}} ]',
        '$$',
        '',
        '则可以按下式进行更新：',
      ].join('\n'),
    );

    expect(doc.blocks).toHaveLength(3);
    expect(doc.blocks[1].kind).toBe('raw');
    expect(doc.blocks[1].text).toBe(
      '$$\n\\nabla f(x1,x2)=[  \\frac{\\partial f}{\\partial{x}_{1}} ]\n$$',
    );
  });

  it('never splits the formula body out of the math block', () => {
    const doc = parseDocument('$$\n{x}_{1}^{\\prime}={x}_{1}-\\eta\\frac{\\partial f}{\\partial{x}_{1}}\n$$');
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].text.split('\n')).toHaveLength(3);
    expect(doc.blocks[0].text).toContain('\\eta');
  });

  it('keeps consecutive math blocks in one raw region (matches code fences)', () => {
    // A blank line inside raw content is verbatim, so two math blocks
    // separated by a blank line land in ONE raw block — exactly how two
    // adjacent ``` fences already behave. The renderer still sees two
    // separate `$$…$$` regions, which is what matters for MathJax.
    const doc = parseDocument(['$$', 'a=1', '$$', '', '$$', 'b=2', '$$'].join('\n'));
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].text).toBe('$$\na=1\n$$\n\n$$\nb=2\n$$');

    // A non-blank line between them does separate them.
    const two = parseDocument(['$$', 'a=1', '$$', '中间', '$$', 'b=2', '$$'].join('\n'));
    expect(two.blocks.length).toBeGreaterThan(1);
  });

  it('folds an indented math block into its parent list block', () => {
    const doc = parseDocument(['- 梯度为：', '  $$', '  a=1', '  $$'].join('\n'));
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].kind).toBe('list');
    expect(doc.blocks[0].text).toBe('梯度为：\n$$\na=1\n$$');
  });

  it('leaves single-line $$x$$ inline math on the normal bare-line path', () => {
    const doc = parseDocument('行内公式 $$x^2$$ 结束');
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].text).toBe('行内公式 $$x^2$$ 结束');
  });

  it('serializes a math block without mangling the LaTeX body', () => {
    // The serializer emits the compact Logseq form (no blank lines between
    // blocks) — same as a code fence. The file's trailing newline is
    // preserved on save (1-byte fidelity). What matters is that the `$$`
    // delimiters and every LaTeX byte survive verbatim.
    const md = ['- 段落', '', '$$', '\\sigma(x)=\\frac{1}{1+{e}^{-x}}', '$$', '', '- 结束', ''].join('\n');
    const out = serializeDocument(parseDocument(md));
    expect(out).toBe('- 段落\n$$\n\\sigma(x)=\\frac{1}{1+{e}^{-x}}\n$$\n- 结束\n');
    // Re-parsing the serialized form yields the same math block (stable).
    expect(parseDocument(out).blocks[1].text).toBe('$$\n\\sigma(x)=\\frac{1}{1+{e}^{-x}}\n$$');
  });

  it('swallows to EOF on an unterminated math fence', () => {
    const doc = parseDocument(['$$', 'a=1', 'b=2'].join('\n'));
    expect(doc.blocks).toHaveLength(1);
    expect(doc.blocks[0].text).toBe('$$\na=1\nb=2');
  });
});
