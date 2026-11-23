import { describe, expect, it } from 'vitest';
import { scanQuoteListLine } from '../src/features/quoteListRender';

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
