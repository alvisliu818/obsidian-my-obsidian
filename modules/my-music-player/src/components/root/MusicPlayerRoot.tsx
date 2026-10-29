/**
 * 音乐播放器根组件
 * 
 * React 应用的根组件，负责：
 * - Tab 切换（currentDisc / library）
 * - 页面切换（disc / lyrics）
 * - 导航栏渲染（通过 portal）
 * - 根据 Tab 渲染对应的页面组件（PlayPage、LibraryPage）
 * 
 * 注意：状态管理通过 hooks 处理，不在此组件中手动管理
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { Platform, TFile } from "obsidian";
import "./MusicPlayerRoot.css";
import { ConfirmModal, LibraryPage, NavigationBar, PlayPage } from "@/components";
import { t } from "@/utils/i18n/i18n";
import {
	useLibraryManagement,
	useLibraryState,
	useLyricsIndex,
	useNavigation,
	usePageState,
	usePlaybackControl,
	usePlaybackState,
	useTrackCovers,
} from "@/hooks";
import type { MusicPlayerView } from "@/views/MusicPlayerView";

export interface MusicPlayerRootProps {
	view: MusicPlayerView;
	navHost: HTMLElement;
}

export function MusicPlayerRoot({ view, navHost }: MusicPlayerRootProps) {
	// 使用 hooks 管理状态
	const { playback } = usePlaybackState(view);
	const { library, refreshSnapshot } = useLibraryState(view);

	// 导航状态管理
	const navigation = useNavigation();
	const pageState = usePageState();

	// 使用 hooks 封装业务逻辑
	const playbackControl = usePlaybackControl(view);
	const libraryManagement = useLibraryManagement(view);
	
	// 跟踪重建状态
	const [isRebuilding, setIsRebuilding] = React.useState(false);
	const isRebuildingRef = React.useRef(false);
	
	// 跟踪是否需要重建索引的状态
	const [needsRebuild, setNeedsRebuild] = React.useState(() => view.getNeedsRebuild());
	
	// 订阅库更新事件，同步 needsRebuild 状态
	React.useEffect(() => {
		const updateNeedsRebuild = () => {
			setNeedsRebuild(view.getNeedsRebuild());
		};
		view.subscribeLibraryUpdates(updateNeedsRebuild);
		return () => {
			view.unsubscribeLibraryUpdates(updateNeedsRebuild);
		};
	}, [view]);
	
	// 包装 rebuildAllData，添加确认对话框和状态跟踪
	const handleRebuild = React.useCallback(async () => {
		// 如果正在重建，直接返回
		if (isRebuildingRef.current) return;

		const message = t("rebuild.body");

		const modal = new ConfirmModal(
			view.app,
			t("rebuild.title"),
			message
		);
		const confirmed = await modal.prompt();
		if (!confirmed) return;

		isRebuildingRef.current = true;
		setIsRebuilding(true);

		try {
			await libraryManagement.rebuildAllData();
		} finally {
			isRebuildingRef.current = false;
			setIsRebuilding(false);
		}
	}, [libraryManagement, view]);
	
	// 单击库中歌曲：只播放当前歌曲，不切换页面
	const handlePlayWithClearAction = React.useCallback(
		(path: string, sectionId?: string) => {
			pageState.clearLastAction();
			void libraryManagement.handlePlay(path, sectionId);
		},
		[pageState, libraryManagement]
	);

	// 双击库中歌曲：播放并切换到唱片页面
	const handleDoubleClick = React.useCallback(
		(path: string, sectionId?: string) => {
			pageState.clearLastAction();
			// 先切换到唱片页，再异步执行播放
			navigation.openDisc();
			void libraryManagement.handlePlay(path, sectionId);
		},
		[pageState, libraryManagement, navigation]
	);

	// 注册播放操作回调，让快捷键也能设置 lastAction
	// 注意：这些回调只设置 lastAction，实际的播放操作会在 view.playPrevious/playNext 中执行
	React.useEffect(() => {
		const handlePrevCallback = () => {
			pageState.handlePrevWithFlag(() => {
				// 空函数，因为实际的播放会在 view.playPrevious() 中执行
			});
		};
		const handleNextCallback = () => {
			pageState.handleNextWithFlag(() => {
				// 空函数，因为实际的播放会在 view.playNext() 中执行
			});
		};
		const handleDirectPlayCallback = () => {
			// 清除 lastAction，直接更新封面，不显示动画
			pageState.clearLastAction();
		};
		view.setPlaybackActionCallbacks(handlePrevCallback, handleNextCallback, handleDirectPlayCallback);
	}, [view, pageState]);

	// 切换到"库"页时，主动刷新一次列表 & 快照，避免库页偶发使用旧数据
	// 对比：搜索模态框每次打开都会先 refreshMusicList，所以总是最新。
	React.useEffect(() => {
		if (navigation.tab !== "library") return;
		void (async () => {
			await view.refreshMusicList();
			refreshSnapshot();
		})();
	}, [navigation.tab, view, refreshSnapshot]);

	// 使用 hook 计算歌词索引
	const playingIndex = useLyricsIndex({
		fullLyrics: playback.fullLyrics,
		fullExtendedLyrics: playback.fullExtendedLyrics,
		currentTime: playback.currentTime,
	});

	// 处理上一首/下一首（带 lastAction 标记）
	const handlePrevWithFlag = React.useCallback(() => {
		pageState.handlePrevWithFlag(() => {
			void playbackControl.playPrevious();
		});
	}, [pageState, playbackControl]);

	const handleNextWithFlag = React.useCallback(() => {
		pageState.handleNextWithFlag(() => {
			void playbackControl.playNext();
		});
	}, [pageState, playbackControl]);

	// 处理音量和播放速率变化
	const api = view.reactApi;
	const handleVolumeChange = React.useCallback(async (volume: number) => {
		await api.setVolume(volume);
	}, [api]);

	const handlePlaybackRateChange = React.useCallback(async (rate: number) => {
		await api.setPlaybackRate(rate);
	}, [api]);

	// 使用 Hook 管理封面加载
	const { finalCoverUrl, finalPrevCoverUrl, finalNextCoverUrl } = useTrackCovers({
		playback,
		view,
	});

	return (
		<>
			{createPortal(
				<NavigationBar
					activeTab={navigation.tab}
					currentPage={navigation.tab === "currentDisc" ? navigation.currentPage : undefined}
					onOpenLibrary={navigation.openLibrary}
					onOpenDisc={navigation.openDisc}
					onOpenLyrics={navigation.openLyrics}
					onRebuild={handleRebuild}
					onSearch={playbackControl.openSearchModal}
					onSettings={() => {
						void view.plugin.openSettings();
					}}
					isRebuilding={isRebuilding}
					needsRebuild={needsRebuild}
				/>,
				navHost
			)}

			{navigation.tab === "currentDisc" ? (
				<PlayPage
						viewMode={navigation.currentPage}
						onSwitchViewMode={
							navigation.currentPage === "disc" 
								? navigation.switchToLyrics 
								: navigation.switchToDisc
						}
						title={playback.title}
						artist={playback.artist}
						coverUrl={finalCoverUrl}
						isPlaying={playback.isPlaying}
						currentTime={playback.currentTime}
						duration={playback.duration}
						playMode={playback.playMode}
						prevLyric={playback.prevLyric}
						currentLyric={playback.currentLyric}
						nextLyric={playback.nextLyric}
						prevExtendedLyric={playback.prevExtendedLyric}
						currentExtendedLyric={playback.currentExtendedLyric}
						nextExtendedLyric={playback.nextExtendedLyric}
						lastAction={pageState.lastAction}
						fullLyrics={playback.fullLyrics}
						fullExtendedLyrics={playback.fullExtendedLyrics}
						playingIndex={playingIndex}
						isInitialMount={navigation.shouldMarkInitialLyricsMount}
						onInitialMountComplete={navigation.clearInitialLyricsMount}
						onPrev={handlePrevWithFlag}
						onNext={handleNextWithFlag}
						onTogglePlay={() => { void playbackControl.togglePlay(); }}
						onToggleMode={() => { void playbackControl.togglePlayMode(); }}
						onOpenPlaylist={() => { void playbackControl.openPlaylistSheet(); }}
						onSeek={playbackControl.seekToRatio}
						onSeekBackward={playbackControl.seekBackward}
						onSeekForward={playbackControl.seekForward}
						prevCoverUrl={finalPrevCoverUrl}
						nextCoverUrl={finalNextCoverUrl}
						currentPath={playback.currentPath}
						sectionId={playback.sectionId || undefined}
						isFavorite={playback.isFavorite}
						volume={playback.volume}
						playbackRate={playback.playbackRate}
						onAddToPlaylist={(path, sectionId) => { void libraryManagement.addToPlaylist(path, sectionId); }}
						onToggleFavorite={(path, sectionId) => { void libraryManagement.toggleFavorite(path, sectionId); }}
						onVolumeChange={(volume) => { void handleVolumeChange(volume); }}
						onPlaybackRateChange={(rate) => { void handlePlaybackRateChange(rate); }}
					/>
			) : null}

			{navigation.tab === "library" ? (
				<LibraryPage
					library={library}
					activePath={library.currentPath}
					currentList={library.currentList}
					onPlay={handlePlayWithClearAction}
					onDoubleClick={handleDoubleClick}
					onToggleFavorite={(path, sectionId) => { void libraryManagement.toggleFavorite(path, sectionId); }}
					onAddToPlaylist={(path, sectionId) => { void libraryManagement.addToPlaylist(path, sectionId); }}
					onRemoveFromPlaylist={(path, playlistName) => { void libraryManagement.removeFromPlaylist(path, playlistName); }}
					onCreatePlaylist={() => { void libraryManagement.createPlaylist(); }}
					onPlayCategory={(categoryType, categoryName, tracks) => { void libraryManagement.playCategory(categoryType, categoryName, tracks); }}
					onEditPlaylist={(playlistName) => { return libraryManagement.editPlaylistName(playlistName); }}
					onDeletePlaylist={(playlistName) => { return libraryManagement.deletePlaylist(playlistName); }}
					getTrackCover={async (file: TFile) => {
						// 移动端列表：默认不提取音频内嵌封面（太耗时），只查同目录 cover/同名图片
						return await view.getTrackCoverAsync(file, { includeEmbedded: !Platform.isMobileApp });
					}}
					app={view.app}
				/>
			) : null}
		</>
	);
}

