/**
 * 已分析文本的类型定义
 * 用于存储图片分析结果的缓存/索引数据
 */
export type AnalyzedText = {
	/** 图片在 vault 中的路径 */
	path: string;
	/** AI 分析生成的关键词文本 */
	text: string;
	/** 生成此索引时使用的插件版本号 */
	libVersion: string;
};

/**
 * 索引文件的存储模式
 * - centralized: 集中式缓存，所有索引文件存储在插件配置目录下（原有模式）
 * - colocated: 同文件夹模式，索引文件存储在被索引图片的同一文件夹下
 */
export type IndexMode = "centralized" | "colocated";

/**
 * 搜索结果类型定义
 * 用于关键词搜索功能返回的结果
 */
export type SearchResult = {
	/** 被索引的图片文件在 vault 中的路径 */
	imagePath: string;
	/** AI 分析生成的关键词文本 */
	keywords: string;
	/** 索引文件在 vault 中的路径 */
	indexPath: string;
};
