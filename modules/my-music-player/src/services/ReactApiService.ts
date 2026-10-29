/**
 * React API 服务
 * 
 * 负责封装 React 组件需要的统一 API 接口，提供：
 * - 播放控制（通过路径播放、播放分类）
 * - 收藏管理（切换收藏状态）
 * - 播放列表管理（添加、移除、创建、编辑、删除）
 * - 音频控制（音量、播放速率）
 * 
 * 本服务将复杂的业务逻辑封装为简单的 API，供 React 组件通过 hooks 调用。
 */

import { TFile } from "obsidian";
import type { ReactApi, ReactTrackInfo } from "@/types";
import MusicPlayerPlugin from "@/main";
import { StateService } from "./StateService";
import { ListService } from "./ListService";
import { PlaybackService } from "./PlaybackService";
import { AudioService } from "./AudioService";
import { FavoriteService } from "./FavoriteService";
import { PlaylistService } from "./PlaylistService";
import { getOrCreateTrackId } from "@/utils/track/id";

/**
 * React API 服务回调接口
 */
export interface ReactApiServiceCallbacks {
	/** 库更新时的回调函数 */
	onLibraryUpdated: () => Promise<void>;
	/** 直接选择歌曲时的回调函数（用于清除 lastAction） */
	onDirectPlay?: () => void;
	/** 显示通知的回调函数 */
	onShowNotice?: (message: string, timeout?: number) => void;
}

/**
 * React API 服务类
 * 
 * 封装所有 React 组件需要的 API 方法，统一管理状态更新和库更新事件
 */
export class ReactApiService {
	/**
	 * 创建 React API 服务实例
	 * 
	 * @param plugin - 插件实例
	 * @param stateService - 状态管理服务
	 * @param listService - 列表服务
	 * @param playbackService - 播放服务
	 * @param audioService - 音频服务
	 * @param favoriteService - 收藏服务
	 * @param playlistService - 播放列表服务
	 * @param callbacks - 回调函数集合
	 */
	constructor(
		private plugin: MusicPlayerPlugin,
		private stateService: StateService,
		private listService: ListService,
		private playbackService: PlaybackService,
		private audioService: AudioService,
		private favoriteService: FavoriteService,
		private playlistService: PlaylistService,
		private callbacks: ReactApiServiceCallbacks
	) {}

	/**
	 * 获取 React API 接口对象
	 * 
	 * 返回一个包含所有 React 组件需要的方法的对象。
	 * 每次调用都会返回一个新的对象，确保方法内部能获取到最新的状态。
	 * 
	 * @returns React API 接口对象
	 */
	getApi(): ReactApi {
		return {
			playByPath: async (path: string, sectionId?: string) => {
				// 清除 lastAction，直接更新封面，不显示动画
				if (this.callbacks.onDirectPlay) {
					this.callbacks.onDirectPlay();
				}
				const state = this.stateService.getState();
				this.updateSectionId(sectionId);
				if (sectionId) {
					const { list, listId } = this.listService.setCurrentListContext(
						sectionId,
						state.currentSectionIdForPlaylist,
						state.trackList,
						state.favorites
					);
					if (list) {
						this.stateService.setCurrentList(list);
						this.stateService.setCurrentListId(listId);
					}
				}
				// 说明：
				// - 对于 React 入口（库页面点击）来说，我们希望“立即开始播放”，而不是等封面预加载+动画完成或同步库刷新
				// - 因此这里显式传入 delayPlay=false 且 skipLibraryUpdate=true，跳过动画等待并异步刷新库
				// - 其它非 React 入口（例如搜索模态框、队列模态框）仍使用默认的 delayPlay=true 行为
				await this.playbackService.playByPath(path, false, true);
			},
			playCategory: async (categoryType: string, categoryName: string, tracks: ReactTrackInfo[]) => {
				// 清除 lastAction，直接更新封面，不显示动画
				if (this.callbacks.onDirectPlay) {
					this.callbacks.onDirectPlay();
				}
				const state = this.stateService.getState();
				// 将 ReactTrackInfo[] 转换为 TFile[]，根据 path 查找对应的 TFile
				const toFiles: TFile[] = (tracks || [])
					.map((t: ReactTrackInfo) => {
						if (t?.path) {
							return state.trackList.find((f) => f.path === t.path);
						}
						return null;
					})
					.filter((f): f is TFile => f !== null && f !== undefined);
				await this.playbackService.playCategory(categoryType, categoryName, toFiles);
			},
			toggleFavorite: async (path: string, sectionId?: string) => {
				this.updateSectionId(sectionId);
				await this.toggleFavoriteByPath(path);
			},
			addToPlaylist: async (path: string, sectionId?: string) => {
				this.updateSectionId(sectionId);
				await this.addToPlaylistByPath(path);
			},
			removeFromPlaylist: async (path: string, playlistName: string) => {
				await this.removeFromPlaylistByPath(path, playlistName);
			},
			createPlaylist: async () => {
				await this.createPlaylist();
			},
			editPlaylistName: async (oldName: string) => {
				return this.editPlaylistName(oldName);
			},
			deletePlaylist: async (playlistName: string) => {
				await this.deletePlaylist(playlistName);
			},
			setVolume: async (volume: number) => {
				const clampedVolume = Math.max(0, Math.min(1, volume));
				const audioElement = this.audioService.getAudioElement();
				if (audioElement) audioElement.volume = clampedVolume;
				this.stateService.setVolume(clampedVolume);
				// 持久化到 data.json
				this.plugin.settings.volume = clampedVolume;
				await this.plugin.saveData(this.plugin.settings);
			},
			getVolume: () => {
				const state = this.stateService.getState();
				const audioElement = this.audioService.getAudioElement();
				return audioElement?.volume ?? state.volume ?? 1.0;
			},
			setPlaybackRate: async (rate: number) => {
				const clampedRate = Math.max(0.25, Math.min(4.0, rate));
				const audioElement = this.audioService.getAudioElement();
				if (audioElement) audioElement.playbackRate = clampedRate;
				this.stateService.setPlaybackRate(clampedRate);
				// 持久化到 data.json
				this.plugin.settings.playbackRate = clampedRate;
				await this.plugin.saveData(this.plugin.settings);
			},
			getPlaybackRate: () => {
				const state = this.stateService.getState();
				const audioElement = this.audioService.getAudioElement();
				return audioElement?.playbackRate ?? state.playbackRate ?? 1.0;
			},
		};
	}

