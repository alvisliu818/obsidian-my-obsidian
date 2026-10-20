/**
 * 音乐库相关类型定义
 * 
 * 定义音乐库数据的接口，用于在 React 组件中展示音乐库信息
 */

/**
 * 歌曲信息接口
 * 
 * 包含歌曲的基本信息，用于在 UI 中展示
 */
export interface ReactTrackInfo {
	/** 歌曲文件路径 */
	path: string;
	/** 歌曲标题 */
	title: string;
	/** 艺术家名称 */
	artist: string;
	/** 专辑名称（可选） */
	album?: string;
	/** 封面图片 URL（可选） */
	coverUrl?: string;
	/** 歌曲时长（秒，可选） */
	duration?: number;
}

/**
 * 音乐库快照接口
 * 
 * 用于 React 组件展示音乐库数据，包含所有分类的歌曲信息。
 * 这个快照由 SnapshotService 生成，通过 useLibraryState hook 提供给组件。
 */
export interface ReactLibrarySnapshot {
	/** 所有歌曲列表 */
	allTracks: ReactTrackInfo[];
	/** 收藏的歌曲列表 */
	favorites: ReactTrackInfo[];
	/** 播放列表数组，每个播放列表包含名称和歌曲列表 */
	playlists: Array<{ name: string; tracks: ReactTrackInfo[] }>;
	/** 艺术家分类数组，每个艺术家包含名称和歌曲列表 */
	artists: Array<{ name: string; tracks: ReactTrackInfo[] }>;
	/** 专辑分类数组，每个专辑包含名称和歌曲列表 */
	albums: Array<{ name: string; tracks: ReactTrackInfo[] }>;
	/** 当前播放歌曲的文件路径 */
	currentPath: string | null;
	/** 当前列表标识符（如 "all", "favorites", "playlist:xxx"） */
	currentList: string | undefined;
}

