/**
 * 音乐库状态管理 Hook
 * 
 * 负责管理音乐库的状态，包括：
 * - 所有歌曲列表
 * - 收藏列表
 * - 歌单列表
 * - 艺术家列表
 * - 专辑列表
 * - 当前播放列表标识
 * - 当前播放歌曲路径
 * 
 * 订阅库更新事件，在外部更新库后自动刷新状态
 */

import * as React from "react";
import type { ReactLibrarySnapshot } from "@/types";
import type { MusicPlayerView } from "@/views/MusicPlayerView";

/**
 * 音乐库状态管理 Hook 的返回值
 */
export interface UseLibraryStateReturn {
	/** 当前音乐库快照 */
	library: ReactLibrarySnapshot;
	/** 重建所有数据（完全重建音乐库的所有数据） */
	rebuildAllData: () => Promise<void>;
	/** 手动刷新库快照（用于在外部更新后刷新） */
	refreshSnapshot: () => void;
}

/**
 * 音乐库状态管理 Hook
 * 
 * @param view MusicPlayerView 实例
 * @returns 音乐库状态和操作方法
 */
export function useLibraryState(view: MusicPlayerView): UseLibraryStateReturn {
	const [library, setLibrary] = React.useState<ReactLibrarySnapshot>(
		() => view.getReactLibrarySnapshot()
	);

	// 手动刷新快照的函数
	const refreshSnapshot = React.useCallback(() => {
		setLibrary(view.getReactLibrarySnapshot());
	}, [view]);

	// 订阅来自 View 的"库已更新"事件，用于在外部更新（例如启动时自动扫描）完成后刷新 React 快照
	React.useEffect(() => {
		const listener = () => {
			refreshSnapshot();
		};
		view.subscribeLibraryUpdates(listener);
		return () => {
			view.unsubscribeLibraryUpdates(listener);
		};
	}, [view, refreshSnapshot]);

	// 重建所有数据（完全重建音乐库的所有数据）
	const rebuildAllData = React.useCallback(async () => {
		await view.rebuildAllData();
		// rebuildAllData 内部会调用 handleLibraryUpdated，进而触发订阅的监听器
		// 所以这里不需要手动调用 refreshSnapshot
	}, [view]);

	return {
		library,
		rebuildAllData,
		refreshSnapshot,
	};
}

