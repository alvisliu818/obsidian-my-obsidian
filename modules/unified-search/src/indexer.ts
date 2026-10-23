import { TFile } from "obsidian";
import type { FileMeta } from "../../index-core/src/index-writer";

/** M1 可索引扩展名（块级拆分与 ext 域见 M2） */
export const INDEXABLE_EXTENSIONS = new Set(["md", "org"]);

export function isIndexable(file: TFile): boolean {
	return INDEXABLE_EXTENSIONS.has(file.extension.toLowerCase());
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
