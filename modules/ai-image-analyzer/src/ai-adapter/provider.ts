/**
 * provider.ts - AI 提供者抽象基类
 *
 * 定义所有 AI 提供者必须实现的接口：
 * - queryHandling: 纯文本查询
 * - queryWithImageHandling: 带图片的查询
 * - generateSettings: 生成提供者专属的设置界面
 *
 * 提供通用的模型记忆和关闭逻辑
 */
import { Models } from "./types";
import AIImageAnalyzerPlugin from "../main";

export abstract class Provider {
	/** 上次使用的文本模型 */
	lastModel!: Models;
	/** 上次使用的图片分析模型 */
	lastImageModel!: Models;

	/**
	 * 纯文本查询（抽象方法，子类必须实现）
	 * @param prompt - 文本提示
	 * @returns AI 生成的文本响应
	 */
	abstract queryHandling(prompt: string): Promise<string>;

	/**
	 * 带图片的查询（抽象方法，子类必须实现）
	 * @param prompt - 文本提示
	 * @param image - Base64 编码的图片数据
	 * @returns AI 生成的图片分析文本
	 */
	abstract queryWithImageHandling(
		prompt: string,
		image: string,
	): Promise<string>;

	/**
	 * 生成提供者专属的设置界面（抽象方法，子类必须实现）
	 * @param containerEl - 设置界面的容器元素
	 * @param plugin - 插件实例
	 */
	abstract generateSettings(
		containerEl: HTMLElement,
		plugin: AIImageAnalyzerPlugin,
	): void;

	/**
	 * 关闭提供者连接（可选重写）
	 * 用于清理资源，如关闭网络连接
	 */
	shutdown(): void {}

	/**
	 * 记录上次使用的文本模型
	 * @param model - 模型信息
	 */
	setLastModel(model: Models) {
		this.lastModel = model;
	}

	/**
	 * 记录上次使用的图片分析模型
	 * @param model - 模型信息
	 */
	setLastImageModel(model: Models) {
		this.lastImageModel = model;
	}
}
