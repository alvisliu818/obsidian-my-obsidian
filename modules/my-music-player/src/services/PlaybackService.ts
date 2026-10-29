/**
 * 播放服务
 * 
	 * 负责组合播放相关的多个服务调用，包括：
	 * - 播放曲目（playTrack）
	 * - 通过路径播放（playByPath）
	 * - 播放分类（playCategory）
	 * - 上一首/下一首（playPrevious/playNext）
	 * - 切换播放/暂停（togglePlay）
	 * - 处理歌曲结束（onTrackEnd）
	 * - 恢复最后播放的曲目（restoreLastPlayedTrack）
 */

import { TFile } from "obsidian";
import { StateService } from "./StateService";
import { AudioService } from "./AudioService";
import { LyricsService } from "./LyricsService";
import { type CurrentList, ListService } from "./ListService";
import { SnapshotService } from "./SnapshotService";
import { findTrackIndexInGlobalList, getNextIndex, getPreviousIndex, handleTrackEnd } from "@/utils/playback/control";
import { ANIMATION_TIMINGS } from "@/constants/ui";
import type MusicPlayerPlugin from "@/main";
import type { PlayMode } from "@/main";
import { t } from "@/utils/i18n/i18n";

/**
 * 播放服务回调接口
 * 
 * 定义播放过程中需要触发的各种回调函数
 */
export interface PlaybackCallbacks {
	/** 库更新时的回调 */
	onLibraryUpdated?: () => Promise<void>;
	/** 播放进度更新时的回调 */
	onProgressUpdate?: () => void;
	/** 音频元数据加载完成时的回调 */
	onDurationUpdate?: () => void;
	/** 歌曲播放结束时的回调 */
	onTrackEnd?: () => void;
	/** 需要刷新音乐列表时的回调 */
	onRefreshMusicList?: () => void;
}

/**
 * 播放服务类
 * 
	 * 负责组合播放相关的多个服务调用，协调状态管理、音频播放、歌词加载等操作。
	 * 这是播放功能的核心服务，统一管理播放流程。
 */
export class PlaybackService {
	/**
	 * 播放请求 ID（自增）
	 * 
	 * 用于实现“最新请求覆盖”：
	 * - 每次开始一个新的播放流程时自增；
	 * - 在异步流程的关键阶段检查 ID 是否仍然匹配；
	 * - 如果不匹配，说明有更新的播放请求进来，当前流程应立即终止，避免并发创建多个 Audio 实例。
	 */
	private playRequestId = 0;

	/**
	 * 合并 ended 与 seeked 补发导致的重复 handleTrackEnd（同一物理结束瞬间）
	 */
	private lastHandleTrackEndAt = 0;

	/**
	 * 创建播放服务实例
	 * 
	 * @param plugin - 插件实例（读取自动播放曲目等设置）
	 * @param stateService - 状态管理服务
	 * @param audioService - 音频服务
	 * @param lyricsService - 歌词服务
	 * @param listService - 列表服务
	 * @param snapshotService - 快照服务（用于获取封面）
	 * @param callbacks - 回调函数集合
	 */
	constructor(
		private plugin: MusicPlayerPlugin,
		private stateService: StateService,
		private audioService: AudioService,
		private lyricsService: LyricsService,
		private listService: ListService,
		private snapshotService: SnapshotService,
		private callbacks: PlaybackCallbacks = {}
	) {}

	/**
	 * 计算上一首或下一首曲目
	 * 
	 * 根据当前曲目、当前列表、播放模式等信息，计算应该播放的上一首或下一首曲目。
	 * 
	 * @param currentTrack - 当前播放的曲目
	 * @param currentList - 当前列表上下文
	 * @param trackList - 所有曲目列表
	 * @param favorites - 收藏列表
	 * @param playMode - 播放模式（normal, repeat-all, repeat-one, shuffle）
	 * @param direction - 方向（"previous" 或 "next"）
	 * @returns 包含全局索引和目标曲目的对象，如果无法计算则返回 null
	 */
	private calculateNextTrack(
		currentTrack: TFile | null,
		currentList: CurrentList | null,
		trackList: TFile[],
		favorites: TFile[],
		playMode: string,
		direction: "previous" | "next"
	): { globalIndex: number; target: TFile } | null {
		const { list } = this.listService.getCurrentPlaylistForTrack(
			currentTrack,
			currentList,
			trackList,
			favorites
		);
		if (!list.length || !currentTrack) return null;

		const currentIdxInList = list.findIndex((f) => f.path === currentTrack.path);
		if (currentIdxInList === -1) return null;

		const nextIdxInList = direction === "previous"
			? getPreviousIndex(currentIdxInList, list, playMode as PlayMode)
			: getNextIndex(currentIdxInList, list, playMode as PlayMode);
		
		const target = list[nextIdxInList];
		if (!target) {
			return null;
		}
		const globalIdx = findTrackIndexInGlobalList(target, trackList);
		if (globalIdx === -1) return null;

		return { globalIndex: globalIdx, target };
	}

