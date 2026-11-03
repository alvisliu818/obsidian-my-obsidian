/**
 * Round-trip probe for the ORIGINAL Logseq file (single-dash "- # 标题"):
 * parse + serialize must be byte-stable — the plugin loads and saves the
 * file through this path, so any diff = what the plugin writes over it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';

const FILE = 'E:/HOME/BaiduSyncdisk/大模型/尚硅谷大模型技术之深度学习2.2.0-Logseq.md';

describe('原版 round-trip', () => {
  it('parse→serialize is byte-stable for the original single-dash file', () => {
    const md = readFileSync(FILE, 'utf8');
    const out = serializeDocument(parseDocument(md));
    if (out !== md) {
      // write the diff inputs for inspection
      writeFileSync('tests/_original-input.md', md, 'utf8');
      writeFileSync('tests/_original-output.md', out, 'utf8');
    }
    expect(out).toBe(md);
  });
});
