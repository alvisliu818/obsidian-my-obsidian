/**
 * ollamaProvider.ts - Ollama AI 提供者实现
 *
 * 实现 Ollama 本地 AI 模型的连接和查询功能：
 * - 管理 Ollama 实例的生命周期（创建、刷新、关闭）
 * - 支持主 URL 和备用 URL 的自动切换
 * - 支持令牌认证
 * - 自动检测本地可用模型并添加到模型列表
 * - 支持模型拉取（下载）及进度显示
 * - 支持请求中止（通过 AbortController）
 */
import { Provider } from "../provider";
import { Notice, Setting } from "obsidian";
import { debugLog } from "../../util";
import { ChatResponse, Ollama } from "ollama";
import { Models } from "../types";
import { notifyModelsChange, possibleModels } from "../globals";
import AIImageAnalyzerPlugin from "../../main";
import { saveSettings, settings } from "../../settings";

const context = "ai-adapter/providers/ollamaProvider";

/** Ollama 客户端实例 */
let ollama: Ollama;

/**
 * Ollama 提供者的设置类型定义
 */
export type OllamaSettings = {
	/** 上次使用的文本模型 */
	lastModel: Models;
	/** 上次使用的图片分析模型 */
	lastImageModel: Models;
	/** Ollama 服务器的主 URL */
	url: string;
	/** 备用 URL（主 URL 不可用时自动切换） */
	fallbackUrl: string;
	/** 认证令牌（可选） */
	token: string;
};

/** Ollama 设置的默认值 */
export const DEFAULT_OLLAMA_SETTINGS: OllamaSettings = {
	lastModel: possibleModels[8],
	lastImageModel: possibleModels[0],
	url: "http://127.0.0.1:11434",
	fallbackUrl: "",
	token: "",
};

/**
 * Ollama AI 提供者
 * 实现与本地 Ollama 服务器的交互逻辑
 */
export class OllamaProvider extends Provider {
	/** 是否正在使用备用 URL */
	private static fallback: boolean = false;
	/** 当前 Ollama 请求的 AbortController，用于中止正在进行的请求 */
	private static currentOllamaController: AbortController | undefined;

	constructor() {
		super();
		this.lastModel = settings.aiAdapterSettings.ollamaSettings.lastModel;
		this.lastImageModel =
			settings.aiAdapterSettings.ollamaSettings.lastImageModel;
		OllamaProvider.refreshInstance();
		this.checkOllama().then((success) => {
			debugLog(context, "Ollama check success: " + success);
		});
	}

	/**
	 * 生成 Ollama 专属的设置界面
	 * 包括模型拉取按钮、URL 配置、备用 URL 和认证令牌
	 */
	generateSettings(containerEl: HTMLElement, plugin: AIImageAnalyzerPlugin) {
		new Setting(containerEl).setName("Ollama").setHeading();

		// 模型拉取按钮
		new Setting(containerEl)
			.setName("Pull models")
			.setDesc("Pull the selected models")
			.addButton((button) =>
				button.setButtonText("Pull model").onClick(async () => {
					await OllamaProvider.pullImage(
						settings.aiAdapterSettings.selectedImageModel,
					);
				}),
			);

		// Ollama 服务器 URL
		new Setting(containerEl)
			.setName("Ollama URL")
			.setDesc("Set the URL for the ollama server")
			.addText((text) =>
				text
					.setPlaceholder("Enter the host (http://127.0.0.1:11434)")
					.setValue(settings.aiAdapterSettings.ollamaSettings.url)
					.onChange(async (value) => {
						if (value.length === 0) {
							value = DEFAULT_OLLAMA_SETTINGS.url;
						}
						settings.aiAdapterSettings.ollamaSettings.url = value;
						OllamaProvider.refreshInstance();
						this.checkOllama().then((success) => {
							debugLog(
								context,
								"Ollama check success: " + success,
							);
						});
						await saveSettings(plugin);
					}),
			);

		// 备用 URL
		new Setting(containerEl)
			.setName("Fallback URL (optional)")
			.setDesc("Set a fallback URL for the ollama server")
			.addText((text) =>
				text
					.setPlaceholder("Enter the host (http://127.0.0.1:11434)")
					.setValue(
						settings.aiAdapterSettings.ollamaSettings.fallbackUrl,
					)
					.onChange(async (value) => {
						settings.aiAdapterSettings.ollamaSettings.fallbackUrl =
							value;
						OllamaProvider.refreshInstance();
						this.checkOllama().then((success) => {
							debugLog(
								context,
								"Ollama check success: " + success,
							);
						});
						await saveSettings(plugin);
					}),
			);

		// 认证令牌
		new Setting(containerEl)
			.setName("Ollama token (optional)")
			.setDesc(
				"Set the token used to authenticate with the ollama server",
			)
			.addText((text) =>
				text
					.setValue(
						settings.aiAdapterSettings.ollamaSettings.token !== ""
							? "••••••••••"
							: "",
					)
					.onChange(async (value) => {
						if (value.contains("•")) {
							return;
						}
						settings.aiAdapterSettings.ollamaSettings.token = value;
						OllamaProvider.refreshInstance();
						await saveSettings(plugin);
					}),
			);
	}

