/**
 * 音频元数据提取模块
 * 
 * 从音频文件的二进制数据中提取嵌入的元数据信息，包括：
 * - 封面图片
 * - 歌词文本（优先原生标签中带时间戳的可同步歌词，否则回退 common.lyrics）
 * - 歌曲基本信息（标题、艺术家、专辑等）
 * - 音轨号和时长等
 * 
 * 注意：歌词从音频内嵌标签读取；优先使用库解析后的 common.lyrics，与最初实现一致。
 * 同一 ID 的多个帧（标签工具拆分超长文本所致）会被合并，避免只读到第一帧。
 */

// 为移动端提供 Buffer polyfill
// music-metadata-browser 库内部使用了 Buffer，需要在全局作用域中提供
import { initBufferPolyfill } from "../polyfills/buffer";
initBufferPolyfill();

import { App, TFile } from "obsidian";
import { IAudioMetadata, parseBuffer } from "music-metadata";
import { isSupportedAudioExtension } from "@/constants/audio";

/**
 * 同一 (格式, 标签ID) 下收集到的多个歌词值。
 */
interface LyricsTagGroup {
	/** 标签格式（如 ID3v2.3、vorbis） */
	format: string;
	/** 标签 ID（大写，如 TXXX:LYRICS） */
	id: string;
	/** 按文件顺序排列的值 */
	chunks: string[];
}

/**
 * 片段是否以新文档/新行开头（LRC 元数据标签或行时间标签）。
 * 用于区分「被拆分的同一份歌词」与「独立写入的多个标签」。
 */
const LRC_DOC_START =
	/^[\s\ufeff]*\[(?:(?:ar|ti|al|by|offset|hash|id|total|sign|qq|qr|author|auth|au|length|language|re|ve|edition|date|genre|encoder|coder|source|media|uploads|program|lrccreator)\s*:|\d{1,3}:\d{1,2}(?:\.\d{1,3})?\])/i;

/**
 * 合并同一标签 ID 的多个值。
 *
 * ID3v2.3 的 TXXX 帧在 music-metadata 中会被按 "/" 拆分：其
 * FrameParser.splitValue 对 major < 4 的帧在值不含 NUL 时按 "/" 分割
 * （ID3v2.3 对 TCOM/TEXT 等人名帧的分隔符规定，被误用到单值的 TXXX），
 * "/" 作为分隔符被吃掉。用 "/" 重新拼接即可原样还原；片段若以新文档头
 * （元数据或行时间标签）开头，则视为独立写入的多个标签，按换行合并。
 *
 * ID3v2.4 仅按 NUL 拆分，Vorbis / APE 等为真正的多值标签，按换行合并。
 *
 * @param format 标签格式（如 ID3v2.3）
 * @param id 标签 ID（大写）
 * @param chunks 按文件顺序排列的值
 * @returns 合并后的完整文本
 */
function joinLyricFrameTexts(format: string, id: string, chunks: readonly string[]): string {
	const slashSeparated = format === "ID3v2.3" && id.startsWith("TXXX");
	let result = "";
	for (const chunk of chunks) {
		if (!chunk) continue;
		if (result) {
			result += slashSeparated && !LRC_DOC_START.test(chunk) ? "/" : "\n";
		}
		result += chunk;
	}
	return result;
}

/**
 * 合并单个标签值中的多个子值（Vorbis / APE 等多值标签），按换行合并。
 */
function joinLyricValues(chunks: readonly string[]): string {
	return chunks.filter((chunk) => chunk).join("\n");
}

/**
 * 从单个标签值中提取歌词文本。
 * 
 * 支持多种值格式：字符串、字符串数组、对象的 text 属性（字符串或字符串数组）。
 * 
 * @param value 标签值
 * @returns 提取的文本，无法提取时返回 null
 */
