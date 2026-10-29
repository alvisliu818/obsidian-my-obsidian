/**
 * 快照生成服务
 * 
 * 负责生成 React 组件需要的快照数据，包括：
 * - 播放状态快照
 * - 音乐库快照
 */

import { App, TFile } from "obsidian";
import MusicPlayerPlugin from "@/main";
import type { ReactLibrarySnapshot, ReactPlaybackSnapshot, ReactTrackInfo } from "@/types";
import type { PlayMode } from "@/main";
import type { LyricLine } from "@/utils/lyrics/parser";
import type { ExtendedLyricLine } from "@/utils/lyrics/extendedParser";
import { getTrackCover, type GetTrackCoverOptions } from "@/utils/library/coverFinder";
import { calculateLyricsIndex } from "@/utils/lyrics/indexCalculator";
import type { CurrentList, ListService } from "./ListService";
import type { LibraryService } from "./LibraryService";
import { sortTracksByTrack } from "@/utils/data/sort";
import { getOrCreateTrackId, getTrackPath } from "@/utils/track/id";
import { t } from "@/utils/i18n/i18n";

/**
 * 快照状态接口
 * 
 * 定义生成快照时需要的完整状态信息
 */
export interface SnapshotState {
	/** 当前播放的曲目 */
	currentTrack: TFile | null;
	/** 当前曲目在列表中的索引 */
	currentIndex: number;
	/** 是否正在播放 */
	isPlaying: boolean;
	/** 播放模式 */
	playMode: PlayMode;
	/** 当前曲目的普通歌词 */
	currentLyrics: LyricLine[];
	/** 当前曲目的逐字歌词 */
	currentExtendedLyrics: ExtendedLyricLine[];
	/** 音量 */
	volume: number;
	/** 播放速率 */
	playbackRate: number;
	/** 音频元素 */
	audioElement: HTMLAudioElement | null;
	/** 所有曲目列表 */
	trackList: TFile[];
	/** 当前列表上下文 */
	currentList: CurrentList | null;
	/** 收藏的曲目列表 */
	favorites: TFile[];
	/** 当前列表标识符 */
	currentListId: string | null;
	/** 当前播放列表的 section ID */
	currentSectionIdForPlaylist: string | null;
	/** 临时存储的下一首封面 URL（用于切换动画） */
	pendingNextCoverUrl?: string;
	/** 临时存储的上一首封面 URL（用于切换动画） */
	pendingPrevCoverUrl?: string;
}

/**
 * 快照生成服务类
 * 
 * 负责生成 React 组件需要的快照数据，将内部状态转换为 React 组件可用的格式。
 * 包括播放状态快照和音乐库快照。
 */
export class SnapshotService {
	/**
	 * 创建快照生成服务实例
	 * 
	 * @param app - Obsidian App 实例，用于查找封面等资源
	 * @param plugin - 插件实例，用于访问设置数据
	 * @param listService - 列表服务，用于获取当前播放列表
	 * @param libraryService - 库服务，用于获取排序后的分类数据
	 */
	constructor(
		private app: App,
		private plugin: MusicPlayerPlugin,
		private listService: ListService,
		private libraryService: LibraryService
	) {}

	/**
	 * 解析歌曲封面 URL（同步，返回 undefined，由组件层面异步获取内嵌封面）
	 * 
	 * 封面只从音频文件的元数据中提取，不在同步方法中获取。
	 * 
	 * @param trackFile - 音乐文件
	 * @returns 始终返回 undefined，封面由异步方法获取
	 */
	private resolveTrackCoverUrl(_trackFile: TFile | null | undefined): string | undefined {
		// 封面只从音频文件的元数据中提取，不在同步方法中获取
		return undefined;
	}

	/**
	 * 异步获取歌曲封面（优先文件夹中的 cover 文件，其次内嵌封面）
	 * 
	 * @param trackFile - 音乐文件
	 * @returns 封面图片 URL（可能是文件路径或 base64 Data URL），如果未找到则返回 undefined
	 */
	public async getTrackCoverAsync(
		trackFile: TFile | null | undefined,
		options?: GetTrackCoverOptions
	): Promise<string | undefined> {
		if (!trackFile) return undefined;
		return await getTrackCover(this.app, trackFile, options);
	}

