/**
 * 音乐库管理逻辑 Hook
 * 
 * 封装音乐库管理相关的业务逻辑，提供 React 组件使用的库管理方法。
 * 所有方法都使用 useCallback 进行优化，避免不必要的重新渲染。
 * 
 * 功能包括：
 * - 播放歌曲
 * - 重建所有数据（完全重建音乐库的所有数据）
 * - 收藏管理（切换收藏状态）
 * - 歌单管理（创建、编辑、删除、添加/移除歌曲）
 * - 分类播放（按艺术家、专辑、歌单播放）
 */

import * as React from "react";
import type { MusicPlayerView } from "@/views/MusicPlayerView";
import type { ReactTrackInfo } from "@/types";

/**
 * 音乐库管理 Hook 的返回值接口
 */
export interface UseLibraryManagementReturn {
	/** 播放歌曲 */
	handlePlay: (path: string, sectionId?: string) => Promise<void>;
	/** 重建所有数据（完全重建音乐库的所有数据） */
	rebuildAllData: () => Promise<void>;
	/** 
	 * 切换收藏状态
	 * @param path - 音乐文件路径
	 * @param sectionId - 可选的 section ID，用于更新列表上下文
	 */
	toggleFavorite: (path: string, sectionId?: string) => Promise<void>;
	/** 
	 * 将歌曲添加到播放列表
	 * @param path - 音乐文件路径
	 * @param sectionId - 可选的 section ID，用于更新列表上下文
	 */
	addToPlaylist: (path: string, sectionId?: string) => Promise<void>;
	/** 
	 * 从播放列表中移除歌曲
	 * @param path - 音乐文件路径
	 * @param playlistName - 播放列表名称
	 */
	removeFromPlaylist: (path: string, playlistName: string) => Promise<void>;
	/** 创建新的播放列表 */
	createPlaylist: () => Promise<void>;
	/** 
	 * 编辑播放列表名称
	 * @param oldName - 旧的播放列表名称
	 */
	editPlaylistName: (oldName: string) => Promise<void>;
	/** 
	 * 删除播放列表
	 * @param playlistName - 要删除的播放列表名称
	 */
	deletePlaylist: (playlistName: string) => Promise<void>;
	/** 
	 * 播放分类（艺术家、专辑、歌单）
	 * @param categoryType - 分类类型（"artist", "album", "playlist"）
	 * @param categoryName - 分类名称
	 * @param tracks - 该分类下的曲目列表
	 */
	playCategory: (categoryType: string, categoryName: string, tracks: ReactTrackInfo[]) => Promise<void>;
}

/**
 * 音乐库管理逻辑 Hook
 * 
 * 提供音乐库管理相关的所有方法，包括收藏、播放列表、分类播放等功能。
 * 所有方法都通过 useCallback 进行优化，确保在依赖不变时不会重新创建。
 * 
 * @param view - MusicPlayerView 实例，提供底层库管理方法
 * @returns 音乐库管理方法集合
 * 
 * @example
 * ```tsx
 * const libraryManagement = useLibraryManagement(view);
 * 
 * // 切换收藏
 * await libraryManagement.toggleFavorite(track.path);
 * 
 * // 添加到播放列表
 * await libraryManagement.addToPlaylist(track.path);
 * 
 * // 播放艺术家
 * await libraryManagement.playCategory("artist", "Artist Name", tracks);
 * ```
 */
export function useLibraryManagement(view: MusicPlayerView): UseLibraryManagementReturn {
	const api = view.reactApi;

	// 播放歌曲
	const handlePlay = React.useCallback(
		async (path: string, sectionId?: string) => {
			await api.playByPath(path, sectionId);
			// playByPath -> playTrack -> handleLibraryUpdated
			// useLibraryState hook 会自动订阅并更新
		},
		[api]
	);

	// 重建所有数据
	const rebuildAllData = React.useCallback(async () => {
		await view.rebuildAllData();
		// rebuildAllData 内部会触发库更新事件，useLibraryState hook 会自动更新
	}, [view]);

	// 切换收藏状态
	const toggleFavorite = React.useCallback(
		async (path: string, sectionId?: string) => {
			await api.toggleFavorite(path, sectionId);
		},
		[api]
	);

	// 添加到歌单
	const addToPlaylist = React.useCallback(
		async (path: string, sectionId?: string) => {
			await api.addToPlaylist(path, sectionId);
		},
		[api]
	);

	// 从歌单移除
	const removeFromPlaylist = React.useCallback(
		async (path: string, playlistName: string) => {
			await api.removeFromPlaylist(path, playlistName);
		},
		[api]
	);

	// 创建歌单
	const createPlaylist = React.useCallback(async () => {
		await api.createPlaylist();
	}, [api]);

	// 编辑歌单名称
	const editPlaylistName = React.useCallback(
		async (oldName: string) => {
			await api.editPlaylistName(oldName);
		},
		[api]
	);

	// 删除歌单
	const deletePlaylist = React.useCallback(
		async (playlistName: string) => {
			await api.deletePlaylist(playlistName);
		},
		[api]
	);

	// 播放分类
	const playCategory = React.useCallback(
		async (categoryType: string, categoryName: string, tracks: ReactTrackInfo[]) => {
			// 直接传递 tracks，转换逻辑统一在 ReactApiService 中处理
			// 这样可以避免重复转换，并且使用最新的 state.trackList 进行查找
			await api.playCategory(categoryType, categoryName, tracks);
		},
		[api]
	);

	return {
		handlePlay,
		rebuildAllData,
		toggleFavorite,
		addToPlaylist,
		removeFromPlaylist,
		createPlaylist,
		editPlaylistName,
		deletePlaylist,
		playCategory,
	};
}

