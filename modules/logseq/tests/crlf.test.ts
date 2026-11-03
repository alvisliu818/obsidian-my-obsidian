import { describe, expect, it } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';

/**
 * CRLF (Windows) files: the parser's `$`-anchored regexes never matched a
 * trailing `\r`, so fences failed to open and every line fell into the
 * bare-line merge path — code blocks exploded into outline blocks, `#`
 * comments became headings. Regression: CRLF content must parse identically
 * to LF content, and saving must preserve the file's CRLF endings.
 */
describe('CRLF files', () => {
  const LF = [
    '# Title',
    '',
    '```python',
    '# a python comment, not a heading',
    'def f():',
    '    return "x * y"',
    '```',
    '',
    '- item one',
    '- item two',
    '',
    '> quote line',
    '',
    'key:: value',
  ].join('\n');

  const CRLF = LF.replace(/\n/g, '\r\n');

  it('parses CRLF exactly like LF (fences stay intact)', () => {
    const lf = parseDocument(LF);
    const crlf = parseDocument(CRLF);
    expect(crlf.crlf).toBe(true);
    expect(lf.crlf).toBeUndefined();
    // Same block kinds, same first lines (parsed model is \n-normalized).
    expect(crlf.blocks.map((b) => b.kind)).toEqual(lf.blocks.map((b) => b.kind));
    expect(crlf.blocks.map((b) => b.text)).toEqual(lf.blocks.map((b) => b.text));
    // The fence is ONE raw block containing the whole code, comment included.
    const fence = crlf.blocks.find((b) => b.text.includes('```python'));
    expect(fence?.kind).toBe('raw');
    expect(fence?.text).toContain('# a python comment, not a heading');
    expect(fence?.text.trimEnd().endsWith('```')).toBe(true);
    // The python comment never becomes a heading raw block of its own.
    expect(crlf.blocks.some((b) => b.kind === 'raw' && b.text.startsWith('# a python'))).toBe(false);
    // List items parse as list blocks without the `- ` marker in the text.
    const items = crlf.blocks.filter((b) => b.text === 'item one' || b.text === 'item two');
    expect(items).toHaveLength(2);
  });

  it('serializes a CRLF document back with CRLF endings', () => {
    const doc = parseDocument(CRLF);
    const out = serializeDocument(doc);
    // Every newline is \r\n — the file's endings survive the round-trip.
    expect(out.includes('\r\n')).toBe(true);
    expect(/\r?\n/.exec(out)?.[0]).toBe('\r\n');
    expect(/(?<!\r)\n/.test(out)).toBe(false);
    // The invariant: re-parsing the serialized text yields the same model.
    const again = parseDocument(out);
    expect(again.blocks.map((b) => [b.kind, b.text])).toEqual(doc.blocks.map((b) => [b.kind, b.text]));
  });

  it('leaves LF documents untouched', () => {
    const doc = parseDocument(LF);
    const out = serializeDocument(doc);
    expect(doc.crlf).toBeUndefined();
    expect(/(?<!\r)\n/.test(out)).toBe(true);
    expect(out.includes('\r')).toBe(false);
  });

  it('handles a lone trailing \\r and mixed endings', () => {
    const doc = parseDocument('```python\r\ncode = 1\r\n```\n\r- mixed line\r');
    expect(doc.crlf).toBe(true);
    const fence = doc.blocks.find((b) => b.text.includes('```python'));
    expect(fence?.kind).toBe('raw');
  });
});
