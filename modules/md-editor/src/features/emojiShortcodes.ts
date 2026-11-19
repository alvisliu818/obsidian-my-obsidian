/**
 * GitHub 风格 emoji shortcode 渲染:`:star2:` → 🌟。
 *
 * 三个渲染面共用同一套识别规则(见 SHORTCODE_RE):
 * - 渲染态(registerMarkdownPostProcessor):块渲染 HTML、原生阅读视图,
 *   直接把文本节点里的 shortcode 换成字符;
 * - MD 编辑器编辑态(livePreview 的 collectLivePreview):光标不在 token
 *   内时整段 replace 成 emoji widget,光标落进去即回原样(GitHub 预览交互);
 * - 原生编辑器实时预览(registerEditorExtension):同一 replace 语义,经
 *   mdEmojiBypass 在 MD 编辑器自家 CM 里让位(那边已有 collectLivePreview
 *   管线,双份 replace 装饰会打架);原生源码模式保持字面。
 *
 * 识别从紧:必须命中 EMOJI_SHORTCODES(gemoji 全集,1913 条)才替换——
 * 时间 `12:30`、属性 `key:: value`、URL 天然查不到,保持字面。跳过代码
 * 环境:行内 code/围栏 fence(编辑态经 covered/fence/syntaxTree 判定,
 * 渲染态经 code/pre 元素判定)。
 */

import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type PluginValue, type ViewUpdate } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import { Facet, RangeSetBuilder, type Extension } from '@codemirror/state';
import { editorLivePreviewField } from 'obsidian';
import { EMOJI_SHORTCODES } from './emojiShortcodesData';
	import { scanLinesWithFences } from '../core/fenceScan';

/**
 * 与 GitHub 同款扫描:`:([a-z0-9_+-]+):`,名字字符集即 gemoji 命名,大小写
 * 不敏。不加边界断言——相邻 token(`:smile::star2:`)、`word:smile:` 在
 * GitHub 都渲染,charset 本身保证不会吞 `:`。误报(时间 `12:30`、属性
 * `key:: value`、URL)靠查表兜住:查不到就字面保留。
 */
export const SHORTCODE_RE = /:([a-zA-Z0-9_+-]+):/g;

/** 查表:命中返回字符,未命中(时间、URL、属性名)返回 undefined。 */
export function resolveShortcode(name: string): string | undefined {
	return EMOJI_SHORTCODES[name.toLowerCase()];
}

/** 纯文本替换:把 text 里所有能查到的 shortcode 换成字符,其余原样。 */
export function replaceShortcodes(text: string): string {
	return text.replace(SHORTCODE_RE, (full, name: string) => resolveShortcode(name) ?? full);
}

/** 编辑态的 emoji widget(整段 replace 的替身)。 */
export class EmojiWidget extends WidgetType {
	constructor(readonly emoji: string) {
		super();
	}
	override eq(o: WidgetType): boolean {
		return o instanceof EmojiWidget && o.emoji === this.emoji;
	}
	// 让点击穿过 widget 落到 CM 的光标定位(点 emoji → 光标进 token 原样)。
	override ignoreEvent(): boolean {
		return false;
	}
	override toDOM(): HTMLElement {
		const el = document.createElement('span');
		el.className = 'lgp-emoji';
		el.textContent = this.emoji;
		return el;
	}
}

export interface EmojiToken {
	from: number;
	to: number;
	emoji: string;
}

/**
 * 编辑态扫描:全文找可渲染的 shortcode token(整行文本级,含围栏跳过与
 * covered 排除——livePreview 的行内 code 已先声明区间)。纯函数,供
 * collectLivePreview 在光标判定后转成 replace 装饰;渲染态不用它。
 *
 * covered 排他:与 livePreview 的 emphasis 一致——code claim 任何重叠都
 * 排斥(``:x:`` 字面);非 code claim(加粗/wikilink)只排斥部分重叠,
 * 完全包含放行(`**:star2:**` 出 emoji,与 GitHub 一致)。
 */
