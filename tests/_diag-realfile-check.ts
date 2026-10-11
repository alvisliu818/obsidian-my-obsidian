// 用新 parser 解析真实 NLP 副本, 验证跨行 img 全部完好（诊断脚本, 非 vitest 用例）
import { readFileSync } from 'node:fs';
import { parseDocument } from '../src/core/parser';
import { serializeDocument } from '../src/core/serializer';

const file = 'E:/HOME/BaiduSyncdisk/260817/10_尚硅谷AI大模型之NLP/1.笔记/尚硅谷大模型技术之NLP笔记/尚硅谷大模型技术之NLP笔记 - 副本.md';
const src = readFileSync(file, 'utf-8');
const doc = parseDocument(src);
const out = serializeDocument(doc);
const out2 = serializeDocument(parseDocument(out));

console.log('幂等(parse∘serialize 不再变化):', out2 === out);
console.log('出现 "- style=" 类损坏:', /^-\s*style=/m.test(out));
const srcImgs = src.match(/<img[^>]*\n[^>]*\/>/g) ?? [];
let intact = 0, split = 0;
for (const frag of srcImgs) (out.includes(frag) ? intact++ : split++);
console.log(`跨行 img 共 ${srcImgs.length} 个: 保持原样 ${intact}, 被改动 ${split}`);
console.log('img 总数(原文/输出):', (src.match(/<img/g) || []).length, '/', (out.match(/<img/g) || []).length);
const idx = out.indexOf('<img src="media/image1.png"');
console.log('--- 样例输出形态 ---');
console.log(JSON.stringify(out.slice(idx, idx + 90)));
