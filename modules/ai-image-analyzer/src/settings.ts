/**
 * settings.ts - 插件设置管理模块
 *
 * 管理插件的所有配置项，包括：
 * - 调试模式开关
 * - AI 分析提示词
 * - 自动清除缓存开关
 * - 索引存储模式（集中式/同文件夹）
 * - 索引文件后缀名
 * - AI 适配器相关配置
 */
import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import { clearCache } from "./cache";
import AIImageAnalyzerPlugin from "./main";
import { debugLog } from "./util";
import {
	AIAdapterPluginSettings,
	generateSettings,
} from "./ai-adapter/settings";
import { DEFAULT_SETTINGS as AI_ADAPTER_DEFAULT_SETTINGS } from "./ai-adapter/settings";
import {
	setUnsubscribeFunctionSetting,
	subscribeModelsChange,
} from "./ai-adapter/globals";
import { IndexMode } from "./types";

const context = "settings";

/**
 * 插件设置的类型定义
 */
interface AIImageAnalyzerPluginSettings {
	/** 是否启用调试模式，启用后会在控制台输出详细日志 */
	debug: boolean;
	/** AI 分析图片时使用的提示词 */
	prompt: string;
	/** 是否在更改模型或提示词后自动清除缓存 */
	autoClearCache: boolean;
	/** 索引文件的存储模式：centralized（集中式）或 colocated（同文件夹） */
	indexMode: IndexMode;
	/** 索引文件的后缀名，仅在同文件夹模式下使用 */
	indexFileSuffix: string;
	/** AI 适配器相关配置 */
	aiAdapterSettings: AIAdapterPluginSettings;
}

/** 插件设置的默认值 */
const DEFAULT_SETTINGS: AIImageAnalyzerPluginSettings = {
	debug: false,
	prompt:
		"Describe the image. Just use Keywords. For example: cat, dog, tree. This must be Computer readable. The provided pictures are used in an notebook. Please provide at least 5 Keywords. It will be used to search for the image later.",
	autoClearCache: true,
	indexMode: "colocated",
	indexFileSuffix: ".ai-index.json",
	aiAdapterSettings: AI_ADAPTER_DEFAULT_SETTINGS,
};

/** 当前生效的插件设置（运行时可变） */
export let settings: AIImageAnalyzerPluginSettings = Object.assign(
	{},
	DEFAULT_SETTINGS,
);

/**
 * 从插件数据中加载设置
 * 将保存的设置与默认设置合并，确保新增字段有默认值
 * @param plugin - 插件实例
 */
export async function loadSettings(plugin: AIImageAnalyzerPlugin) {
	settings = Object.assign({}, DEFAULT_SETTINGS, await plugin.loadData());
	settings.indexMode === "colocated"
}

/**
 * 保存当前设置到插件数据
 * @param plugin - 插件实例
 */
export async function saveSettings(plugin: AIImageAnalyzerPlugin) {
	await plugin.saveData(settings);
}

/**
 * 插件设置界面标签页
 * 在 Obsidian 的设置面板中显示和编辑插件配置
 */
export class AIImageAnalyzerSettingsTab extends PluginSettingTab {
	plugin: AIImageAnalyzerPlugin;

	constructor(app: App, plugin: AIImageAnalyzerPlugin) {
		super(app, plugin);
		this.plugin = plugin;
		// 订阅模型列表变化，当可用模型更新时刷新设置界面
		setUnsubscribeFunctionSetting(
			subscribeModelsChange(() => {
				debugLog(context, "Models changed, updating settings tab");
				this.display();
			}),
		);
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		// 缓存管理设置
		new Setting(containerEl)
			.setName("Clear cache")
			.setDesc("Clear the cache, reanalyzing images could take a while")
			.addButton((button) =>
				button.setButtonText("Clear cache").onClick(async () => {
					await clearCache();
					new Notice("Cache cleared");
				}),
			);

		// 调试模式开关
		new Setting(containerEl)
			.setName("Debug mode")
			.setDesc("Enable debug mode to see logs in the console")
			.addToggle((toggle) =>
				toggle.setValue(settings.debug).onChange(async (value) => {
					settings.debug = value;
					await saveSettings(this.plugin);
				}),
			);

		// AI 适配器配置
		new Setting(containerEl).setName("AI configuration").setHeading();
		generateSettings(containerEl, this.plugin);

		// 索引存储模式配置
		new Setting(containerEl).setName("Index storage").setHeading();

		new Setting(containerEl)
			.setName("Index mode")
			.setDesc(
				"Centralized: Store all index files in the plugin config directory. " +
					"Co-located: Store index files in the same folder as the indexed images, " +
					"so that search can locate images based on index file location.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("centralized", "Centralized")
					.addOption("colocated", "Co-located (recommended)")
					.setValue(settings.indexMode)
					.onChange(async (value: string) => {
						settings.indexMode = value as IndexMode;
						if (settings.autoClearCache) {
							await clearCache();
							new Notice(
								"Cache cleared due to index mode change",
							);
						}
						await saveSettings(this.plugin);
					}),
			);

		new Setting(containerEl)
			.setName("Index file suffix")
			.setDesc(
				"Suffix for index files in co-located mode (e.g., .ai-index.json). " +
					"Changing this will make existing index files unrecognizable.",
			)
			.addText((text) =>
				text
					.setPlaceholder(".ai-index.json")
					.setValue(settings.indexFileSuffix)
					.onChange(async (value) => {
						if (value.length === 0) {
							value = DEFAULT_SETTINGS.indexFileSuffix;
						}
						if (!value.startsWith(".")) {
							value = "." + value;
						}
						settings.indexFileSuffix = value;
						await saveSettings(this.plugin);
					}),
			);

		// 高级设置
		new Setting(containerEl).setName("Advanced").setHeading();

		// 提示词配置
		new Setting(containerEl)
			.setName("Prompt")
			.setDesc("Set the prompt to use alongside the image")
			.addTextArea((text) => {
				text.inputEl.rows = 5;
				text.inputEl.cols = 50;
				return text
					.setPlaceholder("Enter the prompt")
					.setValue(settings.prompt)
					.onChange(async (value) => {
						if (value.length === 0) {
							value = DEFAULT_SETTINGS.prompt;
						}
						settings.prompt = value;
						await saveSettings(this.plugin);

						if (settings.autoClearCache) {
							await clearCache();
						}
					});
			});

		// 自动清除缓存开关
		new Setting(containerEl)
			.setName("Auto clear cache")
			.setDesc(
				"Clear the cache after changing the model or the prompt to reanalyze images (if toggled on the cache will be cleared)",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(settings.autoClearCache)
					.onChange(async (value) => {
						settings.autoClearCache = value;
						if (value) {
							await clearCache();
							new Notice("Cache cleared");
						}
						await saveSettings(this.plugin);
					}),
			);
	}
}