export function collectEmojiTokens(
	doc: { lines: number; line(n: number): { from: number; text: string } },
	covered: ReadonlyArray<{ from: number; to: number; code?: boolean }>,
): EmojiToken[] {
	const tokens: EmojiToken[] = [];
	// 围栏状态走统一扫描（core/fenceScan）——此前手写状态机
	scanLinesWithFences(
		(n) => doc.line(n).text,
		doc.lines,
		(lineText, inFence, n) => {
			if (inFence) return;
			const line = doc.line(n);
			SHORTCODE_RE.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = SHORTCODE_RE.exec(lineText))) {
				const emoji = resolveShortcode(m[1]);
				if (!emoji) continue;
				const from = line.from + m.index;
				const to = from + m[0].length;
				if (
					covered.some((c) => {
						if (from < c.to && to > c.from) {
							// 重叠:code 排斥;非 code 只有部分重叠才排斥。
							return c.code === true || from < c.from || to > c.to;
						}
						return false;
					})
				) {
					continue;
				}
				tokens.push({ from, to, emoji });
			}
		},
	);
	return tokens;
}

/** livePreview 用的整段 replace 装饰(缓存单例不够——eq 按字符比)。 */
export function emojiReplace(emoji: string): Decoration {
	return Decoration.replace({ widget: new EmojiWidget(emoji) });
}

/**
 * 渲染态钩子:所有 markdown 渲染(块渲染 HTML、原生阅读视图、MarkdownRenderer
 * 的其它调用方)把文本节点里的 shortcode 换成 emoji 字符。代码环境跳过:
 * `code`/`pre` 及 CM 编辑器 DOM(安全网——后处理器本不该跑到编辑器上)。
 * 只在文本含 `:` 时才走正则,让绝大多数文本节点零成本过路。
 */
export function registerEmojiShortcodes(plugin: import('obsidian').Plugin): void {
	plugin.registerMarkdownPostProcessor((el) => {
		const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		const targets: Text[] = [];
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const text = node as Text;
			const parent = text.parentElement;
			if (!parent || !text.nodeValue?.includes(':')) continue;
			if (parent.closest('code, pre, script, style, textarea, .cm-editor, .cm-content')) continue;
			targets.push(text);
		}
		for (const text of targets) {
			const replaced = replaceShortcodes(text.nodeValue as string);
			if (replaced !== text.nodeValue) text.nodeValue = replaced;
		}
	});
	// 原生编辑器实时预览:经 workspace.editorExtensions 全局生效,同时会被
	// MD 编辑器的 thirdPartyEditorExtensions 拉进自家 CM——那里有 mdEmojiBypass
	// 让位(collectLivePreview 管线已出 emoji,双份 replace 装饰会打架)。
	plugin.registerEditorExtension(emojiEditorExtension);
}

/**
 * MD 编辑器自家 CM 实例的让位标记:自家 emoji 装饰走 collectLivePreview
 * (StateField 管线,尊重块级 source mode),全局扩展在这些实例上跳过。
 */
export const mdEmojiBypass = Facet.define<true, boolean>({ combine: (vals) => vals.length > 0 });

export interface NativeEmojiScan {
	/** 全文 doc(CM Text 形状:lines + line(n) → {from,to,text})。 */
	doc: { lines: number; line(n: number): { from: number; to: number; text: string } };
	/** 可视行区间(1-based,含端)。原生编辑器只扫可视区,大文档不吃满。 */
	visibleLines: ReadonlyArray<{ fromLine: number; toLine: number }>;
	/** 选区区间(inBlock 语义:内部重叠或光标停在起点 → 回原样)。 */
	sel: ReadonlyArray<{ from: number; to: number }>;
	/** 语法树里的代码区间(InlineCode/FencedCode/CodeBlock)——任何重叠排斥。 */
	codeRanges: ReadonlyArray<{ from: number; to: number }>;
}

/** 纯函数:原生编辑器的 emoji token 扫描(可视行 + 代码区排斥 + 光标让位)。 */
export function collectNativeEmojiTokens(input: NativeEmojiScan): EmojiToken[] {
	const { doc, visibleLines, sel, codeRanges } = input;
	const inBlock = (from: number, to: number): boolean =>
		sel.some((r) => r.to > from && r.from < to) || sel.some((r) => r.from === from && r.to === from);
	const tokens: EmojiToken[] = [];
	for (const { fromLine, toLine } of visibleLines) {
		for (let n = fromLine; n <= toLine; n++) {
			const line = doc.line(n);
			SHORTCODE_RE.lastIndex = 0;
			let m: RegExpExecArray | null;
			while ((m = SHORTCODE_RE.exec(line.text))) {
				const emoji = resolveShortcode(m[1]);
				if (!emoji) continue;
				const from = line.from + m.index;
				const to = from + m[0].length;
				if (codeRanges.some((c) => from < c.to && to > c.from)) continue;
				if (inBlock(from, to)) continue;
				tokens.push({ from, to, emoji });
			}
		}
	}
	return tokens;
}

