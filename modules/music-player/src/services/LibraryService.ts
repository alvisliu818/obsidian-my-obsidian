/**
 * 音乐库管理服务
 * 
 * 负责管理音乐库相关的业务逻辑，包括：
 * - 重建所有数据（完全重建音乐库的所有数据）
 * - 刷新音乐列表（从设置中读取并构建分类数据）
 * - 获取歌曲列表、收藏、歌单、艺术家、专辑等数据
 * - 库更新编排（组合多个服务的调用）
 */

import { App, TFile } from "obsidian";
import MusicPlayerPlugin from "@/main";
import { rebuildAllData as updateMusicLibrary } from "@/utils/library/updater";
import { scanVaultAudioFiles } from "@/utils/library/scanVaultAudio";
import { sortTracksByTrack } from "@/utils/data/sort";
import { isSupportedAudioExtension } from "@/constants";
import { StateService } from "./StateService";
import { PlaylistService } from "./PlaylistService";
import { LyricsService } from "./LyricsService";
import { generateArtistsAndAlbums } from "@/utils/data/transform";
import { getOrCreateTrackId, getTrackPath } from "@/utils/track/id";
export interface LibraryOrchestrationCallbacks {
	/** 库更新时的回调 */
	onLibraryUpdated?: () => Promise<void>;
}

export class LibraryService {
	constructor(
		private app: App,
		private plugin: MusicPlayerPlugin,
		private stateService?: StateService,
		private playlistService?: PlaylistService,
		private lyricsService?: LyricsService,
		private callbacks: LibraryOrchestrationCallbacks = {}
	) {}

	/**
	 * 同步“当前播放列表”与最新库数据
	 *
	 * 背景：库快照是基于最新的 trackList 生成的，因此会自动剔除已删除文件；
	 * 但当前播放列表（state.currentList.tracks）是一次性写入的数组，不会自动重算，
	 * 导致“库中的同名列表”与“当前播放中的列表”不一致。
	 *
	 * 这里在每次 refreshMusicList 后，按 currentList.type/name 重新构建 tracks，
	 * 让当前播放列表也能自动更新。
	 */
	private syncCurrentListAfterRefresh(): void {
		if (!this.stateService) return;
		const state = this.stateService.getState();
		const currentList = state.currentList;
		if (!currentList) return;

		const { type, name } = currentList;
		const trackList = state.trackList;
		const favorites = state.favorites;

		let tracks: TFile[] | null = null;
		if (type === "all") {
			tracks = trackList;
		} else if (type === "favorites") {
			tracks = favorites;
		} else if (type === "playlist") {
			// playlist 需要依赖 PlaylistService
			if (this.playlistService) {
				const playlistMap = this.playlistService.getPlaylistMap();
				const playlistTrackIds = playlistMap[name] || [];
				// 创建路径到文件的映射，用于快速查找
				const pathToFileMap = new Map(trackList.map(f => [f.path, f]));
				// 通过 ID 获取路径，然后查找文件
				const playlistFiles = playlistTrackIds
					.map(id => {
						const path = getTrackPath(id, this.plugin.settings);
						return path ? pathToFileMap.get(path) : null;
					})
					.filter((file): file is TFile => file !== null);
				tracks = sortTracksByTrack(playlistFiles, this.plugin.settings);
			} else {
				tracks = [];
			}
		} else if (type === "artist") {
			tracks = this.getArtists(trackList).find((a) => a.name === name)?.tracks ?? [];
		} else if (type === "album") {
			tracks = this.getAlbums(trackList).find((a) => a.name === name)?.tracks ?? [];
		} else {
			// 兜底：使用当前列表的曲目
			tracks = currentList.tracks || [];
		}

		// 只有确实变化时才写回，减少无意义的 state 更新
		const same =
			tracks.length === currentList.tracks.length &&
			tracks.every((f, i) => f.path === currentList.tracks[i]?.path);
		if (!same) {
			this.stateService.setCurrentList({ type, name, tracks });
		}

		// 同步 currentTrack/currentIndex：
		// 1. 如果当前曲目在新 trackList 中找不到（可能被删除、移动、重命名或不在扫描范围内），清理播放状态
		// 2. 如果索引发生变化（文件顺序改变），更新索引
		if (state.currentTrack) {
			const newIdx = trackList.findIndex((f) => f.path === state.currentTrack!.path);
			if (newIdx === -1) {
				// 文件不在新列表中：清理播放状态，避免状态悬空
				this.stateService.setCurrentTrack(null, -1);
				this.stateService.setIsPlaying(false);
				this.stateService.resetLyrics();
			} else if (newIdx !== state.currentIndex) {
				// 索引变化：更新索引（文件顺序可能改变）
				const track = trackList[newIdx];
				if (track) {
					this.stateService.setCurrentTrack(track, newIdx);
				}
			}
		}
	}

