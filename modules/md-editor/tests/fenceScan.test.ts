/**
 * 围栏逐行扫描（core/fenceScan）单测：开/闭切换、marker 一致性、缩进、
 * 围栏内开行不切 marker、splitByFences 分桶。
 */
import { describe, expect, it } from 'vitest';
import { scanLinesWithFences, splitByFences } from '../src/core/fenceScan';

const collect = (lines: string[]): Array<{ text: string; inFence: boolean }> => {
	const out: Array<{ text: string; inFence: boolean }> = [];
	scanLinesWithFences((n) => lines[n - 1] ?? '', lines.length, (text, inFence, n) => {
		out.push({ text, inFence });
		void n;
	});
	return out;
};

describe('scanLinesWithFences', () => {
	it('无围栏：全部 outside', () => {
		const got = collect(['a', 'b', 'c']);
		expect(got.every((x) => !x.inFence)).toBe(true);
	});

	it('``` 开闭切换', () => {
		const got = collect(['x', '```', 'code', '```', 'y']);
		expect(got.map((x) => x.inFence)).toEqual([false, false, true, false, false]);
	});

	it('~~~ 同款', () => {
		const got = collect(['~~~', 'a', '~~~']);
		expect(got.map((x) => x.inFence)).toEqual([false, true, false]);
	});

	it('围栏内开新围栏不切 marker（嵌套不支持,与旧行为一致）', () => {
		const got = collect(['```', 'inner ~~~', 'still', '```', 'after']);
		expect(got.map((x) => x.inFence)).toEqual([false, true, true, false, false]);
	});

	it('缩进围栏（可缩进开）', () => {
		const got = collect(['  ```', 'a', '  ```']);
		expect(got.map((x) => x.inFence)).toEqual([false, true, false]);
	});

	it('~~~ 块内 ``` 行不闭合（marker 一致性）', () => {
		const got = collect(['~~~', '```', 'x', '~~~']);
		expect(got.map((x) => x.inFence)).toEqual([false, true, true, false]);
	});

	it('围栏开行与闭行本身 = outside', () => {
		const got = collect(['```', 'x', '```']);
		expect(got[0].inFence).toBe(false);
		expect(got[2].inFence).toBe(false);
	});
});

describe('splitByFences', () => {
	it('分桶且保留 0 起索引', () => {
		const { outside, inside } = splitByFences(['a', '```', 'b', '```', 'c']);
		expect(outside.map((x) => x.index)).toEqual([0, 1, 3, 4]);
		expect(inside.map((x) => x.index)).toEqual([2]);
	});
});
