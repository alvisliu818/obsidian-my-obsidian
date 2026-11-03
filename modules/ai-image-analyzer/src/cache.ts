/**
 * cache.ts - 缓存/索引管理模块
 *
 * 支持两种索引存储模式：
 * 1. centralized（集中式）：所有索引文件存储在插件配置目录下，使用 MD5 哈希作为文件名（原有模式）
 * 2. colocated（同文件夹）：索引文件存储在被索引图片的同一文件夹下，文件名格式为 {图片名}.ai-index.json
 *
 * 同文件夹模式的优势：
 * - 索引文件与图片在同一位置，便于管理和迁移
 * - 搜索功能可根据索引文件位置直接确定图片位置
 * - 移动文件夹时索引文件随图片一起移动
 */
import { createHash } from "crypto";
import { TFile } from "obsidian";
import { libVersion } from "./globals";
import { AnalyzedText, SearchResult } from "./types";
import { debugLog } from "./util";
import { settings } from "./settings";

const context = "cache";

/** 索引文件的默认后缀名，用于同文件夹模式 */
const DEFAULT_INDEX_SUFFIX = ".ai-index.json";

/**
 * 获取集中式缓存的根目录路径
 * 路径格式：.obsidian/plugins/ai-image-analyzer/cache
 */
export function getCacheBasePath(): string {
	// @ts-ignore - 使用全局 app 引用，以便在外部模块中使用
	return `${app.vault.configDir}/plugins/ai-image-analyzer/cache`;
}

/**
 * 获取集中式缓存模式下某个文件的缓存路径
 * 使用文件路径的 MD5 哈希作为文件名，避免路径中的特殊字符问题
 * @param file - 需要缓存/索引的图片文件
 * @returns 缓存文件的完整路径
 */
function getCentralizedCachePath(file: TFile): string {
	const hash = createHash("md5").update(file.path).digest("hex");
	const folder = `${getCacheBasePath()}`;
	const filename = `${hash}.json`;
	return `${folder}/${filename}`;
}

/**
 * 获取同文件夹模式下某个图片文件的索引文件路径
 * 索引文件与图片在同一目录下，文件名格式为 {图片文件名}.ai-index.json
 * 例如：photos/beach.png → photos/beach.png.ai-index.json
 * @param file - 需要索引的图片文件
 * @returns 索引文件的完整 vault 路径
 */
function getColocatedIndexPath(file: TFile): string {
	const suffix = settings.indexFileSuffix || DEFAULT_INDEX_SUFFIX;
	return `${file.path}${suffix}`;
}

/**
 * 根据当前设置的模式，获取缓存/索引文件路径
 * 自动根据 settings.indexMode 选择集中式或同文件夹模式
 * @param file - 需要缓存/索引的图片文件
 * @returns 缓存/索引文件的路径
 */
function getCachePath(file: TFile): string {
	if (settings.indexMode === "colocated") {
		return getColocatedIndexPath(file);
	}
	return getCentralizedCachePath(file);
}

/**
 * 根据索引文件路径推导出被索引的图片文件路径
 * 通过移除索引文件后缀名来还原图片路径
 * 例如：photos/beach.png.ai-index.json → photos/beach.png
 * @param indexPath - 索引文件的路径
 * @returns 被索引图片文件的路径
 */
export function getImagePathFromIndex(indexPath: string): string {
	const suffix = settings.indexFileSuffix || DEFAULT_INDEX_SUFFIX;
	if (indexPath.endsWith(suffix)) {
		return indexPath.slice(0, -suffix.length);
	}
	return indexPath;
}

/**
 * 判断索引文件路径是否匹配当前配置的索引后缀名
 * @param filePath - 待检查的文件路径
 * @returns 是否为索引文件
 */
export function isIndexFile(filePath: string): boolean {
	const suffix = settings.indexFileSuffix || DEFAULT_INDEX_SUFFIX;
	return filePath.endsWith(suffix);
}

/**
 * 检查某个图片文件是否已有缓存/索引
 * @param file - 需要检查的图片文件
 * @returns 是否存在缓存/索引
 */
export async function isInCache(file: TFile): Promise<boolean> {
	const path = getCachePath(file);
	// @ts-ignore - 使用全局 app 引用
	return await app.vault.adapter.exists(path);
}

/**
 * 将图片分析结果写入缓存/索引文件
 * 如果分析结果为空则不写入
 * @param file - 被分析的图片文件
 * @param text - AI 生成的关键词文本
 */
export async function writeCache(file: TFile, text: string): Promise<void> {
	if (text.length === 0) {
		return;
	}

	const path = getCachePath(file);

	if (settings.indexMode === "colocated") {
		// 同文件夹模式：确保索引文件所在的目录存在（通常已存在，因为图片已在其中）
		const folder = file.parent?.path;
		if (folder && folder !== "/") {
			// @ts-ignore
			if (!(await app.vault.adapter.exists(folder))) {
				// @ts-ignore
				await app.vault.adapter.mkdir(folder);
			}
		}
	} else {
		// 集中式模式：确保缓存根目录存在
		// @ts-ignore
		if (!(await app.vault.adapter.exists(getCacheBasePath()))) {
			// @ts-ignore
			await app.vault.adapter.mkdir(getCacheBasePath());
		}
	}

	const data: AnalyzedText = {
		path: file.path,
		text,
		libVersion: libVersion,
	};

	debugLog(context, `Writing cache entry for ${file.path}`);
	// @ts-ignore
	await app.vault.adapter.write(path, JSON.stringify(data));
}