	/**
	 * 检查歌曲列表是否需要更新（仅在启动时调用，异步执行避免阻塞UI）
	 * 
	 * 对比实际文件系统中的音乐文件与 settings.tracks 中存储的 ID，
	 * 如果发现不一致（文件被删除、新增、或路径变化），返回 true。
	 * 
	 * 检查逻辑：
	 * 1. 快速检查：对比音乐文件夹中的歌曲数量和JSON中的歌曲数量是否一致
	 * 2. 如果数量一致，检查JSON中的每个ID对应的路径是否真实存在于文件系统中
	 *    （数量一致时，如果所有JSON路径都存在，则不可能有新文件，无需额外检查）
	 * 
	 * @returns Promise<boolean> 如果发现不一致返回 true，否则返回 false
	 */
	async checkLibraryConsistency(): Promise<boolean> {
		// 使用异步执行，避免阻塞UI渲染
		// 通过 Promise.resolve().then() 将同步操作转为异步，让UI先渲染
		return Promise.resolve().then(() => {
			// 获取实际文件系统中的所有音乐文件路径
			const actualFiles = this.getAllMusicFiles();
			const actualPaths = new Set(actualFiles.map(f => f.path));
			
			// 获取 settings.tracks 中存储的所有 ID
			const storedTrackIds = Object.keys(this.plugin.settings.tracks || {});
			
			// 1. 快速检查：如果数量不一致，直接返回（性能优化）
			if (actualPaths.size !== storedTrackIds.length) {
				return true;
			}
			
			// 2. 数量一致时，检查JSON中的每个ID对应的路径是否真实存在于文件系统中
			// 如果数量一致且所有JSON路径都存在，则不可能有新文件，无需额外检查
			for (const trackId of storedTrackIds) {
				const path = getTrackPath(trackId, this.plugin.settings);
				if (!path) {
					// ID 无效，需要更新
					return true;
				}
				// 检查路径是否在实际文件列表中
				if (!actualPaths.has(path)) {
					return true;
				}
				// 验证文件是否真的存在
				const file = this.app.vault.getAbstractFileByPath(path);
				if (!file || !(file instanceof TFile)) {
					return true;
				}
			}
			
			// 所有路径都匹配且文件都存在，不需要更新
			return false;
		});
	}

	/**
	 * 重建所有数据
	 * 
	 * 调用数据重建工具函数来完全重建所有音乐数据
	 */
	async rebuildAllData(): Promise<number> {
		return await updateMusicLibrary(this.app, this.plugin);
	}

	/**
	 * 获取所有音乐文件列表
	 * 
	 * 根据设置的音乐文件夹过滤文件
	 */
	getAllMusicFiles(): TFile[] {
		return scanVaultAudioFiles(this.app, this.plugin.settings.musicFolder ?? "");
	}

	/**
	 * 获取收藏的歌曲列表（按音轨号排序）
	 */
	getFavorites(trackList: TFile[]): TFile[] {
		const favoriteIds = new Set(this.plugin.settings.favorites || []);
		// 创建路径到文件的映射，用于快速查找
		const pathToFileMap = new Map(trackList.map(f => [f.path, f]));
		
		// 通过 ID 获取路径，然后查找文件
		const favoriteFiles = Array.from(favoriteIds)
			.map(id => {
				const path = getTrackPath(id, this.plugin.settings);
				return path ? pathToFileMap.get(path) : null;
			})
			.filter((file): file is TFile => file !== null);
		
		return sortTracksByTrack(favoriteFiles, this.plugin.settings);
	}

	/**
	 * 获取歌单映射表
	 */
	getPlaylistMap(): Record<string, string[]> {
		return this.plugin.settings.playlists || {};
	}

