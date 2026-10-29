/**
 * 播放页面组件
 * 
 * 合并了 DiscPage 和 LyricsPage 的功能，通过 viewMode 控制显示模式
 * - "disc": 显示唱片封面和三行歌词
 * - "lyrics": 显示完整歌词列表
 */

import React from "react";
import "./PlayPage.css";
import { AlbumDisc } from "@/components/player/AlbumDisc";
import { LyricsTriplet } from "@/components/player/LyricsTriplet";
import { LyricsExtendedTriplet } from "@/components/player/LyricsExtendedTriplet";
import { LyricsFull } from "@/components/player/LyricsFull";
import { LyricsExtendedFull } from "@/components/player/LyricsExtendedFull";
import { TrackHeader } from "@/components/player/TrackHeader";
import { ProgressBar } from "@/components/player/ProgressBar";
import { PlaybackControls } from "@/components/player/PlaybackControls";
import { TrackActions } from "@/components/player/TrackActions";
import { useLyricsAutoScroll } from "@/hooks/useLyricsAutoScroll";
import type { PlayMode } from "@/main";
import type { LyricLine } from "@/utils/lyrics/parser";
import type { ExtendedLyricLine } from "@/utils/lyrics/extendedParser";

export type PlayPageViewMode = "disc" | "lyrics";

export interface PlayPageProps {
	/** 显示模式 */
	viewMode: PlayPageViewMode;
	/** 切换到另一个模式 */
	onSwitchViewMode: () => void;
	
	// 基本信息
	title: string;
	artist: string;
	
	// 播放状态
	isPlaying: boolean;
	currentTime: number;
	duration: number;
	playMode: PlayMode;
	
	// 唱片模式相关
	coverUrl?: string;
	prevCoverUrl?: string;
	nextCoverUrl?: string;
	prevLyric?: string;
	currentLyric?: string;
	nextLyric?: string;
	prevExtendedLyric?: ExtendedLyricLine;
	currentExtendedLyric?: ExtendedLyricLine;
	nextExtendedLyric?: ExtendedLyricLine;
	lastAction?: "next" | "prev" | null;
	
	// 歌词模式相关
	fullLyrics: LyricLine[];
	fullExtendedLyrics: ExtendedLyricLine[];
	playingIndex: number;
	/** 是否是首次切换到歌词模式 */
	isInitialMount?: boolean;
	/** 首次切换完成的回调 */
	onInitialMountComplete?: () => void;
	
	// 播放控制
	onPrev: () => void;
	onNext: () => void;
	onTogglePlay: () => void;
	onToggleMode: () => void;
	onOpenPlaylist: () => void;
	onSeek: (ratio: number) => void;
	onSeekBackward: (seconds: number) => void;
	onSeekForward: (seconds: number) => void;
	
	// 歌曲信息
	currentPath: string | null;
	sectionId?: string | null;
	isFavorite: boolean;
	volume: number;
	playbackRate: number;
	onAddToPlaylist: (path: string, sectionId?: string) => void;
	onToggleFavorite: (path: string, sectionId?: string) => void;
	onVolumeChange: (volume: number) => void;
	onPlaybackRateChange: (rate: number) => void;
}

