import { describe, expect, it } from 'vitest';
import { escapeHtml, renderFileLines, renderMarkdownLine } from '../src/lineRender';

const colorizeStub = () => async (text: string): Promise<string> => {
	const lines = text.split('\n');
	return lines.map((l) => `<span class="mtk1">${l}</span>`).join('<br/>') + '<br/>';
};

describe('lineRender:对比视图行内容渲染', () => {
	it('escapeHtml 转义全部敏感字符(用户文件内容不产生标签)', () => {
		expect(escapeHtml('<script>"&\'')).toBe('&lt;script&gt;&quot;&amp;&#39;');
	});

	it('Markdown 行内:标题/粗体/行内代码/链接/列表/任务框', () => {
		expect(renderMarkdownLine('## 标题')).toContain('vl-md-h2');
		expect(renderMarkdownLine('a **粗** *斜* `code`')).toBe(
			'a <strong>粗</strong> <em>斜</em> <code class="vl-md-code">code</code>',
		);
		expect(renderMarkdownLine('- [[笔记|别名]] 和 [外链](https://a.b)')).toContain('别名');
		expect(renderMarkdownLine('1. 第一项')).toContain('vl-md-bullet');
		expect(renderMarkdownLine('- [x] 完成')).toContain('☑');
		expect(renderMarkdownLine('> 引用')).toContain('vl-md-quote');
	});

	it('代码文件走 Monaco colorize 并按 <br/> 切行', async () => {
		const out = await renderFileLines('a.py', ['x', 'y'], {
			mdMode: 'editor',
			colorize: colorizeStub(),
			languageId: 'python',
		});
		expect(out).toEqual(['<span class="mtk1">x</span>', '<span class="mtk1">y</span>']);
	});

	it('Markdown Monaco 模式整段交给 Monaco(markdown 语言)', async () => {
		const calls: string[] = [];
		const out = await renderFileLines('a.md', ['# 标题'], {
			mdMode: 'monaco',
			colorize: async (text, lang) => {
				calls.push(lang);
				return `<span class="mtk1">${text}</span><br/>`;
			},
		});
		expect(calls).toEqual(['markdown']);
		expect(out[0]).toContain('mtk1');
	});

	it('Markdown 默认行内渲染不依赖 Monaco', async () => {
		const out = await renderFileLines('a.md', ['# 标题'], {
			mdMode: 'editor',
			colorize: colorizeStub(),
		});
		expect(out[0]).toContain('vl-md-h1');
	});

	it('无 colorize 时代码退化为转义纯文本', async () => {
		expect(await renderFileLines('a.py', ['print("<x>")'], { mdMode: 'editor', languageId: 'python' })).toEqual([
			'print(&quot;&lt;x&gt;&quot;)',
		]);
	});

	it('Markdown 围栏代码块整段走 Monaco 着色', async () => {
		const out = await renderFileLines('a.md', ['# 标题', '```python', 'x', '```'], {
			mdMode: 'editor',
			colorize: async () => '<span class="mtk1">x</span><br/>',
		});
		expect(out[0]).toContain('vl-md-h1');
		expect(out[1]).toContain('vl-md-fence');
		expect(out[2]).toBe('<span class="mtk1">x</span>');
		expect(out[3]).toContain('vl-md-fence');
	});
});