	/**
	 * 获取艺术家数据（按音轨号排序）
	 */
	getArtists(trackList: TFile[]): Array<{ name: string; tracks: TFile[] }> {
		const artistsData = this.plugin.settings.artists || {};
		// 创建路径到文件的映射，用于快速查找
		const pathToFileMap = new Map(trackList.map(f => [f.path, f]));
		
		return Object.entries(artistsData)
			.map(([name, trackIds]) => {
				// 通过 ID 获取路径，然后查找文件
				const tracks = trackIds
					.map(id => {
						const path = getTrackPath(id, this.plugin.settings);
						return path ? pathToFileMap.get(path) : null;
					})
					.filter((file): file is TFile => file != null); // 同时过滤 null 和 undefined
				
				return {
					name,
					tracks: sortTracksByTrack(tracks, this.plugin.settings),
				};
			})
			.filter((artist) => artist.tracks.length > 0) // 过滤掉没有歌曲的艺术家
			.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
	}

	/**
	 * 获取专辑数据（按音轨号排序）
	 */
	getAlbums(trackList: TFile[]): Array<{ name: string; tracks: TFile[] }> {
		const albumsData = this.plugin.settings.albums || {};
		// 创建路径到文件的映射，用于快速查找
		const pathToFileMap = new Map(trackList.map(f => [f.path, f]));
		
		return Object.entries(albumsData)
			.map(([name, trackIds]) => {
				// 通过 ID 获取路径，然后查找文件
				const tracks = trackIds
					.map(id => {
						const path = getTrackPath(id, this.plugin.settings);
						return path ? pathToFileMap.get(path) : null;
					})
					.filter((file): file is TFile => file != null); // 同时过滤 null 和 undefined
				
				return {
					name,
					tracks: sortTracksByTrack(tracks, this.plugin.settings),
				};
			})
			.filter((album) => album.tracks.length > 0) // 过滤掉没有歌曲的专辑
			.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
	}

	/**
	 * 刷新音乐列表
	 * 
	 * 从 LibraryService 和 PlaylistService 获取最新数据并更新状态。
	 * 包括：所有曲目列表、收藏列表、播放列表映射。
	 * 所有列表都使用统一的排序方式（按音轨号排序）。
	 * 
	 * 注意：此方法需要 StateService 和 PlaylistService 实例。
	 */
	refreshMusicList(): void {
		if (!this.stateService || !this.playlistService) {
			throw new Error("refreshMusicList 需要 StateService 和 PlaylistService 实例");
		}
		const list = this.getAllMusicFiles();
		// 对全局音乐列表进行排序
		const sortedList = sortTracksByTrack(list, this.plugin.settings);
		this.stateService.setTrackList(sortedList);
		this.stateService.setFavorites(this.getFavorites(sortedList));
		this.stateService.setPlaylistMap(this.playlistService.getPlaylistMap());
		this.syncCurrentListAfterRefresh();
	}

	/**
	 * 刷新当前曲目显示
	 * 
	 * 重新加载当前曲目的歌词（普通歌词和逐字歌词）。
	 * 用于在库更新后刷新当前播放曲目的显示信息。
	 * 
	 * 注意：此方法需要 StateService 和 LyricsService 实例。
	 */
	async refreshCurrentTrackDisplay(): Promise<void> {
		if (!this.stateService || !this.lyricsService) {
			throw new Error("refreshCurrentTrackDisplay 需要 StateService 和 LyricsService 实例");
		}
		const state = this.stateService.getState();
		if (!state.currentTrack) return;
		try {
			const { lyrics, extendedLyrics } = this.lyricsService.loadLyrics(state.currentTrack.path);
			this.stateService.setLyrics(lyrics, extendedLyrics);
		} catch (error) {
			console.error("刷新当前曲目显示时出错:", error);
		}
	}

	/**
	 * 处理库更新后的刷新
	 * 
	 * 完整的库更新流程：
	 * 1. 刷新音乐列表（从服务获取最新数据）
	 * 2. 刷新当前曲目显示（重新加载歌词）
	 * 3. 触发所有已注册的监听器
	 * 
	 * @param listeners - 库更新监听器集合
	 */
	async handleLibraryUpdated(listeners: Set<() => void>): Promise<void> {
		if (!this.stateService) {
			throw new Error("handleLibraryUpdated 需要 StateService 实例");
		}
		try {
			this.refreshMusicList();
			await this.refreshCurrentTrackDisplay();
			for (const listener of listeners) {
				try {
					listener();
				} catch (e) {
					console.error("库更新监听器执行出错:", e);
				}
			}
		} catch (error) {
			console.error("处理库更新后的刷新时出错:", error);
		}
	}

