/**
 * dataview 解析归一 round-trip 单测：extractCachedMetadata → dataview 自家
 * parsePage → Transferable → dehydrate JSON → hydrate → Transferable.value。
 *
 * 与 daemon dvImport.ts 的胶水同链（那边经 require 桥进 bundle，本测试经
 * vitest 别名直接 import——同一组文件同一语义）；渲染端 dataviewBridge 到达
 * finish() 的对象形状即此处的 restored。
 */
import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { parsePage } from 'data-import/markdown-file';
// eslint-disable-next-line @typescript-eslint/no-var-requires
import { Transferable } from 'data-model/transferable';
import { extractCachedMetadata } from '../daemon/dvMeta';
import { dehydrateValue, hydrateValue } from '../../../shared/dvSerialize';

const SAMPLE = [
	'---',
	'title: 测试页',
	'date: 2026-01-02',
	'tags: [proj, reading]',
	'---',
	'',
	'# 测试页',
	'',
	'段落内联 [key:: value]',
	'',
	'- 普通父项',
	'\t- [x] 已完成任务 [due:: 2026-03-01] ^taskid',
	'\t- [ ] 未完成任务',
	'',
	'链接到 [[其他笔记|别名]] 和 ![[图片.png]]。',
].join('\n');

const STAT = { ctime: 1700000000000, mtime: 1700000000000, size: SAMPLE.length };

/** 与 daemon dvImport.parseDvPage 完全同构的胶水（require 桥在 bundle 里）。 */
function parseAndRoundTrip(path: string, content: string): Record<string, unknown> {
	const metadata = extractCachedMetadata(content);
	const page = parsePage(path, content, STAT, metadata);
	const json = JSON.stringify(dehydrateValue(Transferable.transferable(page)));
	return Transferable.value(hydrateValue(JSON.parse(json))) as Record<string, unknown>;
}

describe('parsePage → JSON → hydrate → Transferable.value', () => {
	const restored = parseAndRoundTrip('测试页.md', SAMPLE);

	it('fields 为 Map，frontmatter 字段类型化（date → DateTime）', () => {
		const fields = restored['fields'] as Map<string, unknown>;
		expect(fields).toBeInstanceOf(Map);
		expect(fields.get('title')).toBe('测试页');
		expect(fields.get('date')).toBeInstanceOf(DateTime);
		expect((fields.get('date') as DateTime).toISODate()).toBe('2026-01-02');
		// 段落括号内联字段进页面 fields
		expect(fields.get('key')).toBe('value');
	});

	it('tags/aliases 为 Set（JSON 标记往返后仍是 Set）', () => {
		const tags = restored['tags'] as Set<string>;
		expect(tags).toBeInstanceOf(Set);
		expect(tags.has('#proj')).toBe(true);
		expect(tags.has('#reading')).toBe(true);
	});

	it('lists 任务态与块 id 存活', () => {
		const lists = restored['lists'] as Array<Record<string, unknown>>;
		expect(lists.length).toBeGreaterThanOrEqual(3);
		const done = lists.find((l) => l.task) as {
			task?: Record<string, unknown>;
			blockId?: string;
			fields?: Map<string, unknown>;
		};
		expect(done?.task).toBeDefined();
		expect(done.task?.['completed']).toBe(true);
		expect(done.task?.['fullyCompleted']).toBe(true);
		expect(done.blockId).toBe('taskid');
		// 任务行括号内联字段留在任务项自己的 fields（parseLists Pass 2 只上升非任务项字段）
		const due = done.fields?.get('due') as unknown[] | undefined;
		expect(due?.[0]).toBeInstanceOf(DateTime);
		const tasks = lists.filter((l) => l.task).map((l) => l.task as Record<string, unknown>);
		expect(tasks.some((t) => t['completed'] === false)).toBe(true);
	});

	it('links 保留 display，embed 分流', () => {
		const links = restored['links'] as Array<Record<string, unknown>>;
		const wikilink = links.find((l) => l.path === '其他笔记');
		expect(wikilink?.['display']).toBe('别名');
		const embed = links.find((l) => l.path === '图片.png');
		expect(embed?.['embed']).toBe(true);
	});

	it('ctime/mtime 为 DateTime，day 从字段提取不炸', () => {
		expect(restored['ctime']).toBeInstanceOf(DateTime);
		expect(restored['mtime']).toBeInstanceOf(DateTime);
		expect(restored['day']).toBeInstanceOf(DateTime);
	});
});