function extractTagLyricsText(value: unknown): string | null {
	// 格式1：直接是字符串
	if (typeof value === "string") return value;
	// 格式1b：字符串数组（部分 Vorbis / APE 标签的多值歌词）
	if (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((item: unknown) => typeof item === "string")
	) {
		return joinLyricValues(value);
	}
	// 格式2/3：对象中的 text 属性（字符串或字符串数组，如 USLT）
	if (value !== null && typeof value === "object") {
		const textProp = (value as { text?: unknown }).text;
		if (typeof textProp === "string") return textProp;
		if (
			Array.isArray(textProp) &&
			textProp.length > 0 &&
			textProp.every((item: unknown) => typeof item === "string")
		) {
			return joinLyricValues(textProp);
		}
	}
	return null;
}

/**
 * 从原生标签中提取歌词文本（收集所有匹配的帧并按标签合并）。
 *
 * 同一 (格式, 标签ID) 出现多个值有两种成因：标签工具把超长文本拆成多个
 * 同 ID 的帧，或 music-metadata 把 ID3v2.3 的 TXXX 值按 "/" 误拆成多个
 * 标签（"/" 被吃掉）。只取第一帧会丢失后续歌词，因此按 (格式, 标签ID)
 * 分组合并（见 joinLyricFrameTexts）。存在多个候选组时（如 TXXX:LYRICS
 * 与 USLT 同时存在），优先选择带时间戳的歌词（可支持逐字/逐句同步），
 * 其次选择内容更完整的一组。
 *
 * @param native 原生标签对象
 * @param idMatcher 标签 ID 匹配函数，返回 true 表示匹配
 * @param descriptionMatcher 可选的描述匹配函数，用于额外匹配
 * @returns 提取的文本值，如果未找到则返回 undefined
 */
function extractTextFromNativeTags(
	native: IAudioMetadata["native"] | undefined,
	idMatcher: (id: string, upperId: string) => boolean,
	descriptionMatcher?: (description: string) => boolean
): string | undefined {
	if (!native) return undefined;

	const descriptionFromUnknown = (v: unknown): string => {
		if (typeof v !== "object" || v === null || !("description" in v)) return "";
		const d = (v as { description?: unknown }).description;
		return typeof d === "string" ? d : "";
	};

	// 按 (格式, 标签ID) 分组收集所有匹配的文本，保持文件中的出现顺序
	const groups = new Map<string, LyricsTagGroup>();

	for (const format of Object.keys(native)) {
		const nativeTags = native[format] || [];
		// 遍历该格式的所有标签
		for (const tag of nativeTags) {
			const id = String(tag.id || "");
			const upperId = id.toUpperCase();
			const value: unknown = tag.value;

			const isMatched = idMatcher(id, upperId);
			const desc = descriptionFromUnknown(value);
			const matchesByDescription =
				!isMatched && !!descriptionMatcher && desc !== "" && descriptionMatcher(desc);
			if (!isMatched && !matchesByDescription) continue;

			const text = extractTagLyricsText(value);
			if (text === null || text.trim() === "") continue;

			const key = `${format}\u0000${upperId}`;
			const existing = groups.get(key);
			if (existing) {
				existing.chunks.push(text);
			} else {
				groups.set(key, { format, id: upperId, chunks: [text] });
			}
		}
	}

	if (groups.size === 0) return undefined;

	// 选择最佳候选组：优先带时间戳（可同步），其次内容更完整
	let best: string | undefined;
	let bestScore = -1;
	for (const group of groups.values()) {
		const joined = joinLyricFrameTexts(group.format, group.id, group.chunks);
		const hasTimestamps = /\d{1,3}:\d{1,2}\.\d{1,3}/.test(joined);
		const score = (hasTimestamps ? 1_000_000 : 0) + joined.length;
		if (score > bestScore) {
			bestScore = score;
			best = joined;
		}
	}

	return best;
}

/**
 * 从 common.lyrics 元素中提取文本。
 *
 * music-metadata 12 起元素为 { language, descriptor, text } 对象（由 USLT 等
 * 汇总而来），更早版本为字符串，两种情况都要兼容。
 */
