/**
 * analyserManager.ts - 图片分析管理模块
 *
 * 负责协调图片分析的完整流程：
 * 1. 检查缓存/索引，如果已有结果则直接返回
 * 2. 读取图片文件内容
 * 3. 调用 AI 提供者进行图片分析
 * 4. 将分析结果写入缓存/索引
 * 5. 处理超时和重试逻辑
 *
 * 还提供带通知提示的分析入口函数
 */
import { Notice, TFile } from "obsidian";
import { isInCache, readCache, writeCache } from "./cache";
import { debugLog, isImageFile, readFile } from "./util";
import { settings } from "./settings";
import { imagesProcessQueue, runWithTimeout } from "./globals";
import { queryWithImage } from "./ai-adapter/api";
import { provider } from "./ai-adapter/globals";
import { OllamaProvider } from "./ai-adapter/providers/ollamaProvider";

const context = "analyserManager";

/** 已重试过的图片路径集合，避免无限重试 */
const retriedImages = new Set<string>();
/** 单次分析的超时时间（毫秒） */
const ANALYZE_TIMEOUT_MS = 120000;

/**
 * 分析图片（入口函数）
 * 将分析任务加入处理队列，确保逐个处理
 * @param file - 需要分析的图片文件
 * @returns AI 生成的关键词文本，失败时返回空字符串
 */
export async function analyzeImage(file: TFile): Promise<string> {
	try {
		return (
			(await imagesProcessQueue.add(() => analyzeImageTask(file))) ?? ""
		);
	} catch (e) {
		debugLog(context, e);
		return "";
	}
}

/**
 * 图片分析任务（带超时和重试机制）
 * 首次失败后会重试一次（仅对 Ollama 提供者），重试前会刷新实例并中止当前请求
 * @param file - 需要分析的图片文件
 * @returns AI 生成的关键词文本
 */
async function analyzeImageTask(file: TFile): Promise<string> {
	const key = file.path;
	try {
		return await runWithTimeout(
			analyzeImageHandling(file),
			ANALYZE_TIMEOUT_MS,
		);
	} catch (err) {
		debugLog(context, `analyzeImageHandling failed for ${key}:`);
		debugLog(context, err);
		if (!retriedImages.has(key)) {
			retriedImages.add(key);
			// 对 Ollama 提供者进行特殊处理：刷新实例并中止当前请求
			if (provider instanceof OllamaProvider) {
				OllamaProvider.refreshInstance();
			}
			OllamaProvider.abortCurrentOllamaRequest();
			debugLog(context, `Retrying image once: ${key}`);
			try {
				return await runWithTimeout(
					analyzeImageHandling(file),
					ANALYZE_TIMEOUT_MS,
				);
			} catch (err2) {
				debugLog(context, `Retry also failed for ${key}:`);
				debugLog(context, err2);
				throw err2;
			}
		}
		throw err;
	}
}

/**
 * 图片分析的核心处理逻辑
 * 1. 验证文件是否为图片
 * 2. 检查缓存/索引，命中则直接返回
 * 3. 读取图片内容并调用 AI 进行分析
 * 4. 将分析结果写入缓存/索引
 * @param file - 需要分析的图片文件
 * @returns AI 生成的关键词文本
 */
async function analyzeImageHandling(file: TFile): Promise<string> {
	debugLog(context, `Analyzing image ${file.name}`);
	if (!isImageFile(file)) {
		return Promise.reject("File is not an image");
	}

	// 检查缓存/索引
	if (await isInCache(file)) {
		debugLog(context, "Cache hit");
		const text = await readCache(file);
		if (text && text.text !== "") {
			debugLog(context, "Reading from cache");
			debugLog(context, `Image analyzed ${file.name}`);
			return Promise.resolve(text.text);
		} else {
			debugLog(context, "Failed to read cache");
		}
	}

	try {
		// 读取图片文件内容
		const data: string = await readFile(file);

		// 调用 AI 提供者进行图片分析
		const response = await queryWithImage(settings.prompt, data);
		debugLog(context, "Response: " + (response ?? "null"));

		if (!response) {
			return Promise.reject("Failed to analyze image");
		}

		// 将分析结果写入缓存/索引
		await writeCache(file, response);

		debugLog(context, `Image analyzed ${file.name}`);

		return Promise.resolve(response);
	} catch (e) {
		debugLog(context, e);
		return Promise.reject("Failed to analyze image");
	}
}

/**
 * 分析图片并显示通知提示
 * 分析过程中显示"正在分析"通知，完成后显示"分析完成"通知
 * @param file - 需要分析的图片文件
 * @returns AI 生成的关键词文本，失败时返回空字符串
 */
export async function analyzeImageWithNotice(file: TFile): Promise<string> {
	try {
		const notice = new Notice("Analyzing image", 0);
		const text = await analyzeImage(file);
		notice.hide();
		if (text == "") {
			new Notice("Failed to analyze image");
			return "";
		}
		new Notice("Image analyzed");
		return text;
	} catch (e) {
		debugLog(context, e);
		new Notice("Failed to analyze image");
		new Notice(e.toString());
		return "";
	}
}

/**
 * 分析图片并将关键词复制到剪贴板
 * @param file - 需要分析的图片文件
 */
export async function analyzeToClipboard(file: TFile) {
	try {
		const text = await analyzeImageWithNotice(file);
		if (text == "") {
			return;
		}
		await activeWindow.navigator.clipboard.writeText(text);
		new Notice("Text copied to clipboard");
	} catch (e) {
		debugLog(context, e);
	}
}
