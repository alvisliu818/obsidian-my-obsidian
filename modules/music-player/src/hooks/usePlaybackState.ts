/**
 * 播放状态管理 Hook
 * 
 * 负责管理音乐播放器的播放状态，提供实时更新的播放状态快照。
 * 
 * 状态包括：
 * - 当前播放歌曲信息（标题、艺术家、封面等）
 * - 播放进度（当前时间、总时长）
 * - 播放状态（是否正在播放）
 * - 播放模式（顺序、循环、单曲循环、随机）
 * - 歌词信息（普通歌词、逐字歌词）
 * - 收藏状态
 * 
 * 使用 requestAnimationFrame 定期更新播放状态，保证 UI 流畅（特别是逐字歌词）。
 * 更新频率为 60fps（每 16ms 更新一次），确保逐字歌词的流畅显示。
 * 
 * **注意**：此 hook 只负责状态管理，不提供操作方法。
 * 操作方法请使用 {@link usePlaybackControl} hook。
 */

import * as React from "react";
import type { ReactPlaybackSnapshot } from "@/types";
import type { MusicPlayerView } from "@/views/MusicPlayerView";

/**
 * 播放状态管理 Hook 的返回值接口
 */
export interface UsePlaybackStateReturn {
	/** 当前播放状态快照，包含所有播放相关的状态信息 */
	playback: ReactPlaybackSnapshot;
}

/**
 * 播放状态管理 Hook
 * 
 * 自动更新播放状态，使用 requestAnimationFrame 实现高频更新（60fps），
 * 确保 UI 特别是逐字歌词的流畅显示。
 * 
 * @param view - MusicPlayerView 实例，用于获取播放状态快照
 * @returns 包含播放状态快照的对象
 * 
 * @example
 * ```tsx
 * const { playback } = usePlaybackState(view);
 * 
 * // 使用播放状态
 * <div>{playback.title}</div>
 * <div>{playback.artist}</div>
 * <div>{playback.currentTime} / {playback.duration}</div>
 * ```
 */
export function usePlaybackState(view: MusicPlayerView): UsePlaybackStateReturn {
	const [playback, setPlayback] = React.useState<ReactPlaybackSnapshot>(
		() => view.getReactPlaybackSnapshot()
	);

	// 使用 requestAnimationFrame 更频繁地更新播放快照，减少延迟
	// 对于逐字歌词，需要更高的更新频率（16ms ≈ 60fps）来保证流畅
	React.useEffect(() => {
		let rafId: number;
		let lastUpdateTime = 0;
		const updateInterval = 16; // 每 16ms 更新一次（60fps），保证逐字歌词流畅

		const updatePlayback = () => {
			const now = Date.now();
			if (now - lastUpdateTime >= updateInterval) {
				setPlayback(view.getReactPlaybackSnapshot());
				lastUpdateTime = now;
			}
			rafId = window.requestAnimationFrame(updatePlayback);
		};

		rafId = window.requestAnimationFrame(updatePlayback);
		return () => cancelAnimationFrame(rafId);
	}, [view]);

	return {
		playback,
	};
}

