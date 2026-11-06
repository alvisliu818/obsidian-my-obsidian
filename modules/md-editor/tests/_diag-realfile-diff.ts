import { readFileSync } from 'node:fs';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';
const file = 'E:/HOME/BaiduSyncdisk/260817/10_尚硅谷AI大模型之NLP/1.笔记/尚硅谷大模型技术之NLP笔记/尚硅谷大模型技术之NLP笔记 - 副本.md';
const src = readFileSync(file, 'utf-8');
const out = serializeDocument(parseDocument(src));
const srcImgs = src.match(/<img[^>]*\n[^>]*\/>/g) ?? [];
srcImgs.forEach((frag, i) => {
  if (!out.includes(frag)) {
    console.log(`=== 第 ${i + 1} 个跨行 img 被改动 ===`);
    console.log('原文片段:', JSON.stringify(frag));
    const head = frag.split('\n')[0];
    const idx = out.indexOf(head);
    console.log('输出中的后续:', idx < 0 ? '(首行也找不到!)' : JSON.stringify(out.slice(idx, idx + 140)));
  }
});
