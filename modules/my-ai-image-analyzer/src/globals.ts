/**
 * globals.ts - 全局常量和工具函数模块
 *
 * 提供插件范围内的共享常量和通用工具函数：
 * - libVersion: 插件版本号（从 package.json 读取）
 * - imagesProcessQueue: 图片处理队列，控制并发和超时
 * - runWithTimeout: 带超时的 Promise 执行包装器
 */
import * as packageJson from "../package.json";
import PQueue from "p-queue";

/** 插件版本号，从 package.json 中读取 */
export const libVersion = packageJson.version;

/**
 * 图片处理队列
 * 限制并发为 1（逐个处理），超时时间为 5 分钟
 * 避免同时向 AI 提供者发送过多请求
 */
export const imagesProcessQueue = new PQueue({
	concurrency: 1,
	timeout: 300000,
});

/**
 * 带超时的 Promise 执行包装器
 * 如果 Promise 在指定时间内未完成，则抛出超时错误
 * @param p - 需要执行的 Promise
 * @param ms - 超时时间（毫秒）
 * @returns 与原始 Promise 相同的结果，或超时错误
 */
export function runWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
	return Promise.race<T>([
		p,
		new Promise<T>((_, rej) =>
			setTimeout(() => rej(new Error(`timeout after ${ms}ms`)), ms),
		),
	]);
}