	/**
	 * 更新当前播放列表的 section ID
	 * 
	 * @param sectionId - 可选的 section ID，如果提供则更新状态
	 */
	private updateSectionId(sectionId?: string) {
		if (sectionId !== undefined) {
			const state = this.stateService.getState();
			this.stateService.setCurrentSectionIdForPlaylist(sectionId ?? state.currentSectionIdForPlaylist);
		}
	}

	/**
	 * 通过路径切换收藏状态
	 * 
	 * @param path - 音乐文件路径
	 */
	private async toggleFavoriteByPath(path: string) {
		const state = this.stateService.getState();
		const file = state.trackList.find((f) => f.path === path);
		if (!file) return;
		// 从路径获取 ID，然后使用 ID 操作
		const trackId = getOrCreateTrackId(file.path, this.plugin.settings);
		await this.favoriteService.toggleFavorite(trackId);
		await this.callbacks.onLibraryUpdated();
	}

	/**
	 * 执行播放列表操作并刷新库状态
	 * 
	 * 这是一个通用的辅助方法，用于执行播放列表相关的操作（添加、移除、编辑、删除），
	 * 并在操作成功后更新状态和触发库更新事件。
	 * 
	 * @param action - 返回 Promise<boolean> 的操作函数，true 表示成功
	 */
	private async updatePlaylistAndRefresh(action: () => Promise<boolean>) {
		const success = await action();
		if (success) {
			this.stateService.setPlaylistMap(this.playlistService.getPlaylistMap());
			await this.callbacks.onLibraryUpdated();
		}
	}

	/**
	 * 通过路径将歌曲添加到播放列表
	 * 
	 * @param path - 音乐文件路径
	 */
	private async addToPlaylistByPath(path: string) {
		const state = this.stateService.getState();
		const file = state.trackList.find((f) => f.path === path);
		if (!file) return;
		// 从路径获取 ID，然后使用 ID 操作
		const trackId = getOrCreateTrackId(file.path, this.plugin.settings);
		await this.updatePlaylistAndRefresh(() => this.playlistService.addToPlaylist(trackId));
	}

	/**
	 * 从播放列表中移除歌曲
	 * 
	 * @param path - 音乐文件路径
	 * @param playlistName - 播放列表名称
	 */
	private async removeFromPlaylistByPath(path: string, playlistName: string) {
		// 从路径获取 ID，然后使用 ID 操作
		const trackId = getOrCreateTrackId(path, this.plugin.settings);
		await this.updatePlaylistAndRefresh(() => this.playlistService.removeFromPlaylist(trackId, playlistName));
	}

	/**
	 * 创建新的播放列表
	 * 
	 * 如果创建成功，会更新状态并触发库更新事件。
	 */
	private async createPlaylist() {
		const playlistName = await this.playlistService.createPlaylist();
		if (playlistName) {
			this.stateService.setPlaylistMap(this.playlistService.getPlaylistMap());
			await this.callbacks.onLibraryUpdated();
		}
	}

	/**
	 * 编辑播放列表名称
	 * 
	 * @param oldName - 旧的播放列表名称
	 */
	private async editPlaylistName(oldName: string) {
		await this.updatePlaylistAndRefresh(() => this.playlistService.editPlaylistName(oldName));
	}

	/**
	 * 删除播放列表
	 * 
	 * @param playlistName - 要删除的播放列表名称
	 */
	private async deletePlaylist(playlistName: string) {
		await this.updatePlaylistAndRefresh(() => this.playlistService.deletePlaylist(playlistName));
	}
}