	/**
	 * 纯文本查询
	 * 向 Ollama 发送文本消息并获取响应
	 */
	async queryHandling(prompt: string): Promise<string> {
		const response: ChatResponse = await ollama.chat({
			model: settings.aiAdapterSettings.selectedModel.model,
			messages: [{ role: "user", content: prompt }],
		});
		return response.message.content;
	}

	/**
	 * 带图片的查询
	 * 向 Ollama 发送文本消息和图片数据，获取图片分析结果
	 */
	async queryWithImageHandling(
		prompt: string,
		image: string,
	): Promise<string> {
		const response: ChatResponse = await ollama.chat({
			model: settings.aiAdapterSettings.selectedImageModel.model,
			messages: [{ role: "user", content: prompt, images: [image] }],
		});
		return response.message.content;
	}

	/**
	 * 检查 Ollama 连接并获取可用模型
	 * 自动检测本地已安装的模型，区分文本模型和图片分析模型
	 * 如果主 URL 不可用且配置了备用 URL，自动切换到备用 URL
	 * @returns 连接是否成功
	 */
	private async checkOllama(): Promise<boolean> {
		try {
			const models = await ollama.list();
			debugLog(context, models);
			let updated = false;
			for (const model of models.models) {
				// 获取模型的能力信息（是否支持视觉/补全）
				const capabilities = (await ollama.show({ model: model.name }))
					.capabilities;
				const isImageModel = capabilities.includes("vision");
				const isTextModel = capabilities.includes("completion");
				const name =
					model.name.split(":")[0] +
					" [" +
					model.details.parameter_size +
					"]" +
					" (custom)";

				// 添加文本模型（如果尚未存在）
				if (
					isTextModel &&
					!possibleModels.some(
						(m) => m.model === model.name && !m.imageReady,
					)
				) {
					possibleModels.push({
						name,
						model: model.name,
						provider: "ollama",
						imageReady: false,
					});
					debugLog(context, "Added model: " + name);
					updated = true;
				}

				// 添加图片分析模型（如果尚未存在）
				if (
					isImageModel &&
					!possibleModels.some(
						(m) => m.model === model.name && m.imageReady,
					)
				) {
					possibleModels.push({
						name,
						model: model.name,
						provider: "ollama",
						imageReady: true,
					});
					debugLog(context, "Added image model: " + name);
					updated = true;
				}
			}

			if (updated) {
				debugLog(context, "Models updated, notifying settings tab");
				notifyModelsChange();
			}

			// 检查当前选择的模型是否可用
			if (
				!models.models.some(
					(model) =>
						model.name ===
						settings.aiAdapterSettings.selectedModel.model,
				)
			) {
				debugLog(context, "No text model found (currently not used)");
			}
			if (
				!models.models.some(
					(model) =>
						model.name ===
						settings.aiAdapterSettings.selectedImageModel.model,
				)
			) {
				new Notice(
					`No ${settings.aiAdapterSettings.selectedImageModel.name} model found, please make sure you have pulled it (you can pull it over the settings tab or choose another model)`,
				);
			}
			return true;
		} catch (e) {
			debugLog(context, e);
			// 主 URL 失败时尝试备用 URL
			if (
				!OllamaProvider.fallback &&
				settings.aiAdapterSettings.ollamaSettings.fallbackUrl?.length >
					0
			) {
				OllamaProvider.fallback = true;
				debugLog(context, "Falling back to fallback URL");
				OllamaProvider.refreshInstance();
				return await this.checkOllama();
			}
			new Notice("Error connecting to ollama.");
			new Notice(String(e));
			return false;
		}
	}