function lyricsEntryToText(entry: unknown): string {
	if (typeof entry === "string") return entry;
	if (entry !== null && typeof entry === "object" && "text" in entry) {
		const text = (entry as { text?: unknown }).text;
		if (typeof text === "string") return text;
	}
	return "";
}

/**
 * 提取内嵌歌词：
 * 1. 原生标签：id 含 lyrics、或 USLT / SYLT；TXXX 等配合 description 含 lyrics
 *    （extractTextFromNativeTags 内部会优先返回带时间戳、可同步的歌词）
 * 2. 回退 common.lyrics（M4A 等只有汇总字段的格式）
 *
 * 原生优先不能反：v12 起 USLT 也会被汇总进 common.lyrics，若先取汇总字段，
 * 纯文本会盖掉 TXXX:LYRICS 里的逐字时间戳歌词。
 */
function extractLyricsFromMetadata(metadata: IAudioMetadata): string | undefined {
	const fromNative = extractTextFromNativeTags(
		metadata.native,
		(id, upperId) => {
			const isLyricsId = /lyrics/i.test(id);
			const isStandardLyrics = upperId === "USLT" || upperId === "SYLT";
			return isLyricsId || isStandardLyrics;
		},
		(desc) => /lyrics/i.test(desc)
	);
	if (fromNative?.trim()) {
		return fromNative;
	}

	const common = metadata.common.lyrics;
	if (common && Array.isArray(common) && common.length > 0) {
		const joined = common
			.map(lyricsEntryToText)
			.filter((text) => text.trim() !== "")
			.join("\n");
		if (joined.trim()) return joined;
	}

	return undefined;
}

/**
 * 嵌入的音频元数据接口
 * 表示从音频文件中提取出的所有元数据信息
 */
export interface EmbeddedAudioMetadata {
	/** 封面图片的 base64 Data URL（如 data:image/jpeg;base64,...） */
	coverDataUrl?: string;
	/** 歌词文本内容 */
	lyricsText?: string;
	/** 歌曲标题 */
	title?: string;
	/** 艺术家名称 */
	artist?: string;
	/** 专辑名称 */
	album?: string;
	/** 专辑艺术家（可能不同于艺术家） */
	albumArtist?: string;
	/** 发行年份 */
	year?: number;
	/** 音乐流派（可以是字符串或字符串数组） */
	genre?: string | string[];
	/** 音轨号（专辑中的第几首） */
	track?: number;
	/** 歌曲时长（秒） */
	duration?: number;
}

/**
 * 读取音频文件的二进制数据（兼容移动端）
 * 
 * 使用 adapter.readBinary 作为首选方法（移动端兼容），
 * 如果失败则使用 vault.readBinary 作为后备。
 * 
 * @param app Obsidian 应用实例
 * @param file 音频文件
 * @returns 音频文件的二进制数据（ArrayBuffer），如果读取失败则返回 null
 */
export async function readAudioFileBinary(
	app: App,
	file: TFile
): Promise<ArrayBuffer | null> {
	try {
		// 使用 adapter.readBinary 以确保移动端兼容性
		// 在移动端，vault.readBinary 可能不工作，需要使用 adapter.readBinary
		let binary: ArrayBuffer;
		try {
			binary = await app.vault.adapter.readBinary(file.path);
		} catch (adapterError) {
			// 如果 adapter.readBinary 失败，尝试使用 vault.readBinary 作为后备
			console.warn(`使用 adapter.readBinary 读取失败，尝试使用 vault.readBinary (${file.path}):`, adapterError);
			try {
				binary = await app.vault.readBinary(file);
			} catch (vaultError) {
				console.error(`无法读取文件 ${file.path}:`, vaultError);
				return null;
			}
		}
		
		// 确保 binary 是 ArrayBuffer
		if (!(binary instanceof ArrayBuffer)) {
			console.error(`文件 ${file.path} 读取结果不是 ArrayBuffer:`, typeof binary);
			return null;
		}
		
		return binary;
	} catch (error) {
		console.error(`读取音频文件时出错 (${file.path}):`, error);
		return null;
	}
}

