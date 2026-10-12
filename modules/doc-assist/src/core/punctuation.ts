import { forEachLineOutsideFence } from "./cleanup-text";

export type PunctuationToggleMode = "en-to-zh" | "zh-to-en";

/**
 * 英 -> 中 标点映射。
 * 移植自 siyuan-doc-assist punctuation-toggle-core.ts。
 */
const EN_TO_ZH_PUNCTUATION_MAP: Record<string, string> = {
	",": "，",
	".": "。",
	"?": "？",
	"!": "！",
	":": "：",
	";": "；",
	"(": "（",
	")": "）",
	"[": "【",
	"]": "】",
	"{": "｛",
	"}": "｝",
	"<": "《",
	">": "》",
	"．": "。",
	"［": "【",
	"］": "】",
	"＜": "《",
	"＞": "》",
};

/**
 * 中 -> 英 标点映射。
 */
const ZH_TO_EN_PUNCTUATION_MAP: Record<string, string> = {
	"，": ",",
	"。": ".",
	"？": "?",
	"！": "!",
	"：": ":",
	"；": ";",
	"（": "(",
	"）": ")",
	"【": "[",
	"】": "]",
	"｛": "{",
	"｝": "}",
	"《": "<",
	"》": ">",
	"、": ",",
	"“": "\"",
	"”": "\"",
	"‘": "'",
	"’": "'",
	"｡": ".",
	"､": ",",
	"｢": "\"",
	"｣": "\"",
};

const EN_PUNCTUATION_SET = new Set(Object.keys(EN_TO_ZH_PUNCTUATION_MAP));
const ZH_PUNCTUATION_SET = new Set(Object.keys(ZH_TO_EN_PUNCTUATION_MAP));

export type PunctuationConvertResult = {
	next: string;
	changedCount: number;
};

export type PunctuationToggleResult = PunctuationConvertResult & {
	mode: PunctuationToggleMode;
};

function isAsciiDigit(char: string | undefined): boolean {
	if (!char) return false;
	return /[0-9]/.test(char);
}

/**
 * en-to-zh 模式下，夹在两个 ASCII 数字之间的英文逗号/句号视为数字分隔符，保持不变。
 * 例：3.14、1,000。
 */
function shouldKeepEnglishPunctuationInNumber(
	chars: string[],
	index: number,
	mode: PunctuationToggleMode,
): boolean {
	if (mode !== "en-to-zh") return false;
	const current = chars[index];
	if (current !== "," && current !== ".") return false;
	return isAsciiDigit(chars[index - 1]) && isAsciiDigit(chars[index + 1]);
}

function applyPunctuationMap(
	value: string,
	map: Record<string, string>,
	mode: PunctuationToggleMode,
): PunctuationConvertResult {
	let changedCount = 0;
	const chars = Array.from(value || "");
	const next = chars
		.map((char, index) => {
			if (shouldKeepEnglishPunctuationInNumber(chars, index, mode)) {
				return char;
			}
			const converted = map[char];
			if (converted === undefined) {
				return char;
			}
			if (converted !== char) {
				changedCount += 1;
			}
			return converted;
		})
		.join("");

	return { next, changedCount };
}

/**
 * 根据文本内容推断转换方向：出现任一英文标点则 en-to-zh，
 * 只含中文标点则 zh-to-en，完全没有可转换标点时默认 en-to-zh。
 */
export function detectPunctuationToggleMode(value: string): PunctuationToggleMode {
	let hasSupportedPunctuation = false;
	let hasEnglishPunctuation = false;

	for (const char of Array.from(value || "")) {
		if (EN_PUNCTUATION_SET.has(char)) {
			hasSupportedPunctuation = true;
			hasEnglishPunctuation = true;
			continue;
		}
		if (ZH_PUNCTUATION_SET.has(char)) {
			hasSupportedPunctuation = true;
		}
	}

	if (!hasSupportedPunctuation) {
		return "en-to-zh";
	}
	return hasEnglishPunctuation ? "en-to-zh" : "zh-to-en";
}

export function convertChineseEnglishPunctuation(
	value: string,
	mode: PunctuationToggleMode,
): PunctuationConvertResult {
	const map = mode === "zh-to-en" ? ZH_TO_EN_PUNCTUATION_MAP : EN_TO_ZH_PUNCTUATION_MAP;
	return applyPunctuationMap(value || "", map, mode);
}

export function toggleChineseEnglishPunctuation(value: string): PunctuationToggleResult {
	const mode = detectPunctuationToggleMode(value || "");
	const converted = convertChineseEnglishPunctuation(value || "", mode);
	return {
		mode,
		next: converted.next,
		changedCount: converted.changedCount,
	};
}

export type PunctuationToggleOutsideFencesResult = PunctuationToggleResult & {
	fencesSkippedCount: number;
};

/**
 * 围栏感知版标点互转：代码块（```/~~~）内的行保持原样。
 */
export function toggleChineseEnglishPunctuationOutsideFences(
	value: string,
): PunctuationToggleOutsideFencesResult {
	// 方向判定只看围栏外文本，避免代码块内的标点干扰判向
	const outsideLines: string[] = [];
	forEachLineOutsideFence(
		value || "",
		(line) => {
			outsideLines.push(line);
			return line;
		},
		(line) => line,
	);
	const mode = detectPunctuationToggleMode(outsideLines.join("\n"));

	let changedCount = 0;
	let fencesSkippedCount = 0;
	const lines = forEachLineOutsideFence(
		value || "",
		(line) => {
			const converted = convertChineseEnglishPunctuation(line, mode);
			changedCount += converted.changedCount;
			return converted.next;
		},
		(line) => {
			fencesSkippedCount += 1;
			return line;
		},
	);

	return { mode, next: lines.join("\n"), changedCount, fencesSkippedCount };
}
