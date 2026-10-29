/**
 * 歌曲列表组件
 * 
 * 显示歌曲列表，支持：
 * - 封面图片显示（懒加载，只加载可见区域的封面）
 * - 歌曲信息显示（标题、艺术家、专辑）
 * - 当前播放歌曲高亮
 * - 歌曲操作（播放、收藏、添加到歌单、从歌单移除）
 */

import React from "react";
import { App, TFile } from "obsidian";
import type { ReactLibrarySnapshot, ReactTrackInfo } from "@/types";
import { PlayingIndicator } from "@/components/player/PlayingIndicator";
import { IconButton } from "@/components/shared/IconButton";
import { useLazyTrackCovers } from "@/hooks/useLazyTrackCovers";
import "./LibraryPage.css";
import { t } from "@/utils/i18n/i18n";

/**
 * TrackList 组件的属性接口
 */
export interface TrackListProps {
	/** 要显示的歌曲列表 */
	tracks: ReactTrackInfo[];
	/** 当前正在播放的歌曲路径 */
	activePath: string | null;
	/** 列表的 section ID（用于匹配 currentList） */
	sectionId: string;
	/** 当前播放列表标识 */
	currentList?: string;
	/** 播放歌曲的回调函数 */
	onPlay: (path: string, sectionId?: string) => void;
	/** 双击歌曲的回调函数（播放并切换到唱片页面） */
	onDoubleClick?: (path: string, sectionId?: string) => void;
	/** 切换收藏状态的回调函数 */
	onToggleFavorite: (path: string, sectionId?: string) => void;
	/** 添加到歌单的回调函数 */
	onAddToPlaylist: (path: string, sectionId?: string) => void;
	/** 从歌单移除的回调函数（可选） */
	onRemoveFromPlaylist?: (path: string, playlistName: string) => void;
	/** 歌单名称（用于从歌单移除功能） */
	playlistName?: string;
	/** 音乐库快照数据 */
	library: ReactLibrarySnapshot;
	/** 异步获取歌曲封面的函数（优先文件夹中的 cover 文件，其次内嵌封面） */
	getTrackCover?: (file: TFile) => Promise<string | undefined>;
	/** Obsidian App 实例（用于从路径获取文件） */
	app?: App;
}

/**
 * 歌曲列表组件
 * 
 * 显示歌曲列表，支持封面懒加载、播放控制、收藏和歌单操作。
 * 
 * @param props 组件属性
 */
