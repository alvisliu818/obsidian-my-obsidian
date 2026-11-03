/**
 * API 接口类型定义
 * 
 * 定义 React 组件与播放器视图之间的 API 接口契约
 */

import type { ReactTrackInfo } from "./library";

/**
 * React API 接口
 * 
 * 统一封装所有 React 组件需要的方法接口，提供：
 * - 播放控制（通过路径播放、播放分类）
 * - 收藏管理（切换收藏状态）
 * - 播放列表管理（添加、移除、创建、编辑、删除）
 * - 音频控制（音量、播放速率）
 * 
 * 这些方法由 ReactApiService 实现，通过 MusicPlayerView.reactApi 访问。
 */
export interface ReactApi {
	/** 
	 * 通过文件路径播放歌曲
	 * @param path - 音乐文件路径
	 * @param sectionId - 可选的 section ID，用于设置列表上下文
	 */
	playByPath: (path: string, sectionId?: string) => Promise<void>;
	
	/** 
	 * 播放分类（艺术家、专辑、歌单）
	 * @param categoryType - 分类类型（"artist", "album", "playlist"）
	 * @param categoryName - 分类名称
	 * @param tracks - 该分类下的曲目列表（内部会自动转换为 TFile[]）
	 */
	playCategory: (categoryType: string, categoryName: string, tracks: ReactTrackInfo[]) => Promise<void>;
	
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
	 * 设置音量
	 * @param volume - 音量值（0-1），会自动限制在此范围内
	 */
	setVolume: (volume: number) => Promise<void>;
	
	/** 
	 * 获取当前音量
	 * @returns 音量值（0-1），如果音频元素不存在则返回状态中的音量或默认值 1.0
	 */
	getVolume: () => number;
	
	/** 
	 * 设置播放速率
	 * @param rate - 播放速率（0.25-4.0），会自动限制在此范围内
	 */
	setPlaybackRate: (rate: number) => Promise<void>;
	
	/** 
	 * 获取当前播放速率
	 * @returns 播放速率（0.25-4.0），如果音频元素不存在则返回状态中的速率或默认值 1.0
	 */
	getPlaybackRate: () => number;
}

