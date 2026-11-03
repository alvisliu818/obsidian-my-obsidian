/**
 * 封面查找工具模块
 * 
 * 提供查找歌曲封面的功能，按以下优先级查找：
 * 1. 同目录下名为 "cover" 的图片文件（cover.jpg, cover.png 等）
 * 2. 同目录下与歌曲同名的图片文件（例如 song.mp3 -> song.jpg）
 * 3. 从音频文件的元数据中提取内嵌封面
 */

import { App, TFile } from "obsidian";
import { getEmbeddedCoverFromFile } from "@/utils/audio/metadata";
import { IMAGE_EXTENSIONS } from "@/constants/audio";

/**
 * 将图片文件转换为可用于 <img src="..."> 的 URL
 *
 * - 优先使用 Obsidian 提供的资源 URL（更省内存、更快，尤其在移动端）
 * - 如果无法生成资源 URL，再回退为 base64 Data URL
 * 
 * @param app Obsidian 应用实例
 * @param file 图片文件
 * @returns 图片 URL，如果读取失败则返回 undefined
 */
async function imageFileToUrl(app: App, file: TFile): Promise<string | undefined> {
	try {
		// Obsidian 资源路径（推荐）；失败时回退为 base64
		try {
			const resourcePath = app.vault.getResourcePath(file);
			if (resourcePath) return resourcePath;
		} catch {
			// 忽略，走 readBinary 兜底
		}

		const binary = await app.vault.readBinary(file);
		const base64 = Buffer.from(binary).toString("base64");
		const ext = file.extension?.toLowerCase() || "";
		const mimeTypes: Record<string, string> = {
			"jpg": "image/jpeg",
			"jpeg": "image/jpeg",
			"png": "image/png",
			"gif": "image/gif",
			"webp": "image/webp",
			"bmp": "image/bmp",
		};
		const mimeType = mimeTypes[ext] || "image/jpeg";
		return `data:${mimeType};base64,${base64}`;
	} catch (error) {
		console.error(`读取图片文件失败 (${file.path}):`, error);
		return undefined;
	}
}

export interface GetTrackCoverOptions {
	/** 是否允许从音频元数据中提取内嵌封面（移动端列表建议关闭） */
	includeEmbedded?: boolean;
}

/**
 * 获取歌曲封面
 * 
 * 查找规则（按优先级）：
 * 1. 同目录下名为 "cover" 的图片文件（cover.jpg, cover.png, cover.jpeg 等，不区分大小写）
 * 2. 同目录下与歌曲同名的图片文件（例如 song.mp3 -> song.jpg, song.png 等）
 * 3. 从音频文件的元数据中提取内嵌封面
 * 
 * @param app Obsidian 应用实例
 * @param trackFile 曲目文件
 * @param options 可选参数
 * @returns 封面图片 URL（文件路径或 base64 Data URL），如果未找到则返回 undefined
 */
export async function getTrackCover(
	app: App,
	trackFile: TFile,
	options: GetTrackCoverOptions = {}
): Promise<string | undefined> {
	const { includeEmbedded = true } = options;
	// 获取歌曲文件所在的目录路径
	const trackDir = trackFile.parent?.path || "";
	const trackNameWithoutExt = trackFile.basename; // 不包含扩展名的文件名

	// 直接按候选文件名拼路径查找，避免每次都扫描 vault.getFiles()（移动端性能关键）
	const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

	// 优先级 1: cover.(jpg/png/...)
	for (const extWithDot of IMAGE_EXTENSIONS) {
		const ext = extWithDot.startsWith(".") ? extWithDot.slice(1) : extWithDot;
		const p = join(trackDir, `cover.${ext}`);
		const f = app.vault.getAbstractFileByPath(p);
		if (f && f instanceof TFile) {
			const url = await imageFileToUrl(app, f);
			if (url) return url;
		}
		// 兼容 Cover/ COVER 等大小写（Windows/Android 某些情况可能区分）
		const p2 = join(trackDir, `Cover.${ext}`);
		const f2 = app.vault.getAbstractFileByPath(p2);
		if (f2 && f2 instanceof TFile) {
			const url = await imageFileToUrl(app, f2);
			if (url) return url;
		}
	}

	// 优先级 2: songName.(jpg/png/...)
	for (const extWithDot of IMAGE_EXTENSIONS) {
		const ext = extWithDot.startsWith(".") ? extWithDot.slice(1) : extWithDot;
		const p = join(trackDir, `${trackNameWithoutExt}.${ext}`);
		const f = app.vault.getAbstractFileByPath(p);
		if (f && f instanceof TFile) {
			const url = await imageFileToUrl(app, f);
			if (url) return url;
		}
	}

	// 优先级 3: 内嵌封面（可选，移动端列表建议关闭）
	if (!includeEmbedded) return undefined;
	return await getEmbeddedCoverFromFile(app, trackFile);
}

