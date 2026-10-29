/**
 * 播放控制逻辑 Hook
 * 
 * 封装播放控制相关的业务逻辑，提供 React 组件使用的播放控制方法。
 * 所有方法都使用 useCallback 进行优化，避免不必要的重新渲染。
 * 
 * 功能包括：
 * - 播放/暂停控制
 * - 上一首/下一首切换
 * - 播放模式切换
 * - 播放进度控制（跳转、快进、快退）
 * - 播放列表管理
 * - 搜索功能
 */

import * as React from "react";
import type { MusicPlayerView } from "@/views/MusicPlayerView";

/**
 * 播放控制 Hook 的返回值接口
 */
export interface UsePlaybackControlReturn {
	/** 切换播放/暂停状态 */
	togglePlay: () => Promise<void>;
	/** 播放上一首歌曲 */
	playPrevious: () => Promise<void>;
	/** 播放下一首歌曲 */
	playNext: () => Promise<void>;
	/** 切换播放模式（顺序、循环、单曲循环、随机） */
	togglePlayMode: () => Promise<void>;
	/** 跳转到指定播放位置（0-1 之间的比例，0 为开始，1 为结束） */
	seekToRatio: (ratio: number) => void;
	/** 快进指定秒数 */
	seekForward: (seconds: number) => void;
	/** 快退指定秒数 */
	seekBackward: (seconds: number) => void;
	/** 打开播放列表选择对话框，用于查看和切换队列中的歌曲 */
	openPlaylistSheet: () => Promise<void>;
	/** 打开搜索对话框，用于搜索曲目、艺术家、专辑 */
	openSearchModal: () => void;
}

/**
 * 播放控制逻辑 Hook
 * 
 * 提供播放控制相关的所有方法，所有方法都通过 useCallback 进行优化。
 * 
 * @param view - MusicPlayerView 实例，提供底层播放控制方法
 * @returns 播放控制方法集合
 * 
 * @example
 * ```tsx
 * const playbackControl = usePlaybackControl(view);
 * 
 * // 播放/暂停
 * await playbackControl.togglePlay();
 * 
 * // 上一首/下一首
 * await playbackControl.playPrevious();
 * await playbackControl.playNext();
 * 
 * // 跳转到 50% 位置
 * playbackControl.seekToRatio(0.5);
 * ```
 */
export function usePlaybackControl(view: MusicPlayerView): UsePlaybackControlReturn {
	// 切换播放/暂停
	const togglePlay = React.useCallback(async () => {
		await view.togglePlay();
	}, [view]);

	// 播放上一首
	const playPrevious = React.useCallback(async () => {
		await view.playPrevious();
	}, [view]);

	// 播放下一首
	const playNext = React.useCallback(async () => {
		await view.playNext();
	}, [view]);

	// 切换播放模式
	const togglePlayMode = React.useCallback(async () => {
		await view.togglePlayMode();
	}, [view]);

	// 跳转到指定播放位置
	const seekToRatio = React.useCallback(
		(ratio: number) => {
			view.seekToRatio(ratio);
		},
		[view]
	);

	// 快进指定秒数
	const seekForward = React.useCallback(
		(seconds: number) => {
			view.seekForward(seconds);
		},
		[view]
	);

	// 快退指定秒数
	const seekBackward = React.useCallback(
		(seconds: number) => {
			view.seekBackward(seconds);
		},
		[view]
	);

	// 打开播放列表选择对话框
	const openPlaylistSheet = React.useCallback(async () => {
		await view.openPlaylistSheet();
	}, [view]);

	// 打开搜索对话框
	const openSearchModal = React.useCallback(() => {
		view.openSearchModalPublic();
	}, [view]);

	return {
		togglePlay,
		playPrevious,
		playNext,
		togglePlayMode,
		seekToRatio,
		seekForward,
		seekBackward,
		openPlaylistSheet,
		openSearchModal,
	};
}

