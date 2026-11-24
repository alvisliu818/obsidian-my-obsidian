/**
 * llmHubProvider.ts - LLM Hub AI 提供者实现
 *
 * 通过 obsidian-llm-hub 的跨插件 Connect 协议使用它已配置的模型：
 * - 协议事件名与 obsidian-llm-hub src/integrations/connectContract.ts 保持一致
 *   （llm-connect-hub:ready / register-backend / unregister-backend）
 * - 模型列表来自 ConnectBackend.listModels()，动态填充 possibleModels
 * - 文本查询走 generateText；图片分析走 generateVision（LLM Hub 0.39.5+ 提供）
 * - 事件监听用模块级单例：provider 实例随设置切换随时重建，监听器只挂一份
 */
import { Notice, Setting } from "obsidian";
import { Provider } from "../provider";
import { Models } from "../types";
import { notifyModelsChange, possibleModels } from "../globals";
import AIImageAnalyzerPlugin from "../../main";
import { settings } from "../../settings";
import { debugLog } from "../../util";

const context = "ai-adapter/providers/llmHubProvider";

/** 只消费 LLM Hub 本体的 backend（id 即其 manifest.id）。
 *
 *  2026-11-24 llm-hub 并入 My Obsidian 成为模块后，它拿到的是**宿主的** manifest
 *  （单一插件 id 策略，见 src/main.ts 的 startModule），backend.id 随之变成
 *  "obsidian-my-obsidian"；独立安装时仍是 "llm-hub"。两个 id 都认，接入方式
 *  怎么变都不会静默断连。 */
const LLM_HUB_BACKEND_IDS: ReadonlySet<string> = new Set([
	"llm-hub",
	"obsidian-my-obsidian",
]);
function isLlmHubBackendId(id: string | undefined): boolean {
	return !!id && LLM_HUB_BACKEND_IDS.has(id);
}

/** Connect 协议事件名（与 obsidian-llm-hub 的 connectContract.ts 保持一致） */
const CONNECT_READY = "llm-connect-hub:ready";
const CONNECT_REGISTER = "llm-connect-hub:register-backend";
const CONNECT_UNREGISTER = "llm-connect-hub:unregister-backend";

/** LLM Hub ConnectBackend 中本 provider 需要的子集 */
export type LlmHubBackend = {
	id: string;
	name: string;
	listModels(): Array<{ name: string; displayName: string }>;
	getDefaultModel(): string;
	generateText(request: {
		model: string;
		messages: Array<{
			role: "user" | "assistant" | "tool";
			content: string;
			timestamp: number;
		}>;
		systemPrompt: string;
		signal: AbortSignal;
	}): Promise<string>;
	/** LLM Hub 0.39.5+ 提供；旧版本缺失时图片分析不可用 */
	generateVision?(request: {
		model: string;
		prompt: string;
		/** 不带 data: 前缀的原始 base64 图片数据 */
		imageBase64: string;
		mimeType?: string;
		signal: AbortSignal;
	}): Promise<string>;
};

/** LLM Hub 提供者的设置类型定义 */
export type LlmHubSettings = {
	/** 上次使用的文本模型 */
	lastModel: Models;
	/** 上次使用的图片分析模型 */
	lastImageModel: Models;
};

/** LLM Hub 设置的默认值（占位模型见 globals.ts，连接后自动替换为真实列表） */
export const DEFAULT_LLM_HUB_SETTINGS: LlmHubSettings = {
	lastModel: possibleModels.find(
		(m) => m.provider === "llm-hub" && !m.imageReady,
	)!,
	lastImageModel: possibleModels.find(
		(m) => m.provider === "llm-hub" && m.imageReady,
	)!,
};

/** 当前发现的 LLM Hub backend */
let backend: LlmHubBackend | null = null;

/** 已注册的 workspace 事件（name + 回调引用，卸载时用 off 精确摘除） */
let eventHandlers: Array<{
	name: string;
	callback: (...data: unknown[]) => void;
}> = [];

