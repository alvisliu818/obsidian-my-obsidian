/**
 * LRC 歌词偏移（[offset:±ms]）解析与应用模块
 * 
 * 与常规播放器行为一致：
 * - 偏移信息是歌词参数，不显示在歌词中
 * - 正偏移表示歌词整体提前（所有时间戳减去偏移），负偏移表示整体延后
 */

import type { LyricLine } from "./parser";
import type { ExtendedLyricLine } from "./extendedParser";

/** [offset:±ms] 标签的模式（大小写不敏感，允许 + 号与空白） */
const OFFSET_TAG_SOURCE = String.raw`\[\s*offset\s*:\s*([+-]?\d+)\s*\]`;

/** 时间戳下限，避免偏移后出现负时间 */
const MIN_TIME = 0;

/** 把时间 clamp 到不小于 0 */
function clampTime(time: number): number {
	return time < MIN_TIME ? MIN_TIME : time;
}

/**
 * 解析歌词文本中的偏移量（[offset:±ms]），返回秒。
 * 
 * 取第一个出现的偏移标签；无偏移或格式非法时返回 0。
 * 
 * @param text 原始歌词文本
 * @returns 偏移量（秒），正数表示歌词整体提前
 */
export function parseLyricsOffset(text: string): number {
	if (!text) return 0;
	// 用非全局正则单次匹配，避免共享正则对象的 lastIndex 状态问题
	const match = new RegExp(OFFSET_TAG_SOURCE, "i").exec(text);
	const raw = match?.[1];
	if (!raw) return 0;
	const milliseconds = Number.parseInt(raw, 10);
	if (!Number.isFinite(milliseconds)) return 0;
	return milliseconds / 1000;
}

/**
 * 移除歌词文本中所有 [offset:...] 标签。
 * 
 * 偏移是歌词参数而非内容，解析与展示前需要剔除。
 * 
 * @param text 原始歌词文本
 * @returns 移除偏移标签后的文本
 */
export function stripLyricsOffsetTags(text: string): string {
	return text.replace(new RegExp(OFFSET_TAG_SOURCE, "gi"), "");
}

/**
 * 把偏移量应用到解析后的歌词数据（就地修改）。
 * 
 * 行数组已按时间排序，均匀平移不会破坏顺序，仅头部可能被 clamp 到 0。
 * 逐字歌词的行时间、每个字的时间以及行内时间戳会一并平移。
 * 
 * @param lyrics 普通歌词行数组
 * @param extendedLyrics 逐字歌词行数组
 * @param offsetSeconds 偏移量（秒），正数表示歌词整体提前
 */
export function applyLyricsOffset(
	lyrics: LyricLine[],
	extendedLyrics: ExtendedLyricLine[],
	offsetSeconds: number
): void {
	if (!offsetSeconds || !Number.isFinite(offsetSeconds)) return;

	for (const line of lyrics) {
		line.time = clampTime(line.time - offsetSeconds);
	}

	for (const line of extendedLyrics) {
		line.time = clampTime(line.time - offsetSeconds);
		for (const char of line.chars) {
			char.time = clampTime(char.time - offsetSeconds);
		}
		line.lineTimeStamps = line.lineTimeStamps.map((t) => clampTime(t - offsetSeconds));
	}
}
