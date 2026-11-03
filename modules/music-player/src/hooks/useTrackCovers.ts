/**
 * 歌曲封面加载 Hook
 * 
 * 负责管理当前、上一首、下一首歌曲的封面加载逻辑。
 * 优先使用文件夹中的 cover 文件，如果没有则获取内嵌封面。
 */

import React from "react";
import type { MusicPlayerView } from "@/views/MusicPlayerView";
import type { ReactPlaybackSnapshot } from "@/types";

/**
 * Hook 的输入参数
 */
export interface UseTrackCoversParams {
	/** 播放状态快照 */
	playback: ReactPlaybackSnapshot;
	/** MusicPlayerView 实例 */
	view: MusicPlayerView;
}

/**
 * Hook 的返回值
 */
export interface UseTrackCoversReturn {
	/** 当前歌曲的封面 URL（优先文件夹中的 cover，其次内嵌封面） */
	finalCoverUrl: string | undefined;
	/** 上一首歌曲的封面 URL */
	finalPrevCoverUrl: string | undefined;
	/** 下一首歌曲的封面 URL */
	finalNextCoverUrl: string | undefined;
}

/**
 * 歌曲封面加载 Hook
 * 
 * 管理当前、上一首、下一首歌曲的封面加载逻辑。
 * 
 * @param params Hook 参数
 * @returns Hook 返回值
 */
export function useTrackCovers({
	playback,
	view,
}: UseTrackCoversParams): UseTrackCoversReturn {
	const [embeddedCoverUrl, setEmbeddedCoverUrl] = React.useState<string | undefined>(undefined);
	const [embeddedPrevCoverUrl, setEmbeddedPrevCoverUrl] = React.useState<string | undefined>(undefined);
	const [embeddedNextCoverUrl, setEmbeddedNextCoverUrl] = React.useState<string | undefined>(undefined);

	// 加载当前歌曲的内嵌封面
	React.useEffect(() => {
		// 如果已经有文件夹中的 cover，不需要获取内嵌封面
		if (playback.coverUrl) {
			setEmbeddedCoverUrl(undefined);
			return;
		}

		// 如果没有 cover 且有当前路径，异步获取内嵌封面
		if (playback.currentPath) {
			const currentTrack = view.state.trackList.find(t => t.path === playback.currentPath);
			if (currentTrack) {
				void view.getTrackCoverAsync(currentTrack).then(cover => {
					setEmbeddedCoverUrl(cover);
				});
			}
		} else {
			setEmbeddedCoverUrl(undefined);
		}
	}, [playback.coverUrl, playback.currentPath, view]);

	// 加载上一首的内嵌封面
	React.useEffect(() => {
		// 如果已经有文件夹中的 cover，不需要获取内嵌封面
		if (playback.prevCoverUrl) {
			setEmbeddedPrevCoverUrl(undefined);
			return;
		}

		if (playback.currentPath && view.state.trackList.length > 0) {
			const currentIndex = view.state.trackList.findIndex(t => t.path === playback.currentPath);
			if (currentIndex >= 0) {
				const prevIndex = currentIndex > 0 ? currentIndex - 1 : view.state.trackList.length - 1;
				const prevTrack = view.state.trackList[prevIndex];
				if (prevTrack) {
					void view.getTrackCoverAsync(prevTrack).then(cover => {
						setEmbeddedPrevCoverUrl(cover);
					});
				}
			}
		} else {
			setEmbeddedPrevCoverUrl(undefined);
		}
	}, [playback.prevCoverUrl, playback.currentPath, view]);

	// 加载下一首的内嵌封面
	React.useEffect(() => {
		// 如果已经有文件夹中的 cover，不需要获取内嵌封面
		if (playback.nextCoverUrl) {
			setEmbeddedNextCoverUrl(undefined);
			return;
		}

		if (playback.currentPath && view.state.trackList.length > 0) {
			const currentIndex = view.state.trackList.findIndex(t => t.path === playback.currentPath);
			if (currentIndex >= 0) {
				const nextIndex = currentIndex < view.state.trackList.length - 1 ? currentIndex + 1 : 0;
				const nextTrack = view.state.trackList[nextIndex];
				if (nextTrack) {
					void view.getTrackCoverAsync(nextTrack).then(cover => {
						setEmbeddedNextCoverUrl(cover);
					});
				}
			}
		} else {
			setEmbeddedNextCoverUrl(undefined);
		}
	}, [playback.nextCoverUrl, playback.currentPath, view]);

	// 合并封面 URL（优先文件夹中的 cover，其次内嵌封面）
	const finalCoverUrl = playback.coverUrl || embeddedCoverUrl;
	const finalPrevCoverUrl = playback.prevCoverUrl || embeddedPrevCoverUrl;
	const finalNextCoverUrl = playback.nextCoverUrl || embeddedNextCoverUrl;

	return {
		finalCoverUrl,
		finalPrevCoverUrl,
		finalNextCoverUrl,
	};
}