	/**
	 * 预加载封面图片
	 * 
	 * @param coverUrl - 封面图片 URL
	 * @returns Promise，在封面加载完成时解析
	 */
	private preloadCover(coverUrl: string | undefined): Promise<void> {
		return new Promise((resolve) => {
			if (!coverUrl) {
				resolve();
				return;
			}

			const img = new Image();
			
			// 设置超时，避免长时间等待
			const timeout = window.setTimeout(() => {
				resolve(); // 超时后也继续，避免阻塞动画
			}, 2000); // 2秒超时

			img.onload = () => {
				window.clearTimeout(timeout);
				resolve();
			};
			img.onerror = () => {
				window.clearTimeout(timeout);
				resolve(); // 即使加载失败也继续，避免阻塞动画
			};
			
			// 设置 src，开始加载
			img.src = coverUrl;
			
			// 如果图片已经在缓存中，complete 会立即变为 true
			if (img.complete) {
				window.clearTimeout(timeout);
				resolve();
			}
		});
	}

	/**
	 * 播放指定索引的曲目
	 * 
	 * 完整的播放流程：
	 * 1. 验证索引有效性
	 * 2. 更新当前曲目和索引（这会触发 AlbumDisc 组件的动画）
	 * 3. 重置歌词
	 * 4. 计算并设置当前列表 ID
	 * 5. 刷新音乐列表（确保数据最新）
	 * 6. 通知库更新（这会更新封面 URL，触发 AlbumDisc 组件的动画）
	 * 7. 如果 delayPlay 为 true 且提供了 targetTrack，获取封面并等待加载完成，然后等待动画完成
	 * 8. 创建音频元素并绑定事件
	 * 9. 加载歌词
	 * 10. 开始播放（如果 autoPlay 为 true）
	 * 11. 更新播放状态
	 * 
	 * @param index - 曲目在 trackList 中的索引
	 * @param delayPlay - 是否延迟播放（等待封面加载和动画完成），默认为 false
	 * @param targetTrack - 可选的目标曲目（用于从当前播放列表获取封面），如果不提供则使用全局列表中的曲目
	 * @param direction - 可选的方向（"prev" 或 "next"），用于在动画完成后清除对应的临时封面 URL
	 * @param autoPlay - 是否自动播放，默认为 true
	 * @param skipLibraryUpdate - 是否跳过同步等待库更新（用于 React 列表点击等需要“立即播放”的场景）
	 */
	async playTrack(
		index: number,
		delayPlay: boolean = false,
		targetTrack?: TFile,
		direction?: "prev" | "next",
		autoPlay: boolean = true,
		skipLibraryUpdate: boolean = false
	): Promise<void> {
		// 为本次播放生成唯一请求 ID
		const requestId = ++this.playRequestId;

		const state = this.stateService.getState();
		if (index < 0 || index >= state.trackList.length) return;
		
		const track = targetTrack || state.trackList[index];
		if (!track) {
			return; // 曲目不存在
		}
		
		// 如果 delayPlay 为 true，先获取封面并预加载，然后再更新状态
		// 这样确保在状态更新和库更新时，封面已经准备好
		if (delayPlay) {
			const coverUrl = await this.snapshotService.getTrackCoverAsync(track);
			// 如果在等待封面期间有新的播放请求进来，则放弃当前流程
			if (requestId !== this.playRequestId) {
				return;
			}
			await this.preloadCover(coverUrl);
		}
		
		this.stateService.setCurrentTrack(track, index);
		this.stateService.resetLyrics();

		const currentListStr = this.listService.calculateCurrentListId(
			track,
			state.currentList,
			state.trackList,
			state.favorites
		);
		this.stateService.setCurrentListId(currentListStr);
		
		// 刷新音乐列表（确保数据最新）
		if (this.callbacks.onRefreshMusicList) {
			this.callbacks.onRefreshMusicList();
		}

		// 通知库更新（这会更新封面 URL，触发 AlbumDisc 组件的动画）
		// 注意：
		// - 对于“上一首/下一首”等常规操作，希望库和封面在创建 Audio 前就更新好，因此需要 await
		// - 对于 React 列表直接点击播放，希望“先听到声音再慢慢更新库”，因此可以跳过 await，仅异步触发
		if (this.callbacks.onLibraryUpdated) {
			if (skipLibraryUpdate) {
				// 不阻塞播放链路，后台异步刷新库
				void this.callbacks.onLibraryUpdated();
			} else {
				await this.callbacks.onLibraryUpdated();
			}
		}

		// 在进入真正的“创建 Audio + 播放”阶段前再检查一次
		if (requestId !== this.playRequestId) {
			// 有更新的播放请求了，当前流程退出，不再创建新 audio
			return;
		}

		// 如果 delayPlay 为 true，等待动画完成
		if (delayPlay) {
			// 等待动画时间（封面滑入动画）
			await new Promise(resolve =>
				window.setTimeout(resolve, ANIMATION_TIMINGS.DISC_ANIMATION_DURATION + ANIMATION_TIMINGS.DISC_ANIMATION_BUFFER)
			);
			
			// 动画完成后，清除临时存储的封面 URL
			if (direction === "prev") {
				this.stateService.setPendingPrevCoverUrl(undefined);
			} else if (direction === "next") {
				this.stateService.setPendingNextCoverUrl(undefined);
			}
		}

		const savedVolume = this.audioService.getAudioElement()?.volume ?? state.volume ?? 1.0;
		const savedPlaybackRate = this.audioService.getAudioElement()?.playbackRate ?? state.playbackRate ?? 1.0;
		
		await this.audioService.createAudioElement(track, savedVolume, savedPlaybackRate, {
			onTimeUpdate: this.callbacks.onProgressUpdate || (() => {}),
			onLoadedMetadata: this.callbacks.onDurationUpdate || (() => {}),
			onEnded: this.callbacks.onTrackEnd || (() => {}),
		});

		const { lyrics, extendedLyrics } = this.lyricsService.loadLyrics(track.path);
		this.stateService.setLyrics(lyrics, extendedLyrics);
		if (autoPlay) {
			// 最后再校验一次请求 ID，避免在长链路中被更新
			if (requestId !== this.playRequestId) {
				return;
			}

			await this.audioService.play();
			this.stateService.setIsPlaying(true);
		} else {
			this.stateService.setIsPlaying(false);
		}
	}

