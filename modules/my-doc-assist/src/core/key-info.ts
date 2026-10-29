/**
 * 场景一 关键信息提炼 — 纯函数核心。
 *
 * 对应 README 路线图的「全要素关键信息提取」与「多维筛选」：扫描一段
 * Markdown，把标题 / 加粗 / 高亮 / 斜体 / 行内代码 / 代码块 / 标签 / 双链
 * 提成带行号的要点条目。同一行出现多个要素时合并为一条（README 原文：
 * 「同一行的多个要点合并为一条」）。
 *
 * 这里只做文本变换，不碰 Obsidian API —— 所以它可以被直接单测，也方便
 * 复用到将来的侧边栏 View 上。
 */

/** 要素类型。顺序即导出时的分组顺序。 */
export const KEY_INFO_TYPES = [
	'heading',
	'bold',
	'highlight',
	'italic',
	'inlineCode',
	'codeBlock',
	'blockquote',
	'tag',
	'link',
] as const;

export type KeyInfoType = (typeof KEY_INFO_TYPES)[number];

/**
 * 本插件插入的摘要区块用的 callout 标题前缀。
 *
 * 摘要自己也是 `> [!info]` 引述块，不标记的话再筛一次会把它当成要点
 * 收进来，越跑越乱。扫描时见到这个前缀就跳过。
 */
export const SUMMARY_CALLOUT_PREFIX = '> [!info] Doc Assist · 关键内容';

export interface KeyInfoItem {
	/** 这一行出现了哪些要素类型（一行可多种）。 */
	types: KeyInfoType[];
	/** 标题层级 1–6，仅 heading 行有。 */
	level?: number;
	/** 代码块语言，仅 codeBlock 行有。 */
	lang?: string;
	/** 0 基行号，用于跳转与汇报。 */
	line: number;
	/** 提取出的要点文本（标记已剥离，多个要点用「；」连接）。 */
	text: string;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const BOLD_RE = /\*\*([^*\n]+?)\*\*/g;
const HIGHLIGHT_RE = /==([^=\n]+?)==/g;
// 斜体：单个星号，且不被 ** 包裹（用反向断言排除加粗的星号）
const ITALIC_RE = /(?<!\*)\*(?!\*)([^*\n]+?)\*(?!\*)/g;
const INLINE_CODE_RE = /`([^`\n]+?)`/g;
const FENCE_RE = /^\s*```(\w*)\s*$/;
// 引述块：`> 内容`。callout（`> [!type]`）也是引述块的一种。
const BLOCKQUOTE_RE = /^\s*>\s?(.*)$/;
// 标签：# 前是行首或空白/左括号，且不是标题行的 #（标题走 heading 分支）。
// 字符类要用 Unicode 属性——\w 只覆盖 ASCII，`#工作` 这种中文标签会漏掉。
const TAG_RE = /(?:^|[\s(])#([\p{L}\p{N}_\-\/]+)/gu;
// 双链：[[目标]] 或 [[目标|别名]]，取目标
const LINK_RE = /\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]]*\n?)?\]\]/g;

/** 围栏行本身（```）也算一个要点：标记代码块的起止与语言。 */
function fenceLang(line: string): string | null {
	const m = FENCE_RE.exec(line);
	return m ? m[1] ?? '' : null;
}

function pushText(out: string[], s: string): void {
	const t = s.trim();
	if (t) out.push(t);
}

/** 收集一行内某类要素的所有命中；命中过就把类型记上。 */
function collect(
	line: string,
	re: RegExp,
	type: KeyInfoType,
	out: string[],
	types: KeyInfoType[],
	wrap?: (s: string) => string,
): void {
	let found = false;
	for (const m of line.matchAll(re)) {
		found = true;
		pushText(out, wrap ? wrap(m[1]) : m[1]);
	}
	if (found) types.push(type);
}

/**
 * 扫描一段 Markdown，返回要点条目（按行号升序，空结果不进列表）。
 *
 * 代码块内部只按 codeBlock 计一条（语言 + 首行内容），不再拆里面的
 * 加粗/标题之类——否则一段示例代码能炸出几十条假要点。
 */