export function TrackList({
	tracks,
	activePath,
	sectionId,
	currentList,
	onPlay,
	onDoubleClick,
	onToggleFavorite,
	onAddToPlaylist,
	onRemoveFromPlaylist,
	playlistName,
	library,
	getTrackCover,
	app,
}: TrackListProps) {
	// 使用封面懒加载 Hook
	const { embeddedCovers, trackRefs, stopLoading } = useLazyTrackCovers({
		tracks,
		app,
		getTrackCover,
	});

	// 单击/双击冲突处理：
	// React 的双击会先触发两次 click，再触发 dblclick。
	// 如果 click 里直接播放，会导致一次双击触发多次"切歌"，进而在异步播放链路下产生并发播放。
	// 方案：单击延迟触发；双击时取消尚未执行的单击播放。
	const clickTimerRef = React.useRef<number | null>(null);
	const lastClickPathRef = React.useRef<string | null>(null);

	// 处理双击：停止封面加载并交给上层执行"播放并切换页面"
	const handleDoubleClick = React.useCallback(
		(e: React.MouseEvent<HTMLDivElement>, path: string) => {
			e.stopPropagation();

			// 取消尚未触发的单击播放（避免双击导致重复播放）
			if (clickTimerRef.current) {
				window.clearTimeout(clickTimerRef.current);
				clickTimerRef.current = null;
				lastClickPathRef.current = null;
			}

			// 双击时会切换页面，库列表可以停止继续加载封面
			stopLoading();

			if (onDoubleClick) {
				void onDoubleClick(path, sectionId);
			}
		},
		[onDoubleClick, sectionId, stopLoading]
	);

	// 处理单击：仅播放当前歌曲，不切换页面
	const handleClick = React.useCallback(
		(e: React.MouseEvent<HTMLDivElement>, path: string) => {
			e.stopPropagation();

			// 如果存在上一次的定时器，先清理（避免快速点击不同歌曲导致多次触发）
			if (clickTimerRef.current) {
				window.clearTimeout(clickTimerRef.current);
			}

			lastClickPathRef.current = path;

			// 这里 220ms 是经验值：既能让双击可靠取消，又不至于让单击感觉明显迟滞
			clickTimerRef.current = window.setTimeout(() => {
				// 确保仍是同一个待播放目标
				if (lastClickPathRef.current === path) {
					onPlay(path, sectionId);
				}
				clickTimerRef.current = null;
				lastClickPathRef.current = null;
			}, 220);
		},
		[onPlay, sectionId]
	);

	// 组件卸载时清理定时器，避免泄漏
	React.useEffect(() => {
		return () => {
			if (clickTimerRef.current) {
				window.clearTimeout(clickTimerRef.current);
				clickTimerRef.current = null;
			}
		};
	}, []);

	if (!tracks.length) {
		return <div className="empty">{t("library.empty.noTracks")}</div>;
	}

	// 判断当前 sectionId 是否匹配 currentList
	// 只有当匹配时，才高亮当前歌曲
	const isSectionMatched = React.useMemo(() => {
		if (!currentList || !activePath) return false;
		
		// 处理 currentList 格式："all", "favorites", "playlist:名称", "artist:名称", "album:名称"
		// 处理 sectionId 格式："all", "favorites", "playlist-名称", "artist-名称", "album-名称"
		
		if (currentList === "all" && sectionId === "all") {
			return true;
		}
		
		if (currentList === "favorites" && sectionId === "favorites") {
			return true;
		}
		
		// 处理分类列表：playlist、artist、album
		if (currentList.startsWith("playlist:")) {
			const listName = currentList.replace("playlist:", "");
			return sectionId === `playlist-${listName}`;
		}
		
		if (currentList.startsWith("artist:")) {
			const listName = currentList.replace("artist:", "");
			return sectionId === `artist-${listName}`;
		}
		
		if (currentList.startsWith("album:")) {
			const listName = currentList.replace("album:", "");
			return sectionId === `album-${listName}`;
		}
		
		return false;
	}, [currentList, sectionId, activePath]);

	// 创建收藏路径集合，用于快速判断
	const favoritesSet = new Set(library.favorites.map((f: ReactTrackInfo) => f.path));

	return (
		<div className="track-list">
			{tracks.map((track) => {
				const isFavorite = favoritesSet.has(track.path);
				// 只有当 sectionId 匹配 currentList 时，才高亮当前歌曲
				const isActive = isSectionMatched && activePath === track.path;
				// 获取该 track 的 ref（应该在 useEffect 中已经初始化）
				let trackRef = trackRefs.get(track.path);
				if (!trackRef) {
					// 如果 ref 不存在，创建一个（这种情况理论上不应该发生）
					trackRef = React.createRef<HTMLDivElement>();
					trackRefs.set(track.path, trackRef);
				}
				
				// 获取封面 URL（优先使用已有的 coverUrl，其次使用加载的封面）
				const coverUrl = track.coverUrl || embeddedCovers.get(track.path);
				
				return (
					<div
						key={track.path}
						ref={trackRef}
						data-track-path={track.path}
						className={`track-item ${isActive ? "is-active" : ""}`}
						onClick={(e) => handleClick(e, track.path)}
						onDoubleClick={(e) => handleDoubleClick(e, track.path)}
					>
						<div className="track-item-container">
							<div className="track-main-wrapper">
								<div className="track-cover">
									{coverUrl ? (
										<img src={coverUrl} alt={track.title} />
									) : (
										<div className="track-cover-placeholder">{track.title?.[0] ?? "♪"}</div>
									)}
								</div>
								<div className="track-main">
									<div className="track-title">
										{isActive ? (
											<span className="track-playing-indicator">
												<PlayingIndicator />
											</span>
										) : null}
										{track.title}
									</div>
									<div className="track-sub">
										<span className="track-artist">{track.artist}</span>
										{track.album ? <span className="track-album"> · {track.album}</span> : null}
									</div>
								</div>
							</div>
							<div className="track-actions">
								<IconButton
									icon="list-plus"
									label={t("track.addToPlaylist")}
									className="track-action-btn clickable-icon"
									onClick={(e) => {
										e.stopPropagation();
										onAddToPlaylist(track.path, sectionId);
									}}
									onDoubleClick={(e) => {
										e.stopPropagation();
										e.preventDefault();
									}}
								/>
								<IconButton
									icon="heart"
									label={isFavorite ? t("track.removeFavorite") : t("track.addFavorite")}
									className={`track-action-btn clickable-icon ${isFavorite ? "active" : ""}`}
									onClick={(e) => {
										e.stopPropagation();
										onToggleFavorite(track.path, sectionId);
									}}
									onDoubleClick={(e) => {
										e.stopPropagation();
										e.preventDefault();
									}}
								/>
								{playlistName ? (
									<IconButton
										icon="trash-2"
										label={t("track.removeFromPlaylist")}
										className="track-action-btn clickable-icon"
										onClick={(e) => {
											e.stopPropagation();
											onRemoveFromPlaylist?.(track.path, playlistName);
										}}
										onDoubleClick={(e) => {
											e.stopPropagation();
											e.preventDefault();
										}}
									/>
								) : null}
							</div>
						</div>
					</div>
				);
			})}
		</div>
	);
}

