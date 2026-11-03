/**
 * plugin-market 的 store 纯逻辑：备注/标签/全部标签 + 目录反查索引。
 *
 * normRepo 的回归锚点：官方 community-plugins.json 的 repo 字段是裸
 * "owner/repo"（v1 曾把它当 URL 误剥成空串 → 整列反查通道失效），两种输入
 * 都必须认。
 */

import { describe, expect, it } from 'vitest';
import { MarketStore, normRepo } from '../src/store';
import type { CatalogEntry } from '../src/types';

function makeStore(): MarketStore {
	let saved: unknown = null;
	return new MarketStore(
		{} as any,
		{ dir: '.obsidian/plugins/obsidian-my-obsidian' } as any,
		async () => null,
		async (data) => {
			saved = data;
		},
	);
}

describe('normRepo', () => {
	it('裸 owner/repo（官方清单形态）原样小写', () => {
		expect(normRepo('zsviczian/obsidian-excalidraw-plugin')).toBe('zsviczian/obsidian-excalidraw-plugin');
	});
	it('完整 GitHub URL 抽出 owner/repo（详情页链接形态）', () => {
		expect(normRepo('https://github.com/zsviczian/obsidian-excalidraw-plugin')).toBe('zsviczian/obsidian-excalidraw-plugin');
		expect(normRepo('https://github.com/Owner/Repo.git/')).toBe('owner/repo');
		expect(normRepo('https://github.com/Owner/Repo?tab=readme')).toBe('owner/repo');
	});
	it('v1 回归锚：两种输入都不得产出空串', () => {
		expect(normRepo('argenos/hotkeysplus-obsidian')).not.toBe('');
	});
});

describe('MarketStore 备注与标签', () => {
	it('setNote：trim + 截断 2000 + 空删除 + v1 rating 清除', () => {
		const st = makeStore();
		// 模拟 v1 遗留数据
		(st as any).data.reviews['p1'] = { rating: 4, tags: ['t1'] };
		st.setNote('p1', '  好 用  ');
		expect(st.reviewOf('p1')?.note).toBe('好 用');
		expect(st.reviewOf('p1')?.rating).toBeUndefined();

		st.setNote('p1', 'x'.repeat(2500));
		expect(st.reviewOf('p1')?.note?.length).toBe(2000);

		st.setNote('p1', '   ');
		// note 清空但还有 tags → 记录保留
		expect(st.reviewOf('p1')?.tags).toEqual(['t1']);
	});

	it('addTag 去重保序；removeTag 清空后连记录一起删；当前筛选联动撤销', () => {
		const st = makeStore();
		st.addTag('p1', ' 学习 ');
		st.addTag('p1', '学习'); // 大小写不敏感去重
		st.addTag('p1', '工具');
		expect(st.reviewOf('p1')?.tags).toEqual(['学习', '工具']);
		expect([...st.allTags()].sort()).toEqual(['工具', '学习'].sort());

		st.setActiveTag('学习');
		st.removeTag('p1', '学习');
		expect(st.reviewOf('p1')?.tags).toEqual(['工具']);
		// 「学习」已被删光 → 筛选它的 activeTag 联动撤销（防筛出恒空列表）
		expect(st.data.activeTag).toBeUndefined();
		// 标签仍存在时筛选保留
		st.setActiveTag('工具');
		expect(st.data.activeTag).toBe('工具');

		st.removeTag('p1', '工具');
		expect(st.reviewOf('p1')).toBeUndefined();
		expect(st.allTags()).toEqual([]);
		expect(st.data.activeTag).toBeUndefined();
	});

	it('setNote 清空且无标签 → 记录整个删除', () => {
		const st = makeStore();
		st.setNote('p1', 'hello');
		st.setNote('p1', '');
		expect(st.reviewOf('p1')).toBeUndefined();
	});
});

describe('目录反查索引（adoptCatalog）', () => {
	const catalog: CatalogEntry[] = [
		{ id: 'obsidian-excalidraw-plugin', name: 'Excalidraw', author: 'zsviczian', repo: 'zsviczian/obsidian-excalidraw-plugin' },
		{ id: 'other', name: 'Other', author: 'a', repo: 'a/other' },
	];

	it('repo URL 精确反查（大小写无关）', () => {
		const st = makeStore();
		st.adoptCatalog(catalog);
		expect(st.byRepoUrl('https://github.com/zsviczian/obsidian-excalidraw-plugin')?.id).toBe('obsidian-excalidraw-plugin');
		expect(st.byRepoUrl('https://github.com/other/x')).toBeUndefined();
	});

	it('名字+作者反查（列表卡片只有这两样）', () => {
		const st = makeStore();
		st.adoptCatalog(catalog);
		expect(st.lookupNameAuthor('Excalidraw', 'zsviczian')?.id).toBe('obsidian-excalidraw-plugin');
		expect(st.lookupNameAuthor('excalidraw', 'ZSVICZIAN')?.id).toBe('obsidian-excalidraw-plugin');
		expect(st.lookupNameAuthor('Nope', 'x')).toBeUndefined();
	});
});
