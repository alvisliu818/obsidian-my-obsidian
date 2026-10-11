import { readFileSync } from 'node:fs';
import { parseDocument } from '../src/core/parser';
const file = 'E:/HOME/BaiduSyncdisk/260817/10_尚硅谷AI大模型之NLP/1.笔记/尚硅谷大模型技术之NLP笔记/尚硅谷大模型技术之NLP笔记 - 副本.md';
const src = readFileSync(file, 'utf-8');
const doc = parseDocument(src);
const d = (b: any, out: string[], ind = '') => {
  out.push(ind + '[' + b.kind + '] ' + JSON.stringify((b.text || '').split('\n').join('⏎')).slice(0, 130));
  (b.children ?? []).forEach((c: any) => d(c, out, ind + '  '));
};
const out: string[] = [];
doc.blocks.forEach((b) => d(b, out));
// 打印包含 image38 的块及其前后各 1 个
const hit = out.findIndex((l) => l.includes('image38'));
console.log(out.slice(Math.max(0, hit - 2), hit + 3).join('\n'));
