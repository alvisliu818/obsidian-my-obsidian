/**
 * cache.ts - 缓存/索引管理模块
 *
 * 索引默认与图片同目录，文件名固定为 {图片名}_{扩展名}_index.json：
 *   例如 photos/beach.png → photos/beach_png_index.json
 *
 * 同目录命名规则的好处：
 * - 索引文件与图片在同一位置，便于管理和迁移
 * - 搜索可直接从索引文件名还原图片文件名（索引内容即图片内容）
 * - 移动文件夹时索引文件随图片一起移动
 *
 * 兼容旧版同目录命名 {图片名}.{扩展名}.ai-index.json（只读兼容）：
 * 读取时优先新命名，写回时自动改用新命名并清掉旧文件。
 */
import { createHash } from "crypto";
import { TFile } from "obsidian";
import { libVersion } from "./globals";
import { AnalyzedText, SearchResult } from "./types";
import { debugLog } from "./util";
import { settings } from "./settings";

const context = "cache";

/** 新索引文件名后缀：{图片名}_{扩展名}_index.json */
const INDEX_SUFFIX = "_index.json";
/** 早期版本的同目录索引后缀，仅用于兼容读取 */
const LEGACY_INDEX_SUFFIX = ".ai-index.json";
/** 索引文件对应的图片扩展名（与 util.isImageFile 保持一致） */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "svg"]);

/** getAllIndexEntries 的内存缓存，避免 Omnisearch 每次按键都重读全部索引文件 */
let entriesCache: { at: number; entries: SearchResult[] } | null = null;
const ENTRIES_CACHE_TTL_MS = 15_000;

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
 * 索引文件与图片在同一目录下，文件名格式为 {图片名}_{扩展名}_index.json
 * 例如：photos/beach.png → photos/beach_png_index.json
 * @param file - 需要索引的图片文件
 * @returns 索引文件的完整 vault 路径
 */
function getColocatedIndexPath(file: TFile): string {
	const folder = file.parent?.path;
	const prefix = folder && folder !== "/" ? `${folder}/` : "";
	return `${prefix}${file.basename}_${file.extension}${INDEX_SUFFIX}`;
}

/**
 * 旧版同目录索引路径：{图片路径}.ai-index.json
 * 仅用于读取历史索引，避免升级后重复调用 AI 分析。
 */