/**
 * 从缓存/索引文件中读取图片分析结果
 * 如果缓存为空或读取失败，会自动清除无效缓存并返回 null
 * @param file - 需要读取缓存的图片文件
 * @returns 分析结果，如果不存在或无效则返回 null
 */
export async function readCache(file: TFile): Promise<AnalyzedText | null> {
	try {
		if (await isInCache(file)) {
			const path = getCachePath(file);
			// @ts-ignore
			const raw = await app.vault.adapter.read(path);
			const text = JSON.parse(raw) as AnalyzedText;
			if (text.text.length === 0) {
				debugLog(context, "Cache entry is empty, removing");
				await removeFromCache(file);
				return null;
			}
			debugLog(context, `Read cache entry for ${file.path}`);
			return text;
		}
	} catch (e) {
		console.error(e);
	}

	return null;
}

/**
 * 删除某个图片文件的缓存/索引
 * @param file - 需要删除缓存的图片文件
 */
export async function removeFromCache(file: TFile): Promise<void> {
	const path = getCachePath(file);
	if (await isInCache(file)) {
		debugLog(context, `Removing cache entry for ${file.path}`);
		// @ts-ignore
		return await app.vault.adapter.remove(path);
	}
}

/**
 * 清除所有缓存/索引
 * - 集中式模式：直接删除缓存根目录
 * - 同文件夹模式：遍历 vault 查找并删除所有索引文件
 */
export async function clearCache(): Promise<void> {
	return;
	if (settings.indexMode === "colocated") {
		// 同文件夹模式：查找并删除所有索引文件
		const suffix = settings.indexFileSuffix || DEFAULT_INDEX_SUFFIX;
		// @ts-ignore
		const files = app.vault.getFiles() as TFile[];
		const indexFiles = files.filter((f) => f.path.endsWith(suffix));
		for (const indexFile of indexFiles) {
			debugLog(context, `Removing index file: ${indexFile.path}`);
			// @ts-ignore
			await app.vault.adapter.remove(indexFile.path);
		}
		debugLog(context, `Cleared ${indexFiles.length} index files`);
	} else {
		// 集中式模式：删除缓存根目录
		const path = getCacheBasePath();
		// @ts-ignore
		if (await app.vault.adapter.exists(path)) {
			debugLog(context, `Clearing cache`);
			// @ts-ignore
			return await app.vault.adapter.rmdir(path, true);
		}
	}
}

/**
 * 获取所有索引文件的搜索结果列表
 * 遍历 vault 中所有索引文件，读取其内容并构建搜索结果
 * 此函数用于搜索功能的初始化，预加载所有索引数据
 * @returns 所有索引文件的搜索结果数组
 */
export async function getAllIndexEntries(): Promise<SearchResult[]> {
	const results: SearchResult[] = [];
	const suffix = settings.indexFileSuffix || DEFAULT_INDEX_SUFFIX;

	// @ts-ignore
	const files = app.vault.getFiles() as TFile[];
	const indexFiles = files.filter((f) => f.path.endsWith(suffix));

	for (const indexFile of indexFiles) {
		try {
			// @ts-ignore
			const raw = await app.vault.adapter.read(indexFile.path);
			const data = JSON.parse(raw) as AnalyzedText;

			if (data.text && data.text.length > 0) {
				// 优先使用索引文件路径推导图片路径（同文件夹模式的核心逻辑）
				const imagePath = getImagePathFromIndex(indexFile.path);
				results.push({
					imagePath,
					keywords: data.text,
					indexPath: indexFile.path,
				});
			}
		} catch (e) {
			debugLog(context, `Failed to read index file: ${indexFile.path}`);
			console.error(e);
		}
	}

	debugLog(context, `Loaded ${results.length} index entries`);
	return results;
}

/**
 * 根据关键词搜索索引文件
 * 在所有索引文件中搜索包含指定关键词的条目
 * 搜索不区分大小写，支持多关键词（空格分隔，任一匹配即可）
 * @param query - 搜索关键词，支持空格分隔的多个关键词
 * @returns 匹配的搜索结果数组
 */
export async function searchIndexFiles(
	query: string,
): Promise<SearchResult[]> {
	if (!query || query.trim().length === 0) {
		return [];
	}

	const allEntries = await getAllIndexEntries();
	const keywords = query
		.toLowerCase()
		.split(/\s+/)
		.filter((k) => k.length > 0);

	return allEntries.filter((entry) => {
		const lowerKeywords = entry.keywords.toLowerCase();
		// 任一关键词匹配即返回该结果
		return keywords.some((keyword) => lowerKeywords.includes(keyword));
	});
}
