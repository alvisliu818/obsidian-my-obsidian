/**
 * 歌词索引计算 Hook
 * 
 * 根据当前播放时间计算"正在播放"的歌词行索引
 * 使用统一的工具函数进行计算，避免重复逻辑
 */

import * as React from "react";
import type { LyricLine } from "@/utils/lyrics/parser";
import type { ExtendedLyricLine } from "@/utils/lyrics/extendedParser";
import { calculateLyricsIndex } from "@/utils/lyrics/indexCalculator";

export interface UseLyricsIndexOptions {
	/** 普通歌词列表 */
	fullLyrics: LyricLine[];
	/** 逐字歌词列表 */
	fullExtendedLyrics: ExtendedLyricLine[];
	/** 当前播放时间（秒） */
	currentTime: number;
}

/**
 * 歌词索引计算 Hook
 * 
 * @param options 歌词数据和时间
 * @returns 当前播放的歌词行索引（-1 表示没有匹配的歌词）
 */
export function useLyricsIndex({
	fullLyrics,
	fullExtendedLyrics,
	currentTime,
}: UseLyricsIndexOptions): number {
	// 使用统一的工具函数计算歌词索引
	const playingIndex = React.useMemo(() => {
		return calculateLyricsIndex({
			fullLyrics,
			fullExtendedLyrics,
			currentTime,
		});
	}, [fullLyrics, fullExtendedLyrics, currentTime]);

	return playingIndex;
}

