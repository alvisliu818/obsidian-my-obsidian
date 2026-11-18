// @vitest-environment jsdom
// emoji shortcode(`:star2:` → 🌟)三件套:查表/文本替换、渲染态 TreeWalker
// 后处理器的跳过规则、编辑态 collectLivePreview 装饰(光标进出与代码环境)。
import { describe, expect, it } from 'vitest';
import { EditorSelection, EditorState } from '@codemirror/state';
import {
	collectEmojiTokens,
	collectNativeEmojiTokens,
	EmojiWidget,
	emojiReplace,
	replaceShortcodes,
	resolveShortcode,
	SHORTCODE_RE,
} from './emojiShortcodes';
import { EMOJI_SHORTCODES } from './emojiShortcodesData';
import { collectLivePreview, type LiveSpec } from '../editor/livePreview';

const at = (doc: string, anchor: number): LiveSpec[] =>
	collectLivePreview(EditorState.create({ doc, selection: EditorSelection.cursor(anchor) }));

const specs = (doc: string, anchor: number): LiveSpec[] => at(doc, anchor).filter((s) => s.kind === 'emoji');

describe('emojiShortcodes — 查表与文本替换', () => {
	it('star2/smile/tada 渲染,大小写不敏', () => {
		expect(resolveShortcode('star2')).toBe('🌟');
		expect(replaceShortcodes('赞 :star2: 哈')).toBe('赞 🌟 哈');
		expect(replaceShortcodes(':Star2:')).toBe('🌟');
		expect(replaceShortcodes(':smile:')).toBe('😄');
		expect(replaceShortcodes(':tada:')).toBe('🎉');
	});

	it('相邻 token 与连续文本都渲染(GitHub 同款无边界断言)', () => {
		expect(replaceShortcodes(':smile::star2:')).toBe('😄🌟');
		expect(replaceShortcodes('word:smile:ing')).toBe('word😄ing');
	});

	it('查不到的保持字面:时间、属性、未知名', () => {
		expect(replaceShortcodes('12:30')).toBe('12:30');
		expect(replaceShortcodes('12:30:45')).toBe('12:30:45');
		expect(replaceShortcodes('key:: value')).toBe('key:: value');
		expect(replaceShortcodes(':nosuch_thing:')).toBe(':nosuch_thing:');
	});

	it('+1 与数字名也走查表', () => {
		expect(resolveShortcode('+1')).toBe('👍');
		expect(replaceShortcodes(':+1:')).toBe('👍');
	});

	it('数据集完整性:gemoji 全集规模', () => {
		expect(Object.keys(EMOJI_SHORTCODES).length).toBeGreaterThan(1800);
		expect(EMOJI_SHORTCODES['star2']).toBe('🌟');
	});

	it('SHORTCODE_RE 与 GitHub 命名一致', () => {
		expect(':star2:'.match(SHORTCODE_RE)).toEqual([':star2:']);
		expect('a:star2:x'.match(SHORTCODE_RE)).toEqual([':star2:']);
	});
});

describe('collectEmojiTokens — 围栏与 covered', () => {
	it('围栏内的 token 不出(跳过整个 fence 区)', () => {
		const docFence = {
			lines: 3,
			line: (n: number): { from: number; text: string } =>
				({ 1: { from: 0, text: '```' }, 2: { from: 4, text: ':star2:' }, 3: { from: 12, text: '```' } })[n]!,
		};
		expect(collectEmojiTokens(docFence, [])).toEqual([]);
	});

	it('行内 code 的 claim 排斥,非 code claim 完全包含放行', () => {
		const d = { lines: 1, line: () => ({ from: 0, text: '`:star2:` x' }) };
		expect(collectEmojiTokens(d, [{ from: 0, to: 9, code: true }])).toEqual([]);
		const d2 = { lines: 1, line: () => ({ from: 0, text: '**:star2:**' }) };
		expect(collectEmojiTokens(d2, [{ from: 0, to: 11, code: false }])).toEqual([
			{ from: 2, to: 9, emoji: '🌟' },
		]);
	});

	it('resolve 空表文档的空输出', () => {
		expect(collectEmojiTokens({ lines: 0, line: () => ({ from: 0, text: '' }) }, [])).toEqual([]);
	});

	it('emojiReplace 产 widget 装饰', () => {
		const deco = emojiReplace('🌟');
		expect(deco).toBeDefined();
	});
});

