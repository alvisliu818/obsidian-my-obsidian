/**
 * 播放状态相关类型定义
 * 
 * 定义播放器状态快照的接口，用于在 React 组件中展示播放状态
 */

import type { PlayMode } from "@/main";
import type { LyricLine } from "@/utils/lyrics/parser";
import type { ExtendedLyricLine } from "@/utils/lyrics/extendedParser";

/**
 * 播放状态快照接口
 * 
 * 用于 React 组件展示当前播放状态，包含所有播放相关的信息。
 * 这个快照由 SnapshotService 生成，通过 usePlaybackState hook 提供给组件。
 */
export interface ReactPlaybackSnapshot {
	/** 当前播放歌曲的标题 */
	title: string;
	/** 当前播放歌曲的艺术家 */
	artist: string;
	/** 当前播放歌曲的封面 URL（可选） */
	coverUrl?: string;
	/** 是否正在播放 */
	isPlaying: boolean;
	/** 当前播放时间（秒） */
	currentTime: number;
	/** 歌曲总时长（秒） */
	duration: number;
	/** 播放模式（顺序、循环、单曲循环、随机） */
	playMode: PlayMode;
	/** 上一行歌词文本 */
	prevLyric: string;
	/** 当前行歌词文本 */
	currentLyric: string;
	/** 下一行歌词文本 */
	nextLyric: string;
	/** 上一行逐字歌词（可选） */
	prevExtendedLyric?: ExtendedLyricLine;
	/** 当前行逐字歌词（可选） */
	currentExtendedLyric?: ExtendedLyricLine;
	/** 下一行逐字歌词（可选） */
	nextExtendedLyric?: ExtendedLyricLine;
	/** 完整的普通歌词列表 */
	fullLyrics: LyricLine[];
	/** 完整的逐字歌词列表 */
	fullExtendedLyrics: ExtendedLyricLine[];
	/** 上一首歌曲的封面 URL（可选） */
	prevCoverUrl?: string;
	/** 下一首歌曲的封面 URL（可选） */
	nextCoverUrl?: string;
	/** 当前播放歌曲的文件路径 */
	currentPath: string | null;
	/** 当前列表的 section ID（可选） */
	sectionId?: string | null;
	/** 当前音量（0-1） */
	volume: number;
	/** 当前播放速率（0.25-4.0） */
	playbackRate: number;
	/** 当前歌曲是否已收藏 */
	isFavorite: boolean;
}

