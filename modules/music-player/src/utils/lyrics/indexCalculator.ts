/**
 * 歌词索引计算工具函数
 * 
 * 统一处理歌词索引计算逻辑，避免在多个地方重复实现。
 * 支持普通歌词和逐字时间歌词两种模式，使用二分查找优化性能。
 */

import type { LyricLine } from "@/utils/lyrics/parser";
import type { ExtendedLyricLine } from "@/utils/lyrics/extendedParser";

/**
 * 歌词索引计算选项接口
 */
export interface LyricsIndexCalculatorOptions {
	/** 普通歌词列表（LRC 格式） */
	fullLyrics: LyricLine[];
	/** 逐字时间歌词列表（与 LYRICS 内嵌卡拉 OK 格式解析结果一致） */
	fullExtendedLyrics: ExtendedLyricLine[];
	/** 当前播放时间（秒） */
	currentTime: number;
}

/**
 * 计算当前播放的歌词行索引
 * 
 * 根据当前播放时间，使用二分查找算法找到应该显示的歌词行。
 * 优先使用逐字时间歌词（如果存在），否则使用普通歌词。
 * 
 * 时间提前机制：
 * - 逐字歌词：提前 0.2 秒显示（需要更精确的时间控制）
 * - 普通歌词：提前 0.5 秒显示（和三行歌词保持一致，让歌词先上移一行再开始唱）
 * 
 * @param options 歌词数据和时间选项
 * @returns 返回当前应该显示的歌词行索引，如果没有匹配的歌词则返回 -1
 * 
 * @example
 * ```typescript
 * const index = calculateLyricsIndex({
 *   fullLyrics: [...],
 *   fullExtendedLyrics: [...],
 *   currentTime: 12.5
 * });
 * // index: 2 (表示应该显示第 3 行歌词)
 * ```
 */
export function calculateLyricsIndex({
	fullLyrics,
	fullExtendedLyrics,
	currentTime,
}: LyricsIndexCalculatorOptions): number {
	// 判断是否使用逐字歌词
	const useExtendedLyrics = fullExtendedLyrics && fullExtendedLyrics.length > 0;
	const lyricsToUse = useExtendedLyrics ? fullExtendedLyrics : fullLyrics;

	if (!lyricsToUse?.length) return -1;

	// 对于逐字歌词，提前时间更短（0.2秒），因为需要更精确的时间控制
	// 对于普通歌词，提前0.5秒显示，和三行歌词保持一致，让歌词先上移一行再开始唱
	const advanceTime = useExtendedLyrics ? 0.2 : 0.5;
	const adjustedTime = currentTime + advanceTime;

	// 使用二分查找优化查找速度
	let left = 0;
	let right = lyricsToUse.length - 1;
	let result = -1;

	while (left <= right) {
		const mid = Math.floor((left + right) / 2);
		const cur = lyricsToUse[mid];
		const next = lyricsToUse[mid + 1];

		if (cur && adjustedTime >= cur.time) {
			if (!next || adjustedTime < next.time) {
				result = mid;
				break;
			}
			left = mid + 1;
		} else {
			right = mid - 1;
		}
	}

	return result;
}

