/**
 * Heading-with-dash parse probe: what does the parser produce for
 * "- # 标题" (a list marker followed by a heading)? The 副本 file's
 * "- - # 标题" lines suggest the serializer re-emits "- " + text where the
 * text KEPT its own "- " — i.e. the parse of "- # 标题" does not consume the
 * marker the way the serializer expects.
 */
import { describe, it, expect } from 'vitest';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';

describe('heading-with-dash parse probe', () => {
  it('parses and serializes "- # 标题"', () => {
    const doc = parseDocument('- # 标题\n');
    const b = doc.blocks[0];
    // eslint-disable-next-line no-console
    console.log('kind:', b?.kind, 'text:', JSON.stringify(b?.text), 'children:', b?.children?.length);
    // eslint-disable-next-line no-console
    console.log('serialized:', JSON.stringify(serializeDocument(doc)));
  });

  it('parses and serializes "- - # 标题" (the copy file state)', () => {
    const doc = parseDocument('- - # 标题\n');
    const b = doc.blocks[0];
    // eslint-disable-next-line no-console
    console.log('kind:', b?.kind, 'text:', JSON.stringify(b?.text), 'children:', b?.children?.length);
    // eslint-disable-next-line no-console
    console.log('serialized:', JSON.stringify(serializeDocument(doc)));
  });

  it('round-trips the original head (first 6 lines)', () => {
    const md = '- # 尚硅谷大模型技术之深度学习\n  - **作者**：尚硅谷研究院　　**版本**：V2.2.0\n- # 第 1 章 深度学习概述\n  - ## 幻灯片 1：深度学习概述\n    - ![](media/ppt/ppt1_slide01.png)\n  - ## 幻灯片 2：什么是深度学习\n';
    const doc = parseDocument(md);
    const out = serializeDocument(doc);
    // eslint-disable-next-line no-console
    console.log('OUT:', JSON.stringify(out));
    expect(out).toBe(md);
  });
});
