/**
 * util.ts - 通用工具函数模块
 *
 * 提供插件中使用的各种工具函数：
 * - debugLog: 带上下文标识的调试日志输出
 * - getTempBasePath/getTempPath: 临时文件路径管理
 * - isImageFile: 图片文件格式判断
 * - readFile: 读取图片文件内容（支持 SVG 转 PNG）
 * - htmlDescription: 创建 HTML 描述文档片段
 */
import { arrayBufferToBase64, TFile } from "obsidian";
import { settings } from "./settings";

const context = "util";

/**
 * 根据字符串生成 HSL 颜色
 * 用于在调试日志中为不同上下文标识分配不同颜色，便于区分
 * @param str - 输入字符串
 * @returns HSL 颜色字符串
 */
function stringToColor(str: string): string {
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = str.charCodeAt(i) + ((hash << 5) - hash);
		hash |= 0;
	}
	const hue = ((hash % 360) + 360) % 360;
	return `hsl(${hue}, 70%, 50%)`;
}

/**
 * 输出调试日志
 * 仅在调试模式开启时输出，日志带有彩色上下文标识
 * @param context - 日志上下文标识（如模块名）
 * @param message - 日志消息
 */
export function debugLog(context: string, message: unknown) {
	if (settings.debug) {
		const color = stringToColor(context);

		console.log(
			`[AIImageAnalyzer] %c[${context}]`,
			`color: ${color}; font-weight: bold;`,
			message,
		);
	}
}

/**
 * 获取临时文件的根目录路径
 * 临时文件存储在插件配置目录下的 tmp 子目录中
 * @returns 临时文件根目录路径
 */
export function getTempBasePath(): string {
	// @ts-ignore - 使用全局 app 引用
	return `${app.vault.configDir}/plugins/ai-image-analyzer/tmp`;
}

/**
 * 获取某个文件的临时文件路径
 * 将文件路径中的斜杠替换为下划线作为临时文件名
 * @param file - 需要临时存储的文件
 * @returns 临时文件的完整路径
 */
export function getTempPath(file: TFile): string {
	const folder = `${getTempBasePath()}`;
	const filename = `${file.path.replace(/\//g, "_")}`;
	return `${folder}/${filename}`;
}

/**
 * 判断文件是否为支持的图片格式
 * 支持 png、jpg、jpeg、webp、svg 格式
 * @param file - 需要判断的文件
 * @returns 是否为图片文件
 */
export function isImageFile(file: TFile): boolean {
	const path = file.path;

	return (
		path.endsWith(".png") ||
		path.endsWith(".jpg") ||
		path.endsWith(".jpeg") ||
		path.endsWith(".webp") ||
		path.endsWith(".svg")
	);
}

/**
 * 读取图片文件内容并转换为 Base64 编码
 * 对于 SVG 文件，会先在 Canvas 上渲染为 PNG 再编码
 * 对于其他图片格式，直接读取二进制数据并编码
 * @param file - 需要读取的图片文件
 * @returns Base64 编码的图片数据
 */
export async function readFile(file: TFile): Promise<string> {
	if (file.path.endsWith(".svg")) {
		debugLog(context, "Converting SVG to PNG");

		try {
			// @ts-ignore - 使用全局 app 引用
			const svgData: string = await app.vault.adapter.read(file.path);

			return await new Promise<string>((resolve, reject) => {
				const canvas = document.createElement("canvas");
				canvas.width = 1000;
				canvas.height = 1000;
				const ctx = canvas.getContext("2d");

				if (!ctx) {
					reject(new Error("Could not get canvas context"));
					return;
				}

				const image = new Image();
				image.onload = () => {
					try {
						ctx.drawImage(image, 0, 0, 1000, 1000);
						const dataUrl = canvas.toDataURL("image/png");
						resolve(dataUrl.split(",")[1]);
					} catch (err) {
						reject(err);
					}
				};
				image.onerror = (error) => {
					console.error("Error loading SVG image:", error);
					reject(error);
				};

				// 将 SVG 数据编码为 data URL 加载到 Image 元素中
				image.src = `data:image/svg+xml;base64,${btoa(svgData)}`;
			});
		} catch (error) {
			console.error("Error converting SVG to PNG:", error);
			throw error;
		}
	} else {
		// 非 SVG 图片：直接读取二进制数据并转换为 Base64
		// @ts-ignore - 使用全局 app 引用
		return arrayBufferToBase64(await app.vault.readBinary(file));
	}
}

/**
 * 创建包含 HTML 内容的文档片段
 * 用于在设置界面中显示富文本描述
 * @param innerHTML - HTML 内容字符串
 * @returns 包含 HTML 内容的 DocumentFragment
 */
export function htmlDescription(innerHTML: string): DocumentFragment {
	const desc = new DocumentFragment();
	desc.createSpan({}, (span) => {
		span.innerHTML = innerHTML;
	});
	return desc;
}