export function scanKeyInfo(source: string): KeyInfoItem[] {
	const lines = source.replace(/\r\n/g, '\n').split('\n');
	const items: KeyInfoItem[] = [];
	let inFence = false;
	let fenceLangName = '';
	let fenceStart = -1;
	// 引述块状态：连续 `>` 行合成一段，段内不再拆加粗/标题之类
	let inQuote = false;
	let quoteStart = -1;
	let quoteTexts: string[] = [];
	// 这一段是否是本插件插入的摘要 callout（整段丢弃，不能只跳第一行）
	let skipQuote = false;

	const flushQuote = () => {
		if (!inQuote) return;
		if (!skipQuote) {
			const text = quoteTexts.join(' ').trim();
			if (text) {
				items.push({ types: ['blockquote'], line: quoteStart, text });
			}
		}
		inQuote = false;
		skipQuote = false;
		quoteStart = -1;
		quoteTexts = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const lang = fenceLang(line);

		if (inFence) {
			if (lang !== null) {
				// 围栏结束：把整个代码块收成一条
				items.push({
					types: ['codeBlock'],
					lang: fenceLangName || undefined,
					line: fenceStart,
					text: `代码块${fenceLangName ? `（${fenceLangName}）` : ''} 起 ${fenceStart + 1} 行`,
				});
				inFence = false;
				fenceLangName = '';
				fenceStart = -1;
			}
			continue;
		}

		if (lang !== null) {
			flushQuote();
			inFence = true;
			fenceLangName = lang;
			fenceStart = i;
			continue;
		}

		const quote = BLOCKQUOTE_RE.exec(line);
		if (quote) {
			if (!inQuote) {
				inQuote = true;
				quoteStart = i;
				quoteTexts = [];
				// 自家插入的摘要 callout 整段跳过，否则再筛一次会把它收进来
				skipQuote = line.startsWith(SUMMARY_CALLOUT_PREFIX);
			}
			if (!skipQuote) pushText(quoteTexts, quote[1]);
			continue;
		}
		flushQuote();

		const types: KeyInfoType[] = [];
		const texts: string[] = [];
		let level: number | undefined;

		const heading = HEADING_RE.exec(line);
		if (heading) {
			types.push('heading');
			level = heading[1].length;
			pushText(texts, heading[2]);
		} else {
			// 标题行只按 heading 计，避免 `# 标题` 里的 # 被当成标签
			collect(line, TAG_RE, 'tag', texts, types, (s) => `#${s}`);
		}

		collect(line, BOLD_RE, 'bold', texts, types);
		collect(line, HIGHLIGHT_RE, 'highlight', texts, types);
		collect(line, ITALIC_RE, 'italic', texts, types);
		collect(line, INLINE_CODE_RE, 'inlineCode', texts, types, (s) => `\`${s}\``);
		collect(line, LINK_RE, 'link', texts, types, (s) => `[[${s}]]`);

		if (types.length) {
			items.push({ types, level, line: i, text: texts.join('；') });
		}
	}

	// 文档以未闭合的代码块 / 引述块结尾时，也要把它收成一条
	flushQuote();
	if (inFence) {
		items.push({
			types: ['codeBlock'],
			lang: fenceLangName || undefined,
			line: fenceStart,
			text: `代码块${fenceLangName ? `（${fenceLangName}）` : ''} 起 ${fenceStart + 1} 行（未闭合）`,
		});
	}

	return items;
}

export const KEY_INFO_LABELS: Record<KeyInfoType, string> = {
	heading: '标题',
	bold: '加粗',
	highlight: '高亮',
	italic: '斜体',
	inlineCode: '行内代码',
	codeBlock: '代码块',
	blockquote: '引述',
	tag: '标签',
	link: '双链',
};

export interface FormatOptions {
	/** 只保留这些类型；不传 = 全部。 */
	types?: KeyInfoType[];
	/** 按类型分组输出；否则按行号顺序平铺。 */
	groupByType?: boolean;
	/** 标题层级上限（1–6），只影响 heading。 */
	maxLevel?: number;
}

/**
 * 把要点条目格式化成一段结构化 Markdown。
 *
 * 每条形如 `- （第 N 行）文本`，标题按层级缩进；分组时每组一个 `## 标题`。
 * 没有命中任何要素时返回空串，让调用方能报「没有需要处理的内容」。
 */
export function formatKeyInfo(items: KeyInfoItem[], options: FormatOptions = {}): string {
	const { types, groupByType = true, maxLevel } = options;
	const wanted = types?.length ? new Set(types) : null;
	const kept = items.filter((it) => {
		if (wanted && !it.types.some((t) => wanted.has(t))) return false;
		if (maxLevel && it.types.includes('heading') && (it.level ?? 1) > maxLevel) return false;
		return true;
	});
	if (!kept.length) return '';

	const lineOf = (it: KeyInfoItem) => `- （第 ${it.line + 1} 行）${it.text}`;

	if (!groupByType) {
		return kept
			.slice()
			.sort((a, b) => a.line - b.line)
			.map((it) => (it.types.includes('heading') && it.level ? `${'  '.repeat(it.level - 1)}${lineOf(it)}` : lineOf(it)))
			.join('\n');
	}

	const blocks: string[] = [];
	for (const type of KEY_INFO_TYPES) {
		const group = kept
			.filter((it) => it.types.includes(type))
			.slice()
			.sort((a, b) => a.line - b.line);
		if (!group.length) continue;
		blocks.push(`## ${KEY_INFO_LABELS[type]}（${group.length}）\n${group.map(lineOf).join('\n')}`);
	}
	return blocks.join('\n\n');
}

/** 统计命中了哪些类型、各多少条——给 Notice 汇报用。 */
export function countByType(items: KeyInfoItem[]): string {
	const counts = new Map<KeyInfoType, number>();
	for (const it of items) {
		for (const t of it.types) counts.set(t, (counts.get(t) ?? 0) + 1);
	}
	return KEY_INFO_TYPES.filter((t) => counts.has(t))
		.map((t) => `${KEY_INFO_LABELS[t]} ${counts.get(t)}`)
		.join('，');
}
