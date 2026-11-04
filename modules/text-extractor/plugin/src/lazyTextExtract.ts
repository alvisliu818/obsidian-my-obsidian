/**
 * obsidian-text-extract 懒加载器（聚合主仓内存优化，2026-11-05）。
 *
 * lib 体积 2.7MB（wasm 内联），主 bundle 静态携带 = 源码 ×2 常驻（loader
 * new Function 双份留存）。拆为独立懒包（lazy/text-extract.js，独立 esbuild
 * 入口），运行时经 require(插件目录绝对路径) 首次触碰才解析执行。
 *
 * 启动期行为折进首触序列，与原 onload 等价：
 *  - setCacheLocation：配置先记 pending，库加载后立即应用（onload 之前
 *    的设置变更也不丢）；
 *  - convertOldCachePaths：首触后异步跑一次（幂等迁移；与首次提取并发时
 *    最坏情况是旧缓存条目漏命中一次、重新提取，无正确性影响）。
 */

import type * as TextExtractNS from 'obsidian-text-extract';

type NS = typeof TextExtractNS;

let mod: NS | null = null;
let pluginDir: string | null = null;
let pendingCacheLocation: Parameters<NS['setCacheLocation']>[0] | undefined;
let migrated = false;

/** onload 调用：记录插件目录与缓存位置配置（库加载前后都正确生效）。 */
export function configureLazyTextExtract(opts: {
	pluginDir: string;
	cacheLocation: Parameters<NS['setCacheLocation']>[0];
}): void {
	pluginDir = opts.pluginDir;
	pendingCacheLocation = opts.cacheLocation;
	if (mod) mod.setCacheLocation(opts.cacheLocation);
}

/** 库实例（首次触碰触发懒包 require + 启动期序列）。 */
export function getTextExtract(): NS {
	if (mod) return mod;
	if (!pluginDir) throw new Error('[text-extractor] lazy bundle used before configureLazyTextExtract()');
	// 动态 require：esbuild CJS 输出下保持为运行时 require，Electron renderer
	// （nodeIntegration）按绝对路径解析插件目录下的懒包文件。
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	mod = require(`${pluginDir}/lazy/text-extract.js`) as NS;
	if (pendingCacheLocation !== undefined) mod.setCacheLocation(pendingCacheLocation);
	if (!migrated) {
		migrated = true;
		void mod.convertOldCachePaths().catch(() => {});
	}
	return mod;
}

export function isTextExtractLoaded(): boolean {
	return mod !== null;
}

// ---------------------------------------------------------------------------
// 与 lib 同名的转发包装——调用方只改 import 来源，调用点零改动。
// ---------------------------------------------------------------------------

export const extractText = (...a: Parameters<NS['extractText']>): ReturnType<NS['extractText']> =>
	getTextExtract().extractText(...a);

export const canFileBeExtracted = (...a: Parameters<NS['canFileBeExtracted']>): ReturnType<NS['canFileBeExtracted']> =>
	getTextExtract().canFileBeExtracted(...a);

export const isInCache = (...a: Parameters<NS['isInCache']>): ReturnType<NS['isInCache']> =>
	getTextExtract().isInCache(...a);

export const removeFromCache = (...a: Parameters<NS['removeFromCache']>): ReturnType<NS['removeFromCache']> =>
	getTextExtract().removeFromCache(...a);

/** 设置页打开时才需要语言清单（强加载——用户主动进入交互，可接受）。 */
export const getOcrLangs = (...a: Parameters<NS['getOcrLangs']>): ReturnType<NS['getOcrLangs']> =>
	getTextExtract().getOcrLangs(...a);

/** 未加载时无事可清（守卫不触发懒加载）。 */
export function clearOCRWorkers(): void {
	if (isTextExtractLoaded()) getTextExtract().clearOCRWorkers();
}

export function setCacheLocation(loc: Parameters<NS['setCacheLocation']>[0]): void {
	pendingCacheLocation = loc;
	if (mod) mod.setCacheLocation(loc);
}

/** 模块卸载：未加载时无事可清。 */
export function clearProcessQueue(): void {
	if (isTextExtractLoaded()) getTextExtract().clearProcessQueue();
}
