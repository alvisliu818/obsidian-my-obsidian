/**
 * api.ts - AI 适配器 API 模块
 *
 * 提供 AI 查询的统一接口：
 * - query: 纯文本查询
 * - queryWithImage: 带图片的查询（用于图片分析）
 *
 * 处理 AI 提供者的错误响应和异常，对 Ollama 提供者自动刷新实例
 */
import { provider } from "./globals";
import { checkProviderReady } from "./util";
import { debugLog } from "../util";
import { Notice } from "obsidian";
import { OllamaProvider } from "./providers/ollamaProvider";

const context = "ai-adapter/api";

/**
 * 纯文本查询
 * 向当前 AI 提供者发送文本提示并获取响应
 * @param prompt - 文本提示
 * @returns AI 生成的文本响应
 */
export async function query(prompt: string): Promise<string> {
	checkProviderReady();

	try {
		const response = await provider.queryHandling(prompt);
		if (response.length === 0) {
			debugLog(context, "Empty response from provider");
			return Promise.reject("Empty response from provider");
		}

		if (response.startsWith("[AI-ERROR]")) {
			new Notice(response.replace("[AI-ERROR]", ""));
			debugLog(context, "AI Error: " + response);
			return Promise.reject(response);
		}
		return response;
	} catch (e) {
		if (provider instanceof OllamaProvider) {
			OllamaProvider.refreshInstance();
		}
		debugLog(context, e);
		return Promise.reject(e);
	}
}

/**
 * 带图片的查询
 * 向当前 AI 提供者发送文本提示和图片数据，获取图片分析结果
 * @param prompt - 文本提示（如分析指令）
 * @param image - Base64 编码的图片数据
 * @returns AI 生成的图片分析文本
 */
export async function queryWithImage(
	prompt: string,
	image: string,
): Promise<string> {
	checkProviderReady();

	try {
		const response = await provider.queryWithImageHandling(prompt, image);
		if (response.length === 0) {
			debugLog(context, "Empty response from provider");
			return Promise.reject("Empty response from provider");
		}

		return response;
	} catch (e) {
		if (provider instanceof OllamaProvider) {
			OllamaProvider.refreshInstance();
		}
		debugLog(context, e);
		return Promise.reject(e);
	}
}