	/**
	 * 从库中移除单个已删除的歌曲
	 * 
	 * 当检测到歌曲文件被删除时，自动清理相关数据：
	 * - 从 trackIndex 中删除 ID 映射
	 * - 从 tracks 中删除歌曲信息
	 * - 从 favorites 中删除（如果存在）
	 * - 从所有 playlists 中删除（如果存在）
	 * - 重新生成 artists 和 albums 映射
	 * - 如果当前正在播放的歌曲被删除，清理播放状态
	 * - 更新状态服务中的列表
	 * 
	 * @param trackPath - 要删除的歌曲路径
	 */
	async removeTrackFromLibrary(trackPath: string): Promise<void> {
		try {
			// 获取或创建曲目 ID
			const trackId = getOrCreateTrackId(trackPath, this.plugin.settings);
			
			// 1. 从 trackIndex 中删除 ID 映射
			if (this.plugin.settings.trackIndex && this.plugin.settings.trackIndex[trackId]) {
				delete this.plugin.settings.trackIndex[trackId];
			}

			// 2. 从 tracks 中删除歌曲信息
			if (this.plugin.settings.tracks && this.plugin.settings.tracks[trackId]) {
				delete this.plugin.settings.tracks[trackId];
			}

			// 3. 从 favorites 中删除（如果存在）
			if (this.plugin.settings.favorites) {
				const originalFavoritesCount = this.plugin.settings.favorites.length;
				this.plugin.settings.favorites = this.plugin.settings.favorites.filter(
					id => id !== trackId
				);
				if (this.plugin.settings.favorites.length < originalFavoritesCount) {
					console.debug(`已从收藏列表中移除已删除的歌曲: ${trackPath}`);
				}
			}

			// 4. 从所有 playlists 中删除（如果存在）
			if (this.plugin.settings.playlists) {
				let totalRemovedFromPlaylists = 0;
				for (const [playlistName, trackIds] of Object.entries(this.plugin.settings.playlists)) {
					if (Array.isArray(trackIds)) {
						const originalCount = trackIds.length;
						this.plugin.settings.playlists[playlistName] = trackIds.filter(
							id => id !== trackId
						);
						const updatedPlaylist = this.plugin.settings.playlists[playlistName];
						const removedCount = originalCount - (updatedPlaylist?.length ?? 0);
						if (removedCount > 0) {
							totalRemovedFromPlaylists += removedCount;
							console.debug(`已从歌单 "${playlistName}" 中移除已删除的歌曲: ${trackPath}`);
						}
					}
				}
				if (totalRemovedFromPlaylists > 0) {
					console.debug(`共从所有歌单中移除了 ${totalRemovedFromPlaylists} 首已删除的歌曲`);
				}
			}

			// 5. 重新生成 artists 和 albums 映射
			const { artists, albums } = generateArtistsAndAlbums(this.plugin.settings);
			this.plugin.settings.artists = artists;
			this.plugin.settings.albums = albums;

			// 6. 保存设置
			await this.plugin.saveSettings();

			// 7. 如果当前正在播放的歌曲被删除，清理播放状态
			if (this.stateService) {
				const state = this.stateService.getState();
				if (state.currentTrack && state.currentTrack.path === trackPath) {
					this.stateService.setCurrentTrack(null, -1);
					this.stateService.setIsPlaying(false);
					this.stateService.resetLyrics();
					console.debug(`当前播放的歌曲已被删除，已清理播放状态: ${trackPath}`);
				}

				// 8. 更新状态服务中的列表
				this.refreshMusicList();
			}

			// 9. 触发库更新事件，通知 React 组件刷新 UI
			if (this.callbacks.onLibraryUpdated) {
				await this.callbacks.onLibraryUpdated();
			}

			console.debug(`已从库中移除已删除的歌曲: ${trackPath}`);
		} catch (error) {
			console.error(`从库中移除歌曲时出错: ${trackPath}`, error);
		}
	}

