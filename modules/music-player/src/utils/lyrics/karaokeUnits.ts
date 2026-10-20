import type { ExtendedLyricChar, ExtendedLyricLine } from "./extendedParser";
import { resolveCharEndTimes } from "./charFillProgress";

/**
 * 卡拉 OK 展示单元：中文等一字一格；英文以「单词」为一格整体着色。
 */
export interface KaraokeUnit {
	text: string;
	charTime: number;
	charEndTime: number;
}

function isLatinAlphanumeric(char: string): boolean {
	return char.length === 1 && /[A-Za-z0-9]/.test(char);
}

/**
 * 是否属于「当前英文单词」的连续片段（字母数字；以及夹在字母/数字间的撇号、连字符）。
 */
function isLatinWordContinuation(
	chars: ReadonlyArray<ExtendedLyricChar>,
	wordStartIdx: number,
	idx: number
): boolean {
	if (idx < 0 || idx >= chars.length) return false;
	const ch = chars[idx]?.char ?? "";
	if (isLatinAlphanumeric(ch)) return true;
	if (idx > wordStartIdx) {
		const prev = chars[idx - 1]?.char ?? "";
		const next = chars[idx + 1]?.char ?? "";
		if (
			(ch === "'" || ch === "-") &&
			isLatinAlphanumeric(prev) &&
			isLatinAlphanumeric(next)
		) {
			return true;
		}
	}
	return false;
}

/**
 * 将解析后的逐字 `chars` 合并为展示单元；结束时间仅由本行 `lineTimeStamps` 与字开始时间决定。
 */
export function buildKaraokeUnits(
	chars: ReadonlyArray<ExtendedLyricChar>,
	line: Pick<ExtendedLyricLine, "lineTimeStamps">
): KaraokeUnit[] {
	if (!chars.length) return [];
	const ends = resolveCharEndTimes(chars, line.lineTimeStamps);
	const units: KaraokeUnit[] = [];
	let i = 0;
	const n = chars.length;
	while (i < n) {
		if (isLatinWordContinuation(chars, i, i)) {
			const start = i;
			let j = i;
			while (j < n && isLatinWordContinuation(chars, start, j)) {
				j++;
			}
			const last = j - 1;
			const text = chars
				.slice(start, j)
				.map((c) => c.char)
				.join("");
			const charTime = chars[start]?.time ?? 0;
			const lastChar = chars[last];
			const charEndTime =
				(last !== undefined ? ends[last] : undefined) ??
				(lastChar?.time ?? charTime) + 0.12;
			units.push({ text, charTime, charEndTime });
			i = j;
		} else {
			const charTime = chars[i]?.time ?? 0;
			const charEndTime = ends[i] ?? (chars[i]?.time ?? charTime) + 0.12;
			units.push({ text: chars[i]?.char ?? "", charTime, charEndTime });
			i++;
		}
	}
	return units;
}
