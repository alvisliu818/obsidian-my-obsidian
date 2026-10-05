/**
 * Round-trip probe for the Logseq-export copy ("- - # 标题" double-marker
 * headings): parse + serialize must be IDENTICAL to the input — any diff is
 * what the plugin's save writes over the user's file.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { parseDocument } from '../src/core/parser';
import { serializeDocument, serializeBlock } from '../src/core/serializer';

const FILE = 'E:/HOME/BaiduSyncdisk/大模型/尚硅谷大模型技术之深度学习2.2.0-Logseq - 副本.md';

// Representative double-marker structure (the 副本 file's head): tab-indented
// Logseq format with `- - # 标题` headings.
const DOUBLE_MARKER_FIXTURE =
  '- - # 尚硅谷大模型技术之深度学习\n' +
  '\t- **作者**：尚硅谷研究院　　**版本**：V2.2.0\n' +
  '- - # 第 1 章 深度学习概述\n' +
  '\t- ## 幻灯片 1：深度学习概述\n' +
  '\t\t- ![](media/ppt/ppt1_slide01.png)\n' +
  '\t- ## 幻灯片 2：什么是深度学习\n';

describe('副本 round-trip', () => {
  it('parse→serialize is byte-stable for the double-marker format', () => {
    // Live assertion against the user's vault copy when it exists; the
    // inline fixture keeps the regression guard when it doesn't.
    if (!existsSync(FILE)) {
      const doc = parseDocument(DOUBLE_MARKER_FIXTURE);
      expect(serializeDocument(doc)).toBe(DOUBLE_MARKER_FIXTURE);
      return;
    }
    const md = readFileSync(FILE, 'utf8');
    const out = serializeDocument(parseDocument(md));
    expect(out).toBe(md);
  });

  it('minimal double-marker case round-trips', () => {
    // The serializer preserves the file's trailing newline.
    const md = '- - # 标题\n\t- 子项\n';
    expect(serializeDocument(parseDocument(md))).toBe(md);
  });

  it('shows what the serializer does to a double-marker line', () => {
    const md = '- - # 标题\n';
    const doc = parseDocument(md);
    // eslint-disable-next-line no-console
    console.log('block text:', JSON.stringify(doc.blocks[0]?.text));
    console.log('children:', (doc.blocks[0]?.children ?? []).map((c) => JSON.stringify(c.text.slice(0, 30))));
    console.log('serialized:', JSON.stringify(serializeDocument(doc)));
  });

  it('single-block commit (serializeBlock) does not add a dash', () => {
    // The editing-commit path: the block parses from the file line "- - # 标题"
    // with text "- # 标题"; committing it must re-emit the SAME line.
    const doc = parseDocument('- - # 标题\n\t- 子项\n');
    const b0 = doc.blocks[0];
    const out = serializeBlock(b0, 0);
    // eslint-disable-next-line no-console
    console.log('serializeBlock output:', JSON.stringify(out));
    expect(out).toBe('- - # 标题\n\t- 子项');
  });
});
