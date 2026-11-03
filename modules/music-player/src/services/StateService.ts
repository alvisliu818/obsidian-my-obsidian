/**
 * 状态管理服务
 * 
 * 负责管理音乐播放器的所有状态，包括：
 * - 播放状态（当前曲目、播放状态、播放模式等）
 * - 曲目列表和歌词数据
 * - 列表上下文信息
 */

import { TFile } from "obsidian";
import type { PlayMode } from "@/main";
import type { LyricLine } from "@/utils/lyrics/parser";
import type { ExtendedLyricLine } from "@/utils/lyrics/extendedParser";
import type { CurrentList } from "./ListService";

/**
 * 播放器状态接口
 * 
 * 定义音乐播放器的完整状态结构
 */
export interface PlayerState {
	/** 当前播放的曲目文件 */
	currentTrack: TFile | null;
	/** 当前曲目在列表中的索引 */
	currentIndex: number;
	/** 是否正在播放 */
	isPlaying: boolean;
	/** 播放模式（顺序、循环、单曲循环、随机） */
	playMode: PlayMode;
	/** 当前曲目的普通歌词 */
	currentLyrics: LyricLine[];
	/** 当前曲目的逐字歌词 */
	currentExtendedLyrics: ExtendedLyricLine[];
	/** 音量（0-1） */
	volume: number;
	/** 播放速率（0.25-4.0） */
	playbackRate: number;
	/** 所有音乐文件列表 */
	trackList: TFile[];
	/** 收藏的曲目列表 */
	favorites: TFile[];
	/** 播放列表映射（播放列表名称 -> 曲目路径数组） */
	playlistMap: Record<string, string[]>;
	/** 当前列表上下文 */
	currentList: CurrentList | null;
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
 * 状态管理服务类
 * 
 * 负责管理音乐播放器的所有状态，提供状态的读取和更新方法。
 * 状态以不可变方式返回，确保状态的一致性。
 */
export class StateService {
	/** 内部状态对象 */
	private state: PlayerState;

	/**
	 * 创建状态管理服务实例
	 * 
	 * 初始化所有状态为默认值。
	 * 
	 * @param initialVolume - 初始音量（0-1），用于从持久化设置恢复
	 * @param initialPlaybackRate - 初始播放速率（0.25-4.0），用于从持久化设置恢复
	 */
	constructor(initialVolume = 1.0, initialPlaybackRate = 1.0) {
		this.state = {
			currentTrack: null,
			currentIndex: -1,
			isPlaying: false,
			playMode: "normal",
			currentLyrics: [],
			currentExtendedLyrics: [],
			volume: Math.max(0, Math.min(1, initialVolume)),
			playbackRate: Math.max(0.25, Math.min(4.0, initialPlaybackRate)),
			trackList: [],
			favorites: [],
			playlistMap: {},
			currentList: null,
			currentListId: "all",
			currentSectionIdForPlaylist: null,
			pendingNextCoverUrl: undefined,
			pendingPrevCoverUrl: undefined,
		};
	}

	/**
	 * 获取当前状态的副本
	 * 
	 * 返回状态的浅拷贝，确保外部无法直接修改内部状态。
	 * 
	 * @returns 当前状态的副本
	 */
	getState(): PlayerState {
		return { ...this.state };
	}

	/**
	 * 设置当前播放的曲目
	 * 
	 * @param track - 曲目文件，null 表示没有播放的曲目
	 * @param index - 曲目在列表中的索引
	 */
	setCurrentTrack(track: TFile | null, index: number) {
		this.state.currentTrack = track;
		this.state.currentIndex = index;
	}

	/**
	 * 设置播放状态
	 * 
	 * @param isPlaying - 是否正在播放
	 */
	setIsPlaying(isPlaying: boolean) {
		this.state.isPlaying = isPlaying;
	}

	/**
	 * 设置播放模式
	 * 
	 * @param playMode - 播放模式（normal, repeat-all, repeat-one, shuffle）
	 */
	setPlayMode(playMode: PlayMode) {
		this.state.playMode = playMode;
	}

	/**
	 * 设置歌词数据
	 * 
	 * @param lyrics - 普通歌词数组
	 * @param extendedLyrics - 逐字歌词数组
	 */
	setLyrics(lyrics: LyricLine[], extendedLyrics: ExtendedLyricLine[]) {
		this.state.currentLyrics = lyrics;
		this.state.currentExtendedLyrics = extendedLyrics;
	}

	/**
	 * 重置歌词数据
	 * 
	 * 清空当前曲目的所有歌词数据
	 */
	resetLyrics() {
		this.state.currentLyrics = [];
		this.state.currentExtendedLyrics = [];
	}

	/**
	 * 设置音量
	 * 
	 * @param volume - 音量值（0-1）
	 */
	setVolume(volume: number) {
		this.state.volume = volume;
	}

	/**
	 * 设置播放速率
	 * 
	 * @param rate - 播放速率（0.25-4.0）
	 */
	setPlaybackRate(rate: number) {
		this.state.playbackRate = rate;
	}

	/**
	 * 设置曲目列表
	 * 
	 * @param trackList - 所有音乐文件列表
	 */
	setTrackList(trackList: TFile[]) {
		this.state.trackList = trackList;
	}

	/**
	 * 设置收藏列表
	 * 
	 * @param favorites - 收藏的曲目列表
	 */
	setFavorites(favorites: TFile[]) {
		this.state.favorites = favorites;
	}

	/**
	 * 设置播放列表映射
	 * 
	 * @param playlistMap - 播放列表映射（播放列表名称 -> 曲目路径数组）
	 */
	setPlaylistMap(playlistMap: Record<string, string[]>) {
		this.state.playlistMap = playlistMap;
	}

	/**
	 * 设置当前列表上下文
	 * 
	 * @param list - 当前列表对象，null 表示没有当前列表
	 */
	setCurrentList(list: CurrentList | null) {
		this.state.currentList = list;
	}

	/**
	 * 设置当前列表标识符
	 * 
	 * @param listId - 列表标识符字符串（如 "all", "favorites", "playlist:xxx"）
	 */
	setCurrentListId(listId: string | null) {
		this.state.currentListId = listId;
	}

	/**
	 * 设置当前播放列表的 section ID
	 * 
	 * @param sectionId - section ID，用于标识当前播放列表的上下文
	 */
	setCurrentSectionIdForPlaylist(sectionId: string | null) {
		this.state.currentSectionIdForPlaylist = sectionId;
	}

	/**
	 * 设置临时存储的下一首封面 URL
	 * 
	 * @param coverUrl - 封面 URL，undefined 表示清除
	 */
	setPendingNextCoverUrl(coverUrl: string | undefined) {
		this.state.pendingNextCoverUrl = coverUrl;
	}

	/**
	 * 设置临时存储的上一首封面 URL
	 * 
	 * @param coverUrl - 封面 URL，undefined 表示清除
	 */
	setPendingPrevCoverUrl(coverUrl: string | undefined) {
		this.state.pendingPrevCoverUrl = coverUrl;
	}
}

