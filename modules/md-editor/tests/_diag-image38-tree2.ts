import { readFileSync } from 'node:fs';
import { parseDocument } from '../src/core/parser';
const file = 'E:/HOME/BaiduSyncdisk/260817/10_尚硅谷AI大模型之NLP/1.笔记/尚硅谷大模型技术之NLP笔记/尚硅谷大模型技术之NLP笔记 - 副本.md';
const src = readFileSync(file, 'utf-8');
console.log('文件行数:', src.split('\n').length);
const doc = parseDocument(src);
console.log('顶层块数:', doc.blocks.length);
const count = (bs: any[]): number => bs.reduce((n, b) => n + 1 + count(b.children ?? []), 0);
console.log('全部块数:', count(doc.blocks));
// 找含 image38 的块（全文搜索, 不截断）
const find = (bs: any[], path: string[]): any | null => {
  for (const b of bs) {
    if ((b.text || '').includes('image38')) return b;
    const hit = find(b.children ?? [], [...path, 'child']);
    if (hit) return hit;
  }
  return null;
};
const blk = find(doc.blocks, []);
if (!blk) { console.log('未找到含 image38 的块'); process.exit(0); }
console.log('含 image38 的块 kind:', blk.kind, '父链深度:', (() => { let d = 0, p = blk.parent; while (p) { d++; p = p.parent; } return d; })());
console.log('块文本(前 400 字):');
console.log(blk.text.slice(0, 400));
