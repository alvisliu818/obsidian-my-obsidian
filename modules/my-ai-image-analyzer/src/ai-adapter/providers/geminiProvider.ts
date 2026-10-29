/**
 * geminiProvider.ts - Google Gemini AI 提供者实现
 *
 * 实现 Google Gemini API 的连接和查询功能：
 * - 管理 Gemini API 客户端的生命周期
 * - 支持 API Key 认证
 * - 自动检测可用的 Gemini 模型并添加到模型列表
 * - 支持纯文本和带图片的查询
 */
import AIImageAnalyzerPlugin from "../../main";
import { Notice, Setting } from "obsidian";
import { Provider } from "../provider";
import { Models } from "../types";
import { notifyModelsChange, possibleModels } from "../globals";
import { saveSettings, settings } from "../../settings";
import { GoogleGenAI } from "@google/genai";
import { debugLog } from "../../util";

const context = "ai-adapter/providers/geminiProvider";

/** Gemini API 客户端实例 */
let gemini: GoogleGenAI;

/**
 * Gemini 提供者的设置类型定义
 */
export type GeminiSettings = {
	/** 上次使用的文本模型 */
	lastModel: Models;
	/** 上次使用的图片分析模型 */
	lastImageModel: Models;
	/** Gemini API 密钥 */
	apiKey: string;
};

/** Gemini 设置的默认值 */
export const DEFAULT_GEMINI_SETTINGS: GeminiSettings = {
	lastModel: possibleModels[13],
	lastImageModel: possibleModels[12],
	apiKey: "",
};

/**
 * Google Gemini AI 提供者
 * 实现与 Google Gemini API 的交互逻辑
 */
export class GeminiProvider extends Provider {
	constructor() {
		super();
		this.lastModel = settings.aiAdapterSettings.geminiSettings.lastModel;
		this.lastImageModel =
			settings.aiAdapterSettings.geminiSettings.lastImageModel;
		GeminiProvider.restartSession();
		this.checkGemini().then((success) => {
			debugLog(context, "Gemini check success: " + success);
		});
	}

	/**
	 * 生成 Gemini 专属的设置界面
	 * 包括 API 密钥配置
	 */
	generateSettings(containerEl: HTMLElement, plugin: AIImageAnalyzerPlugin) {
		new Setting(containerEl).setName("Gemini").setHeading();

		// API 密钥输入
		new Setting(containerEl)
			.setName("Gemini API key")
			.setDesc("Set your gemini API token")
			.addText((text) =>
				text
					.setValue(
						settings.aiAdapterSettings.geminiSettings.apiKey !== ""
							? "••••••••••"
							: "",
					)
					.onChange(async (value) => {
						if (value.contains("•")) {
							return;
						}
						settings.aiAdapterSettings.geminiSettings.apiKey =
							value;
						GeminiProvider.restartSession();
						this.checkGemini().then((success) => {
							debugLog(
								context,
								"Gemini check success: " + success,
							);
						});
						await saveSettings(plugin);
					}),
			);
	}

	/**
	 * 纯文本查询
	 * 向 Gemini API 发送文本提示并获取响应
	 */
	async queryHandling(prompt: string): Promise<string> {
		const response = await gemini.models.generateContent({
			model: settings.aiAdapterSettings.selectedModel.model,
			contents: [
				{
					role: "user",
					parts: [{ text: prompt }],
				},
			],
		});

		if (response.text === undefined) {
			return "[AI-ERROR] No response from Gemini API";
		}

		return response.text;
	}

	/**
	 * 带图片的查询
	 * 向 Gemini API 发送文本提示和图片数据，获取图片分析结果
	 */
	async queryWithImageHandling(
		prompt: string,
		image: string,
	): Promise<string> {
		const response = await gemini.models.generateContent({
			model: settings.aiAdapterSettings.selectedImageModel.model,
			contents: [
				{
					role: "user",
					parts: [
						{ text: prompt },
						{ inlineData: { mimeType: "image/png", data: image } },
					],
				},
			],
		});

		if (response.text === undefined) {
			return "[AI-ERROR] No response from Gemini API";
		}

		return response.text;
	}

	/**
	 * 记录上次使用的文本模型并保存到设置
	 */
	setLastModel(model: Models) {
		super.setLastModel(model);
		settings.aiAdapterSettings.geminiSettings.lastModel = model;
	}

	/**
	 * 记录上次使用的图片分析模型并保存到设置
	 */
	setLastImageModel(model: Models) {
		super.setLastImageModel(model);
		settings.aiAdapterSettings.geminiSettings.lastImageModel = model;
	}

	/**
	 * 重新创建 Gemini API 客户端会话
	 * 在 API 密钥更改时调用
	 */
	static restartSession() {
		gemini = new GoogleGenAI({
			apiKey: settings.aiAdapterSettings.geminiSettings.apiKey,
		});
	}

	/**
	 * 检查 Gemini API 连接并获取可用模型
	 * 遍历所有支持 generateContent 的模型，同时注册为文本模型和图片分析模型
	 * @returns 连接是否成功
	 */
	private async checkGemini() {
		try {
			let updated = false;

			for await (const model of await gemini.models.list()) {
				if (model.supportedActions?.includes("generateContent")) {
					const modelName = model.displayName ?? "unknown";
					const modelId = model.name ?? "unknown";

					// 注册为图片分析模型
					const geminiModel: Models = {
						name: modelName,
						model: modelId,
						imageReady: true,
						provider: "gemini",
					};

					if (
						!possibleModels.some(
							(m) =>
								m.model === geminiModel.model && m.imageReady,
						)
					) {
						possibleModels.push(geminiModel);
						debugLog(context, "Added model: " + geminiModel.name);
						updated = true;
					}

					// 注册为文本模型
					const geminiTextModel: Models = {
						name: modelName,
						model: modelId,
						imageReady: false,
						provider: "gemini",
					};

					if (
						!possibleModels.some(
							(m) =>
								m.model === geminiModel.model && !m.imageReady,
						)
					) {
						possibleModels.push(geminiTextModel);
						debugLog(
							context,
							"Added model: " + geminiTextModel.name,
						);
						updated = true;
					}
				}
			}

			if (updated) {
				debugLog(context, "Models updated, notifying settings tab");
				notifyModelsChange();
			}
			return true;
		} catch (e) {
			debugLog(context, e);
			new Notice(
				"Error connecting to gemini API. Please check your gemini API key.",
			);
			new Notice(String(e));
			return false;
		}
	}
}