describe('collectLivePreview × emoji — 编辑态装饰', () => {
	it('光标在 token 外:整段 replace(kind=emoji),可见文本消失', () => {
		const doc = 'see :star2: end';
		expect(specs(doc, doc.length).length).toBe(1);
		const gone = new Set<number>();
		for (const s of at(doc, doc.length)) {
			if (s.from === s.to || s.kind.endsWith(':mark')) continue;
			for (let i = s.from; i < s.to; i++) gone.add(i);
		}
		expect([...doc].filter((_, i) => !gone.has(i)).join('')).toBe('see  end');
	});

	it('光标落进 token(含起点)回原样,终点算"之外"', () => {
		const doc = 'see :star2: end';
		expect(specs(doc, 5).length).toBe(0); // 起点 :
		expect(specs(doc, 8).length).toBe(0); // 名字中间
		expect(specs(doc, 11).length).toBe(1); // 闭 : 之后
	});

	it('相邻 token 两个都出', () => {
		const doc = ':smile::star2:';
		expect(specs(doc, doc.length).length).toBe(2);
	});

	it('行内 code / 围栏内保持字面', () => {
		expect(specs('`x :star2: y`', 13).length).toBe(0);
		const fenced = '```\n:star2:\n```';
		expect(specs(fenced, fenced.length).length).toBe(0);
	});

	it('加粗内容里的 token 照常渲染(完全包含放行)', () => {
		const doc = '**:star2:**';
		expect(specs(doc, doc.length).length).toBe(1);
	});

	it('未知名、时间不出装饰', () => {
		expect(specs(':nosuch_thing:', 14).length).toBe(0);
		expect(specs('12:30:45', 8).length).toBe(0);
		expect(specs('key:: value', 11).length).toBe(0);
	});
});

describe('EmojiWidget', () => {
	it('toDOM 出 span.lgp-emoji,eq 按字符比', () => {
		const w = new EmojiWidget('🌟');
		const el = w.toDOM() as HTMLElement;
		expect(el.className).toBe('lgp-emoji');
		expect(el.textContent).toBe('🌟');
		expect(w.eq(new EmojiWidget('🌟'))).toBe(true);
		expect(w.eq(new EmojiWidget('😄'))).toBe(false);
	});
});

describe('collectNativeEmojiTokens — 原生编辑器实时预览扫描', () => {
	// 三行 doc(行偏移不必连续,扫描只读 line.from + text):
	// 行1 'see :star2:'(token 4..11) 行2 '`code :star2:`'(token 18..25)
	// 行3 'end :tada:'(token 32..38)
	const doc = {
		lines: 3,
		line: (n: number) =>
			({
				1: { from: 0, to: 11, text: 'see :star2:' },
				2: { from: 12, to: 26, text: '`code :star2:`' },
				3: { from: 28, to: 38, text: 'end :tada:' },
			})[n]!,
	};
	const all = [{ fromLine: 1, toLine: 3 }];

	it('光标在 token 外:出 token;落进(含起点)回原样;终点算外', () => {
		const away = collectNativeEmojiTokens({ doc, visibleLines: all, sel: [{ from: 40, to: 40 }], codeRanges: [] });
		expect(away).toEqual([
			{ from: 4, to: 11, emoji: '🌟' },
			{ from: 18, to: 25, emoji: '🌟' },
			{ from: 32, to: 38, emoji: '🎉' },
		]);
		const inside = collectNativeEmojiTokens({ doc, visibleLines: all, sel: [{ from: 6, to: 6 }], codeRanges: [] });
		expect(inside.some((t) => t.from === 4)).toBe(false); // star2 让位
		expect(inside.some((t) => t.emoji === '🎉')).toBe(true); // 别的照常
		const atStart = collectNativeEmojiTokens({ doc, visibleLines: all, sel: [{ from: 4, to: 4 }], codeRanges: [] });
		expect(atStart.some((t) => t.from === 4)).toBe(false);
		const atEnd = collectNativeEmojiTokens({ doc, visibleLines: all, sel: [{ from: 11, to: 11 }], codeRanges: [] });
		expect(atEnd.some((t) => t.from === 4)).toBe(true);
	});

	it('代码区(InlineCode/FencedCode/CodeBlock)任何重叠排斥', () => {
		const out = collectNativeEmojiTokens({
			doc,
			visibleLines: all,
			sel: [],
			codeRanges: [{ from: 12, to: 26 }],
		});
		expect(out).toEqual([
			{ from: 4, to: 11, emoji: '🌟' },
			{ from: 32, to: 38, emoji: '🎉' },
		]);
	});

	it('只扫可视行区间', () => {
		const out = collectNativeEmojiTokens({
			doc,
			visibleLines: [{ fromLine: 1, toLine: 1 }],
			sel: [],
			codeRanges: [],
		});
		expect(out).toEqual([{ from: 4, to: 11, emoji: '🌟' }]);
	});

	it('token 与代码区部分重叠也排斥', () => {
		const out = collectNativeEmojiTokens({
			doc,
			visibleLines: all,
			sel: [],
			codeRanges: [{ from: 6, to: 8 }], // 盖住 star2 名字中段
		});
		expect(out.some((t) => t.from === 4)).toBe(false);
		expect(out.some((t) => t.emoji === '🎉')).toBe(true);
	});
});
