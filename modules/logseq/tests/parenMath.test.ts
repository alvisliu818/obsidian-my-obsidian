/**
 * `\( … \)` span detection — the one pure piece of features/parenMath.
 *
 * Everything else in that module needs a live CM6 view or a DOM, so the rules
 * that decide WHAT is a formula live here and are asserted directly: the
 * delimiters, the empty-body rule, the escaped-backslash rule, and (most
 * importantly) that a stray unclosed `\(` does not eat the rest of the line.
 */

import { describe, expect, it } from 'vitest';
import { parenMathSpans } from '../src/features/parenMath';

describe('parenMathSpans', () => {
  it('finds one inline formula', () => {
    expect(parenMathSpans('质能方程 \\(E=mc^2\\) 成立')).toEqual([
      { from: 5, to: 15, body: 'E=mc^2' },
    ]);
  });

  it('finds several on one line, never greedy', () => {
    const spans = parenMathSpans('\\(a\\) + \\(b\\)');
    expect(spans.map((s) => s.body)).toEqual(['a', 'b']);
    expect(spans[0]!.to).toBeLessThan(spans[1]!.from);
  });

  it('an empty body is not a formula', () => {
    expect(parenMathSpans('\\(\\)')).toEqual([]);
    expect(parenMathSpans('\\(  \\)')).toEqual([]);
  });

  it('an unclosed delimiter renders nothing — it must not swallow the line', () => {
    expect(parenMathSpans('开头 \\( 后面还有一整句话，没有收尾')).toEqual([]);
  });

  it('a formula never spans lines', () => {
    expect(parenMathSpans('\\(a\nb\\)')).toEqual([]);
  });

  it('an escaped backslash is not a delimiter', () => {
    expect(parenMathSpans('\\\\(x\\\\)')).toEqual([]);
  });

  it('dollar math is left to the existing pipeline', () => {
    expect(parenMathSpans('$x$ 与 $$y$$')).toEqual([]);
  });
});