	/**
	 * 处理文件重命名
	 * 
	 * 当检测到音乐文件被重命名时，更新库中的路径映射。
	 * 
	 * 使用 ID 系统的优势：
	 * - 只需更新 trackIndex 中的路径映射（ID 保持不变）
	 * - favorites, playlists, artists, albums 中的 ID 不需要更新
	 * - 大大简化了重命名逻辑，提高了性能和可靠性
	 * 
	 * 注意：由于现在使用 Blob URL 播放音频，文件不会被直接占用，
	 * 所以重命名操作可以正常进行，不会出现 EBUSY 错误。
	 * 
	 * @param oldPath - 旧的文件路径
	 * @param newPath - 新的文件路径
	 */
	async renameTrackInLibrary(oldPath: string, newPath: string): Promise<void> {
		try {
			// 验证旧路径和新路径是否相同（不应该发生，但作为安全检查）
			if (oldPath === newPath) {
				console.warn(`旧路径和新路径相同，跳过重命名: ${oldPath}`);
				return;
			}
			
			// 1. 检查新路径是否已经是音乐文件
			const newFile = this.app.vault.getAbstractFileByPath(newPath);
			if (!newFile || !(newFile instanceof TFile)) {
				console.warn(`新路径文件不存在，无法重命名: ${oldPath} -> ${newPath}`);
				return;
			}

			const ext = newFile.extension?.toLowerCase() || '';
			if (!isSupportedAudioExtension(ext)) {
				console.warn(`新路径不是音乐文件，跳过重命名: ${oldPath} -> ${newPath}`);
				return;
			}

			// 2. 获取或创建旧路径的 ID
			const trackId = getOrCreateTrackId(oldPath, this.plugin.settings);
			
			// 3. 更新 trackIndex 中的路径映射（这是唯一需要更新的地方！）
			// ID 保持不变，只更新路径映射
			if (this.plugin.settings.trackIndex && this.plugin.settings.trackIndex[trackId]) {
				this.plugin.settings.trackIndex[trackId] = newPath;
				console.debug(`已更新路径映射: ${oldPath} -> ${newPath} (ID: ${trackId})`);
			} else {
				// 如果旧路径没有 ID，创建新 ID
				const newTrackId = getOrCreateTrackId(newPath, this.plugin.settings);
				// 如果旧路径有 tracks 数据，需要迁移
				const oldTrackData = this.plugin.settings.tracks?.[trackId];
				if (oldTrackData) {
					this.plugin.settings.tracks[newTrackId] = oldTrackData;
					delete this.plugin.settings.tracks[trackId];
					// 更新所有引用（这种情况不应该发生，但为了安全）
					this.updateTrackIdReferences(trackId, newTrackId);
				}
			}

			// 4. 重新生成 artists 和 albums 映射（因为 tracks 可能已更新）
			const { artists, albums } = generateArtistsAndAlbums(this.plugin.settings);
			this.plugin.settings.artists = artists;
			this.plugin.settings.albums = albums;

			// 5. 保存设置
			await this.plugin.saveSettings();

			// 6. 如果当前正在播放的是这个文件，更新当前播放路径
			if (this.stateService) {
				const state = this.stateService.getState();
				if (state.currentTrack && state.currentTrack.path === oldPath) {
					// 更新当前曲目的路径
					this.stateService.setCurrentTrack(newFile, state.currentIndex);
					console.debug(`当前播放的歌曲路径已更新: ${oldPath} -> ${newPath}`);
				}

				// 7. 更新状态服务中的列表
				this.refreshMusicList();
			}

			// 8. 触发库更新事件，通知 React 组件刷新 UI
			if (this.callbacks.onLibraryUpdated) {
				await this.callbacks.onLibraryUpdated();
			}

			console.debug(`已更新文件重命名: ${oldPath} -> ${newPath}`);
		} catch (error) {
			// 记录详细错误信息
			console.error(`更新文件重命名时出错: ${oldPath} -> ${newPath}`, error);
			// 重新抛出错误，让调用者知道操作失败
			throw error;
		}
	}

	/**
	 * 更新曲目 ID 引用（用于迁移场景）
	 * 
	 * 当需要将旧的 ID 替换为新 ID 时，更新所有引用。
	 * 这通常不应该发生，但为了数据一致性，提供此方法。
	 * 
	 * @param oldTrackId - 旧的曲目 ID
	 * @param newTrackId - 新的曲目 ID
	 */
	private updateTrackIdReferences(oldTrackId: string, newTrackId: string): void {
		// 更新 favorites
		if (this.plugin.settings.favorites) {
			const index = this.plugin.settings.favorites.indexOf(oldTrackId);
			if (index !== -1) {
				this.plugin.settings.favorites[index] = newTrackId;
			}
		}

		// 更新 playlists
		if (this.plugin.settings.playlists) {
			for (const [playlistName, trackIds] of Object.entries(this.plugin.settings.playlists)) {
				if (Array.isArray(trackIds)) {
					const index = trackIds.indexOf(oldTrackId);
					if (index !== -1) {
						const playlist = this.plugin.settings.playlists[playlistName];
						if (playlist) {
							playlist[index] = newTrackId;
						}
					}
				}
			}
		}

		// artists 和 albums 会在重新生成时自动更新
	}

