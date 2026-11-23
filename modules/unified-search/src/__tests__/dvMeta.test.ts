/**
 * dvMeta（CachedMetadata 形状提取器）单测。
 *
 * 断言基准 = Obsidian metadataCache 对 dataview 消费面的行为（已知近似清单
 * 见 dvMeta.ts 头注释）。这里测形状本身；取值语义由 dvImport.test.ts 过
 * dataview 自家 parsePage 验证。
 */
import { describe, expect, it } from 'vitest';
import { extractCachedMetadata } from '../daemon/dvMeta';

describe('extractCachedMetadata · frontmatter', () => {
	it('解析 --- 块为对象，日期保持字符串（CORE_SCHEMA）', () => {
		const meta = extractCachedMetadata('---\ntitle: Hello\ndate: 2026-01-02\ntags: [a, b]\n---\n\n正文');
		expect(meta.frontmatter).toEqual({ title: 'Hello', date: '2026-01-02', tags: ['a', 'b'] });
		// sections 不含 frontmatter 行
		for (const s of meta.sections) {
			expect(s.position.start.line).toBeGreaterThanOrEqual(5);
		}
	});

	it('破损 YAML → 无 frontmatter（Obsidian 同语义）', () => {
		const meta = extractCachedMetadata('---\ntitle: [未闭合\n---\n正文');
		expect(meta.frontmatter).toBeUndefined();
	});

	it('frontmatter 里的链接 → frontmatterLinks', () => {
		const meta = extractCachedMetadata('---\nparent: "[[index]]"\n---\n正文');
		expect(meta.frontmatterLinks).toEqual([{ link: 'index', displayText: undefined }]);
	});
});

describe('extractCachedMetadata · headings/sections', () => {
	it('标题行 → headings + heading section', () => {
		const meta = extractCachedMetadata('# Top\n\n正文\n## Sub #tag-h');
		expect(meta.headings).toEqual([
			{ heading: 'Top', level: 1, position: { start: { line: 0 }, end: { line: 0 } } },
			{ heading: 'Sub #tag-h', level: 2, position: { start: { line: 3 }, end: { line: 3 } } },
		]);
		expect(meta.sections.map((s) => s.type)).toEqual(['heading', 'paragraph', 'heading']);
	});
});

describe('extractCachedMetadata · listItems', () => {
	it('嵌套列表：parent 指向父项行，task/id/跨度正确', () => {
		const md = ['- parent item', '\t- [x] child task ^abc', '- sibling'];
		const meta = extractCachedMetadata(md.join('\n'));
		expect(meta.sections).toHaveLength(1);
		expect(meta.sections[0].type).toBe('list');
		expect(meta.sections[0].position).toEqual({ start: { line: 0 }, end: { line: 2 } });

		expect(meta.listItems).toHaveLength(3);
		const [parent, child, sibling] = meta.listItems;
		expect(parent.parent).toBe(-1);
		expect(parent.position).toEqual({ start: { line: 0 }, end: { line: 0 } });
		expect(child.parent).toBe(0);
		expect(child.task).toBe('x');
		expect(child.id).toBe('abc');
		expect(sibling.parent).toBe(-1);
		expect(sibling.position.start.line).toBe(2);
	});

	it('未勾选任务 task = 空格', () => {
		const meta = extractCachedMetadata('- [ ] todo');
		expect(meta.listItems[0].task).toBe(' ');
	});

	it('多行续行并入同一 listItems 跨度', () => {
		const meta = extractCachedMetadata('- item with\n\tcontinuation line\n- next');
		expect(meta.listItems[0].position).toEqual({ start: { line: 0 }, end: { line: 1 } });
		expect(meta.listItems[1].position.start.line).toBe(2);
	});
});

describe('extractCachedMetadata · links/embeds/tags', () => {
	it('wikilink/md 链接/嵌入分流，display 拆分', () => {
		const meta = extractCachedMetadata('见 [[note|别名]] 与 [md](x.md) 以及 ![[img.png]]');
		expect(meta.links).toEqual([
			{ link: 'note', displayText: '别名', position: { start: { line: 0 }, end: { line: 0 } } },
			{ link: 'x.md', displayText: 'md', position: { start: { line: 0 }, end: { line: 0 } } },
		]);
		expect(meta.embeds).toHaveLength(1);
		expect(meta.embeds[0].link).toBe('img.png');
	});

	it('wikilink 子路径保持原样，不被 tag 扫描误命中', () => {
		const meta = extractCachedMetadata('[[a#b]] 纯文本');
		expect(meta.links[0].link).toBe('a#b');
		expect(meta.tags).toHaveLength(0);
	});

	it('#tag 提取；纯数字不是 tag', () => {
		const meta = extractCachedMetadata('标 #tag_1 与 (#tag-2) 与 #12345');
		expect(meta.tags.map((t) => t.tag)).toEqual(['#tag_1', '#tag-2']);
	});

	it('代码围栏内不产 tags/links，且为 code section', () => {
		const md = ['```js', '// [[nolink]] #notag key:: value', '```', '正文'];
		const meta = extractCachedMetadata(md.join('\n'));
		expect(meta.links).toHaveLength(0);
		expect(meta.tags).toHaveLength(0);
		expect(meta.sections[0].type).toBe('code');
		expect(meta.sections[0].position).toEqual({ start: { line: 0 }, end: { line: 2 } });
	});

	it('分隔线 → ruling section（dataview 跳过扫描）', () => {
		const meta = extractCachedMetadata('上\n\n---\n\n下');
		expect(meta.sections.map((s) => s.type)).toEqual(['paragraph', 'ruling', 'paragraph']);
	});
});

describe('extractCachedMetadata · 引用块', () => {
	it('连续 > 行成 quote section，内部列表也入 listItems', () => {
		const md = ['> 引用', '> - [x] 引用内任务', '正文'];
		const meta = extractCachedMetadata(md.join('\n'));
		expect(meta.sections[0].type).toBe('quote');
		expect(meta.listItems).toHaveLength(1);
		expect(meta.listItems[0].task).toBe('x');
	});
});
