/**
 * util.ts - AI 适配器工具函数模块
 *
 * 提供 AI 适配器的初始化和状态检查功能：
 * - initProvider: 根据设置初始化对应的 AI 提供者
 * - checkProviderReady: 检查提供者是否已初始化
 */
import { settings } from "../settings";
import { Provider } from "./provider";
import { OllamaProvider } from "./providers/ollamaProvider";
import { GeminiProvider } from "./providers/geminiProvider";
import { provider } from "./globals";
import { Notice } from "obsidian";
import { debugLog } from "../util";

const context = "ai-adapter/util";

/**
 * 根据当前设置初始化 AI 提供者
 * 读取 settings.aiAdapterSettings.provider 决定创建哪种提供者实例
 * @returns 新创建的 AI 提供者实例
 */
export function initProvider(): Provider {
	debugLog(
		context,
		"Initializing provider: " + settings.aiAdapterSettings.provider,
	);
	switch (settings.aiAdapterSettings.provider) {
		case "ollama": {
			return new OllamaProvider();
		}
		case "gemini": {
			return new GeminiProvider();
		}
	}
}

/**
 * 检查 AI 提供者是否已初始化
 * 如果未初始化，显示通知并抛出错误
 * 在执行 AI 查询前调用此函数确保提供者可用
 */
export function checkProviderReady() {
	if (!provider) {
		debugLog(context, "Provider not initialized");
		new Notice("Provider not initialized");
		throw new Error("Provider not initialized");
	}
}
