/**
 * MOBILE_BUILD 专用的空实现桩。
 *
 * 移动端 bundle 只保留主插件壳 + easy-sync：其它模块入口与模块专属 helper
 * 在 esbuild 构建期由 scripts/mobile-build-plugin.mjs 的 onResolve 重定向到
 * 本文件。descriptors 同时被裁成只含 easy-sync，因此这些空 class/空函数
 * 永远不会真正被启动——它们只是让 main.ts / settings.ts 的静态 import
 * 有东西可解析，避免把真实模块代码（38MB）打进移动端产物。
 *
 * 本文件只在 MOBILE_BUILD=1 时进入构建图；desktop 常规构建完全不受影响。
 */

/** 所有被裁剪模块的默认导出：一个满足 SubPluginLike 的空壳。 */
export default class MobileStubModule {
	async onload(): Promise<void> {}
	onunload(): void {}
	async loadData(): Promise<unknown> { return {}; }
	async saveData(): Promise<void> {}
}

// md-editor 的代码文件视图（main.ts 的 registerCodeFiles 用；移动端已不注册）
export const ExternalCodeView = class {};
export const VIEW_TYPE_EXTERNAL_CODE = "mobile-stub-external-code";

// settings.ts「接管的扩展名」块的默认清单（置空 -> 该块显示空清单，无副作用）
export const DEFAULT_CODE_EXTENSIONS: string[] = [];

// code-editor 执行层 / 编辑器增强 helper
export function registerNativeCodeBlockRun(): void {}
export function langFromExt(): null { return null; }
export function registerAtLinkSuggest(): void {}

// extensionRegistry / windowFrame / remoteBootstrap
export function registerFreeExtensions(): void {}
export function setupTitlebarWindowMenu(): void {}
export function setTitlebarMenuSuppressed(): void {}
export function registerRuntimeBootstrap(): void {}

// dataview 索引桥（main.ts startModule/onunload 里的 dataview 分支已被 descriptors 裁剪短路）
export function installDataviewIndexBridge(): void {}
export function uninstallDataviewIndexBridge(): void {}

// mnaoumov 系列 library 初始化补丁
export function allowReentrantLibraryInit(): void {}
