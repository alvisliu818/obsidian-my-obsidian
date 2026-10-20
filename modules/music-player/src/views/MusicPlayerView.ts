/**
 * 音乐播放器视图模块
 * 
 * 架构说明：
 * - 本类负责 Obsidian View 生命周期管理和服务初始化
 * - 业务逻辑方法（如播放控制、库管理等）主要通过 hooks 封装访问
 * - React 组件应使用 hooks（usePlaybackControl, useLibraryManagement）而不是直接调用 view 方法
 * - Components 组件应通过 props 接收数据和回调，不直接访问 view
 * - 非 React 代码（如键盘快捷键）可以直接访问标记为 @internal 的方法
 */

import { ItemView, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { Root } from "react-dom/client";
import MusicPlayerPlugin from "@/main";
import { KeyboardShortcutHandler, setupKeyboardShortcuts } from "@/utils/keyboard/shortcuts";
import { QueueModal, TrackSearchModal } from "@/components";
import type { ReactLibrarySnapshot, ReactPlaybackSnapshot } from "@/types";
import { AssetService, AudioService, FavoriteService, LibraryService, ListenerService, ListService, LyricsService, PlaybackService, PlaylistService, ReactApiService, SnapshotService, StateService, ViewSetupService } from "@/services";
import { togglePlayMode } from "@/utils/playback/control";
import type { ReactApi } from "@/types";
import { t, tWithParams } from "@/utils/i18n/i18n";
import { formatListLabel } from "@/utils/list/formatter";

/**
 * 音乐播放器视图的类型标识符
 * 
 * 用于在 Obsidian 中注册和识别音乐播放器视图
 */
export const VIEW_TYPE_MUSIC_PLAYER = "view";

/**
 * 音乐播放器视图类
 * 
 * 继承自 Obsidian 的 ItemView，负责：
 * - Obsidian View 生命周期管理（onOpen, onClose）
 * - 所有服务的初始化和依赖注入
 * - 提供业务逻辑方法供 hooks 和键盘快捷键使用
 * - 管理 React 根组件的挂载和卸载
 * 
 * 注意：业务逻辑主要通过 hooks 封装访问，React 组件应使用 hooks 而不是直接调用 view 方法。
 */
export class MusicPlayerView extends ItemView {
	/** 插件实例 */
	plugin: MusicPlayerPlugin;
	
	/**
	 * 获取当前音频元素
	 * 
	 * @returns 当前音频元素，如果不存在则返回 null
	 */
	get audioElement(): HTMLAudioElement | null {
		return this.audioService.getAudioElement();
	}
	
	/** 状态管理服务 */
	private stateService: StateService;
	private libraryService: LibraryService;
	private playlistService: PlaylistService;
	private favoriteService: FavoriteService;
	private lyricsService: LyricsService;
	private audioService: AudioService;
	private listService: ListService;
	private snapshotService: SnapshotService;
	private playbackService: PlaybackService;
	private assetService: AssetService;
	private viewSetupService: ViewSetupService;
	private reactApiService: ReactApiService;
	private listenerService: ListenerService;
	private keyboardShortcuts?: KeyboardShortcutHandler;
	private libraryUpdateListeners: Set<() => void> = new Set();
	private reactRoot: Root | null = null;
	/** 播放上一首时的回调（用于设置 lastAction） */
	private onPlayPreviousCallback?: () => void;
	/** 播放下一首时的回调（用于设置 lastAction） */
	private onPlayNextCallback?: () => void;
	/** 直接选择歌曲时的回调（用于清除 lastAction） */
	private onDirectPlayCallback?: () => void;
	/** 是否需要重建索引的标识 */
	private needsRebuild: boolean = false;

	// ========== 状态访问器 ==========
	// 简化 getter，直接访问 stateService，避免重复调用 getState()
	
	/** 获取完整状态对象 */
	get state() { return this.stateService.getState(); }
	/** 当前播放的曲目 */
	get currentTrack() { return this.state.currentTrack; }
	/** 所有音乐文件列表 */
	get trackList() { return this.state.trackList; }
	/** 当前曲目在列表中的索引 */
	get currentIndex() { return this.state.currentIndex; }
	/** 是否正在播放 */
	get isPlaying() { return this.state.isPlaying; }
	/** 当前曲目的普通歌词 */
	get currentLyrics() { return this.state.currentLyrics; }
	/** 当前曲目的逐字歌词 */
	get currentExtendedLyrics() { return this.state.currentExtendedLyrics; }
	/** 收藏的曲目列表 */
	get favorites() { return this.state.favorites; }
	/** 播放列表映射（播放列表名称 -> 曲目路径数组） */
	get playlistMap() { return this.state.playlistMap; }
	/** 当前播放列表的 section ID */
	get currentSectionIdForPlaylist() { return this.state.currentSectionIdForPlaylist; }
	/** 当前列表上下文 */
	get currentList() { return this.state.currentList; }
	/** 当前列表标识符 */
	get currentListId() { return this.state.currentListId; }
	/** 播放模式 */
	get playMode() { return this.state.playMode; }
	/** 音量（0-1） */
	get volume() { return this.state.volume; }
	/** 播放速率（0.25-4.0） */
	get playbackRate() { return this.state.playbackRate; }

	/**
	 * React API - 统一接口供 React 组件使用
	 * 
	 * 返回 ReactApiService 提供的 API 接口，供 React 组件通过 hooks 调用。
	 * 
	 * @returns React API 接口对象
	 */
	get reactApi(): ReactApi {
		return this.reactApiService.getApi();
	}

	/**
	 * 创建音乐播放器视图实例
	 * 
	 * 初始化所有服务并建立依赖关系。服务初始化顺序很重要：
	 * 1. 基础服务（StateService, LibraryService, PlaylistService 等）
	 * 2. 依赖基础服务的服务（ListService, ViewService 等）
	 * 3. 编排服务（PlaybackService, LibraryOrchestrationService）
	 * 4. API 服务（ReactApiService）
	 * 
	 * @param leaf - Obsidian 工作区叶子节点
	 * @param plugin - 插件实例
	 */
	constructor(leaf: WorkspaceLeaf, plugin: MusicPlayerPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.stateService = new StateService(
			this.plugin.settings.volume ?? 1.0,
			this.plugin.settings.playbackRate ?? 1.0
		);
		this.playlistService = new PlaylistService(this.app, this.plugin);
		this.favoriteService = new FavoriteService(this.plugin);
		this.lyricsService = new LyricsService(this.plugin);
		this.audioService = new AudioService(this.app);
		this.libraryService = new LibraryService(
			this.app,
			this.plugin,
			this.stateService,
			this.playlistService,
			this.lyricsService,
			{
				onLibraryUpdated: () => this.handleLibraryUpdated(),
			}
		);
		this.listService = new ListService(this.libraryService, this.playlistService, this.plugin);
		this.snapshotService = new SnapshotService(this.app, this.plugin, this.listService, this.libraryService);
		this.playbackService = new PlaybackService(
			this.plugin,
			this.stateService,
			this.audioService,
			this.lyricsService,
			this.listService,
			this.snapshotService,
			{
				onLibraryUpdated: () => this.handleLibraryUpdated(),
				onTrackEnd: () => this.onTrackEnd(),
				onRefreshMusicList: () => {
					void this.refreshMusicList();
				},
			}
		);
		this.assetService = new AssetService(this.app, this.plugin);
		this.viewSetupService = new ViewSetupService(this.app);
		this.reactApiService = new ReactApiService(
			this.plugin,
			this.stateService,
			this.listService,
			this.playbackService,
			this.audioService,
			this.favoriteService,
			this.playlistService,
			{
				onLibraryUpdated: () => this.handleLibraryUpdated(),
				onDirectPlay: () => {
					// 清除 lastAction，直接更新封面，不显示动画
					if (this.onDirectPlayCallback) {
						this.onDirectPlayCallback();
					}
				},
				onShowNotice: (message: string, timeout?: number) => {
					new Notice(message, timeout);
				},
			}
		);
		// 创建音频事件处理器，用于在文件重命名时重新创建音频元素
		// 使用与 PlaybackService 相同的回调结构
		const audioEventHandlers = {
			onTimeUpdate: () => {
				// 播放进度更新回调（由 React 组件通过 usePlaybackState 处理）
				// PlaybackService 使用 onProgressUpdate，但这里我们不需要做任何事情
				// 因为 React 组件会通过 requestAnimationFrame 自动更新
			},
			onLoadedMetadata: () => {
				// 元数据加载完成回调（由 React 组件处理）
				// PlaybackService 使用 onDurationUpdate，但这里我们不需要做任何事情
			},
			onEnded: () => {
				// 播放结束回调，与 PlaybackService 的 onTrackEnd 一致
				this.onTrackEnd();
			},
		};
		
		this.listenerService = new ListenerService(
			this.app,
			this.plugin,
			this.libraryService,
			this.stateService,
			this.audioService,
			this.lyricsService,
			audioEventHandlers
		);
	}

	/**
	 * 获取视图类型标识符
	 * 
	 * @returns 视图类型标识符
	 */
	getViewType() {
		return VIEW_TYPE_MUSIC_PLAYER;
	}

	/**
	 * 订阅库更新事件
	 * 
	 * 当音乐库发生变化时（如刷新库、切换收藏、修改播放列表等），
	 * 会通知所有已注册的监听器。
	 * 
	 * @param listener - 库更新时的回调函数
	 */
	public subscribeLibraryUpdates(listener: () => void) {
		this.libraryUpdateListeners.add(listener);
	}

	/**
	 * 取消订阅库更新事件
	 * 
	 * @param listener - 要移除的监听器函数
	 */
	public unsubscribeLibraryUpdates(listener: () => void) {
		this.libraryUpdateListeners.delete(listener);
	}

	/**
	 * 获取视图显示文本
	 * 
	 * @returns 视图显示名称
	 */
	getDisplayText() {
		return t("view.title");
	}

	/**
	 * 获取视图图标
	 * 
	 * @returns 图标名称（Lucide 图标）
	 */
	getIcon() {
		return "lucide-music";
	}

	/**
	 * 视图打开时的初始化方法
	 * 
	 * 负责：
	 * - 设置 React 根组件
	 * - 检查歌曲列表一致性，如果不一致则自动执行库更新
	 * - 刷新库状态
	 * - 恢复上次播放的曲目
	 * - 设置键盘快捷键
	 * - 注册文件系统监听器（监控音乐文件变化）
	 */
	async onOpen() {
		try {
			// 每次视图打开时重新加载设置，确保官方同步后的数据能够生效
			await this.plugin.loadSettings();

			// 先清理旧的 React root（如果存在）
			if (this.reactRoot) {
				try {
					this.reactRoot.unmount();
				} catch (e) {
					console.warn("卸载旧的 React root 时出错:", e);
				}
				this.reactRoot = null;
			}
			
			// 设置 React 根组件（必须在最前面，确保 UI 能显示）
			const { reactRoot } = this.viewSetupService.setupView(this.containerEl, this);
			this.reactRoot = reactRoot;
			
			// 注册文件系统监听器，监控音乐文件变化
			// 先清理可能存在的旧监听器，再设置新的监听器
			this.listenerService.cleanup();
			this.listenerService.setup();
			
			// 启动时自动检查歌曲列表一致性，如果需要重建则设置标识，不自动重建
			try {
				const needsUpdate = await this.libraryService.checkLibraryConsistency();
				if (needsUpdate) {
					console.debug("检测到库不一致，需要重建索引");
					this.needsRebuild = true;
					// 通知 React 组件更新 UI
					this.notifyNeedsRebuildChange();
				}
			} catch (error) {
				// 静默处理错误，不影响启动流程
				console.error("启动时检查数据时出错:", error);
			}
			
			// 初始化时刷新库状态
			await this.handleLibraryUpdated();
			await this.restoreLastPlayedTrack();
			this.keyboardShortcuts = setupKeyboardShortcuts(this);
		} catch (error) {
			console.error("初始化视图时出错:", error);
			// 即使出错，也尝试显示错误信息
			if (this.containerEl) {
				const errorDiv = this.containerEl.createDiv();
				errorDiv.setCssProps({ padding: "20px", color: "var(--text-error)" });
				errorDiv.textContent = tWithParams("view.initFailed", {
					detail: error instanceof Error ? error.message : String(error),
				});
				this.containerEl.appendChild(errorDiv);
			}
		}
	}

	/**
	 * 视图关闭时的清理方法
	 * 
	 * 负责：
	 * - 清理音频元素
	 * - 移除键盘快捷键监听
	 * - 移除文件系统监听器
	 * - 卸载 React 根组件
	 */
	async onClose() {
		await this.audioService.cleanup();
		if (this.keyboardShortcuts) this.keyboardShortcuts.cleanup();
		// 清理文件系统监听器
		this.listenerService.cleanup();
		if (this.reactRoot) {
			this.reactRoot.unmount();
			this.reactRoot = null;
		}
	}

	/**
	 * 打开播放列表选择对话框
	 * @internal React 组件应通过 usePlaybackControl hook 访问此方法
	 */
	public async openPlaylistSheet() {
		// 打开播放列表前刷新库状态
		await this.handleLibraryUpdated();
		const { list } = this.listService.getCurrentPlaylistForTrack(
			this.state.currentTrack,
			this.state.currentList,
			this.state.trackList,
			this.state.favorites
		);
		if (list.length === 0) return;
		const listId = this.listService.calculateCurrentListId(
			this.state.currentTrack,
			this.state.currentList,
			this.state.trackList,
			this.state.favorites
		);
		const modal = new QueueModal(this.app, this.plugin, list, this.state.currentTrack);
		modal.setPlaceholder(
			tWithParams("queue.placeholderWithContext", {
				context: formatListLabel(listId),
			})
		);
		const selectedFile = await modal.prompt();
		if (selectedFile) {
			// 清除 lastAction，直接更新封面，不显示动画
			if (this.onDirectPlayCallback) {
				this.onDirectPlayCallback();
			}
			const success = await this.playbackService.playByPath(selectedFile.path);
			if (!success) {
				new Notice(t("notice.trackMissing"), 5000);
			}
		}
	}

	/**
	 * 打开搜索模态框（私有方法）
	 * 
	 * 刷新音乐列表后打开搜索对话框，允许用户搜索并选择歌曲播放。
	 */
	private async openSearchModal() {
		await this.refreshMusicList();
		if (this.state.trackList.length === 0) return;
		const modal = new TrackSearchModal(this.app, this.plugin, this.state.trackList, this.state.currentTrack);
		modal.setPlaceholder(t("search.placeholder"));
		const selectedFile = await modal.prompt();
		if (selectedFile) {
			// 清除 lastAction，直接更新封面，不显示动画
			if (this.onDirectPlayCallback) {
				this.onDirectPlayCallback();
			}
			this.stateService.setCurrentList({
				type: "all",
				name: t("list.all"),
				tracks: this.state.trackList,
			});
			this.stateService.setCurrentListId("all");
			await this.playbackService.playByPath(selectedFile.path);
		}
	}

	/**
	 * 恢复上次播放的曲目
	 * 
	 * 在视图打开时调用，尝试恢复上次播放的曲目。
	 * 根据设置决定是否自动播放。
	 */
	private async restoreLastPlayedTrack() {
		const autoPlay = this.plugin.settings.autoPlayOnOpen ?? false;
		await this.playbackService.restoreLastPlayedTrack(autoPlay);
	}

	/**
	 * 打开搜索模态框（公共方法）
	 * 
	 * 供外部调用的搜索方法，内部调用私有方法。
	 */
	public openSearchModalPublic() {
		void this.openSearchModal();
	}

	/**
	 * 刷新音乐列表
	 * 
	 * 从设置中读取数据并重新构建分类数据（艺术家、专辑等）。
	 */
	async refreshMusicList() {
		this.libraryService.refreshMusicList();
	}

	/**
	 * 获取资源文件路径
	 * 
	 * @param filename - 资源文件名
	 * @returns 资源文件的完整路径
	 */
	public async getAssetPath(filename: string): Promise<string> {
		return this.assetService.getAssetPath(filename);
	}

	/**
	 * 获取播放状态快照
	 * 
	 * 用于 React 组件获取当前播放状态，包含所有播放相关的信息。
	 * 
	 * @returns 播放状态快照对象
	 */
	public getReactPlaybackSnapshot(): ReactPlaybackSnapshot {
		const state = this.stateService.getState();
		return this.snapshotService.getPlaybackSnapshot({
			...state,
			audioElement: this.audioElement,
		});
	}

	/**
	 * 获取音乐库快照
	 * 
	 * 用于 React 组件获取当前音乐库数据，包含所有分类的歌曲信息。
	 * 
	 * @returns 音乐库快照对象
	 */
	public getReactLibrarySnapshot(): ReactLibrarySnapshot {
		const state = this.stateService.getState();
		return this.snapshotService.getLibrarySnapshot(
			state.trackList,
			state.currentTrack,
			state.currentListId
		);
	}

	/**
	 * 异步获取歌曲封面（优先文件夹中的 cover 文件，其次内嵌封面）
	 * 
	 * @param trackFile - 音乐文件
	 * @param options - 可选参数（例如在移动端列表禁用内嵌封面提取）
	 * @returns 封面图片 URL（可能是文件路径或 base64 Data URL），如果未找到则返回 undefined
	 */
	public async getTrackCoverAsync(
		trackFile: TFile | null | undefined,
		options?: Parameters<typeof this.snapshotService.getTrackCoverAsync>[1]
	): Promise<string | undefined> {
		if (!trackFile) return undefined;
		return await this.snapshotService.getTrackCoverAsync(trackFile, options);
	}

	/**
	 * 切换播放/暂停
	 * @internal React 组件应通过 usePlaybackControl hook 访问此方法
	 */
	async togglePlay() {
		await this.playbackService.togglePlay();
	}

	/**
	 * 播放上一首
	 * @internal React 组件应通过 usePlaybackControl hook 访问此方法
	 */
	async playPrevious() {
		// 如果注册了回调（用于设置 lastAction），先调用回调
		if (this.onPlayPreviousCallback) {
			this.onPlayPreviousCallback();
		}
		await this.playbackService.playPrevious();
	}

	/**
	 * 播放下一首
	 * @internal React 组件应通过 usePlaybackControl hook 访问此方法
	 */
	async playNext() {
		// 如果注册了回调（用于设置 lastAction），先调用回调
		if (this.onPlayNextCallback) {
			this.onPlayNextCallback();
		}
		await this.playbackService.playNext();
	}

	/**
	 * 设置播放操作的回调（用于设置/清除 lastAction）
	 * 
	 * 当通过快捷键触发上一首/下一首时，会调用这些回调来设置 lastAction，
	 * 从而触发唱片滑动动画。
	 * 当直接选择歌曲时（从库、搜索、播放列表），会调用 onDirectPlay 回调来清除 lastAction，
	 * 从而直接更新封面，不显示动画。
	 * 
	 * @param onPrev - 播放上一首时的回调
	 * @param onNext - 播放下一首时的回调
	 * @param onDirectPlay - 直接选择歌曲时的回调（用于清除 lastAction）
	 */
	setPlaybackActionCallbacks(onPrev?: () => void, onNext?: () => void, onDirectPlay?: () => void) {
		this.onPlayPreviousCallback = onPrev;
		this.onPlayNextCallback = onNext;
		this.onDirectPlayCallback = onDirectPlay;
	}

	/**
	 * 歌曲播放结束时的回调
	 * 
	 * 由音频元素的事件监听器调用，处理播放结束后的逻辑
	 * （如自动播放下一首、单曲循环等）
	 */
	private onTrackEnd = () => {
		this.playbackService.handleTrackEnd();
	};

	/**
	 * 切换播放模式
	 * @internal React 组件应通过 usePlaybackControl hook 访问此方法
	 */
	async togglePlayMode() {
		this.stateService.setPlayMode(togglePlayMode(this.state.playMode));
	}

	/**
	 * 跳转到指定播放位置（0-1 之间的比例）
	 * @internal React 组件应通过 usePlaybackControl hook 访问此方法
	 */
	public seekToRatio(ratio: number) {
		this.audioService.seekToRatio(ratio);
	}

	/**
	 * 快进指定秒数
	 * @internal React 组件应通过 usePlaybackControl hook 访问此方法
	 */
	seekForward(seconds: number) {
		this.audioService.seekForward(seconds);
	}

	/**
	 * 快退指定秒数
	 * @internal React 组件应通过 usePlaybackControl hook 访问此方法
	 */
	seekBackward(seconds: number) {
		this.audioService.seekBackward(seconds);
	}

	/**
	 * 重建所有数据
	 * 
	 * 完全重建音乐库的所有数据，包括重新扫描文件、提取元数据、生成分类等。
	 * @internal React 组件应通过 useLibraryManagement hook 访问此方法
	 */
	public async rebuildAllData() {
		// 执行重建
		await this.libraryService.rebuildAllData();
		// 清除重建标识
		this.needsRebuild = false;
		// 通知 React 组件更新 UI
		this.notifyNeedsRebuildChange();
		// 更新状态和通知监听器
		await this.handleLibraryUpdated();
	}

	/**
	 * 获取是否需要重建索引的标识
	 * 
	 * @returns 如果需要重建返回 true，否则返回 false
	 */
	public getNeedsRebuild(): boolean {
		return this.needsRebuild;
	}

	/**
	 * 通知 React 组件更新重建标识状态
	 * 
	 * 通过触发库更新事件来通知 React 组件刷新 UI
	 */
	private notifyNeedsRebuildChange(): void {
		// 触发所有已注册的监听器，让 React 组件能够刷新 UI
		for (const listener of this.libraryUpdateListeners) {
			try {
				listener();
			} catch (e) {
				console.error("通知重建标识变化时出错:", e);
			}
		}
	}

	/**
	 * 处理库更新事件
	 * 
	 * 当音乐库发生变化时调用，通知所有已注册的监听器。
	 * 同时会更新库状态（刷新列表、更新分类等）。
	 */
	public async handleLibraryUpdated() {
		await this.libraryService.handleLibraryUpdated(this.libraryUpdateListeners);
	}
}