	/**
	 * 拉取（下载）指定的 AI 模型
	 * 显示下载进度通知
	 * @param model - 需要拉取的模型信息
	 */
	static async pullImage(model: Models) {
		let progressNotice: Notice | undefined;
		try {
			new Notice(
				`Pulling ${model.name} model started, this may take a while...`,
			);
			const response = await ollama.pull({
				model: model.model,
				stream: true,
			});
			progressNotice = new Notice(`Pulling ${model.name} model 0%`, 0);
			for await (const part of response) {
				debugLog(context, part);
				if (part.total !== null && part.completed !== null) {
					const percentage = (part.completed / part.total) * 100;
					if (
						!isNaN(percentage) &&
						percentage !== Infinity &&
						percentage !== -Infinity
					) {
						const roundedNumber = percentage.toFixed(2);
						const completed = (part.completed / 1000000000).toFixed(
							2,
						);
						const total = (part.total / 1000000000).toFixed(2);
						progressNotice.setMessage(
							`Pulling ${model.name} model ${roundedNumber}% (${completed}GB/${total}GB)`,
						);
					}
				}
			}
			progressNotice.hide();
			new Notice(`${model.name} model pulled successfully`);
		} catch (e) {
			debugLog(context, e);
			progressNotice?.hide();
			new Notice(`Failed to pull ${model.name} model`);
			new Notice(String(e));
		}
	}

	/**
	 * 刷新 Ollama 客户端实例
	 * 根据当前设置（是否使用备用 URL、令牌）创建新的 Ollama 实例
	 * 刷新前会中止当前正在进行的请求
	 */
	static refreshInstance() {
		debugLog(
			context,
			"Refreshing Ollama instance (fallback: " +
				OllamaProvider.fallback +
				")",
		);

		if (ollama !== undefined) {
			ollama.abort();
		}
		OllamaProvider.abortCurrentOllamaRequest();
		ollama = new Ollama({
			host: !this.fallback
				? settings.aiAdapterSettings.ollamaSettings.url
				: settings.aiAdapterSettings.ollamaSettings.fallbackUrl,
			headers: {
				Authorization: `Bearer ${settings.aiAdapterSettings.ollamaSettings.token}`,
			},
			fetch: OllamaProvider.ollamaFetch,
		});
	}

	/**
	 * 记录上次使用的文本模型并保存到设置
	 */
	setLastModel(model: Models) {
		super.setLastModel(model);
		settings.aiAdapterSettings.ollamaSettings.lastModel = model;
	}

	/**
	 * 记录上次使用的图片分析模型并保存到设置
	 */
	setLastImageModel(model: Models) {
		super.setLastImageModel(model);
		settings.aiAdapterSettings.ollamaSettings.lastImageModel = model;
	}

	/**
	 * 关闭 Ollama 连接
	 * 中止当前请求并关闭客户端
	 */
	shutdown(): void {
		debugLog(context, "Shutting down Ollama instance");
		OllamaProvider.abortCurrentOllamaRequest();
		if (ollama !== undefined) {
			ollama.abort();
		}
	}

	/**
	 * 自定义 fetch 函数
	 * 为每个 Ollama 请求创建独立的 AbortController，支持请求中止
	 * 同时转发调用方提供的 signal，确保双方都能触发中止
	 */
	static ollamaFetch(
		input: Parameters<typeof globalThis.fetch>[0],
		init?: RequestInit,
	): Promise<Response> {
		const controller = new AbortController();

		// 转发调用方的中止信号
		if (init?.signal) {
			const callerSignal = init.signal;
			if (callerSignal.aborted) {
				controller.abort();
			} else {
				const onAbort = () => controller.abort();
				callerSignal.addEventListener("abort", onAbort, { once: true });
			}
		}

		OllamaProvider.currentOllamaController = controller;
		const newInit: RequestInit = {
			...(init || {}),
			signal: controller.signal,
		};

		const promise = fetch(input, newInit);

		// 请求完成后清理存储的控制器
		promise
			.finally(() => {
				if (OllamaProvider.currentOllamaController === controller)
					OllamaProvider.currentOllamaController = undefined;
			})
			.catch(() => {});

		return promise;
	}

	/**
	 * 中止当前正在进行的 Ollama 请求
	 */
	static abortCurrentOllamaRequest(): void {
		if (OllamaProvider.currentOllamaController) {
			try {
				OllamaProvider.currentOllamaController.abort();
			} catch {
				// 忽略中止错误
			} finally {
				OllamaProvider.currentOllamaController = undefined;
			}
		}
	}
}