	/**
	 * 生成播放状态快照
	 * 
	 * 将内部播放状态转换为 React 组件可用的格式，包括：
	 * - 歌曲信息（标题、艺术家、封面）
	 * - 播放进度和时间
	 * - 歌词信息（当前行、上一行、下一行、完整歌词）
	 * - 播放状态和模式
	 * - 音量和播放速率
	 */
	getPlaybackSnapshot(state: SnapshotState): ReactPlaybackSnapshot {
		const {
			currentTrack,
			isPlaying,
			playMode,
			currentLyrics,
			currentExtendedLyrics,
			audioElement,
			volume,
			playbackRate,
		} = state;

		const currentPath = currentTrack?.path;
		// 通过路径获取 ID，然后通过 ID 获取 track 信息
		const trackId = currentPath ? getOrCreateTrackId(currentPath, this.plugin.settings) : null;
		const track = trackId ? this.plugin.settings.tracks[trackId] : undefined;

		const title = track?.title || (currentPath ? currentPath.split("/").pop() || "" : t("playback.noTrack"));
		const artistStr = (track?.artist ?? "").trim();
		const artist = artistStr === "" ? t("meta.unknownArtist") : artistStr;
		const coverUrl = this.resolveTrackCoverUrl(currentTrack);

		const currentTime = audioElement?.currentTime ?? 0;
		const duration = audioElement?.duration ?? track?.duration ?? 0;

		// 判断是否使用逐字歌词
		const useExtendedLyrics = currentExtendedLyrics && currentExtendedLyrics.length > 0;
		
		// 使用统一的工具函数计算歌词索引
		const idx = calculateLyricsIndex({
			fullLyrics: currentLyrics,
			fullExtendedLyrics: currentExtendedLyrics,
			currentTime,
		});

		// 普通歌词的三行文本（文本在 LyricsService 入库前已清理，直接取用）
		const prevLyric = idx > 0 && !useExtendedLyrics ? currentLyrics[idx - 1]?.text ?? "" : "";
		const currentLyric = idx >= 0 && !useExtendedLyrics ? currentLyrics[idx]?.text ?? "" : "";
		const nextLyric = idx >= 0 && !useExtendedLyrics ? currentLyrics[idx + 1]?.text ?? "" : "";

		// 逐字歌词的三行数据
		const prevExtendedLyric = idx > 0 && useExtendedLyrics ? currentExtendedLyrics[idx - 1] : undefined;
		const currentExtendedLyric = idx >= 0 && useExtendedLyrics ? currentExtendedLyrics[idx] : undefined;
		const nextExtendedLyric = idx >= 0 && useExtendedLyrics ? currentExtendedLyrics[idx + 1] : undefined;

		// 检查是否已收藏（favorites 在设置中以 trackId 的形式存储，这里统一按 ID 判断）
		const favoriteIds = new Set(this.plugin.settings.favorites || []);
		const isFavorite = trackId ? favoriteIds.has(trackId) : false;

		// 获取上一首和下一首的封面（从当前播放列表中获取）
		// 优先使用临时存储的封面 URL（用于切换动画），否则从当前播放列表计算
		let prevCoverUrl: string | undefined = state.pendingPrevCoverUrl;
		let nextCoverUrl: string | undefined = state.pendingNextCoverUrl;

		// 如果没有临时存储的封面 URL，从当前播放列表计算
		if (!prevCoverUrl || !nextCoverUrl) {
			if (currentTrack) {
				// 获取当前播放列表
				const { list } = this.listService.getCurrentPlaylistForTrack(
					currentTrack,
					state.currentList,
					state.trackList,
					state.favorites
				);

				if (list.length > 0) {
					// 在当前播放列表中查找当前曲目的索引
					const currentIdxInList = list.findIndex((f) => f.path === currentTrack.path);
					
					if (currentIdxInList >= 0) {
						// 上一首（基于当前播放列表）
						if (!prevCoverUrl) {
							const prevIdxInList = currentIdxInList > 0 ? currentIdxInList - 1 : list.length - 1;
							const prevTrack = list[prevIdxInList];
							if (prevTrack) {
								prevCoverUrl = this.resolveTrackCoverUrl(prevTrack);
							}
						}

						// 下一首（基于当前播放列表）
						if (!nextCoverUrl) {
							const nextIdxInList = currentIdxInList < list.length - 1 ? currentIdxInList + 1 : 0;
							const nextTrack = list[nextIdxInList];
							if (nextTrack) {
								nextCoverUrl = this.resolveTrackCoverUrl(nextTrack);
							}
						}
					}
				}
			}
		}

		return {
			title,
			artist,
			coverUrl,
			isPlaying,
			currentTime,
			duration,
			playMode,
			prevLyric,
			currentLyric,
			nextLyric,
			prevExtendedLyric,
			currentExtendedLyric,
			nextExtendedLyric,
			fullLyrics: currentLyrics,
			fullExtendedLyrics: currentExtendedLyrics,
			prevCoverUrl,
			nextCoverUrl,
			currentPath: currentPath || null,
			sectionId: state.currentSectionIdForPlaylist || null,
			volume: audioElement?.volume ?? volume ?? 1.0,
			playbackRate: audioElement?.playbackRate ?? playbackRate ?? 1.0,
			isFavorite,
		};
	}

