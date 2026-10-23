import { TFile } from "obsidian";
import type { FileMeta } from "../../index-core/src/index-writer";

/** M1 可索引扩展名（块级拆分与 ext 域见 M2） */
export const INDEXABLE_EXTENSIONS = new Set(["md", "org"]);

export function isIndexable(file: TFile): boolean {
	return INDEXABLE_EXTENSIONS.has(file.extension.toLowerCase());
}

/**
 * 附件扩展名（M2-1）：建占位 item 使 ![[file]] embed 可解析、附件名可搜。
 * 悬空链接 69.5% 的大头就是附件 embed（主库实测）。
 */
export const ATTACHMENT_EXTENSIONS = new Set([
	"png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "heic",
	"pdf",
	"mp4", "mp3", "wav", "ogg", "m4a", "avi", "mov", "mkv", "webm", "flac", "opus",
]);

export function isAttachment(file: TFile): boolean {
	return ATTACHMENT_EXTENSIONS.has(file.extension.toLowerCase());
}

/** vault 文件 → 索引文件元数据 */
export function fileToMeta(file: TFile): FileMeta {
	return {
		path: file.path,
		domain: "vault",
		mtime: file.stat.mtime,
		size: file.stat.size,
		ext: file.extension.toLowerCase(),
		title: file.basename,
	};
}