export function PlayPage({
	viewMode,
	onSwitchViewMode,
	title,
	artist,
	isPlaying,
	currentTime,
	duration,
	playMode,
	coverUrl,
	prevCoverUrl,
	nextCoverUrl,
	prevLyric,
	currentLyric,
	nextLyric,
	prevExtendedLyric,
	currentExtendedLyric,
	nextExtendedLyric,
	lastAction,
	fullLyrics,
	fullExtendedLyrics,
	playingIndex,
	isInitialMount = false,
	onInitialMountComplete,
	onPrev,
	onNext,
	onTogglePlay,
	onToggleMode,
	onOpenPlaylist,
	onSeek,
	onSeekBackward,
	onSeekForward,
	currentPath,
	sectionId,
	isFavorite,
	volume,
	playbackRate,
	onAddToPlaylist,
	onToggleFavorite,
	onVolumeChange,
	onPlaybackRateChange,
}: PlayPageProps) {
	// 判断是否使用逐字歌词
	const useExtendedLyrics = viewMode === "disc" 
		? currentExtendedLyric !== undefined
		: fullExtendedLyrics && fullExtendedLyrics.length > 0;

	const lyricsToUse = viewMode === "lyrics" 
		? (useExtendedLyrics ? fullExtendedLyrics : fullLyrics)
		: null;

	// 使用歌词自动滚动 Hook
	const { scrollRef, lineRefs } = useLyricsAutoScroll({
		viewMode,
		lyricsToUse,
		playingIndex,
		isInitialMount,
		onInitialMountComplete,
	});

	// 跟踪当前歌曲路径，用于检测歌曲切换
	const prevPathRef = React.useRef<string | null>(currentPath);

	// 计算有效的 playingIndex：如果刚切换歌曲，返回 -1，否则返回实际的 playingIndex
	// 由于容器通过 key={currentPath} 重新创建，新容器首次渲染时 effectivePlayingIndex 为 -1 即可
	// 容器创建后，playingIndex 会正常同步，无需延迟清除标记
	const effectivePlayingIndex = React.useMemo(() => {
		// 检测歌曲切换：如果 currentPath 与 ref 中的值不同，说明刚切换了歌曲
		if (prevPathRef.current !== currentPath) {
			// 歌曲刚切换，更新 ref 并返回 -1
			// 新容器会通过 key 重新创建，首次渲染时使用 -1，之后正常同步 playingIndex
			prevPathRef.current = currentPath;
			return -1;
		}
		
		// 正常情况，返回实际的 playingIndex
		return playingIndex;
	}, [playingIndex, currentPath]); // 依赖 currentPath 确保歌曲切换时重新计算

	const activeIndex = viewMode === "lyrics" ? effectivePlayingIndex : -1;

	const handleSeekToTime = React.useCallback(
		(time: number) => {
			if (!Number.isFinite(time) || duration <= 0) return;
			const ratio = Math.min(Math.max(time / duration, 0), 1);
			onSeek(ratio);
		},
		[duration, onSeek]
	);

	return (
		<div className={`play-page-wrapper play-page-${viewMode}`}>
			<TrackHeader title={title} artist={artist} />
			
			{/* 唱片模式：同时渲染，通过CSS控制显示/隐藏 */}
			<div 
				className={`disc-and-lyrics-triplet-wrapper ${viewMode === "disc" ? "visible" : "hidden"}`} 
				onClick={onSwitchViewMode}
			>
				<div className="disc-wrapper" onClick={onSwitchViewMode}>
					<AlbumDisc
						coverUrl={coverUrl}
						trackKey={currentPath || undefined}
						isPlaying={isPlaying}
						onPrev={onPrev}
						onNext={onNext}
						onTogglePlay={onTogglePlay}
						prevCoverUrl={prevCoverUrl}
						nextCoverUrl={nextCoverUrl}
						lastAction={lastAction}
					/>
				</div>
				<div className="lyrics-triplet-wrapper" onClick={onSwitchViewMode}>
					{useExtendedLyrics ? (
						<LyricsExtendedTriplet 
							prev={prevExtendedLyric} 
							current={currentExtendedLyric} 
							next={nextExtendedLyric}
							currentTime={currentTime}
						/>
					) : (
						<LyricsTriplet prev={prevLyric} current={currentLyric} next={nextLyric} />
					)}
				</div>
			</div>

			{/* 歌词模式：同时渲染，通过CSS控制显示/隐藏 */}
			{/* 使用 currentPath 作为 key，歌曲切换时重新创建容器，滚动位置自动重置 */}
			<div 
				key={currentPath || "no-track"}
				className={`lyrics-list-wrapper ${viewMode === "lyrics" ? "visible" : "hidden"}`} 
				onClick={onSwitchViewMode}
			>
				{useExtendedLyrics ? (
					<LyricsExtendedFull
						fullLyrics={fullExtendedLyrics}
						currentTime={currentTime}
						activeIndex={activeIndex}
						playingIndex={effectivePlayingIndex}
						onToggleMode={onSwitchViewMode}
						onSeek={handleSeekToTime}
						scrollRef={scrollRef}
						lineRefs={lineRefs}
					/>
				) : (
					<LyricsFull
						fullLyrics={fullLyrics}
						activeIndex={activeIndex}
						playingIndex={effectivePlayingIndex}
						onToggleMode={onSwitchViewMode}
						onSeek={handleSeekToTime}
						scrollRef={scrollRef}
						lineRefs={lineRefs}
					/>
				)}
			</div>

			<TrackActions
				currentPath={currentPath}
				sectionId={sectionId}
				isFavorite={isFavorite}
				volume={volume}
				playbackRate={playbackRate}
				onAddToPlaylist={onAddToPlaylist}
				onToggleFavorite={onToggleFavorite}
				onVolumeChange={onVolumeChange}
				onPlaybackRateChange={onPlaybackRateChange}
			/>
			<ProgressBar
				current={currentTime}
				duration={duration}
				onSeek={onSeek}
				onSeekBackward={onSeekBackward}
				onSeekForward={onSeekForward}
			/>
			<PlaybackControls
				isPlaying={isPlaying}
				playMode={playMode}
				onTogglePlay={onTogglePlay}
				onPrev={onPrev}
				onNext={onNext}
				onToggleMode={onToggleMode}
				onOpenPlaylist={onOpenPlaylist}
			/>
		</div>
	);
}