	/**
	 * 通过路径播放曲目
	 * 
	 * 根据文件路径查找曲目在列表中的索引，然后调用 playTrack 播放。
	 * 
	 * @param path - 音乐文件路径
	 * @param delayPlay - 是否延迟播放（等待封面加载和动画完成），默认为 true（选择歌曲时也需要先加载封面）
	 * @param skipLibraryUpdate - 是否跳过同步等待库更新（用于 React 列表点击等需要“立即播放”的场景）
	 * @returns 如果找到并成功播放返回 true，否则返回 false
	 */
	async playByPath(path: string, delayPlay: boolean = true, skipLibraryUpdate: boolean = false): Promise<boolean> {
		const state = this.stateService.getState();
		const idx = state.trackList.findIndex((f) => f.path === path);
		if (idx !== -1) {
			await this.playTrack(idx, delayPlay, undefined, undefined, true, skipLibraryUpdate);
			return true;
		}
		return false;
	}

	/**
	 * 播放分类（艺术家/专辑/歌单）
	 * 
	 * 设置当前列表上下文，然后播放该分类下的第一首歌曲。
	 * 
	 * @param categoryType - 分类类型（"artist", "album", "playlist"）
	 * @param categoryName - 分类名称
	 * @param tracks - 该分类下的曲目列表
	 */
	async playCategory(categoryType: string, categoryName: string, tracks: TFile[]): Promise<void> {
		if (tracks.length === 0) return;
		const firstTrack = tracks[0];
		if (!firstTrack) return;
		const state = this.stateService.getState();
		this.stateService.setCurrentList({ type: categoryType, name: categoryName, tracks });
		this.stateService.setCurrentListId(this.listService.formatCurrentList(categoryType, categoryName));
		
		const idx = state.trackList.findIndex((f) => f.path === firstTrack.path);
		if (idx !== -1) await this.playTrack(idx);
	}

	/**
	 * 播放上一首
	 * 
	 * 流程：
	 * 1. 计算上一首曲目（基于当前播放列表）
	 * 2. 从当前播放列表中获取封面并等待加载完成
	 * 3. 播放曲目（延迟播放，等待动画完成）
	 */
	async playPrevious(): Promise<void> {
		const state = this.stateService.getState();
		const result = this.calculateNextTrack(
			state.currentTrack,
			state.currentList,
			state.trackList,
			state.favorites,
			state.playMode,
			"previous"
		);
		if (!result) return;
		
		// 从当前播放列表中获取目标曲目的封面（result.target 就是当前播放列表中的曲目）
		// 获取封面并等待加载完成
		const coverUrl = await this.snapshotService.getTrackCoverAsync(result.target);
		await this.preloadCover(coverUrl);
		
		// 在更新状态之前，先设置临时存储的上一首封面 URL
		// 这样在生成快照时，会使用这个封面而不是重新计算
		this.stateService.setPendingPrevCoverUrl(coverUrl);
		
		// 使用 delayPlay=true，并传入 targetTrack（当前播放列表中的曲目）来获取封面
		// playTrack 会在动画完成后清除临时封面 URL
		await this.playTrack(result.globalIndex, true, result.target, "prev");
	}

