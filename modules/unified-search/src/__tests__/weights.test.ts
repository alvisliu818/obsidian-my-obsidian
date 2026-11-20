/**
 * 搜索结果权重重排单测（rankByWeight 消费面——searchDaemon 里
 * fts/scan/ext 命中在截断前按 权重:正则 稳定重排）。
 */
import { describe, expect, it } from 'vitest';
import { parseWeightRules, rankByWeight, weightForPath } from '../../../shared/weightRules';

describe('parseWeightRules（搜索侧同款解析）', () => {
	it('坏行丢弃', () => {
		const rules = parseWeightRules(['10:^Important/', '', 'x:foo', '5:项目']);
		expect(rules).toHaveLength(2);
	});
});

describe('rankByWeight（搜索结果加权）', () => {
	it('命中路径靠前，同权重稳定', () => {
		const rules = parseWeightRules(['10:^Important/', '5:^Projects/']);
		const hits = [
			{ path: 'Other/a.md', text: '1' },
			{ path: 'Projects/b.md', text: '2' },
			{ path: 'Important/c.md', text: '3' },
		];
		expect(rankByWeight(hits, rules).map((h) => h.path)).toEqual([
			'Important/c.md',
			'Projects/b.md',
			'Other/a.md',
		]);
	});

	it('weightForPath 第一条命中生效', () => {
		const rules = parseWeightRules(['10:Important', '5:Important/sub']);
		expect(weightForPath('Important/sub/x.md', rules)).toBe(10);
	});
});
