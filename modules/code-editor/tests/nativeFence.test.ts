/**
 * nativeFence.parseFences 的纯逻辑测试：围栏配对、语言门控、可运行块序号。
 * 口径 = runner.langFromTag（python / js / shell 可运行）。
 */
import { describe, expect, it } from 'vitest';
import { parseFences } from '../src/exec/nativeFence';

describe('parseFences', () => {
	it('python 块可运行并从 0 编号', () => {
		const blocks = parseFences(['```python', 'print(1)', '```']);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ open: 1, close: 3, lang: 'python', runnable: true, ordinal: 0 });
	});

	it('js/shell 标签映射正确、序号按出现顺序累加', () => {
		const blocks = parseFences([
			'```js',
			'console.log(1)',
			'```',
			'some text',
			'```bash',
			'echo hi',
			'```',
		]);
		expect(blocks.map((b) => [b.lang, b.runnable, b.ordinal])).toEqual([
			['js', true, 0],
			['bash', true, 1],
		]);
	});

	it('不可运行语言不占序号', () => {
		const blocks = parseFences(['```rust', 'fn main() {}', '```', '```py', 'x = 1', '```']);
		expect(blocks[0].runnable).toBe(false);
		expect(blocks[0].ordinal).toBe(-1);
		expect(blocks[1].ordinal).toBe(0);
	});

	it('波浪线围栏可开块；更长标记只被同级闭合', () => {
		const blocks = parseFences(['~~~python', 'x = 1', '~~~', '````python', '~~~py', '````']);
		expect(blocks[0]).toMatchObject({ open: 1, close: 3, runnable: true });
		expect(blocks[1]).toMatchObject({ open: 4, close: 6, lang: 'python', runnable: true });
	});

	it('未闭合围栏吃到文档末尾', () => {
		const blocks = parseFences(['```python', 'print(1)', 'print(2)']);
		expect(blocks[0]).toMatchObject({ open: 1, close: 3 });
	});

	it('info string 带参数取首个 token', () => {
		const blocks = parseFences(['```python title=demo', 'print(1)', '```']);
		expect(blocks[0].lang).toBe('python');
		expect(blocks[0].runnable).toBe(true);
	});

	it('无语言块保留配对但不占号；大小写归一', () => {
		const blocks = parseFences(['```', 'code', '```', '```JS', 'x', '```']);
		expect(blocks[0]).toMatchObject({ lang: '', runnable: false, ordinal: -1 });
		expect(blocks[1]).toMatchObject({ lang: 'js', runnable: true, ordinal: 0 });
	});

	it('块内同级栅栏行正确闭合（不吞后续内容）', () => {
		const blocks = parseFences(['```python', '```', 'print(1)', '```']);
		// 第 2 行即闭合 → print(1) 不在 python 块内；第 4 行是无语言未闭合栅栏
		expect(blocks[0]).toMatchObject({ open: 1, close: 2, runnable: true, ordinal: 0 });
		expect(blocks[1]).toMatchObject({ open: 4, lang: '', runnable: false });
		expect(blocks).toHaveLength(2);
	});
});