	/**
	 * 播放下一首
	 * 
	 * 流程：
	 * 1. 计算下一首曲目（基于当前播放列表）
	 * 2. 从当前播放列表中获取封面并等待加载完成
	 * 3. 播放曲目（延迟播放，等待动画完成）
	 */
	async playNext(): Promise<void> {
		const state = this.stateService.getState();
		const result = this.calculateNextTrack(
			state.currentTrack,
			state.currentList,
			state.trackList,
			state.favorites,
			state.playMode,
			"next"
		);
		if (!result) return;
		
		// 从当前播放列表中获取目标曲目的封面（result.target 就是当前播放列表中的曲目）
		// 获取封面并等待加载完成
		const coverUrl = await this.snapshotService.getTrackCoverAsync(result.target);
		await this.preloadCover(coverUrl);
		
		// 在更新状态之前，先设置临时存储的下一首封面 URL
		// 这样在生成快照时，会使用这个封面而不是重新计算
		this.stateService.setPendingNextCoverUrl(coverUrl);
		
		// 使用 delayPlay=true，并传入 targetTrack（当前播放列表中的曲目）来获取封面
		// playTrack 会在动画完成后清除临时封面 URL
		await this.playTrack(result.globalIndex, true, result.target, "next");
	}

	/**
	 * 切换播放/暂停
	 */
	async togglePlay(): Promise<void> {
		const state = this.stateService.getState();
		const audioElement = this.audioService.getAudioElement();
		
		if (!audioElement || !state.currentTrack) {
			if (state.trackList.length > 0) await this.playTrack(0);
			return;
		}
		
		if (state.isPlaying) {
			this.audioService.pause();
			this.stateService.setIsPlaying(false);
		} else {
			const d = audioElement.duration;
			const t = audioElement.currentTime;
			if (Number.isFinite(d) && d > 0 && Number.isFinite(t) && (audioElement.ended || t >= d - 0.06)) {
				audioElement.currentTime = 0;
			}
			await this.audioService.play();
			this.stateService.setIsPlaying(true);
		}
	}

	/**
	 * 处理歌曲结束
	 */
	handleTrackEnd(): void {
		const now = Date.now();
		if (now - this.lastHandleTrackEndAt < 450) return;
		this.lastHandleTrackEndAt = now;

		const state = this.stateService.getState();
		const { list } = this.listService.getCurrentPlaylistForTrack(
			state.currentTrack,
			state.currentList,
			state.trackList,
			state.favorites
		);
		
		const currentIdxInList = state.currentTrack
			? list.findIndex((f) => f.path === state.currentTrack!.path)
			: -1;

		const { shouldPlayNext, shouldRepeat, shouldStop } = handleTrackEnd(
			state.playMode,
			currentIdxInList,
			list
		);

		const audioElement = this.audioService.getAudioElement();
		if (shouldRepeat && audioElement) {
			audioElement.currentTime = 0;
			// 使用 audioService.play() 而不是直接调用，以便正确处理错误
			void this.audioService.play().catch((error) => {
				// 如果播放被中断，这是正常情况（例如用户切换曲目）
				if (error instanceof DOMException && error.name === 'AbortError') {
					console.debug('重复播放被中断（可能是切换曲目导致的）:', error.message);
				} else {
					console.error('重复播放时出错:', error);
				}
			});
		} else if (shouldPlayNext) {
			void this.playNext();
		} else if (shouldStop) {
			this.stateService.setIsPlaying(false);
		}
	}

	/**
	 * 恢复最后播放的曲目
	 * 
	 * @param autoPlay - 是否自动播放，默认为 true
	 */
	async restoreLastPlayedTrack(autoPlay: boolean = true): Promise<void> {
		const state = this.stateService.getState();
		if (!state.trackList.length) return;
		this.stateService.setCurrentList({ type: "all", name: t("list.all"), tracks: state.trackList });
		this.stateService.setCurrentListId("all");

		let index = 0;
		const path = (this.plugin.settings.autoPlayOpenTrackPath ?? "").trim();
		if (path) {
			const found = state.trackList.findIndex((f) => f.path === path);
			if (found >= 0) {
				index = found;
			}
		}

		await this.playTrack(index, false, undefined, undefined, autoPlay);
	}
}

