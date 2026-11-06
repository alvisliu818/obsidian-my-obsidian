import { readFileSync } from 'node:fs';
import { parseDocument } from '../src/core/parser';
const file = 'E:/HOME/BaiduSyncdisk/260817/10_尚硅谷AI大模型之NLP/1.笔记/尚硅谷大模型技术之NLP笔记/尚硅谷大模型技术之NLP笔记 - 副本.md';
const src = readFileSync(file, 'utf-8');
const doc = parseDocument(src);
const find = (bs: any[]): any | null => {
  for (const b of bs) {
    if ((b.text || '').includes('image38')) return b;
    const hit = find(b.children ?? []);
    if (hit) return hit;
  }
  return null;
};
const blk = find(doc.blocks)!;
const at = blk.text.indexOf('image38');
console.log('=== 块内 image38 前后文本 ===');
console.log(blk.text.slice(Math.max(0, at - 120), at + 160).split('\n').map((l: string, i: number) => `${i}: ${l}`).join('\n'));
console.log('=== 原文第 1000-1001 行（原样, 显示行首空格）===');
const lines = src.split('\n');
console.log(JSON.stringify(lines[999]));
console.log(JSON.stringify(lines[1000]));
console.log('=== 块的首行 ===');
console.log(JSON.stringify(blk.text.split('\n')[0].slice(0, 60)));