/** 收集可视区间内的代码环境区间。兼容两套语法树命名:
 * - Obsidian 原生树(实时预览):`inline-code` / `hmd-codeblock` /
 *   `hmd-indented-code_*` / `HyperMD-codeblock*`(实测 2026-11-17);
 * - stock @lezer/markdown(名字保险):`InlineCode` / `FencedCode` / `CodeBlock`。
 * 节点名含 `code`(大小写不敏)即视为代码环境——两套命名里所有带 code 的
 * 节点都是代码相关,无非代码误伤。 */
function codeRangesInView(view: EditorView): Array<{ from: number; to: number }> {
	const out: Array<{ from: number; to: number }> = [];
	const tree = syntaxTree(view.state);
	for (const vr of view.visibleRanges) {
		if (vr.from >= tree.length) continue; // 该区还没解析到,不出代码区间
		tree.iterate({
			from: vr.from,
			to: Math.min(vr.to, tree.length),
			enter: (n) => {
				if (n.name.toLowerCase().includes('code')) {
					out.push({ from: n.from, to: n.to });
					return false;
				}
				return undefined;
			},
		});
	}
	return out;
}

/**
 * 原生编辑器实时预览扩展(registerEditorExtension 挂到 workspace.editorExtensions)。
 * 与 MD 编辑器自家管线同一交互:光标落进 token(含起点)回原样,挪开即出 emoji。
 * 字段缺席(单测 stub / 兼容性探针的裸状态)按源码模式处理——保持字面,零装饰。
 */
export const emojiEditorExtension: Extension = ViewPlugin.fromClass(
	class implements PluginValue {
		decorations: DecorationSet = Decoration.none;
		constructor(view: EditorView) {
			this.compute(view);
		}
		update(u: ViewUpdate): void {
			// 无条件重算:除了 doc/选区/视口,还有两类会翻转结果但不进上述旗标的
			// 更新——①语法树异步长高(代码区判定);②原生 live-preview ↔ 源码
			// 模式的 reconfigure(setViewState 只翻转 editorLivePreviewField,装饰
			// 若不重算会滞留成 live-preview 的旧样子)。compute 只扫可视区,成本
			// 与更新频率解耦于文档大小。
			this.compute(u.view);
		}
		private compute(view: EditorView): void {
			// 门控分支必须清空装饰再返回——setViewState 切源码模式只翻转
			// editorLivePreviewField,同一个 ViewPlugin 实例还挂着,不清空就滞留
			// live-preview 时代的旧装饰(实测 3 个 widget 不肯消失)。
			const bypass = view.state.facet(mdEmojiBypass);
			const livePreview = view.state.field(editorLivePreviewField, false);
			if (bypass || !livePreview) {
				this.decorations = Decoration.none;
				return;
			}
			const tree = syntaxTree(view.state);
			const doc = view.state.doc;
			const visibleLines = view.visibleRanges.map((vr) => ({
				fromLine: doc.lineAt(vr.from).number,
				toLine: doc.lineAt(vr.to).number,
			}));
			const codeRanges = codeRangesInView(view);
			const tokens = collectNativeEmojiTokens({
				doc,
				visibleLines,
				sel: view.state.selection.ranges,
				codeRanges,
			}).filter((t) => t.to <= tree.length); // 解析没盖到的区间先按字面,树长到再装饰
			if (tokens.length === 0) {
				this.decorations = Decoration.none;
				return;
			}
			const builder = new RangeSetBuilder<Decoration>();
			for (const t of tokens) builder.add(t.from, t.to, emojiReplace(t.emoji));
			this.decorations = builder.finish();
		}
	},
	{ decorations: (v) => v.decorations },
);
