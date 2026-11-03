/**
 * exampleProvider.ts - 示例 AI 提供者模板
 *
 * 这是一个示例提供者实现，用于演示如何添加新的 AI 提供者。
 * 添加新提供者时，可以复制此文件作为起点，然后实现具体的查询逻辑。
 *
 * 添加新提供者的步骤：
 * 1. 复制此文件并重命名（如 myProvider.ts）
 * 2. 实现 queryHandling 和 queryWithImageHandling 方法
 * 3. 在 types.ts 中扩展 Providers 类型
 * 4. 在 globals.ts 中添加模型定义
 * 5. 在 util.ts 的 initProvider 中添加 case
 * 6. 在 settings.ts 中添加设置类型和默认值
 */
import { Setting } from "obsidian";
import { Provider } from "../provider";
import { Models } from "../types";
import { possibleModels } from "../globals";
import AIImageAnalyzerPlugin from "../../main";

/**
 * 示例提供者的设置类型定义
 */
export type ExampleSettings = {
	/** 上次使用的文本模型 */
	lastModel: Models;
	/** 上次使用的图片分析模型 */
	lastImageModel: Models;
};

/** 示例提供者设置的默认值 */
export const DEFAULT_EXAMPLE_SETTINGS: ExampleSettings = {
	lastModel: possibleModels[13],
	lastImageModel: possibleModels[12],
};

/**
 * 示例 AI 提供者
 * 所有方法返回空值，仅作为模板使用
 */
export class ExampleProvider extends Provider {
	constructor() {
		super();
	}

	/**
	 * 生成示例提供者的设置界面
	 */
	generateSettings(containerEl: HTMLElement, plugin: AIImageAnalyzerPlugin) {
		new Setting(containerEl).setName("Testing").setHeading();
	}

	/**
	 * 纯文本查询（示例实现，返回空字符串）
	 */
	queryHandling(prompt: string): Promise<string> {
		return Promise.resolve("");
	}

	/**
	 * 带图片的查询（示例实现，返回空字符串）
	 */
	queryWithImageHandling(prompt: string, image: string): Promise<string> {
		return Promise.resolve("");
	}

	/**
	 * 记录上次使用的文本模型
	 */
	setLastModel(model: Models) {
		super.setLastModel(model);
	}

	/**
	 * 记录上次使用的图片分析模型
	 */
	setLastImageModel(model: Models) {
		super.setLastImageModel(model);
	}
}
