/**
 * 从仓库扫描音频文件（不依赖插件主类），供 LibraryService 与设置页等复用。
 *
 * 通过文件夹树遍历收集音频文件，避免使用 vault.getFiles() 全库枚举 API。
 */

import type { App } from "obsidian";
import { TFile, TFolder } from "obsidian";
import { isSupportedAudioExtension } from "@/constants";

function collectAudioFilesInFolder(folder: TFolder): TFile[] {
	const results: TFile[] = [];
	const stack: TFolder[] = [folder];

	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;

		for (const child of current.children) {
			if (child instanceof TFolder) {
				stack.push(child);
			} else if (child instanceof TFile) {
				const ext = child.extension?.toLowerCase() ?? "";
				if (isSupportedAudioExtension(ext)) {
					results.push(child);
				}
			}
		}
	}

	return results;
}

function getScanRootFolder(app: App, musicFolder: string): TFolder | null {
	const normalized = musicFolder.replace(/\/$/, "");
	if (normalized) {
		const folder = app.vault.getFolderByPath(normalized);
		return folder ?? null;
	}
	return app.vault.getRoot();
}

/**
 * 按音乐文件夹设置过滤后返回支持的音频文件列表（未排序）。
 */
export function scanVaultAudioFiles(app: App, musicFolder: string): TFile[] {
	const root = getScanRootFolder(app, musicFolder);
	if (!root) {
		return [];
	}
	return collectAudioFilesInFolder(root);
}
