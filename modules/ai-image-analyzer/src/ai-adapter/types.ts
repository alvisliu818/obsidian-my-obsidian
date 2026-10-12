/**
 * types.ts - AI 适配器类型定义模块
 *
 * 定义 AI 适配器相关的核心类型：
 * - Models: AI 模型的描述信息
 * - Providers: 支持的 AI 提供者类型
 * - providerNames: 提供者名称列表
 */

/**
 * AI 模型类型定义
 */
export type Models = {
	/** 模型的显示名称 */
	name: string;
	/** 模型的标识符（用于 API 调用） */
	model: string;
	/** 是否支持图片分析 */
	imageReady: boolean;
	/** 所属的 AI 提供者 */
	provider: Providers;
};

/**
 * 支持的 AI 提供者类型
 * 添加新提供者时需在此处扩展
 */
export type Providers = "ollama" | "gemini";

/** 所有支持的 AI 提供者名称列表 */
export const providerNames: Providers[] = ["ollama", "gemini"];
