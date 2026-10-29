/**
 * 音乐播放器设置类型定义
 * 
 * 统一管理插件设置相关的类型定义，避免在多个文件中重复定义
 */

/**
 * 曲目信息接口
 * 存储单首曲目的元数据信息
 */
export interface TrackInfo {
	/** 曲目标题 */
	title: string;
	/** 艺术家 */
	artist: string;
	/** 专辑名称 */
	album: string;
	/** 歌词原文（与文件内 LYRICS 标签一致；可为逐句 LRC 或逐字卡拉 OK 文本，由解析器自动识别） */
	lyrics?: string;
	/** 发行年份 */
	year?: number;
	/** 流派 */
	genre?: string | string[];
	/** 音轨号 */
	track?: number;
	/** 时长（秒） */
	duration?: number;
}

/**
 * 音乐播放器设置接口
 * 存储插件的所有配置和用户数据
 *
 * 注意：播放状态（当前曲目、播放模式等）不持久化到设置中，仅在视图生命周期内以内存形式保存。
 * 但音量和播放速率会持久化，以便下次启动时恢复上次的偏好设置。
 * 
 * 使用 ID 系统：
 * - trackIndex: ID 到文件路径的映射（主表）
 * - tracks: ID 到曲目信息的映射
 * - favorites, playlists, artists, albums: 使用 ID 数组而不是路径数组
 * 这样文件重命名时只需更新 trackIndex，其他列表保持不变。
 */
export interface MusicPlayerSettings {
	/** 音乐文件夹路径（相对于仓库根目录，留空则扫描整个仓库） */
	musicFolder: string;
	/** ID 到文件路径的映射表（主表，文件重命名时只需更新此处） */
	trackIndex: Record<string, string>;
	/** 收藏的曲目 ID 列表 */
	favorites: string[];
	/** 曲目信息映射表，键为曲目 ID，值为曲目详细信息 */
	tracks: Record<string, TrackInfo>;
	/** 歌单映射表，键为歌单名称，值为曲目 ID 数组 */
	playlists: Record<string, string[]>;
	/** 艺术家映射表，键为艺术家名称，值为该艺术家的曲目 ID 数组 */
	artists: Record<string, string[]>;
	/** 专辑映射表，键为专辑名称，值为该专辑的曲目 ID 数组 */
	albums: Record<string, string[]>;
	/** 打开时自动播放，默认为 false */
	autoPlayOnOpen: boolean;
	/**
	 * 打开自动播放时要播的曲目在仓库中的路径（与 TFile.path 一致）。
	 * 留空表示「全部」列表按当前排序后的第一首。
	 */
	autoPlayOpenTrackPath: string;
	/** 持久化的音量值（0-1），下次启动时恢复 */
	volume: number;
	/** 持久化的播放速率（0.25-4.0），下次启动时恢复 */
	playbackRate: number;
}

/**
 * 默认设置值
 * 当用户首次使用插件或设置文件不存在时使用这些默认值
 */
export const DEFAULT_SETTINGS: MusicPlayerSettings = {
	musicFolder: '',           // 默认不限制文件夹，扫描整个仓库
	trackIndex: {},            // 默认没有 ID 映射
	favorites: [],            // 默认没有收藏
	tracks: {},                 // 默认没有曲目信息
	playlists: {},             // 默认没有歌单
	artists: {},                // 默认没有艺术家数据
	albums: {},                 // 默认没有专辑数据
	autoPlayOnOpen: false,      // 默认不自动播放
	autoPlayOpenTrackPath: '', // 默认：全部列表第一首
	volume: 1.0,               // 默认音量 100%
	playbackRate: 1.0,         // 默认正常速度
};