/**
 * 从音频文件的二进制缓冲区中提取嵌入的元数据
 * 
 * 使用 music-metadata-browser 库解析音频文件，提取：
 * 1. 封面图片：转换为 Blob URL
 * 2. 歌词：优先从原生标签取可同步的时间戳歌词，否则回退 common.lyrics
 * 3. 基本信息：标题、艺术家、专辑、年份、流派、音轨号、时长等
 * 
 * @param buffer 音频文件的二进制数据（ArrayBuffer）
 * @returns 返回提取的元数据对象，如果解析失败则返回 null
 * 
 * @example
 * ```typescript
 * const binary = await vault.readBinary(file);
 * const metadata = await getEmbeddedAudioMetadataFromBuffer(binary);
 * if (metadata) {
 *   console.log(metadata.title, metadata.artist);
 * }
 * ```
 */
export async function getEmbeddedAudioMetadataFromBuffer(
	buffer: ArrayBuffer,
): Promise<EmbeddedAudioMetadata | null> {
	try {
		// 验证 buffer 类型
		if (!(buffer instanceof ArrayBuffer)) {
			console.error("getEmbeddedAudioMetadataFromBuffer: buffer 不是 ArrayBuffer", typeof buffer);
			return null;
		}
		
		// 检查 buffer 大小
		if (buffer.byteLength === 0) {
			console.error("getEmbeddedAudioMetadataFromBuffer: buffer 为空");
			return null;
		}
		
		// 将 ArrayBuffer 转换为 Uint8Array
		// 使用 Uint8Array 而不是 Node.js 的 Buffer，以支持浏览器和移动端环境
		const uint8Array = new Uint8Array(buffer);
		
		// 解析音频元数据，启用时长计算
		// 在移动端，可能需要限制解析的数据量以避免内存问题
		const metadata: IAudioMetadata = await parseBuffer(uint8Array, "audio", {
			duration: true,
		});

		const result: EmbeddedAudioMetadata = {};

		// 提取封面图片
		// 封面图片通常存储在 metadata.common.picture 数组中
		const picture = metadata.common.picture && metadata.common.picture[0];
		if (picture && picture.data) {
			// 将图片数据转换为 Uint8Array（兼容浏览器环境）
			const pictureData = new Uint8Array(picture.data);

			// 使用 Buffer（已在顶部做过 polyfill）将二进制数据转成 base64
			// 注意：这里生成的是可持久化存储在 data.json 中的 base64 Data URL
			const base64 = Buffer.from(pictureData).toString("base64");
			const mimeType = picture.format || "image/jpeg";
			result.coverDataUrl = `data:${mimeType};base64,${base64}`;
		}

		// 歌词：common.lyrics → 原生宽泛匹配 → USLT 兜底（与最初实现一致）
		const lyricsText = extractLyricsFromMetadata(metadata);
		if (lyricsText?.trim()) {
			result.lyricsText = lyricsText;
		}

		// 提取基本元数据信息
		// 歌曲标题：优先从 common.title 获取，如果不存在则尝试从原生标签中查找
		if (metadata.common.title) {
			result.title = metadata.common.title;
		} else {
			const extractedTitle = extractTextFromNativeTags(
				metadata.native,
				(id) => {
					// 检查是否是标题相关的标签
					const upperId = id.toUpperCase();
					return /^(TIT2|TITLE|TITLE_MAIN|TITLE_MAIN_MAIN|TITLE_ORIGINAL)$/i.test(upperId);
				}
			);
			if (extractedTitle) {
				result.title = extractedTitle.trim();
			}
		}

		// 歌曲时长（秒）
		if (metadata.format?.duration) {
			result.duration = metadata.format.duration;
		}
		
		// 艺术家名称（可能是数组，需要合并）
		// 优先从 common.artist 获取，如果不存在则尝试从原生标签中查找
		if (metadata.common.artist) {
			result.artist = Array.isArray(metadata.common.artist)
				? metadata.common.artist.join(", ")
				: metadata.common.artist;
		} else {
			const extractedArtist = extractTextFromNativeTags(
				metadata.native,
				(id) => {
					// 检查是否是艺术家相关的标签
					const upperId = id.toUpperCase();
					return /^(TPE1|ARTIST|ARTIST_MAIN|ARTIST_ORIGINAL)$/i.test(upperId);
				}
			);
			if (extractedArtist) {
				result.artist = extractedArtist.trim();
			}
		}
		
		// 专辑名称
		if (metadata.common.album) {
			result.album = metadata.common.album;
		}
		
		// 专辑艺术家（可能是数组，需要合并）
		if (metadata.common.albumartist) {
			result.albumArtist = Array.isArray(metadata.common.albumartist)
				? metadata.common.albumartist.join(", ")
				: metadata.common.albumartist;
		}
		
		// 发行年份
		if (metadata.common.year) {
			result.year = metadata.common.year;
		}
		
		// 音乐流派（可能是数组，需要合并）
		if (metadata.common.genre) {
			result.genre = Array.isArray(metadata.common.genre)
				? metadata.common.genre.join(", ")
				: metadata.common.genre;
		}
		
		// 音轨号（可能是对象 {no: 1, of: 10} 或直接是数字）
		if (metadata.common.track) {
			result.track = typeof metadata.common.track === "object"
				? metadata.common.track.no || undefined
				: metadata.common.track;
		}

		return result;
	} catch (e) {
		// 如果解析失败，记录详细错误信息以便调试（特别是在移动端）
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorDetails: Record<string, unknown> = {
			error: errorMessage,
			bufferSize: buffer?.byteLength ?? 0,
			bufferType: buffer ? (buffer instanceof ArrayBuffer ? 'ArrayBuffer' : typeof buffer) : 'null/undefined'
		};
		
		// 只在开发环境或非移动端记录堆栈信息（移动端可能不支持）
		if (e instanceof Error && e.stack) {
			try {
				errorDetails.stack = e.stack;
			} catch {
				// 忽略堆栈信息获取失败
			}
		}
		
		console.error("Failed to parse embedded audio metadata:", errorDetails);
		return null;
	}
}

