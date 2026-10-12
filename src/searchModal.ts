/**
 * searchModal.ts - 图片关键词搜索弹窗
 *
 * 提供基于关键词的图片搜索功能：
 * - 遍历所有索引文件，根据关键词匹配搜索结果
 * - 搜索不区分大小写，支持多关键词（空格分隔，任一匹配即可）
 * - 点击搜索结果可跳转到对应的图片文件
 * - 搜索基于索引文件位置确定图片位置（同文件夹模式核心逻辑）
 */
import { App, SuggestModal, Notice } from "obsidian";
import { SearchResult } from "./types";
import { getAllIndexEntries } from "./cache";
import { debugLog } from "./util";

const context = "searchModal";

/**
 * 图片搜索弹窗
 * 继承 Obsidian 的 SuggestModal，提供关键词搜索和结果选择功能
 */
export class SearchModal extends SuggestModal<SearchResult> {
	/** 预加载的所有索引条目，用于快速搜索 */
	private allEntries: SearchResult[] = [];

	constructor(app: App) {
		super(app);
		this.setPlaceholder("Search images by keywords...");
		this.setInstructions([
			{ command: "Type keywords", purpose: "to search indexed images" },
			{ command: "↑↓", purpose: "to navigate" },
			{ command: "↵", purpose: "to open image" },
			{ command: "esc", purpose: "to dismiss" },
		]);
		this.loadIndexEntries();
	}

	/**
	 * 预加载所有索引条目
	 * 在弹窗打开时异步加载，避免每次输入时重新读取文件
	 */
	private async loadIndexEntries() {
		try {
			this.allEntries = await getAllIndexEntries();
			debugLog(
				context,
				`Loaded ${this.allEntries.length} index entries for search`,
			);
		} catch (e) {
			debugLog(context, "Failed to load index entries");
			console.error(e);
		}
	}

	/**
	 * 根据用户输入获取搜索建议
	 * 支持多关键词搜索（空格分隔），任一关键词匹配即返回结果
	 * @param query - 用户输入的搜索关键词
	 * @returns 匹配的搜索结果数组
	 */
	async getSuggestions(query: string): Promise<SearchResult[]> {
		if (!query || query.trim().length === 0) {
			return [];
		}

		const keywords = query
			.toLowerCase()
			.split(/\s+/)
			.filter((k) => k.length > 0);

		if (keywords.length === 0) {
			return [];
		}

		return this.allEntries.filter((entry) => {
			const lowerKeywords = entry.keywords.toLowerCase();
			const lowerImagePath = entry.imagePath.toLowerCase();
			// 在关键词文本和图片路径中搜索，任一关键词匹配即返回
			return keywords.some(
				(keyword) =>
					lowerKeywords.includes(keyword) ||
					lowerImagePath.includes(keyword),
			);
		});
	}

	/**
	 * 渲染单个搜索建议项
	 * 显示图片路径和关键词预览
	 * @param result - 搜索结果
	 * @param el - 渲染目标的 HTML 元素
	 */
	renderSuggestion(result: SearchResult, el: HTMLElement) {
		const container = el.createEl("div", {
			cls: "ai-image-search-result",
		});

		// 显示图片文件名作为标题
		const imageName = result.imagePath.split("/").pop() || result.imagePath;
		container.createEl("div", {
			cls: "ai-image-search-result-title",
			text: imageName,
		});

		// 显示图片的完整路径
		container.createEl("div", {
			cls: "ai-image-search-result-path",
			text: result.imagePath,
		});

		// 显示关键词预览（截断过长的文本）
		const maxPreviewLength = 100;
		const preview =
			result.keywords.length > maxPreviewLength
				? result.keywords.substring(0, maxPreviewLength) + "..."
				: result.keywords;
		container.createEl("div", {
			cls: "ai-image-search-result-keywords",
			text: preview,
		});
	}

	/**
	 * 用户选择搜索结果后的回调
	 * 在 Obsidian 中打开对应的图片文件
	 * @param result - 被选中的搜索结果
	 */
	onChooseSuggestion(result: SearchResult) {
		// @ts-ignore - 使用全局 app 引用
		const file = app.vault.getAbstractFileByPath(result.imagePath);
		if (file) {
			// @ts-ignore
			app.workspace.getLeaf().openFile(file);
			debugLog(context, `Opening image: ${result.imagePath}`);
		} else {
			new Notice(`Image not found: ${result.imagePath}`);
			debugLog(context, `Image not found: ${result.imagePath}`);
		}
	}
}