	/**
	 * 更新单个音乐文件的元数据
	 * 
	 * 当检测到音乐文件被修改时，重新提取元数据并更新库中的信息：
	 * - 重新提取文件的元数据（标题、艺术家、专辑、歌词等）
	 * - 更新 tracks 中的歌曲信息
	 * - 重新生成 artists 和 albums 映射
	 * - 如果当前正在播放的是这个文件，更新当前播放信息（包括歌词）
	 * - 更新状态服务中的列表
	 * 
	 * @param trackPath - 要更新的歌曲路径
	 */
	async updateTrackMetadata(trackPath: string): Promise<void> {
		try {
			// 1. 获取文件对象
			const file = this.app.vault.getAbstractFileByPath(trackPath);
			if (!file || !(file instanceof TFile)) {
				console.warn(`文件不存在，无法更新元数据: ${trackPath}`);
				return;
			}

			// 2. 检查是否是音乐文件
			const ext = file.extension?.toLowerCase() || '';
			if (!isSupportedAudioExtension(ext)) {
				console.warn(`不是音乐文件，跳过更新: ${trackPath}`);
				return;
			}

			// 3. 读取音频文件的二进制数据并提取元数据
			const { readAudioFileBinary } = await import("@/utils/audio/metadata");
			const { getEmbeddedAudioMetadataFromBuffer } = await import("@/utils/audio/metadata");
			
			const binary = await readAudioFileBinary(this.app, file);
			if (!binary) {
				console.warn(`无法读取文件，跳过更新: ${trackPath}`);
				return;
			}

			const audioMetadata = await getEmbeddedAudioMetadataFromBuffer(binary);
			if (!audioMetadata) {
				console.warn(`无法提取文件元数据，跳过更新: ${trackPath}`);
				return;
			}

			// 4. 获取或创建曲目 ID，然后更新曲目元数据
			const trackId = getOrCreateTrackId(trackPath, this.plugin.settings);
			this.plugin.settings.tracks[trackId] = {
				title: audioMetadata.title || file.basename,
				artist: audioMetadata.artist?.trim() || '',
				album: audioMetadata.album?.trim() || '',
				lyrics: audioMetadata.lyricsText || '',
				year: audioMetadata.year,
				genre: Array.isArray(audioMetadata.genre) ? 
					audioMetadata.genre[0] : audioMetadata.genre,
				track: audioMetadata.track,
				duration: audioMetadata.duration
			};

			// 5. 重新生成 artists 和 albums 映射
			const { generateArtistsAndAlbums } = await import("@/utils/data/transform");
			const { artists, albums } = generateArtistsAndAlbums(this.plugin.settings);
			this.plugin.settings.artists = artists;
			this.plugin.settings.albums = albums;

			// 6. 保存设置
			await this.plugin.saveSettings();

			// 7. 如果当前正在播放的是这个文件，更新当前播放信息（包括歌词）
			if (this.stateService) {
				const state = this.stateService.getState();
				if (state.currentTrack && state.currentTrack.path === trackPath) {
					// 更新当前曲目的歌词
					if (this.lyricsService) {
						const { lyrics, extendedLyrics } = this.lyricsService.loadLyrics(trackPath);
						this.stateService.setLyrics(lyrics, extendedLyrics);
					}
					console.debug(`当前播放的歌曲元数据已更新: ${trackPath}`);
				}

				// 8. 更新状态服务中的列表
				this.refreshMusicList();
			}

			// 9. 触发库更新事件，通知 React 组件刷新 UI
			if (this.callbacks.onLibraryUpdated) {
				await this.callbacks.onLibraryUpdated();
			}

			console.debug(`已更新歌曲元数据: ${trackPath}`);
		} catch (error) {
			console.error(`更新歌曲元数据时出错: ${trackPath}`, error);
		}
	}
}

