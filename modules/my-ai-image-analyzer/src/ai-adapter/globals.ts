/**
 * globals.ts - AI 适配器全局状态模块
 *
 * 管理 AI 适配器的全局状态：
 * - provider: 当前使用的 AI 提供者实例
 * - possibleModels: 可用的 AI 模型列表
 * - 模型变更订阅/通知机制
 * - 设置取消订阅函数
 */
import { Models } from "./types";
import { Provider } from "./provider";

/**
 * 设置当前 AI 提供者实例
 * @param p - 新的提供者实例
 */
export function setProvider(p: Provider): void {
	provider = p;
}

/** 当前使用的 AI 提供者实例 */
export let provider: Provider;

/**
 * 预定义的可用 AI 模型列表
 * 每个模型包含名称、模型标识、是否支持图片分析和所属提供者
 * 运行时会动态添加从 Ollama/Gemini 获取的自定义模型
 */
export const possibleModels: Models[] = [
	{
		name: "llava-llama3 (8B) [default]",
		model: "llava-llama3:latest",
		imageReady: true,
		provider: "ollama",
	},
	{
		name: "llama3.2-vision (11B)",
		model: "llama3.2-vision:11b",
		imageReady: true,
		provider: "ollama",
	},
	{
		name: "llama3.2-vision (90B)",
		model: "llama3.2-vision:90b",
		imageReady: true,
		provider: "ollama",
	},
	{
		name: "llava (7B)",
		model: "llava:latest",
		imageReady: true,
		provider: "ollama",
	},
	{
		name: "llava (13B)",
		model: "llava:13b",
		imageReady: true,
		provider: "ollama",
	},
	{
		name: "llava (34B)",
		model: "llava:34b",
		imageReady: true,
		provider: "ollama",
	},
	{
		name: "llama3.3 (70B)",
		model: "llama3.3",
		imageReady: false,
		provider: "ollama",
	},
	{
		name: "deepseek-r1 (7B)",
		model: "deepseek-r1",
		imageReady: false,
		provider: "ollama",
	},
	{
		name: "llama3.2 (3B)",
		model: "llama3.2",
		imageReady: false,
		provider: "ollama",
	},
	{
		name: "llama3.2 (1B)",
		model: "llama3.2:1b",
		imageReady: false,
		provider: "ollama",
	},
	{
		name: "llama3.1 (8B)",
		model: "llama3.1",
		imageReady: false,
		provider: "ollama",
	},
	{
		name: "llama3.1 (70B)",
		model: "llama3.1:70b",
		imageReady: false,
		provider: "ollama",
	},
	{
		name: "gemma3 (1B)",
		model: "gemma3:1b",
		imageReady: false,
		provider: "ollama",
	},
	{
		name: "gemma3 (4B)",
		model: "gemma3:4b",
		imageReady: true,
		provider: "ollama",
	},
	{
		name: "gemma3 (12B)",
		model: "gemma3:12b",
		imageReady: true,
		provider: "ollama",
	},
	{
		name: "gemma3 (27B)",
		model: "gemma3:27b",
		imageReady: true,
		provider: "ollama",
	},
];

/** 设置变更的取消订阅函数，用于插件卸载时清理 */
export let unsubscribeFunctionSetting: (() => void) | null = null;

/**
 * 设置取消订阅函数
 * @param fn - 取消订阅的回调函数
 */
export function setUnsubscribeFunctionSetting(fn: (() => void) | null) {
	unsubscribeFunctionSetting = fn;
}

/** 模型变更监听器列表 */
const modelsChangeListeners: Array<() => void> = [];

/**
 * 订阅模型变更事件
 * 当可用模型列表更新时（如检测到新的 Ollama/Gemini 模型），触发回调
 * @param cb - 模型变更时的回调函数
 * @returns 取消订阅的函数
 */
export function subscribeModelsChange(cb: () => void) {
	modelsChangeListeners.push(cb);
	return () => {
		const idx = modelsChangeListeners.indexOf(cb);
		if (idx > -1) modelsChangeListeners.splice(idx, 1);
	};
}

/**
 * 通知所有模型变更监听器
 * 在检测到新模型或提供者变更时调用
 */
export function notifyModelsChange() {
	modelsChangeListeners.forEach((cb) => cb());
}
