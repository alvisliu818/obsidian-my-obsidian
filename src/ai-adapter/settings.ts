/**
 * settings.ts - AI 适配器设置模块
 *
 * 管理 AI 适配器的配置项和设置界面：
 * - AIAdapterPluginSettings: 适配器设置类型定义
 * - DEFAULT_SETTINGS: 默认设置值
 * - generateSettings: 生成适配器设置界面（提供者选择、模型选择）
 */
import { Setting } from "obsidian";
import { Models, providerNames, Providers } from "./types";
import {
	DEFAULT_OLLAMA_SETTINGS,
	OllamaSettings,
} from "./providers/ollamaProvider";
import {
	possibleModels,
	setProvider,
	provider,
	notifyModelsChange,
} from "./globals";
import { initProvider } from "./util";
import {
	DEFAULT_GEMINI_SETTINGS,
	GeminiSettings,
} from "./providers/geminiProvider";
import AIImageAnalyzerPlugin from "../main";
import { saveSettings, settings } from "../settings";

/**
 * AI 适配器插件的设置类型定义
 */
export type AIAdapterPluginSettings = {
	/** 当前使用的 AI 提供者 */
	provider: Providers;
	/** 当前选择的文本模型 */
	selectedModel: Models;
	/** 当前选择的图片分析模型 */
	selectedImageModel: Models;
	/** Ollama 提供者的配置 */
	ollamaSettings: OllamaSettings;
	/** Gemini 提供者的配置 */
	geminiSettings: GeminiSettings;
};

/** AI 适配器设置的默认值 */
export const DEFAULT_SETTINGS: AIAdapterPluginSettings = {
	provider: "ollama",
	selectedModel: possibleModels[8],
	selectedImageModel: possibleModels[0],
	ollamaSettings: DEFAULT_OLLAMA_SETTINGS,
	geminiSettings: DEFAULT_GEMINI_SETTINGS,
};

/**
 * 生成 AI 适配器的设置界面
 * 包括提供者选择下拉框和图片模型选择下拉框
 * 切换提供者时会自动重新初始化提供者实例
 * @param containerEl - 设置界面的容器元素
 * @param plugin - 插件实例
 */
export function generateSettings(
	containerEl: HTMLElement,
	plugin: AIImageAnalyzerPlugin,
) {
	// 提供者选择
	new Setting(containerEl)
		.setName("Provider")
		.setDesc("Select the provider to use")
		.addDropdown((dropdown) =>
			dropdown
				.addOptions(
					providerNames.reduce(
						(acc, provider) => {
							acc[provider] = provider;
							return acc;
						},
						{} as Record<Providers, string>,
					),
				)
				.setValue(settings.aiAdapterSettings.provider)
				.onChange(async (value: Providers) => {
					settings.aiAdapterSettings.provider = value;
					// 切换提供者时重新初始化
					setProvider(initProvider());

					settings.aiAdapterSettings.selectedModel =
						provider.lastModel ?? possibleModels[0];

					settings.aiAdapterSettings.selectedImageModel =
						provider.lastImageModel ?? possibleModels[0];

					await saveSettings(plugin);
					notifyModelsChange();
				}),
		);

	// 图片分析模型选择（仅显示当前提供者支持图片分析的模型）
	new Setting(containerEl)
		.setName("Image model")
		.setDesc("Select the image model to use")
		.addDropdown((dropdown) =>
			dropdown
				.addOptions(
					possibleModels
						.filter(
							(model: Models) =>
								model.provider ==
									settings.aiAdapterSettings.provider &&
								model.imageReady,
						)
						.reduce(
							(acc, model) => {
								acc[model.name] = model.name;
								return acc;
							},
							{} as Record<string, string>,
						),
				)
				.setValue(settings.aiAdapterSettings.selectedImageModel.name)
				.onChange(async (value) => {
					settings.aiAdapterSettings.selectedImageModel =
						possibleModels.find((model) => model.name === value)!;
					provider.setLastImageModel(
						settings.aiAdapterSettings.selectedImageModel,
					);
					await saveSettings(plugin);
				}),
		);

	// 生成当前提供者专属的设置界面
	provider.generateSettings(containerEl, plugin);
}
