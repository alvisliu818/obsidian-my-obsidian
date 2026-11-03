/**
 * 场景二 清洗核心 — 纯文本变换，全部基于 markdown 字符串，不依赖 Obsidian API。
 *
 * 移植自 siyuan-doc-assist src/core/markdown-cleanup-{core,text-core}.ts，
 * 适配差异：
 * - 思源块模型（块 ID + IAL `{: ...}`）→ 纯 Markdown 行模型，IAL 相关规则移除；
 * - 部分操作增加围栏感知（代码块内容原样保留），比思源版更保守。
 */

export type CleanupResult = {
	text: string;
	removedLines: number;
};

export type TrailingWhitespaceResult = {
	text: string;
	changedLines: number;
	removedChars: number;
};

export function isBlankLine(line: string): boolean {
	if (!line) return true;
	const normalized = line
		.replace(/<[^>]*>/g, '')
		.replace(/&nbsp;|&#160;|&#xA0;/gi, '')
		.replace(/[\p{Cf}\p{Z}]/gu, '')
		.replace(/\s+/g, '');
	return normalized.length === 0;
}

export function isFenceLine(line: string): { marker: string; length: number } | null {
	const match = line.match(/^\s*(`{3,}|~{3,})/);
	if (!match) return null;
	return { marker: match[1], length: match[1].length };
}

/**
 * 逐行遍历工具：跟踪 ```/~~~ 围栏状态，fence 内行回调 onInside，其余回调 onOutside。
 * 回调返回 null 表示删除该行（不进入输出）。
 */
export function forEachLineOutsideFence(
	text: string,
	onOutside: (line: string) => string | null,
	onInside: (line: string) => string = (line) => line,
): string[] {
	const lines = text.split(/\r?\n/);
	const output: string[] = [];
	let inFence = false;
	let fenceChar = '';
	let fenceLen = 0;
	for (const line of lines) {
		const fence = isFenceLine(line);
		if (fence) {
			const markerChar = fence.marker[0];
			if (!inFence) {
				inFence = true;
				fenceChar = markerChar;
				fenceLen = fence.length;
			} else if (markerChar === fenceChar && fence.length >= fenceLen) {
				inFence = false;
				fenceChar = '';
				fenceLen = 0;
			}
			output.push(line);
			continue;
		}
		const next = inFence ? onInside(line) : onOutside(line);
		if (next !== null) {
			output.push(next);
		}
	}
	return output;
}

/** 去除多余空行：连续空行合并为一行（围栏内不动）。 */
export function removeExtraBlankLines(text: string): CleanupResult {
	if (!text) return { text: '', removedLines: 0 };
	let removedLines = 0;
	let previousBlank = false;
	const lines = forEachLineOutsideFence(text, (line) => {
		if (isBlankLine(line)) {
			if (previousBlank) {
				removedLines += 1;
				return null;
			}
			previousBlank = true;
			return '';
		}
		previousBlank = false;
		return line;
	}, (line) => {
		previousBlank = false;
		return line;
	});
	return { text: lines.join('\n'), removedLines };
}

/** 去除行尾空白（围栏内不动——代码里的行尾空白可能有语义）。 */
export function removeTrailingWhitespace(text: string): TrailingWhitespaceResult {
	if (!text) return { text: '', changedLines: 0, removedChars: 0 };
	const trailingPattern = /[^\S\r\n]+$/u;
	let changedLines = 0;
	let removedChars = 0;
	const lines = forEachLineOutsideFence(text, (line) => {
		const match = line.match(trailingPattern);
		if (!match) return line;
		changedLines += 1;
		removedChars += match[0].length;
		return line.slice(0, line.length - match[0].length);
	}, (line) => line);
	return { text: lines.join('\n'), changedLines, removedChars };
}

export type ClippedListPrefixResult = {
	text: string;
	removedCount: number;
};

const BULLET_CHARS = '[•·○◦▪▸➢➤►◆◇✓✔★☆→⁃‣⦿⦾◉●]';

/** 清理剪藏器塞进列表项里的冗余符号前缀：`- • text` → `- text`、`1. 1. text` → `1. text`。 */
export function removeClippedListPrefixes(text: string): ClippedListPrefixResult {
	if (!text) return { text: '', removedCount: 0 };
	const lines = text.replace(/\r\n/g, '\n').split('\n');
	const out: string[] = [];
	let removedCount = 0;
	for (const line of lines) {
		const flatUnordered = line.match(
			new RegExp(`^(\\s*(?:[-*+]))\\s+${BULLET_CHARS}\\s*(.*)$`),
		);
		if (flatUnordered) {
			out.push(`${flatUnordered[1]} ${flatUnordered[2]}`);
			removedCount += 1;
			continue;
		}
		const flatOrdered = line.match(/^(\s*)(\d+)([.)])\s+(\d+)([.)])\s+(.*)$/);
		if (flatOrdered && flatOrdered[2] === flatOrdered[4]) {
			out.push(`${flatOrdered[1]}${flatOrdered[2]}${flatOrdered[3]} ${flatOrdered[6]}`);
			removedCount += 1;
			continue;
		}
		out.push(line);
	}
	return { text: out.join('\n'), removedCount };
}

// ---------------------------------------------------------------------------
// AI 报告残留清理（Deep Research 类报告的脚注/隐藏标记/来源链接噪音）
// 移植自 src/core/markdown-cleanup-ai-core.ts，逐行规则管线原样保留。
// ---------------------------------------------------------------------------

export type AiOutputCleanupResult = {
	text: string;
	removedSupCount: number;
	removedCaretCount: number;
	removedInternetLinkCount: number;
	removedHiddenSpanCount: number;
	removedRefCount: number;
	removedDividerCount: number;
	removedCount: number;
};

function stripTrailingInternetLinksInLine(line: string): { line: string; removedCount: number } {
	if (!line) return { line: '', removedCount: 0 };
	const padding = '[\\p{Cf}\\p{Zs}\\t]*';
	const httpTarget = '(https?:\\/\\/[^)\\s]+(?:\\s+["\'][^"\'\\n]*["\'])?)';
	const patterns = [
		new RegExp(`${padding}\\[\\[[^\\]\\n]*\\]\\(${httpTarget}\\)\\]${padding}$`, 'iu'),
		new RegExp(`${padding}\\[[^\\]\\n]*\\]\\(${httpTarget}\\)${padding}$`, 'iu'),
		new RegExp(`${padding}<https?:\\/\\/[^>\\s]+>${padding}$`, 'iu'),
		new RegExp(`${padding}\\[https?:\\/\\/[^\\]\\s]+\\]${padding}$`, 'iu'),
		new RegExp(`${padding}https?:\\/\\/[^\\s<>()]+${padding}$`, 'iu'),
	];
	let next = line;
	let removedCount = 0;
	let removed = false;
	do {
		removed = false;
		for (const pattern of patterns) {
			const match = pattern.exec(next);
			if (!match || match.index < 0) continue;
			next = next.slice(0, match.index);
			removedCount += 1;
			removed = true;
			break;
		}
	} while (removed);
	return { line: next, removedCount };
}

export function cleanupAiOutputArtifacts(text: string): AiOutputCleanupResult {
	const source = text || '';
	const counters = {
		removedSupCount: 0,
		removedCaretCount: 0,
		removedInternetLinkCount: 0,
		removedHiddenSpanCount: 0,
		removedRefCount: 0,
		removedDividerCount: 0,
	};
	if (!source) return { text: '', ...counters, removedCount: 0 };

	const lines = forEachLineOutsideFence(source, (line) => {
		let next = line;
		// 隐藏 span
		next = next.replace(
			/<span\b[^>]*\bstyle\s*=\s*["'][^"']*\bdisplay\s*:\s*none\b[^"']*["'][^>]*>[\s\S]*?<\/span>/giu,
			() => {
				counters.removedHiddenSpanCount += 1;
				return '';
			},
		);
		// <sup> 脚注上标
		next = next.replace(/[ \t]*<sup\b[^>\n]*>[\s\S]*?<\/sup>/giu, () => {
			counters.removedSupCount += 1;
			return '';
		});
		// ^^ 上标标记
		next = next.replace(/[ \t]*\^\^[ \t]*/g, () => {
			counters.removedCaretCount += 1;
			return '';
		});
		// 行尾来源链接（表格行保护尾部的 |）
		const tableSuffix = next.match(/^([\s\S]*?)(\s*\|\s*)$/u);
		if (tableSuffix) {
			const stripped = stripTrailingInternetLinksInLine(tableSuffix[1] || '');
			next = `${stripped.line}${tableSuffix[2]}`;
			counters.removedInternetLinkCount += stripped.removedCount;
		} else {
			const stripped = stripTrailingInternetLinksInLine(next);
			next = stripped.line;
			counters.removedInternetLinkCount += stripped.removedCount;
		}
		// 引用标记 [^1] / [1_2] / ^^1^^（行首的纯编号列表项保留）
		next = next.replace(
			/\[\^[0-9]+(?:_[0-9]+)*\](?!\():?|\[[0-9]+(?:_[0-9]+)+\](?!\()/gu,
			(match, offset: number) => {
				const isLineStart = /^\s*$/.test(next.slice(0, offset));
				if (!match.includes('^') && isLineStart) return match;
				counters.removedRefCount += 1;
				return '';
			},
		);
		// 独立分隔线：整行删除（不留空行）
		if (/^[ \t]*(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(next)) {
			counters.removedDividerCount += 1;
			return null;
		}
		return next;
	});

	const removedCount =
		counters.removedSupCount +
		counters.removedCaretCount +
		counters.removedInternetLinkCount +
		counters.removedHiddenSpanCount +
		counters.removedRefCount +
		counters.removedDividerCount;
	return { text: lines.join('\n'), ...counters, removedCount };
}

// ---------------------------------------------------------------------------
// 中英双语段落拆分（思源版逐段翻译的孪生操作：一段中英混排拆成两段）
// 移植自 src/core/markdown-cleanup-text-core.ts splitBilingualParagraphMarkdown。
// ---------------------------------------------------------------------------

export type BilingualParagraphSplitResult = {
	parts: string[];
	changed: boolean;
};

type LanguageLabel = 'en' | 'zh' | 'neutral';

type SentenceChunkMeta = {
	text: string;
	label: LanguageLabel;
};

const MARKDOWN_LINK_PATTERN = /!?\[([^\]]*)\]\([^)]+\)/g;
const INLINE_MARKUP_PATTERN = /[*_~#>]+/g;
const HTML_TAG_PATTERN = /<[^>]+>/g;
const LATIN_LETTER_PATTERN = /[A-Za-z]/g;
const HAN_CHAR_PATTERN = /\p{Script=Han}/gu;
const BILINGUAL_SKIP_PATTERN = /`|https?:\/\/|www\./iu;
const SENTENCE_END_CHARS = new Set(['.', '!', '?', ';', '。', '！', '？', '；']);
const SENTENCE_TAIL_PATTERN = /["'”’)\]】）\s]/u;

function countMatches(value: string, pattern: RegExp): number {
	return value.match(pattern)?.length || 0;
}

function stripMarkdownForLanguageDetection(value: string): string {
	return (value || '')
		.replace(MARKDOWN_LINK_PATTERN, '$1')
		.replace(HTML_TAG_PATTERN, ' ')
		.replace(INLINE_MARKUP_PATTERN, '');
}

function splitSentenceChunks(value: string): string[] {
	if (!value) return [];
	const chunks: string[] = [];
	let current = '';
	for (let i = 0; i < value.length; i += 1) {
		current += value[i];
		if (!SENTENCE_END_CHARS.has(value[i])) continue;
		while (i + 1 < value.length && SENTENCE_TAIL_PATTERN.test(value[i + 1])) {
			current += value[i + 1];
			i += 1;
		}
		chunks.push(current);
		current = '';
	}
	if (current) chunks.push(current);
	return chunks.filter((chunk) => chunk.trim().length > 0);
}

function classifySentenceChunk(value: string): SentenceChunkMeta {
	const normalized = stripMarkdownForLanguageDetection(value);
	const latinCount = countMatches(normalized, LATIN_LETTER_PATTERN);
	const hanCount = countMatches(normalized, HAN_CHAR_PATTERN);
	if (latinCount >= 12 && latinCount >= hanCount * 2) return { text: value, label: 'en' };
	if (hanCount >= 6 && hanCount >= latinCount * 2) return { text: value, label: 'zh' };
	return { text: value, label: 'neutral' };
}

/** 单段中英混排拆分：仅当恰好一次语言切换时拆为两段。 */
export function splitBilingualParagraph(paragraph: string): BilingualParagraphSplitResult {
	const normalized = (paragraph || '').replace(/\r\n/g, '\n').trim();
	if (!normalized || normalized.includes('\n') || BILINGUAL_SKIP_PATTERN.test(normalized)) {
		return { parts: [paragraph || ''], changed: false };
	}
	const stripped = stripMarkdownForLanguageDetection(normalized);
	const totalLatin = countMatches(stripped, LATIN_LETTER_PATTERN);
	const totalHan = countMatches(stripped, HAN_CHAR_PATTERN);
	if (totalLatin < 20 || totalHan < 8) return { parts: [paragraph], changed: false };

	const chunks = splitSentenceChunks(normalized);
	if (chunks.length < 2) return { parts: [paragraph], changed: false };

	const metas = chunks.map(classifySentenceChunk);
	const dominant = metas.map((meta, index) => ({ ...meta, index })).filter((m) => m.label !== 'neutral');
	if (dominant.length < 2) return { parts: [paragraph], changed: false };

	let splitAt = -1;
	let switchCount = 0;
	for (let i = 1; i < dominant.length; i += 1) {
		if (dominant[i - 1].label === dominant[i].label) continue;
		switchCount += 1;
		splitAt = dominant[i].index;
	}
	if (switchCount !== 1 || splitAt <= 0 || splitAt >= chunks.length) {
		return { parts: [paragraph], changed: false };
	}
	const first = chunks.slice(0, splitAt).join('').trim();
	const second = chunks.slice(splitAt).join('').trim();
	if (!first || !second) return { parts: [paragraph], changed: false };
	const firstMeta = classifySentenceChunk(first);
	const secondMeta = classifySentenceChunk(second);
	if (
		firstMeta.label === 'neutral' ||
		secondMeta.label === 'neutral' ||
		firstMeta.label === secondMeta.label
	) {
		return { parts: [paragraph], changed: false };
	}
	return { parts: [first, second], changed: true };
}

/** 对整个范围逐段应用双语拆分（围栏内不动），返回替换文本与拆分段数。 */
export function splitBilingualParagraphsInText(text: string): { text: string; splitCount: number } {
	let splitCount = 0;
	const lines = forEachLineOutsideFence(text, (line) => {
		const result = splitBilingualParagraph(line);
		if (result.changed) {
			splitCount += 1;
			return result.parts.join('\n\n');
		}
		return line;
	});
	return { text: lines.join('\n'), splitCount };
}

// ---------------------------------------------------------------------------
// 段落⇋换行互转（选区级）
// 移植自 src/core/selection-text-transform-core.ts。
// ---------------------------------------------------------------------------

export function countSingleLineBreaks(value: string): number {
	const normalized = (value || '').replace(/\r\n/g, '\n');
	return normalized.match(/(?<!\n)\n(?!\n)/g)?.length || 0;
}

/** 单个换行 → 段落（空行）。 */
export function convertSingleLineBreaksToParagraphs(value: string): string {
	return (value || '').replace(/\r\n/g, '\n').replace(/(?<!\n)\n(?!\n)/g, '\n\n');
}

/** 连续空行 → 单换行（段内合并）。 */
export function convertParagraphBreaksToLines(value: string): string {
	return (value || '').replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n');
}

// ---------------------------------------------------------------------------
// 中英文空格（盘古规则）
// ---------------------------------------------------------------------------

const CJK_CHAR = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const LATIN_WORD = /[A-Za-z0-9`$%@&#*_+=[\](）]/;

/** 在 CJK 与拉丁字符/数字之间补一个空格（跳过 URL 与已有空格），围栏内不动。 */
export function addCjkLatinSpaces(text: string): { text: string; changedCount: number } {
	let changedCount = 0;
	const lines = forEachLineOutsideFence(text, (line) => {
		// 跳过 URL：按 http/www 切段，只处理非 URL 段
		const segments = line.split(/(https?:\/\/\S+|www\.\S+)/g);
		const processed = segments.map((segment) => {
			if (/^(https?:\/\/|www\.)/.test(segment)) return segment;
			return segment.replace(
				new RegExp(
					`(${CJK_CHAR.source})(?=${LATIN_WORD.source})|(${LATIN_WORD.source})(?=${CJK_CHAR.source})`,
					'gu',
				),
				(match) => {
					changedCount += 1;
					return `${match} `;
				},
			);
		});
		return processed.join('');
	});
	return { text: lines.join('\n'), changedCount };
}