/** Connect 协议的自定义事件不在本仓 vendored obsidian 类型的事件枚举里——
 *  官方 Events 运行时支持任意字符串事件，这里按宽松签名访问（同 main.ts 的转型先例）。 */
type LooseWorkspace = {
	on(name: string, callback: (...data: unknown[]) => void): unknown;
	off(name: string, callback: (...data: unknown[]) => void): void;
	trigger(name: string, data?: unknown): void;
};

/** 模块级获取全局 workspace（与 main.ts getActiveFile 同样绕开模块顶层无 this 的限制） */
function getLooseWorkspace(): LooseWorkspace | null {
	return (
		(globalThis as unknown as { app?: { workspace?: LooseWorkspace } }).app
			?.workspace ?? null
	);
}

/** 把 LLM Hub 的模型列表同步进 possibleModels（文本 + 图片分析各一份，与 gemini 同构） */
function refreshModels(source: LlmHubBackend): boolean {
	try {
		let updated = false;
		for (const entry of source.listModels()) {
			const displayName = entry.displayName || entry.name;
			if (
				!possibleModels.some(
					(m) =>
						m.provider === "llm-hub" &&
						m.model === entry.name &&
						m.imageReady,
				)
			) {
				possibleModels.push({
					name: displayName,
					model: entry.name,
					imageReady: true,
					provider: "llm-hub",
				});
				debugLog(context, "Added image model: " + displayName);
				updated = true;
			}
			if (
				!possibleModels.some(
					(m) =>
						m.provider === "llm-hub" &&
						m.model === entry.name &&
						!m.imageReady,
				)
			) {
				possibleModels.push({
					name: displayName,
					model: entry.name,
					imageReady: false,
					provider: "llm-hub",
				});
				debugLog(context, "Added model: " + displayName);
				updated = true;
			}
		}
		return updated;
	} catch (e) {
		debugLog(context, e);
		return false;
	}
}

/** 收到 LLM Hub 的 backend 时记录并刷新模型列表 */
function onBackendDiscovered(source: LlmHubBackend): void {
	if (backend) return;
	backend = source;
	if (refreshModels(source)) {
		notifyModelsChange();
	}
}

/** 确保 workspace 事件监听已挂好：CONNECT_REGISTER 监听 + CONNECT_READY 握手 */
function ensureAttached(): void {
	if (eventHandlers.length > 0) return;
	const workspace = getLooseWorkspace();
	if (!workspace) return;
	const onRegister = (...data: unknown[]) => {
		const source = data[0] as LlmHubBackend | undefined;
		if (source && isLlmHubBackendId(source.id)) onBackendDiscovered(source);
	};
	const onUnregister = (...data: unknown[]) => {
		if (data[0] === backend) backend = null;
	};
	workspace.on(CONNECT_REGISTER, onRegister);
	workspace.on(CONNECT_UNREGISTER, onUnregister);
	eventHandlers.push(
		{ name: CONNECT_REGISTER, callback: onRegister },
		{ name: CONNECT_UNREGISTER, callback: onUnregister },
	);
	// 握手：LLM Hub 若早于本插件加载，让它的 backend 重新注册进来
	workspace.trigger(CONNECT_READY, {
		registerBackend: (source: LlmHubBackend) => {
			if (isLlmHubBackendId(source.id)) onBackendDiscovered(source);
		},
	});
	debugLog(context, "Connect listeners attached");
}

/** 摘除事件监听（插件卸载时调用） */
function detach(): void {
	const workspace = getLooseWorkspace();
	for (const { name, callback } of eventHandlers) {
		workspace?.off(name, callback);
	}
	eventHandlers = [];
	backend = null;
}

/** backend 是否已连接 */
function isReady(): boolean {
	return backend !== null;
}

/** 供查询方法取 backend；未连接时提示并抛错（由 api.ts 统一拒绝） */
function requireBackend(): LlmHubBackend {
	const source = backend;
	if (!source) {
		new Notice(
			"LLM Hub is not connected. Enable the LLM Hub plugin and verify at least one provider.",
		);
		throw new Error("LLM Hub backend is not connected");
	}
	return source;
}

