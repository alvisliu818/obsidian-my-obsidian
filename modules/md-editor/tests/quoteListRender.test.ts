import { describe, expect, it } from 'vitest';
import { quoteContentColumn, quoteListFoldEnd, scanQuoteListLine } from '../src/features/quoteListRender';

const at = (lines: string[]) => (i: number): string | null => lines[i] ?? null;

describe('scanQuoteListLine（原生编辑器引述列表识别）', () => {
	it('引述里的无序列表', () => {
		const hit = scanQuoteListLine('> - 功能测试：开发人员（单元测试）、黑盒测试');
		expect(hit).toMatchObject({
			markerFrom: 2,
			markerTo: 3,
			markerEnd: 4,
			ordered: false,
			markerText: '',
			indentLevel: 0,
		});
	});

	it('引述里的有序列表', () => {
		const hit = scanQuoteListLine('> 12. 第十二项');
		expect(hit).toMatchObject({ markerFrom: 2, markerTo: 5, ordered: true, markerText: '12.' });
		expect(scanQuoteListLine('> 3) 第三项')?.markerText).toBe('3)');
	});

	it('引述内再缩进 = 更深一层', () => {
		expect(scanQuoteListLine('>   - 嵌套项')?.indentLevel).toBe(1);
		expect(scanQuoteListLine('>     - 更深')?.indentLevel).toBe(2);
		expect(scanQuoteListLine('> \t- tab 缩进')?.indentLevel).toBe(1);
	});

	it('多级引述按引述层数叠加缩进', () => {
		expect(scanQuoteListLine('>> - 双层引述')?.indentLevel).toBe(1);
		expect(scanQuoteListLine('> >   - 双层引述再缩进')?.indentLevel).toBe(2);
	});

	it('空列表项也识别（只画圆点）', () => {
		const hit = scanQuoteListLine('> -');
		expect(hit).toMatchObject({ markerFrom: 2, markerTo: 3, markerEnd: 3, ordered: false });
	});

	it('普通列表与普通引述不匹配', () => {
		expect(scanQuoteListLine('- 普通列表项')).toBeNull();
		expect(scanQuoteListLine('1. 有序普通列表')).toBeNull();
		expect(scanQuoteListLine('> 普通引述文字')).toBeNull();
		expect(scanQuoteListLine('> -not a list（标记后必须有空白）')).toBeNull();
	});
});

describe('quoteContentColumn（引述正文列）', () => {
	it('引述前缀之后的缩进计入列宽', () => {
		expect(quoteContentColumn('> - a')).toBe(2);
		expect(quoteContentColumn('>   - a')).toBe(4);
		expect(quoteContentColumn('> \t- a')).toBe(4);
		expect(quoteContentColumn('>> - a')).toBe(3);
	});
	it('非引述行为 null，空引述行为 +∞', () => {
		expect(quoteContentColumn('- a')).toBeNull();
		expect(quoteContentColumn('plain')).toBeNull();
		expect(quoteContentColumn('>')).toBe(Number.POSITIVE_INFINITY);
		expect(quoteContentColumn('>   ')).toBe(Number.POSITIVE_INFINITY);
	});
});

describe('quoteListFoldEnd（引述列表折叠范围）', () => {
	it('嵌套项与缩进续行算子树，同级项结束', () => {
		const lines = ['> - 父项', '>   - 子项', '>   - 子项二', '> - 兄弟'];
		expect(quoteListFoldEnd(at(lines), 0)).toBe(2);
		expect(quoteListFoldEnd(at(lines), 3)).toBe(-1);
	});

	it('多层嵌套一直收到层级回到同级为止', () => {
		const lines = ['> - 父', '>   - 子', '>     - 孙', '>   - 子二'];
		expect(quoteListFoldEnd(at(lines), 0)).toBe(3);
		expect(quoteListFoldEnd(at(lines), 2)).toBe(-1);
	});

	it('空引述行留在子树内，普通行结束子树', () => {
		expect(quoteListFoldEnd(at(['> - a', '>', '>   - b']), 0)).toBe(2);
		expect(quoteListFoldEnd(at(['> - a', '', '>   - b']), 0)).toBe(-1);
		expect(quoteListFoldEnd(at(['> - a', 'plain', '>   - b']), 0)).toBe(-1);
	});

	it('有序列表与缩进续行', () => {
		const lines = ['> 1. 父项', '>    续行文字', '> 2. 兄弟'];
		expect(quoteListFoldEnd(at(lines), 0)).toBe(1);
		expect(quoteListFoldEnd(at(lines), 2)).toBe(-1);
	});

	it('普通引述行没有折叠范围', () => {
		expect(quoteListFoldEnd(at(['> 引述文字', '>   缩进文字']), 0)).toBe(-1);
	});
});
