/**
 * 社区插件市场增强（plugin-market）——数据形状。
 *
 * 评价/标签绑定到**社区插件 id**（official community-plugins.json 里的 id，
 * 与已安装插件的 manifest.id 同一空间），存在模块自己的数据片里；
 * id 反查靠目录缓存（community-catalog.json，与 data.json 分文件防膨胀）。
 */

/** 单个插件的评价 + 标签。 */
export interface PluginReview {
	/** 1-5 星；缺省 = 未评分 */
	rating?: number;
	/** 标签（小写保序去重在写入侧做，UI 不改大小写） */
	tags?: string[];
	updatedAt?: number;
}

/** 模块数据片（宿主 data.json 的 modules['plugin-market'].data）。 */
export interface MarketData {
	reviews: Record<string, PluginReview>;
	/** 当前的标签筛选；undefined = 不过滤 */
	activeTag?: string;
}

/** 目录缓存里的一条（community-plugins.json 的子集 + 便于匹配的小写字段）。 */
export interface CatalogEntry {
	id: string;
	name: string;
	author: string;
	description?: string;
	/** "owner/repo"（GitHub），小写 */
	repo: string;
}

/** 目录缓存文件落盘格式。v2 = repo 为裸 owner/repo（v1 有剥空 bug）。 */
export interface CatalogFile {
	v: 2;
	fetchedAt: number;
	plugins: CatalogEntry[];
}

export const DEFAULT_MARKET_DATA: MarketData = { reviews: {} };

/** 目录缓存刷新周期：7 天。 */
export const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 官方社区目录（id/repo/name/author 的权威来源）。 */
export const CATALOG_URL =
	'https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json';