function getLegacyIndexPath(file: TFile): string {
	return `${file.path}${LEGACY_INDEX_SUFFIX}`;
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
 * 新命名：photos/beach_png_index.json → photos/beach.png
 * 旧命名：photos/beach.png.ai-index.json → photos/beach.png
 * @param indexPath - 索引文件的路径
 * @returns 被索引图片文件的路径
 */
export function getImagePathFromIndex(indexPath: string): string {
	const slash = indexPath.lastIndexOf("/");
	const dir = slash >= 0 ? indexPath.slice(0, slash + 1) : "";
	const name = slash >= 0 ? indexPath.slice(slash + 1) : indexPath;

	if (name.endsWith(LEGACY_INDEX_SUFFIX)) {
		return indexPath.slice(0, -LEGACY_INDEX_SUFFIX.length);
	}
	if (!name.endsWith(INDEX_SUFFIX)) {
		return indexPath;
	}

	const stem = name.slice(0, -INDEX_SUFFIX.length);
	const separator = stem.lastIndexOf("_");
	if (separator <= 0 || separator === stem.length - 1) {
		return indexPath;
	}
	return `${dir}${stem.slice(0, separator)}.${stem.slice(separator + 1)}`;
}

/**
 * 判断索引文件路径是否匹配图片 AI 索引命名
 * 同时识别新命名 {name}_{ext}_index.json 与旧命名 *.ai-index.json
 * @param filePath - 待检查的文件路径
 * @returns 是否为图片索引文件
 */
export function isIndexFile(filePath: string): boolean {
	const name = filePath.split("/").pop() ?? filePath;
	if (name.endsWith(LEGACY_INDEX_SUFFIX)) {
		return true;
	}
	if (!name.endsWith(INDEX_SUFFIX)) {
		return false;
	}

	const stem = name.slice(0, -INDEX_SUFFIX.length);
	const separator = stem.lastIndexOf("_");
	if (separator <= 0 || separator === stem.length - 1) {
		return false;
	}
	return IMAGE_EXTENSIONS.has(
		stem.slice(separator + 1).toLowerCase(),
	);
}

/** 判断某个索引文件是否使用旧版命名 */
function isLegacyIndexPath(filePath: string): boolean {
	const name = filePath.split("/").pop() ?? filePath;
	return name.endsWith(LEGACY_INDEX_SUFFIX);
}

/**
 * 查找某个图片实际存在的索引文件路径
 * 优先新命名，其次旧命名；都不存在时返回 null
 */
async function findExistingCachePath(file: TFile): Promise<string | null> {
	const candidates = [getCachePath(file)];
	if (settings.indexMode === "colocated") {
		candidates.push(getLegacyIndexPath(file));
	}

	for (const path of candidates) {
		// @ts-ignore - 使用全局 app 引用
		if (await app.vault.adapter.exists(path)) {
			return path;
		}
	}
	return null;
}

/**
 * 检查某个图片文件是否已有缓存/索引
 * @param file - 需要检查的图片文件
 * @returns 是否存在缓存/索引
 */
export async function isInCache(file: TFile): Promise<boolean> {
	return (await findExistingCachePath(file)) !== null;
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

	if (settings.indexMode !== "colocated") {
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

	// 写回新命名后清掉旧命名，避免同一图片出现两份索引
	if (settings.indexMode === "colocated") {
		const legacyPath = getLegacyIndexPath(file);
		// @ts-ignore
		if (await app.vault.adapter.exists(legacyPath)) {
			// @ts-ignore
			await app.vault.adapter.remove(legacyPath);
		}
	}

	invalidateIndexEntriesCache();
}

/**
 * 从缓存/索引文件中读取图片分析结果
 * 如果缓存为空或读取失败，会自动清除无效缓存并返回 null
 * @param file - 需要读取缓存的图片文件
 * @returns 分析结果，如果不存在或无效则返回 null
 */
export async function readCache(file: TFile): Promise<AnalyzedText | null> {
	try {
		const path = await findExistingCachePath(file);
		if (path) {
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
 * 删除某个图片文件的缓存/索引（新旧命名一起删）
 * @param file - 需要删除缓存的图片文件
 */
export async function removeFromCache(file: TFile): Promise<void> {
	const paths = [getCachePath(file)];
	if (settings.indexMode === "colocated") {
		paths.push(getLegacyIndexPath(file));
	}
	for (const path of paths) {
		// @ts-ignore
		if (await app.vault.adapter.exists(path)) {
			debugLog(context, `Removing cache entry for ${file.path}`);
			// @ts-ignore
			await app.vault.adapter.remove(path);
		}
	}
	invalidateIndexEntriesCache();
}

/**
 * 清除所有缓存/索引
 * - 集中式模式：直接删除缓存根目录
 * - 同文件夹模式：遍历 vault 查找并删除所有索引文件
 */
export async function clearCache(): Promise<void> {
	return;
	if (settings.indexMode === "colocated") {
		// 同文件夹模式：查找并删除所有索引文件（含旧命名）
		// @ts-ignore
		const files = app.vault.getFiles() as TFile[];
		const indexFiles = files.filter((f) => isIndexFile(f.path));
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
	invalidateIndexEntriesCache();
}

/**
 * 把旧命名索引（*.ai-index.json）一次性迁移到新命名
 * {图片名}_{扩展名}_index.json。内容不变；已有新命名文件时删除旧文件。
 * 幂等：迁移完成后再次调用只会做一次空扫描。
 */
export async function migrateLegacyIndexFiles(): Promise<void> {
	if (settings.indexMode !== "colocated") {
		return;
	}

	// @ts-ignore
	const files = app.vault.getFiles() as TFile[];
	const legacyFiles = files.filter((f) =>
		f.path.endsWith(LEGACY_INDEX_SUFFIX),
	);
	if (legacyFiles.length === 0) {
		return;
	}

	let migrated = 0;
	for (const indexFile of legacyFiles) {
		const slash = indexFile.path.lastIndexOf("/");
		const dir = slash >= 0 ? indexFile.path.slice(0, slash + 1) : "";
		const legacyName = indexFile.path.slice(slash + 1);
		const imageName = legacyName.slice(0, -LEGACY_INDEX_SUFFIX.length);
		const dot = imageName.lastIndexOf(".");
		if (dot <= 0 || dot === imageName.length - 1) {
			continue;
		}

		const base = imageName.slice(0, dot);
		const ext = imageName.slice(dot + 1);
		if (!IMAGE_EXTENSIONS.has(ext.toLowerCase())) {
			continue;
		}

		const newPath = `${dir}${base}_${ext}${INDEX_SUFFIX}`;
		try {
			// @ts-ignore
			if (await app.vault.adapter.exists(newPath)) {
				// @ts-ignore
				await app.vault.adapter.remove(indexFile.path);
			} else {
				// @ts-ignore
				await app.vault.adapter.rename(indexFile.path, newPath);
			}
			migrated++;
		} catch (e) {
			debugLog(context, `Failed to migrate index file: ${indexFile.path}`);
			console.error(e);
		}
	}

	if (migrated > 0) {
		debugLog(context, `Migrated ${migrated} legacy index files`);
		invalidateIndexEntriesCache();
	}
}

/**
 * 清空 getAllIndexEntries 的内存缓存
 * 索引文件写入/删除，或 vault 中索引文件发生变化时调用
 */
export function invalidateIndexEntriesCache(): void {
	entriesCache = null;
}

/**
 * 验证索引文件推导出的路径确实是库内图片；否则回退到索引 JSON 里记录的 path
 * @param derived - 由索引文件名还原的图片路径
 * @param stored - 索引 JSON 中保存的图片路径
 * @returns 可用的图片路径，找不到时返回 null
 */
function resolveImagePath(
	derived: string,
	stored: string | undefined,
): string | null {
	for (const candidate of [derived, stored]) {
		if (!candidate) continue;
		// @ts-ignore - 使用全局 app 引用
		const file = app.vault.getAbstractFileByPath(candidate);
		if (
			file instanceof TFile &&
			IMAGE_EXTENSIONS.has(file.extension.toLowerCase())
		) {
			return candidate;
		}
	}
	return null;
}

/**
 * 获取所有索引文件的搜索结果列表
 * 遍历 vault 中所有图片索引文件，读取其内容并映射回图片路径。
 * 新命名优先于旧命名；同一图片只保留一条结果。
 * @returns 所有索引文件的搜索结果数组
 */
export async function getAllIndexEntries(): Promise<SearchResult[]> {
	const now = Date.now();
	if (entriesCache && now - entriesCache.at < ENTRIES_CACHE_TTL_MS) {
		return entriesCache.entries;
	}

	const results: SearchResult[] = [];
	const seenImages = new Set<string>();

	// @ts-ignore
	const files = app.vault.getFiles() as TFile[];
	const indexFiles = files
		.filter((f) => isIndexFile(f.path))
		.sort(
			(a, b) =>
				Number(isLegacyIndexPath(a.path)) -
				Number(isLegacyIndexPath(b.path)),
		);

	for (const indexFile of indexFiles) {
		try {
			// @ts-ignore
			const raw = await app.vault.adapter.read(indexFile.path);
			const data = JSON.parse(raw) as AnalyzedText;

			if (data.text && data.text.length > 0) {
				// 优先使用索引文件名还原图片路径（同目录模式的核心逻辑）
				const derived = getImagePathFromIndex(indexFile.path);
				const imagePath = resolveImagePath(derived, data.path);
				if (!imagePath || seenImages.has(imagePath)) {
					continue;
				}
				seenImages.add(imagePath);
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
	entriesCache = { at: Date.now(), entries: results };
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
