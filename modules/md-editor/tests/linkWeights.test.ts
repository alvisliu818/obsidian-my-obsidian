/**
 * 双链提示权重（parseLinkWeightRules / weightForPath）单测：
 * 逐行 权重:正则 解析 + 路径命中的权重计算 + rankByWeight 稳定重排。
 * 实现收口在 modules/shared/weightRules.ts（links.ts 按 API 名再导出）。
 */
import { describe, expect, it } from 'vitest';
import { parseLinkWeightRules, weightForPath } from '../src/features/links';
import { rankByWeight } from '../../shared/weightRules';

describe('parseLinkWeightRules', () => {
	it('解析 权重:正则 行', () => {
		const rules = parseLinkWeightRules(['10:^Important/', '5:项目']);
		expect(rules).toHaveLength(2);
		expect(rules[0].weight).toBe(10);
		expect(rules[0].regex.test('Important/a.md')).toBe(true);
		expect(rules[1].regex.test('项目/b.md')).toBe(true);
	});

	it('坏行丢弃（非数字开头/空/坏正则）', () => {
		const rules = parseLinkWeightRules(['', 'x:foo', '10:[bad', '10:^ok/']);
		expect(rules).toHaveLength(1);
		expect(rules[0].weight).toBe(10);
	});

	it('undefined/空数组 → 空', () => {
		expect(parseLinkWeightRules(undefined)).toEqual([]);
		expect(parseLinkWeightRules([])).toEqual([]);
	});
});

describe('weightForPath', () => {
	const rules = parseLinkWeightRules(['10:^Important/', '3:^Projects/']);

	it('命中返回对应权重', () => {
		expect(weightForPath('Important/a.md', rules)).toBe(10);
		expect(weightForPath('Projects/b.md', rules)).toBe(3);
	});

	it('无命中 → 0', () => {
		expect(weightForPath('Other/c.md', rules)).toBe(0);
	});

	it('空规则 → 0', () => {
		expect(weightForPath('Important/a.md', [])).toBe(0);
	});
});

describe('rankByWeight', () => {
	const rules = parseLinkWeightRules(['10:^Important/', '5:^Projects/']);

	it('权重降序，同权重保持原序（FTS rank 序）', () => {
		const hits = [
			{ path: 'Other/a.md', text: '1' },
			{ path: 'Projects/b.md', text: '2' },
			{ path: 'Important/c.md', text: '3' },
			{ path: 'Other/d.md', text: '4' },
		];
		const out = rankByWeight(hits, rules);
		expect(out.map((h) => h.path)).toEqual([
			'Important/c.md', // 10
			'Projects/b.md', // 5
			'Other/a.md', // 0，原序在前
			'Other/d.md', // 0
		]);
	});

	it('无规则 → 原样（副本）', () => {
		const hits = [{ path: 'a.md', text: 'x' }];
		const out = rankByWeight(hits, []);
		expect(out).toEqual(hits);
		expect(out).not.toBe(hits);
	});

	it('空输入 → 空', () => {
		expect(rankByWeight([], rules)).toEqual([]);
	});
});
