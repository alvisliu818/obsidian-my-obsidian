/**
 * 新建文件序号防撞（withSequence）单测：
 * 默认名重名 → untitled_0/1/2…；无重名 → 原样；上限兜底。
 */
import { describe, expect, it } from 'vitest';
import { withSequence } from '../src/panels/promptModals';

describe('withSequence', () => {
	it('无重名 → 原样', () => {
		expect(withSequence('untitled.md', () => false)).toBe('untitled.md');
	});

	it('重名 → _0', () => {
		const existing = new Set(['untitled.md']);
		expect(withSequence('untitled.md', (c) => existing.has(c))).toBe('untitled.md_0');
	});

	it('连续重名 → _1/_2 递增', () => {
		const existing = new Set(['untitled.md', 'untitled.md_0', 'untitled.md_1']);
		expect(withSequence('untitled.md', (c) => existing.has(c))).toBe('untitled.md_2');
	});

	it('间隙跳过（_0 占用,_1 空则取 _1）', () => {
		const existing = new Set(['a.md', 'a.md_0', 'a.md_2']);
		expect(withSequence('a.md', (c) => existing.has(c))).toBe('a.md_1');
	});

	it('上限 1000 兜底返回原 base', () => {
		// 所有 _N 候选都算占用 → 循环耗尽 → 兜底返回原 base
		const got = withSequence('x.md', (c) => /_\d+$/.test(c));
		expect(got).toBe('x.md');
	});
});
