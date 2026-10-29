/**
 * main.ts - 插件入口模块
 *
 * Obsidian AI 图片分析插件的主入口文件，负责：
 * - 注册插件命令（分析图片、搜索图片、清除缓存等）
 * - 注册右键菜单（图片文件的 AI 分析菜单）
 * - 管理插件生命周期（加载/卸载）
 * - 暴露插件 API 供其他插件调用
 */
import { MenuItem, Notice, Plugin, TFile } from "obsidian";
import { isInCache, removeFromCache } from "./cache";
import {
	analyzeImage,
	analyzeImageWithNotice,
	analyzeToClipboard,
} from "./analyserManager";
import { debugLog, isImageFile } from "./util";
import { AIImageAnalyzerSettingsTab, loadSettings } from "./settings";
import { imagesProcessQueue } from "./globals";
import {
	provider,
	setProvider,
	unsubscribeFunctionSetting,
} from "./ai-adapter/globals";
import { initProvider } from "./ai-adapter/util";
import { SearchModal } from "./searchModal";

const context = "main";

/**
 * 插件对外暴露的 API 类型定义
 * 其他插件可以通过此 API 调用图片分析功能
 */
export type AIImageAnalyzerAPI = {
	/** 分析指定图片文件，返回关键词文本 */
	analyzeImage: (file: TFile) => Promise<string>;
	/** 判断文件是否为可分析的图片格式 */
	canBeAnalyzed: (file: TFile) => boolean;
	/** 检查指定图片是否已有缓存/索引 */
	isInCache: (file: TFile) => Promise<boolean>;
};

/**
 * AI 图片分析插件主类
 * 继承 Obsidian 的 Plugin 基类，实现插件的加载和卸载逻辑
 */
export default class AIImageAnalyzerPlugin extends Plugin {
	/** 对外暴露的插件 API */
	public api: AIImageAnalyzerAPI = {
		analyzeImage: analyzeImage,
		canBeAnalyzed: isImageFile,
		isInCache: isInCache,
	};

	/**
	 * 插件加载时调用
	 * 初始化设置、AI 提供者，注册命令和事件
	 */
	async onload() {
		debugLog(context, "loading ai image analyzer plugin");
		await loadSettings(this);

		setProvider(initProvider());

		// 注册命令：分析图片并将关键词复制到剪贴板
		this.addCommand({
			id: "analyze-image-to-clipboard",
			name: "Analyze image to clipboard",
			checkCallback: (checking: boolean) => {
				const file = getActiveFile();

				if (file != null && isImageFile(file)) {
					if (!checking) {
						analyzeToClipboard(file);
					}
					return true;
				}

				return false;
			},
		});

		// 注册命令：分析图片并显示结果
		this.addCommand({
			id: "analyze-image",
			name: "Analyze image",
			checkCallback: (checking: boolean) => {
				const file = getActiveFile();
				if (file != null && isImageFile(file)) {
					if (!checking) {
						analyzeImageWithNotice(file);
					}
					return true;
				}

				return false;
			},
		});

		// 注册命令：清除当前图片的缓存/索引
		this.addCommand({
			id: "clear-cache-of-active-image",
			name: "Clear cache of active image",
			checkCallback: (checking: boolean) => {
				const file = getActiveFile();
				if (file != null && isImageFile(file)) {
					if (!checking) {
						removeFromCache(file);
						new Notice("Cache cleared");
					}
					return true;
				}

				return false;
			},
		});

		// 注册命令：通过关键词搜索已索引的图片
		this.addCommand({
			id: "search-images-by-keywords",
			name: "Search images by keywords",
			callback: () => {
				new SearchModal(this.app).open();
			},
		});

		// 注册右键菜单：为图片文件添加 AI 分析子菜单
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file, _source) => {
				if (file instanceof TFile && isImageFile(file)) {
					menu.addItem((item: MenuItem) => {
						item.setTitle("AI analyze image");

						// obsidian ^1.5.7 的 typings 没收录 setSubmenu，运行时（1.9+）存在
					const submenu = (
						item as unknown as { setSubmenu(): import("obsidian").Menu }
					).setSubmenu();

						// 子菜单：分析图片并复制到剪贴板
						submenu.addItem((item: MenuItem) =>
							item
								.setTitle("Analyze image to clipboard")
								.setIcon("clipboard")
								.onClick(() => {
									analyzeToClipboard(file);
								}),
						);

						// 子菜单：分析图片（清除旧缓存后重新分析）
						submenu.addItem((item: MenuItem) =>
							item
								.setTitle("Analyze image")
								.setIcon("search")
								.onClick(async () => {
									await removeFromCache(file);
									await analyzeImageWithNotice(file);
								}),
						);

						// 子菜单：清除该图片的缓存
						submenu.addItem((item: MenuItem) =>
							item
								.setTitle("Clear cache")
								.setIcon("trash")
								.onClick(async () => {
									await removeFromCache(file);
									new Notice("Cache cleared");
								}),
						);
					});
				}
			}),
		);

		// 注册设置标签页
		this.addSettingTab(new AIImageAnalyzerSettingsTab(this.app, this));
	}

	/**
	 * 插件卸载时调用
	 * 清理资源：清空处理队列、关闭 AI 提供者连接、取消设置订阅
	 */
	onunload() {
		imagesProcessQueue.clear();
		provider.shutdown();
		if (unsubscribeFunctionSetting) {
			unsubscribeFunctionSetting();
		}
		debugLog(context, "unloading ai image analyzer plugin");
	}
}

/**
 * 获取当前活动的文件
 * 优先从活动编辑器获取，其次从工作区获取
 * @returns 当前活动的 TFile，如果没有则返回 null
 */
function getActiveFile(): TFile | null {
	// 模块顶层函数没有实例 this（esbuild 的 CJS 输出里 this 是 undefined，
	// 原来的 this.app 一调用就 TypeError）——改走全局 app。
	const workspace = (
		globalThis as unknown as { app?: { workspace: { activeEditor?: { file?: TFile | null }; getActiveFile(): TFile | null } } }
	).app?.workspace;
	if (!workspace) return null;
	return workspace.activeEditor?.file ?? workspace.getActiveFile();
}