/**
 * LLM Hub AI 提供者
 * 不直连任何 API；一切请求经由 LLM Hub 插件已配置的模型完成
 */
export class LlmHubProvider extends Provider {
	constructor() {
		super();
		// 旧 data.json 缺少 llmHubSettings（loadSettings 已补默认值，这里兜底）
		if (!settings.aiAdapterSettings.llmHubSettings) {
			settings.aiAdapterSettings.llmHubSettings = {
				...DEFAULT_LLM_HUB_SETTINGS,
			};
		}
		this.lastModel = settings.aiAdapterSettings.llmHubSettings.lastModel;
		this.lastImageModel =
			settings.aiAdapterSettings.llmHubSettings.lastImageModel;
		ensureAttached();
		if (backend) {
			// 已连接：补一次模型刷新（LLM Hub 侧可能刚加过模型）
			if (refreshModels(backend)) notifyModelsChange();
		}
	}

	/**
	 * 生成 LLM Hub 专属的设置界面
	 * 显示连接状态，并提供手动刷新模型列表的入口
	 */
	generateSettings(containerEl: HTMLElement, _plugin: AIImageAnalyzerPlugin) {
		new Setting(containerEl).setName("LLM Hub").setHeading();

		new Setting(containerEl)
			.setName("Connection")
			.setDesc(
				isReady()
					? "Connected to LLM Hub. Models follow the LLM Hub plugin settings."
					: "Not connected. Enable the LLM Hub plugin, verify at least one API provider, then reopen this settings tab.",
			)
			.addButton((button) =>
				button.setButtonText("Refresh models").onClick(() => {
					if (!backend) {
						new Notice("LLM Hub is not connected.");
						return;
					}
					if (refreshModels(backend)) {
						notifyModelsChange();
						new Notice("Model list updated from LLM Hub.");
					} else {
						new Notice("The LLM Hub model list has not changed.");
					}
				}),
			);
	}

	/**
	 * 纯文本查询
	 * 经 LLM Hub 的 generateText 用其当前文本模型生成响应
	 */
	async queryHandling(prompt: string): Promise<string> {
		const source = requireBackend();
		const model = settings.aiAdapterSettings.selectedModel.model;
		if (!model) {
			new Notice("No LLM Hub text model selected. Pick one in the settings.");
			throw new Error("No LLM Hub text model selected");
		}
		return await source.generateText({
			model,
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
			systemPrompt: "",
			signal: new AbortController().signal,
		});
	}

	/**
	 * 带图片的查询
	 * 经 LLM Hub 的 generateVision 用其选定的图片模型分析图片
	 */
	async queryWithImageHandling(
		prompt: string,
		image: string,
	): Promise<string> {
		const source = requireBackend();
		if (!source.generateVision) {
			new Notice(
				"The installed LLM Hub version does not support image analysis (generateVision missing).",
			);
			throw new Error("LLM Hub generateVision is unavailable");
		}
		const model = settings.aiAdapterSettings.selectedImageModel.model;
		if (!model) {
			new Notice(
				"No LLM Hub image model selected. Connect LLM Hub and pick one in the settings.",
			);
			throw new Error("No LLM Hub image model selected");
		}
		return await source.generateVision({
			model,
			prompt,
			imageBase64: image,
			mimeType: "image/png",
			signal: new AbortController().signal,
		});
	}

	/**
	 * 记录上次使用的文本模型并保存到设置
	 */
	setLastModel(model: Models) {
		super.setLastModel(model);
		settings.aiAdapterSettings.llmHubSettings.lastModel = model;
	}

	/**
	 * 记录上次使用的图片分析模型并保存到设置
	 */
	setLastImageModel(model: Models) {
		super.setLastImageModel(model);
		settings.aiAdapterSettings.llmHubSettings.lastImageModel = model;
	}

	/**
	 * 关闭提供者连接
	 * 摘除 workspace 事件监听
	 */
	shutdown(): void {
		debugLog(context, "Detaching LLM Hub connect listeners");
		detach();
	}
}
