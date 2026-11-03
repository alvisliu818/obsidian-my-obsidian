/**
 * 资源管理服务
 *
 * 负责管理插件资源文件的加载和缓存。
 * 资源文件（如图片）会被转换为 base64 数据 URI 格式，方便在 React 组件中使用。
 *
 * 通过 {@link App.vault.adapter} 读取 `.obsidian/plugins/<id>/` 下的文件，避免使用 Node `fs`，
 * 以兼容 Obsidian 移动端与 eslint-plugin-obsidianmd 的 `import/no-nodejs-modules` 规则。
 */

import { App, normalizePath } from "obsidian";
import MusicPlayerPlugin from "@/main";

/** 将 ArrayBuffer 转为 base64（不依赖 Node Buffer，适配浏览器 / 移动端） */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	const chunkSize = 8192;
	let binary = "";
	for (let i = 0; i < bytes.length; i += chunkSize) {
		const end = Math.min(i + chunkSize, bytes.length);
		const chunk = bytes.subarray(i, end);
		binary += String.fromCharCode(...chunk);
	}
	return btoa(binary);
}

function extensionFromFilename(filename: string): string {
	const lastDot = filename.lastIndexOf(".");
	return lastDot >= 0 ? filename.slice(lastDot).toLowerCase() : "";
}

function mimeTypeForImageExtension(ext: string): string {
	switch (ext) {
		case ".png":
			return "image/png";
		case ".jpg":
		case ".jpeg":
			return "image/jpeg";
		case ".gif":
			return "image/gif";
		case ".svg":
			return "image/svg+xml";
		default:
			return "image/png";
	}
}

/**
 * 资源管理服务类
 *
 * 提供资源文件的加载和缓存功能，将文件转换为 base64 数据 URI。
 * 使用内存缓存避免重复读取文件。
 */
export class AssetService {
	/** 资源文件缓存（文件名 -> base64 数据 URI） */
	private assetCache: Map<string, string> = new Map();

	/**
	 * 创建资源管理服务实例
	 *
	 * @param app - Obsidian App 实例，用于访问 vault 适配器
	 * @param plugin - 插件实例，用于获取插件 ID
	 */
	constructor(
		private app: App,
		private plugin: MusicPlayerPlugin
	) {}

	/**
	 * 获取插件资源文件的 base64 数据 URI
	 *
	 * 从插件目录读取资源文件，转换为 base64 数据 URI 格式。
	 * 如果文件已缓存，直接返回缓存结果。
	 * 如果文件不存在或读取失败，返回一个透明的 1x1 像素占位图。
	 *
	 * @param filename - 资源文件名（相对于插件目录）
	 * @returns base64 数据 URI 字符串
	 */
	async getAssetPath(filename: string): Promise<string> {
		if (this.assetCache.has(filename)) return this.assetCache.get(filename)!;
		try {
			const pluginId = this.plugin.manifest.id;
			const relativePath = normalizePath(`.obsidian/plugins/${pluginId}/${filename}`);
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(relativePath))) {
				throw new Error(`资源文件不存在: ${relativePath}`);
			}
			const fileBuffer = await adapter.readBinary(relativePath);
			const base64 = arrayBufferToBase64(fileBuffer);
			const ext = extensionFromFilename(filename);
			const mimeType = mimeTypeForImageExtension(ext);
			const dataUri = `data:${mimeType};base64,${base64}`;
			this.assetCache.set(filename, dataUri);
			return dataUri;
		} catch (error) {
			console.error(`无法加载资源文件 ${filename}:`, error);
			return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
		}
	}
}
