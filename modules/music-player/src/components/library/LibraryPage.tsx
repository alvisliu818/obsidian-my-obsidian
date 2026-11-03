/**
 * 音乐库页面组件
 * 
 * 提供音乐库的完整管理界面，包括：
 * - 标签页切换（收藏、全部、歌单、艺术家、专辑）
 * - 歌曲列表显示（支持封面、标题、艺术家、专辑信息）
 * - 歌曲操作（播放、收藏、添加到歌单、从歌单移除）
 * - 歌单管理（创建、编辑、删除）
 * - 分类播放（按艺术家、专辑、歌单播放）
 * - 当前播放歌曲高亮显示
 */

import React from "react";
import { App, setIcon, TFile } from "obsidian";
import type { ReactLibrarySnapshot, ReactTrackInfo } from "@/types";
import { PlayingIndicator } from "@/components/player/PlayingIndicator";
import { IconButton } from "@/components/shared/IconButton";
import { LibraryTabs, type TabId } from "@/components/library/LibraryTabs";
import { TrackList } from "@/components/library/TrackList";
import "./LibraryPage.css";
import { t } from "@/utils/i18n/i18n";

/**
 * 音乐库页面组件的属性接口
 */
export interface LibraryPageProps {
	/** 音乐库快照数据，包含所有歌曲、收藏、歌单、艺术家、专辑信息 */
	library: ReactLibrarySnapshot;
	/** 当前正在播放的歌曲路径（用于高亮显示） */
	activePath: string | null;
	/** 播放歌曲的回调函数 */
	onPlay: (path: string, sectionId?: string) => void;
	/** 双击歌曲的回调函数（播放并切换到唱片页面） */
	onDoubleClick?: (path: string, sectionId?: string) => void;
	/** 切换收藏状态的回调函数 */
	onToggleFavorite: (path: string, sectionId?: string) => void;
	/** 添加到歌单的回调函数 */
	onAddToPlaylist: (path: string, sectionId?: string) => void;
	/** 从歌单移除的回调函数 */
	onRemoveFromPlaylist: (path: string, playlistName: string) => void;
	/** 创建歌单的回调函数 */
	onCreatePlaylist: () => void;
	/** 播放分类（艺术家、专辑、歌单）的回调函数 */
	onPlayCategory: (categoryType: string, categoryName: string, tracks: ReactTrackInfo[]) => void;
	/** 编辑歌单名称的回调函数（可选） */
	onEditPlaylist?: (playlistName: string) => Promise<void>;
	/** 删除歌单的回调函数（可选） */
	onDeletePlaylist?: (playlistName: string) => Promise<void>;
	/** 当前播放列表标识（用于高亮显示当前列表中的歌曲） */
	currentList?: string;
	/** 异步获取歌曲封面的函数（优先文件夹中的 cover 文件，其次内嵌封面） */
	getTrackCover?: (file: TFile) => Promise<string | undefined>;
	/** Obsidian App 实例（用于从路径获取文件） */
	app?: App;
}

/**
 * 添加歌单按钮组件（内部使用）
 * 
 * 显示一个加号图标按钮，用于创建新歌单
 * 
 * @param props 按钮属性
 */
function AddPlaylistButton({ onClick }: { onClick: () => void }) {
	const iconRef = React.useRef<HTMLDivElement>(null);

	React.useEffect(() => {
		if (iconRef.current) {
			setIcon(iconRef.current, "plus");
		}
	}, []);

	return (
		<div className="add-playlist-btn">
			<div
				ref={iconRef}
				className="add-playlist-icon clickable-icon"
				aria-label={t("library.newPlaylist")}
				onClick={onClick}
			/>
		</div>
	);
}

/**
 * 音乐库页面组件
 * 
 * 提供完整的音乐库管理界面，包括标签页切换、歌曲列表显示、歌曲操作等功能。
 * 
 * @param props 页面属性
 */