	/**
	 * 生成音乐库快照
	 */
	getLibrarySnapshot(
		trackList: TFile[],
		currentTrack: TFile | null,
		currentListId: string | null
	): ReactLibrarySnapshot {
		// 过滤掉 undefined 和 null 值，防止后续处理出错
		const validTrackList = trackList.filter((file): file is TFile => file != null);
		
		const mapToTrack = (file: TFile): ReactTrackInfo => {
			// 通过路径获取 ID，然后通过 ID 获取 track 信息
			const trackId = getOrCreateTrackId(file.path, this.plugin.settings);
			const meta = this.plugin.settings.tracks[trackId];
			const artistStr = (meta?.artist ?? "").trim();
			const artist = artistStr === "" ? t("meta.unknownArtist") : artistStr;
			let album: string | undefined;
			if (meta?.album !== undefined && meta?.album !== null) {
				const bv = String(meta.album).trim();
				album = bv === "" ? t("meta.unknownAlbum") : bv;
			}
			return {
				path: file.path,
				title: meta?.title || file.name,
				artist,
				album,
				coverUrl: this.resolveTrackCoverUrl(file),
				duration: meta?.duration,
			};
		};

		// 创建路径到 ID 的映射，用于快速查找
		const pathToIdMap = new Map<string, string>();
		validTrackList.forEach(file => {
			const trackId = getOrCreateTrackId(file.path, this.plugin.settings);
			pathToIdMap.set(file.path, trackId);
		});

		const favoritesSet = new Set(this.plugin.settings.favorites || []);
		const allTracks = validTrackList.map(mapToTrack);
		// 通过 ID 过滤收藏列表
		const favorites = validTrackList
			.filter((f) => {
				const trackId = pathToIdMap.get(f.path);
				return trackId && favoritesSet.has(trackId);
			})
			.map(mapToTrack);

		// 使用 LibraryService 获取排序后的播放列表、艺术家和专辑数据
		const playlistsData = Object.entries(this.plugin.settings.playlists || {}).map(([name, trackIds]) => {
			// 通过 ID 获取路径，然后查找文件
			const playlistFiles = trackIds
				.map(id => {
					const path = getTrackPath(id, this.plugin.settings);
					return path ? validTrackList.find(f => f.path === path) : null;
				})
				.filter((file): file is TFile => file != null); // 同时过滤 null 和 undefined
			// 对播放列表进行排序
			const sortedTracks = sortTracksByTrack(playlistFiles, this.plugin.settings);
			return {
				name,
				tracks: sortedTracks.map(mapToTrack),
			};
		});
		// 播放列表按名称排序
		const playlists = playlistsData.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));

		// 使用 LibraryService 获取排序后的艺术家数据
		const artistsData = this.libraryService.getArtists(validTrackList);
		const artists = artistsData.map(({ name, tracks }) => ({
			name,
			tracks: tracks.map(mapToTrack),
		}));

		// 使用 LibraryService 获取排序后的专辑数据
		const albumsData = this.libraryService.getAlbums(validTrackList);
		const albums = albumsData.map(({ name, tracks }) => ({
			name,
			tracks: tracks.map(mapToTrack),
		}));

		return {
			allTracks,
			favorites,
			playlists,
			artists,
			albums,
			currentPath: currentTrack?.path || null,
			currentList: currentListId || "all",
		};
	}
}