/**
 * 从音频文件中提取内嵌封面
 * 
 * 读取音频文件的二进制数据，提取内嵌封面并返回 base64 Data URL。
 * 这是一个便捷函数，封装了文件读取和封面提取的完整流程。
 * 
 * @param app Obsidian 应用实例
 * @param file 音频文件
 * @returns 封面图片的 base64 Data URL，如果未找到则返回 undefined
 * 
 * @example
 * ```typescript
 * const coverUrl = await getEmbeddedCoverFromFile(app, file);
 * if (coverUrl) {
 *   console.log('封面:', coverUrl);
 * }
 * ```
 */
export async function getEmbeddedCoverFromFile(
	app: App,
	file: TFile
): Promise<string | undefined> {
	try {
		// 检查是否为支持的音频格式
		const ext = file.extension?.toLowerCase() || '';
		if (!isSupportedAudioExtension(ext)) {
			return undefined;
		}

		// 读取音频文件的二进制数据（兼容移动端）
		const buffer = await readAudioFileBinary(app, file);
		if (!buffer) {
			return undefined;
		}
		
		// 提取元数据（包括内嵌封面）
		const metadata = await getEmbeddedAudioMetadataFromBuffer(buffer);
		
		// 如果存在内嵌封面，返回 base64 Data URL
		return metadata?.coverDataUrl;
	} catch (error) {
		console.error(`获取内嵌封面时出错 (${file.path}):`, error);
		return undefined;
	}
}