export function LibraryPage(props: LibraryPageProps) {
	const { library, activePath, currentList } = props;
	const [activeTab, setActiveTab] = React.useState<TabId>("all");
	const [collapsedSections, setCollapsedSections] = React.useState<Record<string, boolean>>({});

	const toggleSection = (key: string) => {
		setCollapsedSections((prev) => {
			const current = prev[key] ?? true;
			return {
				...prev,
				[key]: !current,
			};
		});
	};

	const renderPlaylists = (list: Array<{ name: string; tracks: ReactTrackInfo[] }>, type: "playlists" | "artists" | "albums") => {
		const categoryType = type === "playlists" ? "playlist" : type.slice(0, -1);
		
		// 辅助函数：判断 sectionId 是否匹配 currentList
		const isSectionMatched = (sectionId: string): boolean => {
			if (!currentList || !activePath) return false;
			
			if (currentList === "all" && sectionId === "all") return true;
			if (currentList === "favorites" && sectionId === "favorites") return true;
			
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
		};

		return (
			<div className="section-list">
				{!list.length ? (
					type === "playlists" ? (
						<div className="empty">{t("library.empty.noPlaylists")}</div>
					) : (
						<div className="empty">{t("library.empty.noData")}</div>
					)
				) : null}
				{list.map((item) => {
					const key = `${categoryType}:${item.name}`;
					const isCollapsed = collapsedSections[key] ?? true;
					// 判断当前分类是否匹配 currentList
					const sectionId = `${categoryType}-${item.name}`;
					const matched = isSectionMatched(sectionId);

					return (
						<div key={item.name} className="section">
							<div
								className={`section-header ${matched ? "is-active" : ""}`}
								onClick={() => toggleSection(key)}
							>
								<div className="section-header-left">
									<IconButton
										icon={isCollapsed ? "chevron-right" : "chevron-down"}
										label={isCollapsed ? t("library.expand") : t("library.collapse")}
										className="section-action-btn clickable-icon"
										onClick={(e) => {
											e.stopPropagation();
											toggleSection(key);
										}}
									/>
									{matched ? (
										<div className="section-playing-indicator">
											<PlayingIndicator />
										</div>
									) : null}
									<div className={`section-title ${matched ? "is-active" : ""}`}>
										<span>{item.name}</span>
										<span className="section-count">（{item.tracks.length}）</span>
									</div>
								</div>
								<div
									className="section-actions"
									onClick={(e) => e.stopPropagation()}
								>
									<IconButton
										icon="play-circle"
										label={t("library.playCategory")}
										className="section-action-btn clickable-icon"
										onClick={() =>
											props.onPlayCategory(categoryType, item.name, item.tracks)
										}
									/>
									{type === "playlists" && props.onEditPlaylist ? (
										<IconButton
											icon="pencil"
											label={t("library.renamePlaylist")}
											className="section-action-btn clickable-icon"
											onClick={() => {
												void props.onEditPlaylist?.(item.name);
											}}
										/>
									) : null}
									{type === "playlists" && props.onDeletePlaylist ? (
										<IconButton
											icon="trash-2"
											label={t("library.deletePlaylist")}
											className="section-action-btn clickable-icon"
											onClick={() => {
												void props.onDeletePlaylist?.(item.name);
											}}
										/>
									) : null}
								</div>
							</div>
							{!isCollapsed ? (
								item.tracks.length > 0 ? (
									<TrackList
										tracks={item.tracks}
										activePath={activePath}
										sectionId={`${categoryType}-${item.name}`}
										currentList={currentList}
										onPlay={props.onPlay}
										onDoubleClick={props.onDoubleClick}
										onToggleFavorite={props.onToggleFavorite}
										onAddToPlaylist={props.onAddToPlaylist}
										onRemoveFromPlaylist={props.onRemoveFromPlaylist}
										playlistName={type === "playlists" ? item.name : undefined}
										library={library}
										getTrackCover={props.getTrackCover}
										app={props.app}
									/>
								) : (
									<div className="empty">{t("library.empty.noTracks")}</div>
								)
							) : null}
						</div>
					);
				})}

				{type === "playlists" ? <AddPlaylistButton onClick={props.onCreatePlaylist} /> : null}
			</div>
		);
	};

	return (
		<div className="tracklist">
			<LibraryTabs
				activeTab={activeTab}
				onChangeTab={setActiveTab}
				currentList={currentList}
				activePath={activePath}
			/>

			<div className="tab-body">
				{activeTab === "favorites" ? (
					library.favorites.length > 0 ? (
						<TrackList
							tracks={library.favorites}
							activePath={activePath}
							sectionId="favorites"
							currentList={currentList}
							onPlay={props.onPlay}
							onDoubleClick={props.onDoubleClick}
							onToggleFavorite={props.onToggleFavorite}
							onAddToPlaylist={props.onAddToPlaylist}
							onRemoveFromPlaylist={props.onRemoveFromPlaylist}
							library={library}
							getTrackCover={props.getTrackCover}
							app={props.app}
						/>
					) : (
						<div className="empty">{t("library.empty.noTracks")}</div>
					)
				) : null}

				{activeTab === "all" ? (
					<TrackList
						tracks={library.allTracks}
						activePath={activePath}
						sectionId="all"
						currentList={currentList}
						onPlay={props.onPlay}
						onDoubleClick={props.onDoubleClick}
						onToggleFavorite={props.onToggleFavorite}
						onAddToPlaylist={props.onAddToPlaylist}
						onRemoveFromPlaylist={props.onRemoveFromPlaylist}
						library={library}
						getTrackCover={props.getTrackCover}
						app={props.app}
					/>
				) : null}

				{activeTab === "playlists" ? renderPlaylists(library.playlists, "playlists") : null}
				{activeTab === "artists" ? renderPlaylists(library.artists, "artists") : null}
				{activeTab === "albums" ? renderPlaylists(library.albums, "albums") : null}
			</div>
		</div>
	);
}
